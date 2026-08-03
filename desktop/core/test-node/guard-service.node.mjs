import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "../../..");
const ENTRY = process.env.LAMARCK_GUARD_ENTRY
  ? resolve(process.env.LAMARCK_GUARD_ENTRY)
  : join(ROOT, "desktop/core/dist/guard-service.cjs");
const TOKEN = "node-guard-test-token-0123456789";
const DIRECT = process.env.LAMARCK_GUARD_TEST_DIRECT === "1";
const require = createRequire(import.meta.url);
const TEST_PRODUCER_REF = `producer:v1:sha256:${"1".repeat(64)}`;
const OTHER_TEST_PRODUCER_REF = `producer:v1:sha256:${"2".repeat(64)}`;

const host = {
  source: "system:test",
  producerRef: TEST_PRODUCER_REF,
  tableGrants: "*",
  docGrants: "*",
  schemaGrant: true,
};

let workspace;
let child;
let origin;
let stderr = "";
let rpcCounter = 0;
let directEngine;

before(async () => {
  assert.equal(
    existsSync(ENTRY),
    true,
    `Build ${ENTRY} first (node scripts/build-electron-main.mjs)`,
  );
  workspace = mkdtempSync(join(tmpdir(), "lamarck-node-guard-"));
  const lamarckDir = join(workspace, ".lamarck");
  mkdirSync(lamarckDir, { recursive: true });
  seedDataDb(join(lamarckDir, "data.db"));

  if (DIRECT) {
    const { GuardEngine } = require(ENTRY);
    directEngine = new GuardEngine({ workspacePath: workspace });
    return;
  }

  child = spawn(process.execPath, [ENTRY, workspace], {
    env: {
      ...process.env,
      LAMARCK_GUARD_TOKEN: TOKEN,
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolveReady, rejectReady) => {
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message?.type === "ready") resolveReady(message);
      } catch {}
    });
    child.once("exit", (code) => {
      rejectReady(new Error(`Guard exited before ready (${code}): ${stderr}`));
    });
    child.once("error", rejectReady);
  });
  const message = await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Guard startup timeout: ${stderr}`)), 10_000)),
  ]);
  origin = `http://127.0.0.1:${message.port}`;
});

