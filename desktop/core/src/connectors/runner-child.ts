// runner-child — the connector runner process entrypoint.
//
// Spawned by ProcessRunnerSession with IPC. Imports exactly one trusted
// connector package (trust was verified by the host before spawning), runs
// requirement handlers and run(context) on command, and proxies every
// capability call (guard/state/auth) back to the host over RPC. The child has
// no database handle, no Guard, and no secrets — only what the host serves.

import { pathToFileURL } from "url";
import { validateConnectorDefinition } from "./runtime";
import type { ConnectorConfigPatch, ConnectorDefinition, ConnectorRequirementStatus } from "./types";
import type { HostToRunnerMessage, RunnerRpcMethod, RunnerToHostMessage } from "./runner-protocol";

let definition: ConnectorDefinition | undefined;
const abortController = new AbortController();

let rpcSeq = 0;
const rpcPending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();

function send(message: RunnerToHostMessage): void {
  process.send?.(message);
}

function rpc<T>(method: RunnerRpcMethod, params?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++rpcSeq;
    rpcPending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    send({ type: "rpc", id, method, params });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handleMessage(msg: HostToRunnerMessage): Promise<void> {
  switch (msg.type) {
    case "load": {
      try {
        const url = pathToFileURL(msg.entryPath);
        url.searchParams.set("hash", msg.contentHash);
        const mod = await import(url.href);
        const candidate = (mod.default ?? mod.connector) as ConnectorDefinition;
        validateConnectorDefinition(candidate);
        definition = candidate;
        send({
          type: "loaded",
          requirementIds: Object.keys(definition.requirements ?? {}),
        });
      } catch (err) {
        send({ type: "load-error", message: errorMessage(err) });
      }
      return;
    }

    case "check": {
      const records: Record<string, ConnectorRequirementStatus | null> = {};
      for (const id of msg.ids) {
        const handler = definition?.requirements?.[id];
        if (!handler) {
          records[id] = null;
          continue;
        }
        try {
          records[id] = await handler.check(msg.ctx);
        } catch (err) {
          records[id] = { status: "error", message: errorMessage(err) };
        }
      }
      send({ type: "checked", records });
      return;
    }

    case "request": {
      const handler = definition?.requirements?.[msg.id];
      if (!handler) {
        send({ type: "requested", status: null });
        return;
      }
      try {
        const status = handler.request ? await handler.request(msg.ctx) : await handler.check(msg.ctx);
        send({ type: "requested", status });
      } catch (err) {
        send({ type: "requested", status: { status: "error", message: errorMessage(err) } });
      }
      return;
    }

    case "run": {
      if (!definition) {
        send({ type: "run-error", message: "Connector runner has no loaded definition" });
        return;
      }
      try {
        await definition.run({
          guard: {
            writeEvent: (event) => rpc("writeEvent", event),
            writeEvents: (events) => rpc("writeEvents", events),
            writeTextBlob: (input) => rpc("writeTextBlob", input),
          },
          state: {
            get: () => rpc("stateGet"),
            set: (value) => rpc<void>("stateSet", value),
          },
          warnings: {
            set: (warning) => rpc<void>("warningSet", warning),
            clear: (key) => rpc<void>("warningClear", key),
          },
          auth: msg.authType === "none"
            ? { type: "none" }
            : {
              type: msg.authType as "apiKey" | "oauth2" | "managedProvider",
              getToken: () => rpc<string>("authGetToken"),
            },
          config: msg.configSet ? msg.config : undefined,
          host: msg.host,
          signal: abortController.signal,
        });
        send({ type: "done" });
      } catch (err) {
        send({ type: "run-error", message: errorMessage(err) });
      }
      return;
    }

    case "configUi": {
      if (!definition) {
        send({ type: "config-ui-error", message: "Connector runner has no loaded definition" });
        return;
      }
      if (!definition.configUi) {
        send({ type: "config-ui-error", message: "Connector does not implement configUi(context)" });
        return;
      }
      try {
        const result = await definition.configUi({
          panelId: msg.panelId,
          config: msg.configSet ? msg.config : undefined,
          configStore: {
            get: () => rpc("configGet"),
            replace: (config) => rpc<void>("configReplace", config),
            patch: (patch: ConnectorConfigPatch) => rpc("configPatch", patch),
          },
          state: {
            get: () => rpc("stateGet"),
            set: (state) => rpc<void>("stateSet", state),
          },
          host: msg.host,
          signal: abortController.signal,
        });
        send({ type: "config-ui-ready", url: result.url });
      } catch (err) {
        send({ type: "config-ui-error", message: errorMessage(err) });
      }
      return;
    }

    case "abort": {
      abortController.abort();
      return;
    }

    case "rpc-result": {
      const pending = rpcPending.get(msg.id);
      if (!pending) return;
      rpcPending.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.value);
      } else {
        pending.reject(new Error(msg.error ?? "Connector capability call failed"));
      }
      return;
    }
  }
}

process.on("message", (msg) => {
  void handleMessage(msg as HostToRunnerMessage).catch((err) => {
    console.error("[connector-runner] unhandled error:", err);
  });
});

process.once("disconnect", () => {
  // The Core process is the sole capability broker. If it disappears, this
  // child must not survive as an orphaned connector/config-panel process.
  abortController.abort();
  setImmediate(() => process.exit(0));
});

send({ type: "hello" });
