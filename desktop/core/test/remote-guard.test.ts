import { describe, expect, test } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  APP_CAPABILITY_HEADER,
  AppCapabilityRegistry,
  admitRequest,
} from "../src/auth";
import {
  GuardRpcClient,
  RemoteGuard,
  type GuardBinding,
  type GuardExecutionOptions,
} from "../src/remote-guard";

const STALE_HASH = "0".repeat(64);
const MATCH_HASH = "1".repeat(64);
const STALE_UPDATED_AT = 100;
const MATCH_UPDATED_AT = 101;

class FakeRpc {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  executionOptions: GuardExecutionOptions[] = [];

  async call<T>(
    method: string,
    params: Record<string, unknown>,
    options: GuardExecutionOptions,
  ): Promise<T> {
    this.calls.push({ method, params });
    this.executionOptions.push(options);
    if (method === "query") return [{ id: "first" }] as T;
    if (method === "writeEvent") return "event-id" as T;
    if (method === "writeDoc") return { ok: true } as T;
    if (method === "listLockedDocHashesForWorkingTree") {
      return [{ id: "private/one", contentHash: MATCH_HASH }] as T;
    }
    if (method === "compareAndWriteDoc" || method === "compareAndDeleteDoc") {
      return (
        params.expectedHash === MATCH_HASH
        && params.expectedUpdatedAt === MATCH_UPDATED_AT
      ) as T;
    }
    throw new Error(`Unexpected method: ${method}`);
  }

  async health(): Promise<void> {}
}

function createGuard(rpc: FakeRpc, binding?: Partial<GuardBinding>): RemoteGuard {
  return new RemoteGuard(rpc as unknown as GuardRpcClient, {
    source: "system:server",
    writeTables: null,
    docGrants: null,
    schemaGrant: true,
    ...binding,
  });
}

