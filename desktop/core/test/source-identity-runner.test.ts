import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  InProcessRunnerSession,
  ProcessRunnerSession,
  type RunnerCapabilities,
} from "../src/connectors/process-runner";
import { validateConnectorDefinition } from "../src/connectors/runtime";
import type { ConnectorDefinition } from "../src/connectors/types";

const runnerEntry = process.env.LAMARCK_CONNECTOR_RUNNER_ENTRY!;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Connector source identity runner contract", () => {
  test("cross-validates source identity kind and resolver export shape", () => {
    const withoutResolver: ConnectorDefinition = { async run() {} };
    const withResolver: ConnectorDefinition = {
      async run() {},
      async resolveSourceIdentity() {
        return { key: "account-1" };
      },
    };

    expect(() => validateConnectorDefinition(withoutResolver, "connector"))
      .toThrow("requires a resolveSourceIdentity");
    expect(() => validateConnectorDefinition(withResolver, "single"))
      .toThrow("forbids a resolveSourceIdentity");
    expect(() => validateConnectorDefinition(withResolver, "device"))
      .toThrow("forbids a resolveSourceIdentity");
    expect(() => validateConnectorDefinition(withResolver, "connector")).not.toThrow();
    expect(() => validateConnectorDefinition({
      ...withoutResolver,
      resolveSourceIdentity: true,
    } as unknown as ConnectorDefinition)).toThrow("must be a function");
  });

  test("enforces the manifest-definition cross-field when a child package loads", async () => {
    const cases = [
      {
        kind: "connector" as const,
        source: "export default { async run() {} };\n",
        error: "requires a resolveSourceIdentity",
      },
      {
        kind: "single" as const,
        source: `export default {
  async run() {},
  async resolveSourceIdentity() { return { key: "forbidden" }; },
};
`,
        error: "forbids a resolveSourceIdentity",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const cwd = temporaryDirectory();
      const entryPath = join(cwd, "connector.mjs");
      writeFileSync(entryPath, testCase.source);
      const session = new ProcessRunnerSession({
        entryPath,
        contentHash: `cross-field-${index}`,
        cwd,
        connectorId: `cross-field-${index}`,
        sourceIdentityKind: testCase.kind,
        runnerEntryPath: runnerEntry,
      });
      await expect(session.open()).rejects.toThrow(testCase.error);
      await session.close();
    }
  });

  test("gives in-process resolvers only config, auth, connector id, and signal", async () => {
    const controller = new AbortController();
    const definition: ConnectorDefinition<{ region: string }> = {
      async run() {},
      async resolveSourceIdentity(context) {
        expect(Object.keys(context).sort()).toEqual([
          "auth",
          "config",
          "connectorId",
          "signal",
        ]);
        expect(context.connectorId).toBe("managed-account");
        expect(context.config).toEqual({ region: "tw" });
        expect(context.signal).toBe(controller.signal);
        expect(context.auth).toMatchObject({
          type: "managedProvider",
          providerOrigin: "https://api.example.test",
        });
        if (context.auth.type !== "managedProvider") throw new Error("expected managed auth");
        return {
          key: await context.auth.getToken(),
          label: context.auth.providerOrigin,
        };
      },
    };
    const session = new InProcessRunnerSession(definition);

    await expect(session.resolveSourceIdentity({
      connectorId: "managed-account",
      config: { region: "tw" },
      signal: controller.signal,
      capabilities: {
        authType: "managedProvider",
        providerOrigin: "https://api.example.test",
        authGetToken: async () => "account-1",
      },
    })).resolves.toEqual({
      key: "account-1",
      label: "https://api.example.test",
    });
  });

  test("carries providerOrigin on run and enforces the auth cross-field", async () => {
    const seen: unknown[] = [];
    const session = new InProcessRunnerSession({
      async run({ auth }) {
        seen.push(auth);
      },
    });
    const capabilities = runCapabilities({
      authType: "managedProvider",
      providerOrigin: "https://api.example.test",
    });

    await session.run({
      config: undefined,
      host: { workspacePath: "/workspace" },
      signal: new AbortController().signal,
      capabilities,
    });
    expect(seen).toEqual([
      expect.objectContaining({
        type: "managedProvider",
        providerOrigin: "https://api.example.test",
      }),
    ]);

    await expect(session.run({
      config: undefined,
      host: { workspacePath: "/workspace" },
      signal: new AbortController().signal,
      capabilities: runCapabilities({ authType: "managedProvider" }),
    })).rejects.toThrow("requires providerOrigin");
    await expect(session.run({
      config: undefined,
      host: { workspacePath: "/workspace" },
      signal: new AbortController().signal,
      capabilities: runCapabilities({
        authType: "apiKey",
        providerOrigin: "https://api.example.test",
      }),
    })).rejects.toThrow("only valid for managedProvider");
  });

  test("resolves in the child runner and rejects every non-auth RPC", async () => {
    const cwd = temporaryDirectory();
    const entryPath = join(cwd, "connector.mjs");
    writeFileSync(entryPath, `
export default {
  async run() {},
  async resolveSourceIdentity(context) {
    const fields = Object.keys(context).sort().join(",");
    if (fields !== "auth,config,connectorId,signal") {
      throw new Error("identity context exposed excess authority: " + fields);
    }
    if (context.connectorId !== "child-identity") throw new Error("wrong connector id");
    if (context.auth.type !== "managedProvider") throw new Error("wrong auth type");
    if (context.auth.providerOrigin !== "https://api.example.test") {
      throw new Error("missing provider origin");
    }
    const token = await context.auth.getToken();
    const denied = await new Promise((resolve) => {
      const id = 9001;
      const onMessage = (message) => {
        if (message?.type !== "rpc-result" || message.id !== id) return;
        process.off("message", onMessage);
        resolve(message);
      };
      process.on("message", onMessage);
      process.send({
        type: "rpc",
        id,
        method: "writeEvent",
        params: { type: "must-not-write" },
      });
    });
    if (denied.ok) throw new Error("writeEvent unexpectedly available during identity resolution");
    return { key: token, label: denied.error };
  },
};
`);
    const session = new ProcessRunnerSession({
      entryPath,
      contentHash: "source-identity-test",
      cwd,
      connectorId: "child-identity",
      sourceIdentityKind: "connector",
      runnerEntryPath: runnerEntry,
    });

    try {
      await session.open();
      const result = await session.resolveSourceIdentity({
        connectorId: "child-identity",
        config: { region: "tw" },
        signal: new AbortController().signal,
        capabilities: {
          authType: "managedProvider",
          providerOrigin: "https://api.example.test",
          authGetToken: async () => "account-7",
        },
      });
      expect(result.key).toBe("account-7");
      expect(result.label).toContain("unavailable: writeEvent");
    } finally {
      await session.close();
    }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lamarck-source-identity-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCapabilities(
  auth: Pick<RunnerCapabilities, "authType" | "providerOrigin">,
): RunnerCapabilities {
  return {
    ...auth,
    authGetToken: async () => "token",
    writeEvent: async () => undefined,
    writeEvents: async () => undefined,
    writeTextBlob: async () => undefined,
    stateGet: async () => undefined,
    stateSet: async () => {},
    warningSet: async () => {},
    warningClear: async () => {},
  };
}