after(async () => {
  directEngine?.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  }
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("Node Guard utility", { concurrency: 1 }, () => {
  test("serves loopback health and requires bearer auth for RPC", { skip: DIRECT }, async () => {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      schemaVersion: "0.1",
      database: "data.db",
    });

    const unauthorized = await fetch(`${origin}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "unauthorized", method: "query", params: {} }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, "GUARD_UNAUTHORIZED");
  });

  test("clamps trusted per-call budgets to the Guard hard ceiling", { skip: DIRECT }, async () => {
    const isolatedWorkspace = mkdtempSync(join(tmpdir(), "lamarck-node-guard-ceiling-"));
    const isolatedDir = join(isolatedWorkspace, ".lamarck");
    mkdirSync(isolatedDir, { recursive: true });
    seedDataDb(join(isolatedDir, "data.db"));
    const { startGuardService } = require(ENTRY);
    const isolatedToken = "hard-ceiling-test-token-0123456789";
    const service = await startGuardService({
      workspacePath: isolatedWorkspace,
      token: isolatedToken,
      hardExecutionLimitMs: 125,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${service.port}/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${isolatedToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "hard-ceiling",
          method: "query",
          deadlineMs: 10_000,
          params: { principal: host, sql: expensiveRecursiveQuery() },
        }),
      });
      assert.equal((await response.json()).error?.code, "GUARD_DEADLINE");
    } finally {
      await service.close();
      rmSync(isolatedWorkspace, { recursive: true, force: true });
    }
  });

  test("kills a busy data.db owner when the outer Guard is SIGKILLed", { skip: DIRECT }, async () => {
    const isolatedWorkspace = mkdtempSync(join(tmpdir(), "lamarck-node-guard-parent-death-"));
    const isolatedDir = join(isolatedWorkspace, ".lamarck");
    mkdirSync(isolatedDir, { recursive: true });
    seedDataDb(join(isolatedDir, "data.db"));
    const isolatedToken = "parent-death-test-token-0123456789";
    let outer;
    let executorPid;
    let replacement;
    try {
      const started = await spawnGuardProcess(isolatedWorkspace, isolatedToken);
      outer = started.child;
      executorPid = started.executorPid;
      const mutation = fetch(`${started.origin}/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${isolatedToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "parent-death-mutation",
          method: "mutate",
          deadlineMs: 30_000,
          params: {
            principal: principal("app:parent-death", ["parents"]),
            sql: `
              WITH RECURSIVE counter(x) AS (
                VALUES(0) UNION ALL SELECT x + 1 FROM counter WHERE x < 1000000000
              )
              INSERT INTO parents (id, label)
              SELECT 'parent-death-' || x, 'uncommitted' FROM counter
            `,
          },
        }),
      }).then((response) => response.json(), (error) => error);
      await delay(150);
      outer.kill("SIGKILL");
      await once(outer, "exit");
      await mutation;

      await waitForProcessToExit(executorPid, 3_000);
      assert.equal(processExists(executorPid), false, "orphaned Guard executor survived its parent");

      const { startGuardService } = require(ENTRY);
      replacement = await startGuardService({
        workspacePath: isolatedWorkspace,
        token: isolatedToken,
        hardExecutionLimitMs: 5_000,
      });
      const response = await fetch(`http://127.0.0.1:${replacement.port}/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${isolatedToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "parent-death-recovery",
          method: "query",
          deadlineMs: 1_000,
          params: {
            principal: host,
            sql: "SELECT id FROM parents WHERE id LIKE 'parent-death-%' LIMIT 1",
          },
        }),
      });
      assert.deepEqual((await response.json()).result, []);
    } finally {
      await replacement?.close();
      if (outer && outer.exitCode === null && outer.signalCode === null) outer.kill("SIGKILL");
      if (executorPid && processExists(executorPid)) {
        try { process.kill(executorPid, "SIGKILL"); } catch {}
      }
      rmSync(isolatedWorkspace, { recursive: true, force: true });
    }
  });

  test("bounds recursive SQL in a disposable owner and recovers after client disconnect", { skip: DIRECT }, async () => {
    await assert.rejects(
      () => rpc("query", {
        principal: host,
        sql: expensiveRecursiveQuery(),
      }, { deadlineMs: 150 }),
      (error) => error?.code === "GUARD_DEADLINE",
    );
    const recoveredHealth = await fetch(`${origin}/health`);
    assert.equal(recoveredHealth.status, 200);
    assert.deepEqual(await queryRows("SELECT 1 AS recovered"), [{ recovered: 1 }]);

    const controller = new AbortController();
    const disconnected = rpcEnvelope("query", {
      principal: host,
      sql: expensiveRecursiveQuery(),
    }, {
      id: "disconnect-expensive-query",
      deadlineMs: 5_000,
      signal: controller.signal,
    });
    await delay(75);
    controller.abort(new Error("viewer channel revoked"));
    await assert.rejects(() => disconnected, /revoked|abort/i);

    // The next request cannot reach a fresh data.db owner until the killed
    // process has exited and SQLite has released/rolled back its connection.
    assert.deepEqual(await queryRows("SELECT 2 AS recovered"), [{ recovered: 2 }]);
  });

  test("bounds SQLite allocation before result or audit encoding and keeps Guard available", async () => {
    await assertRpcRejects("query", {
      principal: host,
      sql: "SELECT randomblob(1000000000) AS oversized",
    }, /out of memory|too big|string longer/i);

    const source = "app:oversized-blob";
    await assertRpcRejects("mutate", {
      principal: principal(source, ["blob_rows"]),
      sql: "INSERT INTO blob_rows (id, value) VALUES ('oversized', zeroblob(1000000000))",
    }, /out of memory|too big|audit exceeds/i);
    // Exercise a value below SQLite's built-in single-value ceiling too. It
    // reaches Guard CDC, exceeds the audit budget, and must still roll back.
    await assertRpcRejects("mutate", {
      principal: principal(source, ["blob_rows"]),
      sql: "INSERT INTO blob_rows (id, value) VALUES ('audit-oversized', zeroblob(16777216))",
    }, /out of memory|too big|audit exceeds/i);
    assert.deepEqual(
      await queryRows("SELECT id FROM blob_rows WHERE id IN ('oversized', 'audit-oversized')"),
      [],
    );
    assert.deepEqual(await auditPayloads(source), []);

    if (!DIRECT) {
      const recoveredHealth = await fetch(`${origin}/health`);
      assert.equal(recoveredHealth.status, 200);
    }
    assert.deepEqual(await queryRows("SELECT 3 AS recovered"), [{ recovered: 3 }]);
  });

  test("never executes a cancelled actor's request while replacing a timed-out owner", { skip: DIRECT }, async () => {
    const blocker = rpcEnvelope("query", {
      principal: host,
      sql: expensiveRecursiveQuery(),
    }, { id: "queue-blocker", deadlineMs: 200 });
    await delay(40);
    const queued = rpcEnvelope("mutate", {
      principal: principal("app:cancelled-queue", ["parents"]),
      sql: "INSERT INTO parents (id, label) VALUES ('cancelled-queue-row', 'must-not-run')",
    }, { id: "cancelled-queue", deadlineMs: 5_000 });
    await delay(40);

    const cancellation = await cancelRpc("cancelled-queue");
    assert.equal(cancellation.cancelled, true);
    const [blockerResult, queuedResult] = await Promise.all([blocker, queued]);
    assert.equal(blockerResult.error?.code, "GUARD_DEADLINE");
    assert.equal(queuedResult.error?.code, "GUARD_ABORTED");
    assert.deepEqual(
      await queryRows("SELECT id FROM parents WHERE id = 'cancelled-queue-row'"),
      [],
    );
    assert.deepEqual(await auditPayloads("app:cancelled-queue"), []);

    // A separate cancellation connection can overtake its RPC. The tombstone
    // must reject that later admission instead of treating cancel(false) as a
    // grant to execute under a replacement owner.
    assert.equal((await cancelRpc("cancel-before-admission")).cancelled, true);
    const reordered = await rpcEnvelope("mutate", {
      principal: principal("app:cancel-before-admission", ["parents"]),
      sql: "INSERT INTO parents (id, label) VALUES ('cancel-before-admission-row', 'must-not-run')",
    }, { id: "cancel-before-admission", deadlineMs: 5_000 });
    assert.equal(reordered.error?.code, "GUARD_ABORTED");
    assert.deepEqual(
      await queryRows("SELECT id FROM parents WHERE id = 'cancel-before-admission-row'"),
      [],
    );
  });

  test("deadline-killed D2 mutation rolls back rows and audit", { skip: DIRECT }, async () => {
    const source = "app:deadline-mutate";
    await assert.rejects(
      () => rpc("mutate", {
        principal: principal(source, ["parents"]),
        sql: `
          WITH RECURSIVE counter(x) AS (
            VALUES(0) UNION ALL SELECT x + 1 FROM counter WHERE x < 1000000000
          )
          INSERT INTO parents (id, label)
          SELECT 'deadline-mutate-' || x, 'uncommitted' FROM counter
        `,
      }, { deadlineMs: 150 }),
      (error) => error?.code === "GUARD_DEADLINE",
    );
    assert.deepEqual(
      await queryRows("SELECT id FROM parents WHERE id LIKE 'deadline-mutate-%' LIMIT 1"),
      [],
    );
    assert.deepEqual(await auditPayloads(source), []);
  });

  test("deadline-killed transaction rolls back prior D2 row and its staged audit", { skip: DIRECT }, async () => {
    const source = "app:deadline-transaction";
    await assert.rejects(
      () => rpc("transaction", {
        principal: principal(source, ["parents"]),
        statements: [
          {
            sql: "INSERT INTO parents (id, label) VALUES ('deadline-transaction-row', 'uncommitted')",
          },
          { sql: expensiveRecursiveQuery() },
        ],
      }, { deadlineMs: 150 }),
      (error) => error?.code === "GUARD_DEADLINE",
    );
    assert.deepEqual(
      await queryRows("SELECT id FROM parents WHERE id = 'deadline-transaction-row'"),
      [],
    );
    assert.deepEqual(await auditPayloads(source), []);
  });

  test("query is relationally unrestricted but denies writes and administrative surfaces", async () => {
    await rpc("mutate", {
      principal: host,
      sql: "INSERT INTO parents (id, label) VALUES (?, ?), (?, ?)",
      params: ["q1", "one", "q2", "two"],
    });
    await rpc("mutate", {
      principal: host,
      sql: "INSERT INTO children (id, parent_id, value) VALUES (?, ?, ?), (?, ?, ?)",
      params: ["qc1", "q1", 3, "qc2", "q1", 4],
    });

    const rows = await rpc("query", {
      principal: host,
      sql: `
        WITH totals AS (
          SELECT parent_id, sum(value) AS total,
                 json_group_array(value) AS values_json
          FROM children GROUP BY parent_id
        )
        SELECT p.id, coalesce(t.total, 0) AS total, t.values_json,
               row_number() OVER (ORDER BY p.id) AS rank,
               (SELECT count(*) FROM children c WHERE c.parent_id = p.id) AS child_count
        FROM parents p LEFT JOIN totals t ON t.parent_id = p.id
        WHERE p.id IN (?, ?) ORDER BY p.id
      `,
      params: ["q1", "q2"],
    });
    assert.deepEqual(rows, [
      { id: "q1", total: 7, values_json: "[3,4]", rank: 1, child_count: 2 },
      { id: "q2", total: 0, values_json: null, rank: 2, child_count: 0 },
    ]);
    assert.deepEqual(await rpc("query", {
      principal: host,
      sql: "SELECT key, value FROM json_each(?) ORDER BY key",
      params: ['["first","second"]'],
    }), [
      { key: 0, value: "first" },
      { key: 1, value: "second" },
    ]);
    assert.deepEqual(await rpc("query", {
      principal: host,
      sql: "SELECT id, label FROM parents WHERE id = $id",
      params: { id: "q1" },
    }), [{ id: "q1", label: "one" }]);
    assert.deepEqual(await rpc("query", {
      principal: host,
      sql: "/* leading ; comment */ WITH value(x) AS (SELECT ';') SELECT x FROM value; -- trailing ; comment",
    }), [{ x: ";" }]);

    await assertRpcRejects("query", {
      principal: host,
      sql: "INSERT INTO parents (id, label) VALUES ('query-write', 'no')",
    }, /not authorized|authorization denied/i);
    await assertRpcRejects("query", { principal: host, sql: "PRAGMA table_info(parents)" }, /authorized/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "SELECT * FROM pragma_table_info('parents')",
    }, /authorized|prohibited/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "ATTACH DATABASE ':memory:' AS other",
    }, /authorized/i);
    await assertRpcRejects("query", { principal: host, sql: "DETACH DATABASE other" }, /authorized/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "VACUUM",
    }, /authorized|relational result/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "VACUUM INTO 'guard-must-not-create.db'",
    }, /authorized|relational result/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "ANALYZE",
    }, /authorized|relational result/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "REINDEX",
    }, /authorized|relational result/i);
    await assertRpcRejects("query", { principal: host, sql: "BEGIN IMMEDIATE" }, /authorized/i);
    await assertRpcRejects("query", { principal: host, sql: "SAVEPOINT forged" }, /authorized/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "SELECT load_extension('forbidden')",
    }, /authorized|prohibited/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "SELECT _lamarck_encode_cdc_scalar('text', x'61')",
    }, /authorized|prohibited/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "SELECT * FROM temp._lamarck_cdc_rows",
    }, /authorized|access to temp/i);
    await assertRpcRejects("query", {
      principal: host,
      sql: "SELECT 1; SELECT 2",
    }, /exactly one/i);
  });

  test("mutate enforces direct table grants and denies D0/D1/system writes", async () => {
    await assertRpcRejects("mutate", {
      principal: {
        source: "app:forged-wildcard",
        producerRef: TEST_PRODUCER_REF,
        tableGrants: "*",
        docGrants: [],
        schemaGrant: false,
      },
      sql: "INSERT INTO parents (id, label) VALUES ('wildcard', 'denied')",
    }, /wildcard D2 grants require a system source/i);

    const app = principal("app:direct", ["parents"]);
    await rpc("mutate", {
      principal: app,
      sql: "INSERT INTO parents (id, label) VALUES (?, ?) RETURNING id, label",
      params: ["direct-ok", "ok"],
    });
    const upsert = await rpc("mutate", {
      principal: app,
      sql: `
        /* conflict clause; semicolons in comments are inert */
        INSERT INTO parents (id, label) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET label = excluded.label
        RETURNING id, label; -- accepted trailing terminator ;
      `,
      params: ["direct-ok", "updated"],
    });
    assert.deepEqual(upsert.rows, [{ id: "direct-ok", label: "updated" }]);
    const directAudit = await auditPayloads("app:direct");
    assert.deepEqual(directAudit.map((event) => event.type), ["d2.insert", "d2.update"]);
    await rpc("mutate", {
      principal: app,
      sql: "INSERT INTO parents (id, label) VALUES ($id, $label)",
      params: { id: "direct-named", label: "named params" },
    });
    await assertRpcRejects("mutate", {
      principal: app,
      sql: "INSERT INTO children (id, parent_id, value) VALUES (?, ?, ?)",
      params: ["direct-no", "direct-ok", 1],
    }, /not authorized|authorization denied/i);
    await assertRpcRejects("mutate", {
      principal: host,
      sql: 'DELETE FROM "main"."events"',
    }, /not authorized|authorization denied/i);
    await assertRpcRejects("mutate", {
      principal: host,
      sql: "UPDATE main.docs SET content = 'forged'",
    }, /not authorized|authorization denied/i);
    await assertRpcRejects("mutate", {
      principal: host,
      sql: "CREATE TABLE no_admin (id TEXT)",
    }, /DML|authorized/i);
  });

  test("principals require a strict logical Producer ref", async () => {
    const missing = { ...host };
    delete missing.producerRef;
    await assertRpcRejects("query", {
      principal: missing,
      sql: "SELECT 1 AS ok",
    }, /invalid principal producerRef/i);

    for (const producerRef of [
      "",
      "producer:v1:sha256:abc",
      `producer:v1:sha256:${"A".repeat(64)}`,
      `producer:v1:sha512:${"1".repeat(64)}`,
      `producer:v2:sha256:${"1".repeat(64)}`,
    ]) {
      await assertRpcRejects("query", {
        principal: { ...host, producerRef },
        sql: "SELECT 1 AS ok",
      }, /invalid principal producerRef/i);
    }
  });

  test("INSERT OR REPLACE authorizes and audits both actual side effects", async () => {
    const source = "app:replace";
    const app = principal(source, ["parents", "children"]);
    await rpc("mutate", {
      principal: app,
      sql: "INSERT INTO main.parents (id, label) VALUES (?, ?)",
      params: ["replace-row", "before"],
    });
    const replaced = await rpc("mutate", {
      principal: app,
      sql: "/* conflict replacement */ INSERT OR REPLACE INTO main.parents (id, label) VALUES (?, ?)",
      params: ["replace-row", "after"],
    });
    assert.equal(replaced.auditEventIds.length, 2);
    assert.deepEqual(await queryRows(
      "SELECT id, label FROM parents WHERE id = 'replace-row'",
    ), [{ id: "replace-row", label: "after" }]);
    const audit = await auditPayloads(source);
    assert.deepEqual(audit.map((event) => event.type), [
      "d2.insert",
      "d2.delete",
      "d2.insert",
    ]);
  });

  test("table grants follow SQLite ASCII folding without collapsing Unicode identifiers", async () => {
    const upperGrant = principal("app:unicode-upper", ["Ä"]);
    await rpc("mutate", {
      principal: upperGrant,
      sql: 'INSERT INTO "Ä" (id) VALUES (?)',
      params: ["upper-ok"],
    });
    await assertRpcRejects("mutate", {
      principal: upperGrant,
      sql: 'INSERT INTO "ä" (id) VALUES (?)',
      params: ["lower-denied"],
    }, /not authorized|authorization denied/i);
    assert.deepEqual(await queryRows('SELECT id FROM "Ä"'), [{ id: "upper-ok" }]);
    assert.deepEqual(await queryRows('SELECT id FROM "ä"'), []);

    await rpc("mutate", {
      principal: principal("app:quoted-table", ["weird table"]),
      sql: 'INSERT INTO "weird table" (id) VALUES (?)',
      params: ["quoted-ok"],
    });
    assert.deepEqual(await queryRows('SELECT id FROM "weird table"'), [{ id: "quoted-ok" }]);
  });

  test("trigger side effects require grants and every actual table change is audited", async () => {
    const sourceOnly = principal("app:trigger-denied", ["trigger_source"]);
    await assertRpcRejects("mutate", {
      principal: sourceOnly,
      sql: "INSERT INTO trigger_source (id, body) VALUES (?, ?)",
      params: ["trigger-denied", "no"],
    }, /not authorized|authorization denied/i);
    assert.deepEqual(await queryRows("SELECT id FROM trigger_source WHERE id = 'trigger-denied'"), []);
    assert.deepEqual(await queryRows("SELECT id FROM trigger_sink WHERE id = 'trigger-denied'"), []);

    const both = principal("app:trigger-ok", ["trigger_source", "trigger_sink"]);
    const result = await rpc("mutate", {
      principal: both,
      sql: "INSERT INTO trigger_source (id, body) VALUES (?, ?)",
      params: ["trigger-ok", "mirrored"],
    });
    assert.equal(result.auditEventIds.length, 2);
    assert.deepEqual(await queryRows("SELECT id, body FROM trigger_sink WHERE id = 'trigger-ok'"), [
      { id: "trigger-ok", body: "mirrored" },
    ]);
    const audit = await auditPayloads("app:trigger-ok");
    assert.deepEqual(new Set(audit.map((event) => event.payload.table)), new Set(["trigger_source", "trigger_sink"]));
    assert.ok(audit.every((event) => event.type === "d2.insert"));
    assert.ok(audit.every((event) => event.payload.affected_rows === 1));
  });

  test("foreign-key cascades require child grants and audit both tables atomically", async () => {
    await rpc("mutate", {
      principal: host,
      sql: "INSERT INTO parents (id, label) VALUES (?, ?)",
      params: ["cascade-parent", "cascade"],
    });
    await rpc("mutate", {
      principal: host,
      sql: "INSERT INTO children (id, parent_id, value) VALUES (?, ?, ?)",
      params: ["cascade-child", "cascade-parent", 9],
    });

    await assertRpcRejects("mutate", {
      principal: principal("app:cascade-denied", ["parents"]),
      sql: "DELETE FROM parents WHERE id = ?",
      params: ["cascade-parent"],
    }, /not authorized|authorization denied/i);
    assert.equal((await queryRows("SELECT count(*) AS n FROM parents WHERE id = 'cascade-parent'"))[0].n, 1);
    assert.equal((await queryRows("SELECT count(*) AS n FROM children WHERE id = 'cascade-child'"))[0].n, 1);

    const result = await rpc("mutate", {
      principal: principal("app:cascade-ok", ["parents", "children"]),
      sql: "DELETE FROM parents WHERE id = ?",
      params: ["cascade-parent"],
    });
    assert.equal(result.auditEventIds.length, 2);
    assert.deepEqual(await queryRows("SELECT id FROM children WHERE id = 'cascade-child'"), []);
    const audit = await auditPayloads("app:cascade-ok");
    assert.deepEqual(new Set(audit.map((event) => event.payload.table)), new Set(["parents", "children"]));
    assert.ok(audit.every((event) => event.type === "d2.delete"));
  });

  test("transaction owns BEGIN/COMMIT and rolls data plus audit back on any denial", async () => {
    await assertRpcRejects("transaction", {
      principal: host,
      statements: Array.from({ length: 101 }, () => ({ sql: "SELECT 1 AS value" })),
    }, /at most 100 statements/i);
    await assertRpcRejects("transaction", {
      principal: host,
      statements: [{ sql: "VACUUM INTO 'transaction-escape.db'" }],
    }, /relational SQL or DML|authorized|transaction/i);
    await assertRpcRejects("transaction", {
      principal: host,
      statements: [{ sql: "ANALYZE" }],
    }, /relational SQL or DML|authorized/i);

    const source = "app:transaction-denied";
    await assertRpcRejects("transaction", {
      principal: principal(source, ["parents"]),
      statements: [
        { sql: "INSERT INTO parents (id, label) VALUES (?, ?)", params: ["tx-rollback", "first"] },
        { sql: "INSERT INTO children (id, parent_id, value) VALUES (?, ?, ?)", params: ["tx-no", "tx-rollback", 1] },
      ],
    }, /not authorized|authorization denied/i);
    assert.deepEqual(await queryRows("SELECT id FROM parents WHERE id = 'tx-rollback'"), []);
    assert.deepEqual(await auditPayloads(source), []);

    const okSource = "app:transaction-ok";
    const results = await rpc("transaction", {
      principal: principal(okSource, ["parents"]),
      statements: [
        {
          sql: "INSERT INTO parents (id, label) VALUES (?, ?) RETURNING id",
          params: ["tx-ok", "before"],
        },
        { sql: "SELECT label FROM parents WHERE id = ?", params: ["tx-ok"] },
        {
          sql: "UPDATE parents SET label = ? WHERE id = ? RETURNING label",
          params: ["after", "tx-ok"],
        },
      ],
    });
    assert.deepEqual(results.map((result) => result.kind), ["mutate", "query", "mutate"]);
    assert.deepEqual(results[1].rows, [{ label: "before" }]);
    const audit = await auditPayloads(okSource);
    assert.equal(audit.length, 2);
    assert.equal(audit[0].payload.transaction_id, audit[1].payload.transaction_id);
    assert.deepEqual(audit.map((event) => event.payload.statement_index), [0, 2]);

    const constraintSource = "app:transaction-constraint";
    await assertRpcRejects("transaction", {
      principal: principal(constraintSource, ["parents"]),
      statements: [
        {
          sql: "INSERT INTO parents (id, label) VALUES (?, ?)",
          params: ["constraint-rollback", "first"],
        },
        {
          sql: "INSERT INTO parents (id, label) VALUES (?, ?)",
          params: ["constraint-rollback", "duplicate"],
        },
      ],
    }, /unique|constraint/i);
    assert.deepEqual(await queryRows(
      "SELECT id FROM parents WHERE id = 'constraint-rollback'",
    ), []);
    assert.deepEqual(await auditPayloads(constraintSource), []);
  });

  test("App D1 and D2 audit writes retain the initiating Producer ref", async () => {
    const app = principal(
      "app:producer-retention",
      ["parents"],
      ["apps/producer-retention/"],
      OTHER_TEST_PRODUCER_REF,
    );
    await rpc("writeDoc", {
      principal: app,
      id: "apps/producer-retention/one",
      content: "producer-bound",
    });
    await rpc("mutate", {
      principal: app,
      sql: "INSERT INTO parents (id, label) VALUES (?, ?)",
      params: ["producer-retention", "producer-bound"],
    });

    assert.deepEqual(
      (await d1Events("app:producer-retention")).map((event) => event.producerRef),
      [OTHER_TEST_PRODUCER_REF],
    );
    assert.deepEqual(
      (await auditPayloads("app:producer-retention")).map((event) => event.producerRef),
      [OTHER_TEST_PRODUCER_REF],
    );
  });

  test("D1 and D0 helpers preserve envelopes and enforce path/event namespaces", async () => {
    const docs = principal("app:docs", [], ["apps/docs/", "shared/pinned"]);
    assert.deepEqual(await rpc("writeDoc", {
      principal: docs,
      id: "apps/docs/today",
      content: "hello",
      metadata: { mood: "calm" },
    }), { ok: true });
    await assertRpcRejects("writeDoc", {
      principal: docs,
      id: "apps/other/no",
      content: "denied",
    }, /not allowed to write doc/i);
    assert.equal(await rpc("deleteDoc", { principal: docs, id: "apps/docs/today" }), true);

    const eventId = await rpc("writeEvent", {
      principal: docs,
      event: {
        type: "focus.completed",
        externalId: "focus-1",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
        payload: { minutes: 25 },
      },
    });
    const event = (await queryRows(
      "SELECT id, schema_version, source, producer_ref, type, external_id, payload FROM events WHERE id = ?",
      [eventId],
    ))[0];
    assert.deepEqual(event, {
      id: eventId,
      schema_version: "0.1",
      source: "app:docs",
      producer_ref: TEST_PRODUCER_REF,
      type: "focus.completed",
      external_id: "focus-1",
      payload: '{"minutes":25}',
    });

    const replayId = await rpc("writeEvent", {
      principal: principal("app:docs", [], [], OTHER_TEST_PRODUCER_REF),
      event: {
        type: "focus.completed",
        externalId: "focus-1",
        startedAt: 1_800_000_000_000,
        payload: { minutes: 99 },
      },
    });
    assert.equal(replayId, eventId);
    assert.deepEqual((await queryRows(
      "SELECT producer_ref, started_at, payload FROM events WHERE id = ?",
      [eventId],
    ))[0], {
      producer_ref: TEST_PRODUCER_REF,
      started_at: 1_700_000_000_000,
      payload: '{"minutes":25}',
    });

    const crossSourceId = await rpc("writeEvent", {
      principal: principal("app:docs-other-source", [], [], OTHER_TEST_PRODUCER_REF),
      event: {
        type: "focus.completed",
        externalId: "focus-1",
        startedAt: 1_800_000_000_000,
        payload: { minutes: 99 },
      },
    });
    assert.notEqual(crossSourceId, eventId);
    assert.deepEqual((await queryRows(
      "SELECT source, producer_ref FROM events WHERE id = ?",
      [crossSourceId],
    ))[0], {
      source: "app:docs-other-source",
      producer_ref: OTHER_TEST_PRODUCER_REF,
    });
    await assertRpcRejects("writeEvent", {
      principal: docs,
      event: { type: "d2.insert", startedAt: Date.now(), payload: {} },
    }, /system-reserved/i);

    await assertRpcRejects("writeEvent", {
      principal: { ...host, source: "system:suppressed" },
      event: { type: "suppressed.test", startedAt: Date.now(), payload: {} },
    }, /changed 0 rows instead of 1/i);
    assert.deepEqual(await queryRows(
      "SELECT id FROM events WHERE source = 'system:suppressed'",
    ), []);

    await assertRpcRejects("mutate", {
      principal: { ...host, source: "system:suppressed" },
      sql: "INSERT INTO parents (id, label) VALUES ('suppressed-audit', 'rollback')",
    }, /changed 0 rows instead of 1/i);
    assert.deepEqual(await queryRows(
      "SELECT id FROM parents WHERE id = 'suppressed-audit'",
    ), []);
  });

  test("D1 ids cannot alias one portable Working Tree path", async () => {
    const docs = { ...host, source: "system:portable-doc-ids" };
    await rpc("writeDoc", {
      principal: docs,
      id: "Alias/CAFÉ",
      content: "first",
    });
    await assertRpcRejects("writeDoc", {
      principal: docs,
      id: "alias/cafe\u0301",
      content: "must not commit",
    }, /collides with portable Working Tree id/i);
    await assertRpcRejects("compareAndWriteDoc", {
      principal: docs,
      id: "ALIAS/café",
      expectedHash: null,
      expectedUpdatedAt: null,
      content: "must not commit conditionally",
    }, /collides with portable Working Tree id/i);

    await rpc("writeDoc", {
      principal: docs,
      id: "portable-shared/Spelling/one",
      content: "shared directory owner",
    });
    await assertRpcRejects("writeDoc", {
      principal: docs,
      id: "portable-shared/spelling/two",
      content: "must not create a differently spelled shared directory",
    }, /collides with portable Working Tree id/i);

    await rpc("writeDoc", {
      principal: docs,
      id: "portable-file-dir/leaf",
      content: "file owner",
    });
    await assertRpcRejects("compareAndWriteDoc", {
      principal: docs,
      id: "portable-file-dir/leaf.md/child",
      expectedHash: null,
      expectedUpdatedAt: null,
      content: "must not turn the existing file path into a directory",
    }, /collides with portable Working Tree id/i);
    assert.deepEqual(await queryRows(
      `SELECT id, content FROM docs
       WHERE id IN (?, ?, ?, ?, ?, ?)
       ORDER BY id`,
      [
        "Alias/CAFÉ",
        "alias/cafe\u0301",
        "portable-shared/Spelling/one",
        "portable-shared/spelling/two",
        "portable-file-dir/leaf",
        "portable-file-dir/leaf.md/child",
      ],
    ), [
      { id: "Alias/CAFÉ", content: "first" },
      { id: "portable-file-dir/leaf", content: "file owner" },
      { id: "portable-shared/Spelling/one", content: "shared directory owner" },
    ]);
  });

  test("Host lifecycle writes retain the System Producer ref", async () => {
    const eventId = await rpc("writeEvent", {
      principal: host,
      event: {
        type: "app.created",
        startedAt: 1_700_000_100_000,
        payload: { app_id: "producer-test" },
      },
    });
    assert.deepEqual((await queryRows(
      "SELECT source, producer_ref, type FROM events WHERE id = ?",
      [eventId],
    ))[0], {
      source: "system:test",
      producer_ref: TEST_PRODUCER_REF,
      type: "app.created",
    });
  });

  test("only system principals can privately read complete Working Tree documents", async () => {
    const source = "system:working-tree-private-read";
    const docs = { ...host, source };
    const docId = "journal/working-tree-large-private";
    const content = `private-large-sentinel:${"x".repeat(8 * 1024 * 1024)}`;

    await rpc("writeDoc", {
      principal: docs,
      id: docId,
      content,
      metadata: { locked: true, label: "private" },
    });

    const read = await rpc("readDocForWorkingTree", {
      principal: principal("system:working-tree-reader", [], []),
      id: docId,
    });
    assert.equal(read.id, docId);
    assert.equal(read.content, content);
    assert.equal(read.metadata, '{"locked":true,"label":"private"}');
    assert.equal(typeof read.updatedAt, "number");
    assert.deepEqual(await d1Events(source, docId), []);

    await assertRpcRejects("readDocForWorkingTree", {
      principal: principal("app:working-tree-reader", [], [docId]),
      id: docId,
    }, /require a system principal/i);
  });

  test("only system principals can page exact hashes of currently locked documents", async () => {
    const docs = { ...host, source: "system:working-tree-locked-hashes" };
    const ids = [
      "zz-working-tree-locked-hashes/a",
      "zz-working-tree-locked-hashes/b",
      "zz-working-tree-locked-hashes/c",
    ];
    const contents = ["private-a", "private-b", "private-c"];
    for (let index = 0; index < ids.length; index += 1) {
      await rpc("writeDoc", {
        principal: docs,
        id: ids[index],
        content: contents[index],
        metadata: { locked: true },
      });
    }
    await rpc("writeDoc", {
      principal: docs,
      id: "zz-working-tree-locked-hashes/unlocked",
      content: "public",
      metadata: { locked: false },
    });

    assert.deepEqual(await rpc("listLockedDocHashesForWorkingTree", {
      principal: principal("system:working-tree-hash-reader", [], []),
      afterId: "zz-working-tree-locked-hashes/",
      limit: 2,
    }), [
      { id: ids[0], contentHash: sha256(contents[0]) },
      { id: ids[1], contentHash: sha256(contents[1]) },
    ]);
    assert.deepEqual(await rpc("listLockedDocHashesForWorkingTree", {
      principal: principal("system:working-tree-hash-reader", [], []),
      afterId: ids[1],
      limit: 2,
    }), [
      { id: ids[2], contentHash: sha256(contents[2]) },
    ]);

    await assertRpcRejects("listLockedDocHashesForWorkingTree", {
      principal: principal("app:working-tree-hash-reader", [], ids),
      afterId: "",
      limit: 512,
    }, /require a system principal/i);
    await assertRpcRejects("listLockedDocHashesForWorkingTree", {
      principal: principal("system:working-tree-hash-reader", [], []),
      afterId: "",
      limit: 0,
    }, /limit must be an integer from 1 through 512/i);
    await assertRpcRejects("listLockedDocHashesForWorkingTree", {
      principal: principal("system:working-tree-hash-reader", [], []),
      afterId: "",
      limit: 513,
    }, /limit must be an integer from 1 through 512/i);
  });

  test("locked D1 metadata is sticky and suppresses content-bearing history", async () => {
    const source = "app:locked-docs";
    const docs = principal(source, [], ["journal/"]);
    const docId = "journal/private";

    await rpc("writeDoc", {
      principal: docs,
      id: docId,
      content: "private-create-sentinel",
      metadata: { locked: true, label: "private" },
    });
    await rpc("writeDoc", {
      principal: docs,
      id: docId,
      content: "private-omitted-metadata-sentinel",
    });
    let row = (await queryRows("SELECT content, metadata FROM docs WHERE id = ?", [docId]))[0];
    assert.deepEqual(JSON.parse(row.metadata), { locked: true, label: "private" });
    assert.deepEqual(await d1Events(source, docId), []);

    await rpc("writeDoc", {
      principal: docs,
      id: docId,
      content: "private-replaced-metadata-sentinel",
      metadata: { category: "journal" },
    });
    row = (await queryRows("SELECT content, metadata FROM docs WHERE id = ?", [docId]))[0];
    assert.deepEqual(JSON.parse(row.metadata), { category: "journal", locked: true });
    assert.deepEqual(await d1Events(source, docId), []);

    await rpc("writeDoc", {
      principal: docs,
      id: docId,
      content: "private-unlock-transition-sentinel",
      metadata: { category: "public", locked: false },
    });
    assert.deepEqual(await d1Events(source, docId), []);
    await rpc("writeDoc", {
      principal: docs,
      id: docId,
      content: "public-after-explicit-unlock",
    });
    assert.deepEqual((await d1Events(source, docId)).map((event) => event.type), ["d1.write"]);

    const sealingSource = "app:locking-transition";
    const sealingDocs = principal(sealingSource, [], ["journal/"]);
    await rpc("writeDoc", {
      principal: sealingDocs,
      id: "journal/to-lock",
      content: "public-before-lock",
    });
    await rpc("writeDoc", {
      principal: sealingDocs,
      id: "journal/to-lock",
      content: "newly-locked-secret-sentinel",
      metadata: { locked: true },
    });
    const sealingEvents = await d1Events(sealingSource, "journal/to-lock");
    assert.equal(sealingEvents.length, 1);
    assert.equal(JSON.stringify(sealingEvents).includes("newly-locked-secret-sentinel"), false);

    const deleteSource = "app:locked-delete";
    const deleteDocs = principal(deleteSource, [], ["journal/"]);
    await rpc("writeDoc", {
      principal: deleteDocs,
      id: "journal/delete-private",
      content: "locked-delete-secret-sentinel",
      metadata: { locked: true },
    });
    assert.equal(await rpc("deleteDoc", {
      principal: deleteDocs,
      id: "journal/delete-private",
    }), true);
    assert.deepEqual(await queryRows(
      "SELECT id FROM docs WHERE id = 'journal/delete-private'",
    ), []);
    assert.deepEqual(await d1Events(deleteSource, "journal/delete-private"), []);
    assert.deepEqual(await queryRows(
      "SELECT id FROM events WHERE payload LIKE ?",
      ["%locked-delete-secret-sentinel%"],
    ), []);

    const ordinarySource = "app:ordinary-delete";
    const ordinaryDocs = principal(ordinarySource, [], ["journal/"]);
    await rpc("writeDoc", {
      principal: ordinaryDocs,
      id: "journal/delete-public",
      content: "recoverable public content",
      metadata: { category: "public" },
    });
    assert.equal(await rpc("deleteDoc", {
      principal: ordinaryDocs,
      id: "journal/delete-public",
    }), true);
    const ordinaryEvents = await d1Events(ordinarySource, "journal/delete-public");
    assert.deepEqual(ordinaryEvents.map((event) => event.type), ["d1.write", "d1.delete"]);
    assert.deepEqual(ordinaryEvents[1].payload, {
      doc_id: "journal/delete-public",
      content: "recoverable public content",
      metadata: { category: "public" },
    });
    assert.equal(await rpc("deleteDoc", {
      principal: ordinaryDocs,
      id: "journal/missing",
    }), false);

    await assertRpcRejects("writeDoc", {
      principal: docs,
      id: "journal/invalid-lock",
      content: "must not commit",
      metadata: { locked: "yes" },
    }, /metadata\.locked must be a boolean/i);
    assert.deepEqual(await queryRows(
      "SELECT id FROM docs WHERE id = 'journal/invalid-lock'",
    ), []);
  });

  test("Working Tree cross-id copies of currently locked content inherit the lock atomically", async () => {
    const secret = "cross-id-private-content-sentinel";
    await rpc("writeDoc", {
      principal: { ...host, source: "system:cross-id-private-source" },
      id: "reconciliation/private-source",
      content: secret,
      metadata: { locked: true },
    });

    const workingTree = principal("working-tree:pages", [], ["reconciliation/"]);
    assert.equal(await rpc("compareAndWriteDoc", {
      principal: workingTree,
      id: "reconciliation/private-copy",
      expectedHash: null,
      expectedUpdatedAt: null,
      content: secret,
      metadata: { locked: false, importedFrom: "file" },
    }), true);

    const copied = (await queryRows(
      "SELECT content, metadata FROM docs WHERE id = ?",
      ["reconciliation/private-copy"],
    ))[0];
    assert.equal(copied.content, secret);
    assert.deepEqual(JSON.parse(copied.metadata), { locked: true, importedFrom: "file" });
    assert.deepEqual(await d1Events("working-tree:pages", "reconciliation/private-copy"), []);

    const overwriteId = "reconciliation/private-overwrite-target";
    const publicBeforeOverwrite = "public-before-private-overwrite";
    await rpc("writeDoc", {
      principal: { ...host, source: "system:cross-id-public-target" },
      id: overwriteId,
      content: publicBeforeOverwrite,
      metadata: { locked: false, label: "existing" },
    });
    const overwriteVersion = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      [overwriteId],
    ))[0].updated_at;
    assert.equal(await rpc("compareAndWriteDoc", {
      principal: workingTree,
      id: overwriteId,
      expectedHash: sha256(publicBeforeOverwrite),
      expectedUpdatedAt: overwriteVersion,
      content: secret,
    }), true);
    const overwritten = (await queryRows(
      "SELECT content, metadata FROM docs WHERE id = ?",
      [overwriteId],
    ))[0];
    assert.equal(overwritten.content, secret);
    assert.deepEqual(JSON.parse(overwritten.metadata), { locked: true, label: "existing" });
    assert.deepEqual(await d1Events("working-tree:pages", overwriteId), []);

    assert.deepEqual(await queryRows(
      "SELECT id FROM events WHERE payload LIKE ?",
      [`%${secret}%`],
    ), []);
  });

  test("conditional D1 helpers compare and mutate atomically without stale audit", async () => {
    const source = "system:conditional-docs";
    const docs = { ...host, source };
    const docId = "reconciliation/conditional";

    await rpc("writeDoc", {
      principal: docs,
      id: docId,
      content: "version-one",
      metadata: { label: "preserved" },
    });
    const versionOneUpdatedAt = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      [docId],
    ))[0].updated_at;
    assert.equal(await rpc("compareAndWriteDoc", {
      principal: docs,
      id: docId,
      expectedHash: sha256("stale"),
      expectedUpdatedAt: versionOneUpdatedAt,
      content: "must-not-commit",
      metadata: { label: "must-not-commit" },
    }), false);
    assert.deepEqual((await queryRows(
      "SELECT content, metadata FROM docs WHERE id = ?",
      [docId],
    ))[0], {
      content: "version-one",
      metadata: '{"label":"preserved"}',
    });
    assert.deepEqual((await d1Events(source, docId)).map((event) => event.type), ["d1.write"]);

    assert.equal(await rpc("compareAndWriteDoc", {
      principal: docs,
      id: docId,
      expectedHash: sha256("version-one"),
      expectedUpdatedAt: versionOneUpdatedAt,
      content: "version-two",
    }), true);
    assert.deepEqual((await queryRows(
      "SELECT content, metadata FROM docs WHERE id = ?",
      [docId],
    ))[0], {
      content: "version-two",
      metadata: '{"label":"preserved"}',
    });
    assert.deepEqual((await d1Events(source, docId)).map((event) => event.type), [
      "d1.write",
      "d1.write",
    ]);
    const versionTwoUpdatedAt = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      [docId],
    ))[0].updated_at;

    assert.equal(await rpc("compareAndDeleteDoc", {
      principal: docs,
      id: docId,
      expectedHash: sha256("version-one"),
      expectedUpdatedAt: versionTwoUpdatedAt,
    }), false);
    assert.equal((await queryRows(
      "SELECT count(*) AS count FROM docs WHERE id = ?",
      [docId],
    ))[0].count, 1);
    assert.equal((await d1Events(source, docId)).length, 2);

    assert.equal(await rpc("compareAndDeleteDoc", {
      principal: docs,
      id: docId,
      expectedHash: sha256("version-two"),
      expectedUpdatedAt: versionTwoUpdatedAt,
    }), true);
    assert.deepEqual((await d1Events(source, docId)).map((event) => event.type), [
      "d1.write",
      "d1.write",
      "d1.delete",
    ]);

    assert.equal(await rpc("compareAndWriteDoc", {
      principal: docs,
      id: "reconciliation/empty",
      expectedHash: null,
      expectedUpdatedAt: null,
      content: "",
    }), true);
    assert.equal(await rpc("compareAndWriteDoc", {
      principal: docs,
      id: "reconciliation/empty",
      expectedHash: null,
      expectedUpdatedAt: null,
      content: "must-not-replace-existing",
    }), false);
    const emptyUpdatedAt = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      ["reconciliation/empty"],
    ))[0].updated_at;
    assert.equal(await rpc("compareAndWriteDoc", {
      principal: docs,
      id: "reconciliation/empty",
      expectedHash: sha256(""),
      expectedUpdatedAt: emptyUpdatedAt,
      content: "now-present",
    }), true);

    const lockedId = "reconciliation/locked";
    await rpc("writeDoc", {
      principal: docs,
      id: lockedId,
      content: "locked-one",
      metadata: { locked: true, label: "private" },
    });
    const lockedOneUpdatedAt = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      [lockedId],
    ))[0].updated_at;
    assert.equal(await rpc("compareAndWriteDoc", {
      principal: docs,
      id: lockedId,
      expectedHash: sha256("locked-one"),
      expectedUpdatedAt: lockedOneUpdatedAt,
      content: "locked-two-secret-sentinel",
      metadata: { category: "journal" },
    }), true);
    assert.deepEqual(JSON.parse((await queryRows(
      "SELECT metadata FROM docs WHERE id = ?",
      [lockedId],
    ))[0].metadata), { category: "journal", locked: true });
    const lockedTwoUpdatedAt = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      [lockedId],
    ))[0].updated_at;
    assert.equal(await rpc("compareAndDeleteDoc", {
      principal: docs,
      id: lockedId,
      expectedHash: sha256("locked-two-secret-sentinel"),
      expectedUpdatedAt: lockedTwoUpdatedAt,
    }), true);
    assert.deepEqual(await d1Events(source, lockedId), []);
    assert.deepEqual(await queryRows(
      "SELECT id FROM events WHERE payload LIKE ?",
      ["%locked-two-secret-sentinel%"],
    ), []);
  });

  test("conditional D1 versions reject same-content metadata races within one millisecond", async () => {
    const docs = { ...host, source: "system:conditional-metadata-race" };
    const id = "reconciliation/metadata-race";
    const content = "same-content";
    await rpc("writeDoc", {
      principal: docs,
      id,
      content,
      metadata: { revision: 1 },
    });
    const firstUpdatedAt = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      [id],
    ))[0].updated_at;

    await rpc("writeDoc", {
      principal: docs,
      id,
      content,
      metadata: { revision: 2 },
    });
    const secondUpdatedAt = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      [id],
    ))[0].updated_at;
    assert.ok(secondUpdatedAt > firstUpdatedAt);

    assert.equal(await rpc("compareAndWriteDoc", {
      principal: docs,
      id,
      expectedHash: sha256(content),
      expectedUpdatedAt: firstUpdatedAt,
      content: "must-not-commit",
    }), false);
    assert.deepEqual((await queryRows(
      "SELECT content, metadata FROM docs WHERE id = ?",
      [id],
    ))[0], {
      content,
      metadata: '{"revision":2}',
    });

    assert.equal(await rpc("compareAndWriteDoc", {
      principal: docs,
      id,
      expectedHash: sha256(content),
      expectedUpdatedAt: secondUpdatedAt,
      content: "version-three",
    }), true);
    const thirdUpdatedAt = (await queryRows(
      "SELECT updated_at FROM docs WHERE id = ?",
      [id],
    ))[0].updated_at;
    assert.ok(thirdUpdatedAt > secondUpdatedAt);

    await assertRpcRejects("compareAndWriteDoc", {
      principal: docs,
      id: "reconciliation/invalid-null-version",
      expectedHash: null,
      expectedUpdatedAt: 0,
      content: "must-not-commit",
    }, /hash and updated_at must both be null or both identify/i);
    await assertRpcRejects("compareAndWriteDoc", {
      principal: docs,
      id,
      expectedHash: sha256("version-three"),
      expectedUpdatedAt: null,
      content: "must-not-commit",
    }, /hash and updated_at must both be null or both identify/i);
    await assertRpcRejects("compareAndDeleteDoc", {
      principal: docs,
      id,
      expectedHash: sha256("version-three"),
      expectedUpdatedAt: -1,
    }, /updated_at must be a nonnegative safe integer/i);
  });

  test("locked D1 policy survives a Guard restart", () => {
    const isolatedWorkspace = mkdtempSync(join(tmpdir(), "lamarck-locked-restart-"));
    const { GuardEngine } = require(ENTRY);
    const restartPrincipal = {
      source: "system:locked-restart",
      producerRef: TEST_PRODUCER_REF,
      tableGrants: "*",
      docGrants: "*",
      schemaGrant: true,
    };
    let engine;
    try {
      engine = new GuardEngine({ workspacePath: isolatedWorkspace });
      engine.writeDoc(
        restartPrincipal,
        "journal/restart-private",
        "restart-private-create-sentinel",
        { locked: true, persisted: true },
      );
      engine.close();
      engine = new GuardEngine({ workspacePath: isolatedWorkspace });
      engine.writeDoc(
        restartPrincipal,
        "journal/restart-private",
        "restart-private-update-sentinel",
      );
      const rows = engine.query(
        restartPrincipal,
        "SELECT content, metadata FROM docs WHERE id = ?",
        ["journal/restart-private"],
      );
      assert.equal(rows[0].content, "restart-private-update-sentinel");
      assert.deepEqual(JSON.parse(rows[0].metadata), { locked: true, persisted: true });
      assert.deepEqual(engine.query(
        restartPrincipal,
        "SELECT id FROM events WHERE source = ? AND type LIKE 'd1.%'",
        [restartPrincipal.source],
      ), []);
    } finally {
      try { engine?.close(); } catch {}
      rmSync(isolatedWorkspace, { recursive: true, force: true });
    }
  });

  test("D1 helpers reject trigger or foreign-key side effects into D2", async () => {
    await rpc("writeDoc", {
      principal: host,
      id: "legacy/cascade-parent",
      content: "must survive",
    });
    await rpc("mutate", {
      principal: host,
      sql: "INSERT INTO legacy_doc_children (id, doc_id) VALUES (?, ?)",
      params: ["legacy-child", "legacy/cascade-parent"],
    });

    await assertRpcRejects("deleteDoc", {
      principal: host,
      id: "legacy/cascade-parent",
    }, /D2 side effect|not authorized|authorization denied/i);
    assert.equal((await queryRows(
      "SELECT count(*) AS n FROM docs WHERE id = 'legacy/cascade-parent'",
    ))[0].n, 1);
    assert.equal((await queryRows(
      "SELECT count(*) AS n FROM legacy_doc_children WHERE id = 'legacy-child'",
    ))[0].n, 1);
  });

  test("schema methods are separately privileged and refresh CDC", async () => {
    const inspected = await rpc("schema.inspect", { principal: host });
    assert.ok(inspected.tables.some((table) => table.name === "events"));
    assert.ok(inspected.tables.some((table) => table.name === "docs"));
    assert.ok(inspected.tables.some((table) => table.name === "parents"));
    await assertRpcRejects("schema.inspect", {
      principal: principal("app:no-inspect", []),
    }, /schema lifecycle capability/i);

    await assertRpcRejects("schema.plan", {
      principal: {
        source: "app:forged-schema",
        producerRef: TEST_PRODUCER_REF,
        tableGrants: [],
        docGrants: [],
        schemaGrant: true,
      },
      kind: "promote",
      ddl: "CREATE TABLE forged_schema (id TEXT PRIMARY KEY)",
    }, /requires a system source/i);
    await assertRpcRejects("schema.plan", {
      principal: principal("app:no-schema", []),
      kind: "promote",
      ddl: "CREATE TABLE schema_denied (id TEXT PRIMARY KEY)",
    }, /schema lifecycle capability/i);
    await assertRpcRejects("schema.apply", {
      principal: host,
      kind: "promote",
      ddl: "CREATE TABLE ctas_escape AS SELECT 'unaudited' AS value",
      approved: true,
    }, /DDL is not allowed/i);
    assert.deepEqual(await queryRows(
      "SELECT name FROM sqlite_master WHERE name = 'ctas_escape'",
    ), []);
    await assertRpcRejects("schema.apply", {
      principal: host,
      kind: "promote",
      ddl: "/* target-hiding comment */ CREATE TABLE commented_schema (id TEXT)",
      approved: true,
    }, /DDL is not allowed/i);
    await assertRpcRejects("schema.plan", {
      principal: host,
      kind: "promote",
      ddl: `CREATE TABLE forbidden_doc_fk (
        id TEXT PRIMARY KEY,
        doc_id TEXT REFERENCES docs(id) ON DELETE CASCADE
      )`,
    }, /cannot reference system table docs/i);

    const plan = await rpc("schema.plan", {
      principal: host,
      kind: "promote",
      ddl: "CREATE TABLE schema_created (id TEXT PRIMARY KEY, value TEXT)",
    });
    assert.equal(plan.kind, "promote");
    assert.ok(Array.isArray(plan.beforeSchema.tables));
    await rpc("schema.apply", {
      principal: host,
      kind: "promote",
      ddl: "CREATE TABLE schema_created (id TEXT PRIMARY KEY, value TEXT)",
      approved: true,
      requestedBy: "node-test",
    });
    assert.deepEqual(await queryRows(
      `SELECT producer_ref
       FROM events
       WHERE source = ? AND type = 'ddl.promote'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      [host.source],
    ), [{ producer_ref: TEST_PRODUCER_REF }]);
    const result = await rpc("mutate", {
      principal: principal("app:schema-created", ["schema_created"]),
      sql: "INSERT INTO schema_created (id, value) VALUES (?, ?)",
      params: ["new", "captured"],
    });
    assert.equal(result.auditEventIds.length, 1);
    const audit = await auditPayloads("app:schema-created");
    assert.equal(audit[0].payload.table, "schema_created");

    await rpc("schema.apply", {
      principal: host,
      kind: "promote",
      ddl: [
        'CREATE TABLE "schema weird" (id TEXT PRIMARY KEY, value TEXT)',
        'CREATE INDEX "schema weird idx" ON "schema weird" (value)',
      ],
      approved: true,
      requestedBy: "node-test-quoted",
    });
    await rpc("mutate", {
      principal: principal("app:schema-quoted", ["schema weird"]),
      sql: 'INSERT INTO "schema weird" (id, value) VALUES (?, ?)',
      params: ["quoted", "captured"],
    });
    assert.deepEqual(await queryRows(
      'SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'schema weird idx\'',
    ), [{ name: "schema weird idx" }]);
    await rpc("schema.apply", {
      principal: host,
      kind: "demote",
      ddl: [
        'DROP INDEX "schema weird idx"',
        'DROP TABLE "schema weird"',
      ],
      approved: true,
      requestedBy: "node-test-quoted-drop",
    });
    assert.deepEqual(await queryRows(
      "SELECT name FROM sqlite_master WHERE name = 'schema weird'",
    ), []);

    await assertRpcRejects("schema.apply", {
      principal: host,
      kind: "promote",
      ddl: "CREATE TRIGGER forbidden AFTER INSERT ON schema_created BEGIN SELECT 1; END",
      approved: true,
    }, /DDL is not allowed|exactly one/i);
  });

  test("schema handles SQLite-owned objects and does not widen batch demotion", async () => {
    await rpc("schema.apply", {
      principal: host,
      kind: "promote",
      ddl: "CREATE TABLE auto_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)",
      approved: true,
    });
    await rpc("mutate", {
      principal: principal("app:auto", ["auto_rows"]),
      sql: "INSERT INTO auto_rows (value) VALUES (?)",
      params: ["captured"],
    });
    await rpc("schema.apply", {
      principal: host,
      kind: "demote",
      ddl: "DROP TABLE auto_rows",
      approved: true,
    });
    assert.deepEqual(await queryRows(
      "SELECT name FROM sqlite_master WHERE name = 'auto_rows'",
    ), []);

    await rpc("schema.apply", {
      principal: host,
      kind: "demote",
      ddl: "DROP TABLE drop_trigger_table",
      approved: true,
    });
    assert.deepEqual(await queryRows(
      "SELECT name FROM sqlite_master WHERE name = 'drop_trigger_table'",
    ), []);

    await rpc("mutate", {
      principal: host,
      sql: "INSERT INTO demote_parent (id) VALUES (?)",
      params: ["batch-parent"],
    });
    await rpc("mutate", {
      principal: host,
      sql: "INSERT INTO demote_child (id, parent_id) VALUES (?, ?)",
      params: ["batch-child", "batch-parent"],
    });
    await assertRpcRejects("schema.apply", {
      principal: host,
      kind: "demote",
      ddl: [
        "DROP TABLE demote_parent",
        "DROP INDEX demote_child_parent_idx",
      ],
      approved: true,
    }, /not authorized|authorization denied/i);
    assert.equal((await queryRows(
      "SELECT count(*) AS n FROM demote_child WHERE id = 'batch-child'",
    ))[0].n, 1);
    assert.deepEqual(await queryRows(
      "SELECT name FROM sqlite_master WHERE name = 'demote_child_parent_idx'",
    ), [{ name: "demote_child_parent_idx" }]);
  });

  test("BLOB params/results are JSON-safe and audit capture is tagged", async () => {
    const blob = Buffer.from([0, 1, 2, 254, 255]).toString("base64");
    await rpc("mutate", {
      principal: principal("app:blob", ["blob_rows"]),
      sql: "INSERT INTO blob_rows (id, value) VALUES (?, ?)",
      params: ["blob-1", { $blobBase64: blob }],
    });
    assert.deepEqual(await queryRows("SELECT value FROM blob_rows WHERE id = 'blob-1'"), [
      { value: { $blobBase64: blob } },
    ]);
    const audit = await auditPayloads("app:blob");
    assert.deepEqual(audit[0].payload.after[0].value, { $blobHex: "000102FEFF" });
  });

  test("64-bit integers and non-finite REAL values remain exact in results and audit", async () => {
    await rpc("mutate", {
      principal: principal("app:numeric", ["numeric_rows"]),
      sql: `INSERT INTO numeric_rows (id, integer_value, real_value)
            VALUES ('max', 9223372036854775807, 1e999),
                   ('min', -9223372036854775808, -1e999)`,
    });

    assert.deepEqual(await queryRows(
      "SELECT id, integer_value, real_value FROM numeric_rows ORDER BY id",
    ), [
      {
        id: "max",
        integer_value: { $integer: "9223372036854775807" },
        real_value: { $real: "Infinity" },
      },
      {
        id: "min",
        integer_value: { $integer: "-9223372036854775808" },
        real_value: { $real: "-Infinity" },
      },
    ]);

    const audit = await auditPayloads("app:numeric");
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].payload.after, [
      {
        id: "max",
        integer_value: { $integer: "9223372036854775807" },
        real_value: { $real: "Infinity" },
      },
      {
        id: "min",
        integer_value: { $integer: "-9223372036854775808" },
        real_value: { $real: "-Infinity" },
      },
    ]);

    const maxRowid = await rpc("mutate", {
      principal: principal("app:max-rowid", ["max_rowid_rows"]),
      sql: "INSERT INTO max_rowid_rows (id, value) VALUES (9223372036854775807, 'exact')",
    });
    assert.deepEqual(maxRowid.lastInsertRowid, { $integer: "9223372036854775807" });
    assert.deepEqual(await queryRows("SELECT id, value FROM max_rowid_rows"), [{
      id: { $integer: "9223372036854775807" },
      value: "exact",
    }]);
    const rowidAudit = await auditPayloads("app:max-rowid");
    assert.deepEqual(rowidAudit[0].payload.primary_key, [
      { id: { $integer: "9223372036854775807" } },
    ]);

    const exactFiniteReal = 2.0723159991821757e90;
    await rpc("mutate", {
      principal: principal("app:finite-real", ["numeric_rows"]),
      sql: "INSERT INTO numeric_rows (id, integer_value, real_value) VALUES (?, ?, ?)",
      params: ["finite", 1, exactFiniteReal],
    });
    const finiteResult = await queryRows(
      "SELECT real_value FROM numeric_rows WHERE id = 'finite'",
    );
    assert.equal(Object.is(finiteResult[0].real_value, exactFiniteReal), true);
    const finiteAudit = await auditPayloads("app:finite-real");
    assert.equal(Object.is(finiteAudit[0].payload.after[0].real_value, exactFiniteReal), true);
  });

  test("tables that cannot be row-captured fail closed before execution", async () => {
    await assertRpcRejects("mutate", {
      principal: principal("app:wide", ["wide_table"]),
      sql: "INSERT INTO wide_table (c0) VALUES (?)",
      params: ["must-not-commit"],
    }, /cannot audit writes|too many arguments/i);
    assert.deepEqual(await queryRows("SELECT c0 FROM wide_table WHERE c0 = 'must-not-commit'"), []);
    assert.deepEqual(await auditPayloads("app:wide"), []);
  });

  test("invalid UTF-8 TEXT is rejected before data or audit can commit", async () => {
    await assertRpcRejects("mutate", {
      principal: principal("app:invalid-text", ["numeric_rows"]),
      sql: `INSERT INTO numeric_rows (id, integer_value, real_value)
            VALUES (CAST(x'80' AS TEXT), 1, 1.0)`,
    }, /valid UTF-8|user-defined function/i);
    assert.deepEqual(await queryRows(
      "SELECT hex(id) AS id_hex FROM numeric_rows WHERE hex(id) = '80'",
    ), []);
    assert.deepEqual(await auditPayloads("app:invalid-text"), []);

    await rpc("mutate", {
      principal: principal("app:bom-text", ["numeric_rows"]),
      sql: `INSERT INTO numeric_rows (id, integer_value, real_value)
            VALUES (CAST(x'EFBBBF61' AS TEXT), 1, 1.0)`,
    });
    const bomRow = (await queryRows(
      "SELECT id, hex(id) AS id_hex FROM numeric_rows WHERE hex(id) = 'EFBBBF61'",
    ))[0];
    assert.equal(bomRow.id, "\uFEFFa");
    assert.equal(bomRow.id_hex, "EFBBBF61");
    const bomAudit = await auditPayloads("app:bom-text");
    assert.equal(bomAudit[0].payload.after[0].id, "\uFEFFa");
  });
});