describe("RemoteGuard capability binding", () => {
  test("capability revocation sends an authenticated out-of-band Guard cancellation", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/cancel")) {
        return Promise.resolve(new Response(JSON.stringify({ cancelled: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }) as typeof fetch;

    let releaseAdmission: (() => void) | undefined;
    try {
      const registry = new AppCapabilityRegistry();
      const issued = registry.issue("focus", "ui", {
        manifestGeneration: 1,
        writeTables: [],
        docGrants: [],
      });
      const admission = admitRequest(new Request("http://localhost/api/query", {
        headers: { [APP_CAPABILITY_HEADER]: issued.capability },
      }), { coreToken: "core-token" }, registry);
      if (!admission) throw new Error("Expected App admission");
      releaseAdmission = admission.release;
      const client = new GuardRpcClient("http://guard.test", "guard-token");
      const operation = client.call("query", { sql: "SELECT 1" }, {
        signal: admission.signal,
        deadlineMs: 5000,
      });
      const revocation = registry.revoke(issued.channelId);
      expect(admission.signal.aborted).toBe(true);
      await expect(operation).rejects.toThrow("App capability was revoked");
      await delay(0);

      expect(calls).toHaveLength(2);
      const requestBody = JSON.parse(String(calls[0].init?.body));
      const cancelBody = JSON.parse(String(calls[1].init?.body));
      expect(requestBody.deadlineMs).toBe(5000);
      expect(cancelBody.id).toBe(requestBody.id);
      expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe("Bearer guard-token");
      admission.release();
      releaseAdmission = undefined;
      await expect(revocation).resolves.toBe(true);
    } finally {
      releaseAdmission?.();
      globalThis.fetch = originalFetch;
    }
  });

  test("source rebinding drops schema authority and serializes the principal", async () => {
    const rpc = new FakeRpc();
    const connector = createGuard(rpc).withSource("connector:calendar");

    await connector.writeEvent({
      type: "calendar.item",
      externalId: "one",
      startedAt: 1,
      payload: {},
    });

    expect(rpc.calls[0]).toEqual({
      method: "writeEvent",
      params: {
        principal: {
          source: "connector:calendar",
          tableGrants: [],
          docGrants: "*",
          schemaGrant: false,
        },
        event: {
          type: "calendar.item",
          externalId: "one",
          startedAt: 1,
          payload: {},
        },
      },
    });
  });

  test("app grants are concrete arrays and queryOne stays a client helper", async () => {
    const rpc = new FakeRpc();
    const app = createGuard(rpc).withSource("app:focus", {
      writeTables: ["focus_sessions"],
      docGrants: ["apps/focus/"],
      schemaGrant: false,
    });

    expect(await app.queryOne("SELECT id FROM focus_sessions LIMIT 1")).toEqual({ id: "first" });
    expect(rpc.calls[0]).toEqual({
      method: "query",
      params: {
        principal: {
          source: "app:focus",
          tableGrants: ["focus_sessions"],
          docGrants: ["apps/focus/"],
          schemaGrant: false,
        },
        sql: "SELECT id FROM focus_sessions LIMIT 1",
        params: undefined,
      },
    });
  });

  test("forwards the Host-selected abort signal and bounded execution deadline", async () => {
    const rpc = new FakeRpc();
    const controller = new AbortController();
    const app = createGuard(rpc).withSource("app:focus", {
      writeTables: ["focus_sessions"],
      docGrants: [],
      signal: controller.signal,
      deadlineMs: 1234,
    });

    await app.query("SELECT 1");
    expect(rpc.executionOptions[0]).toEqual({
      signal: controller.signal,
      deadlineMs: 1234,
    });
  });

  test("doc materialization failures do not turn a committed RPC into failure", async () => {
    const rpc = new FakeRpc();
    const guard = createGuard(rpc);
    guard.onDocChange = async () => {
      throw new Error("filesystem unavailable");
    };

    const originalError = console.error;
    console.error = () => {};
    try {
      await expect(guard.writeDoc("notes/one", "saved")).resolves.toBeUndefined();
      await delay(0);
    } finally {
      console.error = originalError;
    }
    expect(rpc.calls[0].method).toBe("writeDoc");
  });

  test("conditional doc helpers forward expectations and notify only after success", async () => {
    const rpc = new FakeRpc();
    const guard = createGuard(rpc);
    const materialized: Array<[string, string | null]> = [];
    const notified: string[] = [];
    guard.onDocChange = (id, content) => { materialized.push([id, content]); };
    guard.docChangeSubscribers.push((id) => notified.push(id));

    await expect(guard.compareAndWriteDoc(
      "notes/one",
      STALE_HASH,
      STALE_UPDATED_AT,
      "must-not-notify",
      { label: "draft" },
    )).resolves.toBe(false);
    await expect(guard.compareAndWriteDoc(
      "notes/one",
      MATCH_HASH,
      MATCH_UPDATED_AT,
      "saved",
      { label: "draft" },
    )).resolves.toBe(true);
    await expect(guard.compareAndDeleteDoc(
      "notes/one",
      STALE_HASH,
      STALE_UPDATED_AT,
    )).resolves.toBe(false);
    await expect(guard.compareAndDeleteDoc(
      "notes/one",
      MATCH_HASH,
      MATCH_UPDATED_AT,
    )).resolves.toBe(true);

    expect(rpc.calls).toEqual([
      {
        method: "compareAndWriteDoc",
        params: {
          principal: {
            source: "system:server",
            tableGrants: "*",
            docGrants: "*",
            schemaGrant: true,
          },
          id: "notes/one",
          expectedHash: STALE_HASH,
          expectedUpdatedAt: STALE_UPDATED_AT,
          content: "must-not-notify",
          metadata: { label: "draft" },
        },
      },
      {
        method: "compareAndWriteDoc",
        params: {
          principal: {
            source: "system:server",
            tableGrants: "*",
            docGrants: "*",
            schemaGrant: true,
          },
          id: "notes/one",
          expectedHash: MATCH_HASH,
          expectedUpdatedAt: MATCH_UPDATED_AT,
          content: "saved",
          metadata: { label: "draft" },
        },
      },
      {
        method: "compareAndDeleteDoc",
        params: {
          principal: {
            source: "system:server",
            tableGrants: "*",
            docGrants: "*",
            schemaGrant: true,
          },
          id: "notes/one",
          expectedHash: STALE_HASH,
          expectedUpdatedAt: STALE_UPDATED_AT,
        },
      },
      {
        method: "compareAndDeleteDoc",
        params: {
          principal: {
            source: "system:server",
            tableGrants: "*",
            docGrants: "*",
            schemaGrant: true,
          },
          id: "notes/one",
          expectedHash: MATCH_HASH,
          expectedUpdatedAt: MATCH_UPDATED_AT,
        },
      },
    ]);
    expect(materialized).toEqual([
      ["notes/one", "saved"],
      ["notes/one", null],
    ]);
    expect(notified).toEqual(["notes/one", "notes/one"]);
  });

  test("forwards the private paged locked-document hash request", async () => {
    const rpc = new FakeRpc();
    const guard = createGuard(rpc);

    await expect(guard.listLockedDocHashesForWorkingTree("private/zero", 128)).resolves.toEqual([
      { id: "private/one", contentHash: MATCH_HASH },
    ]);
    expect(rpc.calls).toEqual([{
      method: "listLockedDocHashesForWorkingTree",
      params: {
        principal: {
          source: "system:server",
          tableGrants: "*",
          docGrants: "*",
          schemaGrant: true,
        },
        afterId: "private/zero",
        limit: 128,
      },
    }]);
  });
});
