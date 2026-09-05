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
import { TEST_PRODUCER_REF } from "./support/test-guard";

const CONNECTOR_PRODUCER_REF = `producer:v1:sha256:${"2".repeat(64)}`;
const APP_PRODUCER_REF = `producer:v1:sha256:${"3".repeat(64)}`;

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
    if (method === "writeEvent" || method === "writeLifecycleEvent" || method === "writeWorkspaceEvent") return "event-id" as T;
    if (method === "schema.plan") {
      return {
        ddl: ["CREATE TABLE focus (id TEXT PRIMARY KEY NOT NULL)"],
        beforeSchema: { tables: [], indexes: [] },
        afterSchema: { tables: [], indexes: [] },
      } as T;
    }
    if (method === "schema.apply") return { ok: true } as T;
    throw new Error(`Unexpected method: ${method}`);
  }

  async health(): Promise<void> {}
}

function createGuard(rpc: FakeRpc, binding?: Partial<GuardBinding>): RemoteGuard {
  return new RemoteGuard(rpc as unknown as GuardRpcClient, {
    source: "system:server",
    producerRef: TEST_PRODUCER_REF,
    writeTables: null,
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
        activationId: `activation_${"d".repeat(32)}`,
        manifestDigest: `sha256:${"a".repeat(64)}`,
        packageDigest: `sha256:${"c".repeat(64)}`,
        appCommit: "a".repeat(40),
        writeTables: [],
        fileGrants: [],
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

  test("source rebinding drops schema authority and serializes only D2 grants", async () => {
    const rpc = new FakeRpc();
    const connector = createGuard(rpc).withSource("connector:calendar", {
      producerRef: CONNECTOR_PRODUCER_REF,
    });

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
          producerRef: CONNECTOR_PRODUCER_REF,
          tableGrants: [],
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

  test("publishes the bound descriptor before D0-producing calls but not queries", async () => {
    const rpc = new FakeRpc();
    const callsObservedDuringPrepare: number[] = [];
    const guard = createGuard(rpc, {
      prepareProducer: () => {
        callsObservedDuringPrepare.push(rpc.calls.length);
      },
    });

    await guard.query("SELECT 1");
    expect(callsObservedDuringPrepare).toEqual([]);
    await guard.writeWorkspaceEvent({
      type: "workspace.files.changed",
      startedAt: 1,
      payload: { changes: [] },
    });

    expect(callsObservedDuringPrepare).toEqual([1]);
    expect(rpc.calls.map((call) => call.method)).toEqual(["query", "writeWorkspaceEvent"]);
  });

  test("plans and applies one exact schema-change contract without caller classification", async () => {
    const rpc = new FakeRpc();
    const guard = createGuard(rpc);
    const plan = await guard.schemaPlan("CREATE TABLE focus (id TEXT PRIMARY KEY NOT NULL)");
    await guard.applySchemaPlan(plan, {
      approved: true,
      author: "codex",
      context: "Add focus storage.",
      eventPrincipal: { source: "app:focus:ui", producerRef: APP_PRODUCER_REF },
    });

    expect(rpc.calls).toEqual([
      {
        method: "schema.plan",
        params: {
          principal: {
            source: "system:server",
            producerRef: TEST_PRODUCER_REF,
            tableGrants: "*",
            schemaGrant: true,
          },
          ddl: "CREATE TABLE focus (id TEXT PRIMARY KEY NOT NULL)",
        },
      },
      {
        method: "schema.apply",
        params: {
          principal: {
            source: "system:server",
            producerRef: TEST_PRODUCER_REF,
            tableGrants: "*",
            schemaGrant: true,
          },
          plan,
          approved: true,
          author: "codex",
          context: "Add focus storage.",
          eventPrincipal: { source: "app:focus:ui", producerRef: APP_PRODUCER_REF },
        },
      },
    ]);
  });

  test("App grants are concrete arrays and queryOne stays a client helper", async () => {
    const rpc = new FakeRpc();
    const app = createGuard(rpc).withSource("app:focus", {
      producerRef: APP_PRODUCER_REF,
      writeTables: ["focus_sessions"],
      schemaGrant: false,
    });

    expect(await app.queryOne("SELECT id FROM focus_sessions LIMIT 1")).toEqual({ id: "first" });
    expect(rpc.calls[0].params.principal).toEqual({
      source: "app:focus",
      producerRef: APP_PRODUCER_REF,
      tableGrants: ["focus_sessions"],
      schemaGrant: false,
    });
  });

  test("forwards the Host-selected abort signal and bounded execution deadline", async () => {
    const rpc = new FakeRpc();
    const controller = new AbortController();
    const app = createGuard(rpc).withSource("app:focus", {
      producerRef: APP_PRODUCER_REF,
      writeTables: ["focus_sessions"],
      signal: controller.signal,
      deadlineMs: 1234,
    });

    await app.query("SELECT 1");
    expect(rpc.executionOptions[0]).toEqual({ signal: controller.signal, deadlineMs: 1234 });
  });
});
