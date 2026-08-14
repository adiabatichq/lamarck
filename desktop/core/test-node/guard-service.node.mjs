import assert from "node:assert/strict";
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

const host = {
  source: "system:test",
  producerRef: TEST_PRODUCER_REF,
  tableGrants: "*",
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

  test("mutate enforces direct table grants and denies D0/system writes", async () => {
    await assertRpcRejects("mutate", {
      principal: {
        source: "app:forged-wildcard",
        producerRef: TEST_PRODUCER_REF,
        tableGrants: "*",
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
    assert.deepEqual(directAudit.map((event) => event.type), [
      "workspace.table.rows.inserted",
      "workspace.table.rows.updated",
    ]);
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
      "workspace.table.rows.inserted",
      "workspace.table.rows.deleted",
      "workspace.table.rows.inserted",
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
    assert.ok(audit.every((event) => event.type === "workspace.table.rows.inserted"));
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
    assert.ok(audit.every((event) => event.type === "workspace.table.rows.deleted"));
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

  test("D2 mutation audit groups rows, skips zero-row writes, and keeps primary keys immutable", async () => {
    const source = "app:d2-contract";
    const app = principal(source, ["parents", "children"]);
    const inserted = await rpc("mutate", {
      principal: app,
      sql: "INSERT INTO parents (id, label) VALUES ('group-a', 'A'), ('group-b', 'B')",
    });
    assert.equal(inserted.auditEventIds.length, 1);
    const [grouped] = await auditPayloads(source);
    assert.equal(grouped.type, "workspace.table.rows.inserted");
    assert.equal(grouped.payload.affected_rows, 2);
    assert.deepEqual(grouped.payload.primary_key, [{ id: "group-a" }, { id: "group-b" }]);

    const zero = await rpc("mutate", {
      principal: app,
      sql: "UPDATE parents SET label = 'never' WHERE id = 'missing-row'",
    });
    assert.deepEqual(zero.auditEventIds, []);
    assert.equal((await auditPayloads(source)).length, 1);

    await rpc("mutate", {
      principal: app,
      sql: "INSERT INTO children (id, parent_id, value) VALUES ('group-child', 'group-a', 1)",
    });
    const auditCount = (await auditPayloads(source)).length;
    await assertRpcRejects("mutate", {
      principal: app,
      sql: "UPDATE parents SET id = 'group-renamed' WHERE id = 'group-a'",
    }, /GUARD_D2_PRIMARY_KEY_MUTATION|primary keys are immutable/i);
    assert.deepEqual(await queryRows(
      "SELECT id FROM parents WHERE id IN ('group-a', 'group-renamed') ORDER BY id",
    ), [{ id: "group-a" }]);
    assert.deepEqual(await queryRows(
      "SELECT id, parent_id FROM children WHERE id = 'group-child'",
    ), [{ id: "group-child", parent_id: "group-a" }]);
    assert.equal((await auditPayloads(source)).length, auditCount);
  });

  test("D2 schema admission rejects nullable or missing primary keys and accepts SQLite-safe forms", async () => {
    for (const ddl of [
      "CREATE TABLE rejected_nullable_pk (id TEXT PRIMARY KEY, value TEXT)",
      "CREATE TABLE rejected_missing_pk (id TEXT NOT NULL, value TEXT)",
      "CREATE TABLE rejected_composite_pk (a TEXT NOT NULL, b TEXT, PRIMARY KEY (a, b))",
      "CREATE TABLE rejected_desc_integer_pk (id INTEGER PRIMARY KEY DESC, value TEXT)",
    ]) {
      await assertRpcRejects("schema.apply", {
        principal: host,
        kind: "promote",
        ddl,
        approved: true,
      }, /GUARD_D2_PRIMARY_KEY|primary.?key/i);
    }
    assert.deepEqual(await queryRows(
      "SELECT name FROM sqlite_master WHERE name LIKE 'rejected_%' ORDER BY name",
    ), []);

    for (const ddl of [
      "CREATE TABLE accepted_integer_pk (id INTEGER PRIMARY KEY, value TEXT)",
      "CREATE TABLE accepted_not_null_pk (id TEXT PRIMARY KEY NOT NULL, value TEXT)",
      "CREATE TABLE accepted_strict_pk (id TEXT PRIMARY KEY, value TEXT) STRICT",
      "CREATE TABLE accepted_without_rowid_pk (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID",
    ]) {
      await rpc("schema.apply", {
        principal: host,
        kind: "promote",
        ddl,
        approved: true,
      });
    }
    assert.deepEqual(await queryRows(
      "SELECT name FROM sqlite_master WHERE name LIKE 'accepted_%' ORDER BY name",
    ), [
      { name: "accepted_integer_pk" },
      { name: "accepted_not_null_pk" },
      { name: "accepted_strict_pk" },
      { name: "accepted_without_rowid_pk" },
    ]);
  });

  test("schema methods are separately privileged and refresh CDC", async () => {
    const inspected = await rpc("schema.inspect", { principal: host });
    assert.ok(inspected.tables.some((table) => table.name === "events"));
    assert.ok(inspected.tables.some((table) => table.name === "parents"));
    await assertRpcRejects("schema.inspect", {
      principal: principal("app:no-inspect", []),
    }, /schema lifecycle capability/i);

    await assertRpcRejects("schema.plan", {
      principal: {
        source: "app:forged-schema",
        producerRef: TEST_PRODUCER_REF,
        tableGrants: [],
        schemaGrant: true,
      },
      kind: "promote",
      ddl: "CREATE TABLE forged_schema (id TEXT PRIMARY KEY NOT NULL)",
    }, /requires a system source/i);
    await assertRpcRejects("schema.plan", {
      principal: principal("app:no-schema", []),
      kind: "promote",
      ddl: "CREATE TABLE schema_denied (id TEXT PRIMARY KEY NOT NULL)",
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
      ddl: `CREATE TABLE forbidden_event_fk (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT REFERENCES events(id) ON DELETE CASCADE
      )`,
    }, /cannot reference system table events/i);

    const plan = await rpc("schema.plan", {
      principal: host,
      kind: "promote",
      ddl: "CREATE TABLE schema_created (id TEXT PRIMARY KEY NOT NULL, value TEXT)",
    });
    assert.equal(plan.kind, "promote");
    assert.ok(Array.isArray(plan.beforeSchema.tables));
    await rpc("schema.apply", {
      principal: host,
      kind: "promote",
      ddl: "CREATE TABLE schema_created (id TEXT PRIMARY KEY NOT NULL, value TEXT)",
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
        'CREATE TABLE "schema weird" (id TEXT PRIMARY KEY NOT NULL, value TEXT)',
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
      CREATE TRIGGER suppress_test_event
      BEFORE INSERT ON events
      WHEN NEW.source = 'system:suppressed'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
      CREATE TABLE parents (
        id TEXT PRIMARY KEY NOT NULL,
        label TEXT NOT NULL
      );
      CREATE TABLE children (
        id TEXT PRIMARY KEY NOT NULL,
        parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE ON UPDATE CASCADE,
        value INTEGER NOT NULL
      );
      CREATE TABLE trigger_source (
        id TEXT PRIMARY KEY NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE trigger_sink (
        id TEXT PRIMARY KEY NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TRIGGER mirror_trigger_source
      AFTER INSERT ON trigger_source
      BEGIN
        INSERT INTO trigger_sink (id, body) VALUES (NEW.id, NEW.body);
      END;
      CREATE TABLE blob_rows (
        id TEXT PRIMARY KEY NOT NULL,
        value BLOB NOT NULL
      );
      CREATE TABLE numeric_rows (
        id TEXT PRIMARY KEY NOT NULL,
        integer_value INTEGER NOT NULL,
        real_value REAL NOT NULL
      );
      CREATE TABLE max_rowid_rows (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE "Ä" (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE "ä" (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE "weird table" (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE drop_trigger_table (id TEXT PRIMARY KEY NOT NULL);
      CREATE TRIGGER drop_trigger_table_audit
      AFTER INSERT ON drop_trigger_table
      BEGIN
        SELECT NEW.id;
      END;
      CREATE TABLE demote_parent (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE demote_child (
        id TEXT PRIMARY KEY NOT NULL,
        parent_id TEXT NOT NULL REFERENCES demote_parent(id) ON DELETE CASCADE
      );
      CREATE INDEX demote_child_parent_idx ON demote_child(parent_id);
      CREATE TABLE wide_table (
        c0 TEXT PRIMARY KEY NOT NULL,
        ${Array.from({ length: 520 }, (_, index) => `c${index + 1} TEXT`).join(",\n")}
      );
      PRAGMA user_version = 1;
    `);
  } finally {
    db.close();
  }
}

function principal(source, tableGrants, producerRef = TEST_PRODUCER_REF) {
  return { source, producerRef, tableGrants, schemaGrant: false };
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
    "SELECT type, producer_ref, payload FROM events WHERE source = ? AND type LIKE 'workspace.table.rows.%' ORDER BY created_at, rowid",
    [source],
  );
  return rows.map((row) => ({
    type: row.type,
    producerRef: row.producer_ref,
    payload: JSON.parse(row.payload),
  }));
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