function seedDataDb(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL DEFAULT '0.1',
        source TEXT NOT NULL,
        producer_ref TEXT NOT NULL,
        type TEXT NOT NULL,
        external_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        payload JSON NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000)
      );
      CREATE INDEX idx_events_source ON events(source, started_at DESC);
      CREATE INDEX idx_events_type ON events(type, started_at DESC);
      CREATE UNIQUE INDEX idx_events_dedup ON events(source, external_id)
        WHERE external_id IS NOT NULL;
      CREATE TRIGGER prevent_events_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
      CREATE TRIGGER prevent_events_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
      CREATE TABLE docs (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        metadata JSON,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_docs_updated ON docs(updated_at DESC);
      CREATE TRIGGER suppress_test_event
      BEFORE INSERT ON events
      WHEN NEW.source = 'system:suppressed'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
      CREATE TABLE parents (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL
      );
      CREATE TABLE children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        value INTEGER NOT NULL
      );
      CREATE TABLE trigger_source (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE TABLE trigger_sink (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE TRIGGER mirror_trigger_source
      AFTER INSERT ON trigger_source
      BEGIN
        INSERT INTO trigger_sink (id, body) VALUES (NEW.id, NEW.body);
      END;
      CREATE TABLE blob_rows (
        id TEXT PRIMARY KEY,
        value BLOB NOT NULL
      );
      CREATE TABLE numeric_rows (
        id TEXT PRIMARY KEY,
        integer_value INTEGER NOT NULL,
        real_value REAL NOT NULL
      );
      CREATE TABLE max_rowid_rows (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE "Ä" (id TEXT PRIMARY KEY);
      CREATE TABLE "ä" (id TEXT PRIMARY KEY);
      CREATE TABLE "weird table" (id TEXT PRIMARY KEY);
      CREATE TABLE drop_trigger_table (id TEXT PRIMARY KEY);
      CREATE TRIGGER drop_trigger_table_audit
      AFTER INSERT ON drop_trigger_table
      BEGIN
        SELECT NEW.id;
      END;
      CREATE TABLE demote_parent (id TEXT PRIMARY KEY);
      CREATE TABLE demote_child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES demote_parent(id) ON DELETE CASCADE
      );
      CREATE INDEX demote_child_parent_idx ON demote_child(parent_id);
      CREATE TABLE legacy_doc_children (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE
      );
      CREATE TABLE wide_table (
        c0 TEXT PRIMARY KEY,
        ${Array.from({ length: 520 }, (_, index) => `c${index + 1} TEXT`).join(",\n")}
      );
    `);
  } finally {
    db.close();
  }
}

function principal(source, tableGrants, docGrants = [], producerRef = TEST_PRODUCER_REF) {
  return { source, producerRef, tableGrants, docGrants, schemaGrant: false };
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function rpc(method, params, options = {}) {
  if (directEngine) return directEngine.dispatch(method, params);
  const body = await rpcEnvelope(method, params, options);
  if (body.error) {
    const error = new Error(body.error.message);
    error.code = body.error.code;
    throw error;
  }
  return body.result;
}

async function rpcEnvelope(method, params, options = {}) {
  const id = options.id ?? `rpc-${++rpcCounter}`;
  const response = await fetch(`${origin}/rpc`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, method, params, deadlineMs: options.deadlineMs }),
    signal: options.signal,
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error?.message ?? `Guard HTTP ${response.status}`);
    error.code = body.error?.code;
    throw error;
  }
  return body;
}

async function cancelRpc(id) {
  const response = await fetch(`${origin}/cancel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function assertRpcRejects(method, params, pattern) {
  await assert.rejects(() => rpc(method, params), pattern);
}

async function queryRows(sql, params) {
  return rpc("query", { principal: host, sql, params });
}

async function auditPayloads(source) {
  const rows = await queryRows(
    "SELECT type, producer_ref, payload FROM events WHERE source = ? AND type LIKE 'd2.%' ORDER BY created_at, rowid",
    [source],
  );
  return rows.map((row) => ({
    type: row.type,
    producerRef: row.producer_ref,
    payload: JSON.parse(row.payload),
  }));
}

async function d1Events(source, docId) {
  const rows = await queryRows(
    "SELECT type, producer_ref, payload FROM events WHERE source = ? AND type LIKE 'd1.%' ORDER BY created_at, rowid",
    [source],
  );
  const events = rows.map((row) => ({
    type: row.type,
    producerRef: row.producer_ref,
    payload: JSON.parse(row.payload),
  }));
  return docId === undefined
    ? events
    : events.filter((event) => event.payload.doc_id === docId);
}

function expensiveRecursiveQuery() {
  return `
    WITH RECURSIVE counter(x) AS (
      VALUES(0) UNION ALL SELECT x + 1 FROM counter WHERE x < 1000000000
    )
    SELECT sum(x) AS total FROM counter
  `;
}

async function spawnGuardProcess(workspacePath, token) {
  const guard = spawn(process.execPath, [ENTRY, workspacePath], {
    env: {
      ...process.env,
      LAMARCK_GUARD_TOKEN: token,
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let processStderr = "";
  guard.stderr.setEncoding("utf8");
  guard.stderr.on("data", (chunk) => { processStderr += chunk; });
  const lines = createInterface({ input: guard.stdout });
  try {
    const message = await Promise.race([
      new Promise((resolveReady, rejectReady) => {
        lines.on("line", (line) => {
          try {
            const parsed = JSON.parse(line);
            if (
              parsed?.type === "ready"
              && Number.isSafeInteger(parsed.port)
              && Number.isSafeInteger(parsed.executorPid)
            ) {
              resolveReady(parsed);
            }
          } catch {}
        });
        guard.once("error", rejectReady);
        guard.once("exit", (code, signal) => rejectReady(new Error(
          `Guard exited before readiness (${code ?? signal}): ${processStderr}`,
        )));
      }),
      delay(10_000).then(() => {
        throw new Error(`Guard readiness timed out: ${processStderr}`);
      }),
    ]);
    return {
      child: guard,
      origin: `http://127.0.0.1:${message.port}`,
      executorPid: message.executorPid,
    };
  } catch (error) {
    if (guard.exitCode === null && guard.signalCode === null) guard.kill("SIGKILL");
    throw error;
  } finally {
    lines.close();
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessToExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) await delay(25);
}
