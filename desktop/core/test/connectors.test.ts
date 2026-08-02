import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { gunzipSync, gzipSync } from "node:zlib";
import { ContentBlobStore } from "../src/blob-store";
import { openTestDatabases as openDatabases } from "./support/test-databases";
import { TestGuard as Guard } from "./support/test-guard";
import {
  ConnectorScheduler,
  ConnectorSupervisor,
  ConnectorAuthManager,
  hashConnectorPackage,
  installConnector,
  listInstalledConnectorDirs,
  installConnectorFromSource,
  isPlatformSupported,
  listAvailableBuiltIns,
  loadConnectorEventCatalog,
  loadConnectorManifest,
  materializeBuiltInConnector,
  registerWorkspaceConnectors,
  removeConnectorFromWorkspace,
  removeInstalledConnector,
  resolveConnectorEntry,
  sourceForConnector,
  updateConnectorFromSource,
  validateConnectorDefinition,
  validateConnectorEventCatalog,
  validateConnectorManifest,
  nextCronRunAt,
  type ConnectorDefinition,
  type ConnectorManifest,
} from "../src/connectors";
import { defaultAuthRef } from "../src/connectors/state";
import { MemorySecretStore } from "../src/credentials";

const TEST_EVENT_CATALOG = {
  catalogVersion: 1,
  eventTypes: {
    "test.event": {
      description: "A test event.",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: {
            type: "string",
            description: "Test value.",
          },
        },
      },
    },
  },
} as const;

function writeTestEventCatalog(connectorDir: string): void {
  writeFileSync(
    join(connectorDir, "events.json"),
    `${JSON.stringify(TEST_EVENT_CATALOG, null, 2)}\n`,
  );
}

function writeConnectorManifestFixture(path: string, contents: string): void {
  writeFileSync(path, contents);
  writeTestEventCatalog(dirname(path));
}

const telegramBotApiReference = JSON.parse(readFileSync(
  new URL("../../template/connectors/telegram-bot/api-reference.json", import.meta.url),
  "utf8",
)) as {
  schemaVersion: number;
  provider: string;
  api: string;
  transport: string;
  compatibility: {
    minimumVersion: string;
    testedAgainstVersion: string;
    testedAgainstReleaseDate: string;
    versionPolicy: string;
  };
  references: {
    documentation: string;
    changelog: string;
    testedAgainstRelease: string;
  };
  methods: string[];
  updateTypes: string[];
};

async function waitWithTestTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function contentBlobPath(workspace: string, digestHex: string): string {
  return join(
    workspace,
    ".lamarck",
    "blobs",
    "content",
    "v1",
    "sha256",
    digestHex.slice(0, 2),
    digestHex.slice(2, 4),
    `${digestHex}.gz`,
  );
}

function writeSyntheticContentBlob(workspace: string, digestHex: string, bytes: Buffer): void {
  const path = contentBlobPath(workspace, digestHex);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

describe("Connector system", () => {
  let workspace: string;
  let dataDb: ReturnType<typeof openDatabases>["dataDb"];
  let systemDb: ReturnType<typeof openDatabases>["systemDb"];
  let close: () => void;
  let supervisor: ConnectorSupervisor;
  let secrets: MemorySecretStore;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-connector-test-"));
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
    const result = openDatabases(workspace);
    dataDb = result.dataDb;
    systemDb = result.systemDb;
    close = result.close;
    secrets = new MemorySecretStore();
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager: new ConnectorAuthManager(secrets),
    });
  });

  afterEach(() => {
    close();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("loads and validates a connector manifest from YAML", async () => {
    const dir = join(workspace, "connectors", "calendar");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: calendar
name: Calendar
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
source:
  identity: connector
configPanels:
  privacy-controls:
    label: Privacy Controls
    description: Configure privacy policy
platforms:
  darwin:
    requirements:
      - macos-accessibility
  cloud: {}
auth:
  type: oauth2-public
  authorizationEndpoint: https://accounts.google.com/o/oauth2/v2/auth
  tokenEndpoint: https://oauth2.googleapis.com/token
  clientId: calendar-client-id
  scope:
    - https://www.googleapis.com/auth/calendar.readonly
`,
    );

    const manifest = await loadConnectorManifest(dir);
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: "calendar",
      name: "Calendar",
      description: "Test connector manifest.",
      eventCatalog: "./events.json",
      entry: "./index.mjs",
	      runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
	      source: { identity: "connector" },
	      configPanels: {
	        "privacy-controls": {
	          label: "Privacy Controls",
	          description: "Configure privacy policy",
	        },
	      },
	      platforms: {
        darwin: { requirements: ["macos-accessibility"] },
        cloud: { requirements: [] },
      },
      auth: {
        type: "oauth2-public",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: "calendar-client-id",
        scope: ["https://www.googleapis.com/auth/calendar.readonly"],
      },
    });
    expect(await loadConnectorEventCatalog(dir, manifest)).toMatchObject(TEST_EVENT_CATALOG);
  });

  test("rejects a symlinked Connector manifest", async () => {
    const connectorDir = join(workspace, "connectors", "linked-manifest");
    const externalManifest = join(workspace, "external-connector.yaml");
    mkdirSync(connectorDir, { recursive: true });
    writeFileSync(
      externalManifest,
      `manifestVersion: 1
id: linked-manifest
name: Linked Manifest
description: A Connector whose manifest is stored outside its package.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
auth:
  type: none
`,
    );
    symlinkSync(externalManifest, join(connectorDir, "connector.yaml"), "file");

    await expect(loadConnectorManifest(connectorDir)).rejects.toThrow(
      "Connector manifest must not be a symlink",
    );
  });

  test("keeps bundled Connector templates valid under the V1 package contract", async () => {
    const templatesDir = fileURLToPath(new URL("../../template/connectors", import.meta.url));
    const rejected: string[] = [];
    const available = await listAvailableBuiltIns(templatesDir, (dir) => rejected.push(basename(dir)));

    expect(available.map(({ manifest }) => manifest.id).sort()).toEqual([
      "local-git",
      "macos-ax",
      "oura",
      "telegram-bot",
    ]);
    // The manifest gate is what keeps a parked package out of the catalog; no
    // package is excluded by name. These two still declare the retired
    // `integrations` block and cannot be revived until they declare a Source
    // identity.
    expect(rejected.sort()).toEqual(["app-commits", "code-agent-transcripts"]);
    for (const entry of available) {
      const catalog = await loadConnectorEventCatalog(entry.dir, entry.manifest);
      expect(Object.keys(catalog.eventTypes).length).toBeGreaterThan(0);
    }
  });

  test("rejects invalid manifest ids, modes, schedules, auth, and platforms", () => {
    const base: ConnectorManifest = {
      manifestVersion: 1,
      id: "demo",
      name: "Demo",
      description: "Test connector manifest.",
      eventCatalog: "./events.json",
      entry: "./index.ts",
      runtime: { mode: "poll" },
      source: { identity: "single" },
    };

    expect(() => validateConnectorManifest({ ...base, id: "../demo" })).toThrow("Invalid connector id");
    expect(() =>
      validateConnectorManifest({ ...base, source: undefined as any })
    ).toThrow("requires an explicit source.identity");
    for (const identity of ["single", "device", "connector"] as const) {
      expect(validateConnectorManifest({ ...base, source: { identity } }).source).toEqual({
        identity,
      });
    }
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "stream" as any } })
    ).toThrow("invalid runtime mode");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "watch", defaultSchedule: "every 1m" } })
    ).toThrow("defaultSchedule is only valid");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "poll", defaultSchedule: "every 1m" } })
    ).toThrow("Unsupported connector schedule");
    expect(() =>
      validateConnectorManifest({ ...base, runtime: { mode: "poll", schedule: "every 1m" } as any })
    ).toThrow("unknown field: schedule");
    expect(() =>
      validateConnectorManifest({ ...base, platforms: ["darwin" as any] as any })
    ).toThrow("structured object");
    expect(() =>
      validateConnectorManifest({ ...base, platforms: { haiku: {} } as any })
    ).toThrow("invalid platform");
	    expect(() =>
	      validateConnectorManifest({ ...base, source: { identity: "many" as any } })
	    ).toThrow("invalid source identity");
	    expect(() =>
	      validateConnectorManifest({ ...base, configPanels: [] as any })
	    ).toThrow("configPanels must be a map");
	    expect(() =>
	      validateConnectorManifest({ ...base, configPanels: { "../panel": { label: "Panel" } } as any })
	    ).toThrow("invalid id");
	    expect(() =>
	      validateConnectorManifest({ ...base, configPanels: { panel: { label: "" } } as any })
	    ).toThrow("requires a label");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "oauth2",
          authorizationEndpoint: "https://x/auth",
          tokenEndpoint: "https://x/token",
          clientId: "cid",
        } as any,
      })
    ).toThrow("invalid auth type");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: { type: "oauth2-public", tokenEndpoint: "https://x/token", clientId: "cid" } as any,
      })
    ).toThrow("requires authorizationEndpoint");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: { type: "oauth2-public", authorizationEndpoint: {}, tokenEndpoint: "https://x/token", clientId: "cid" } as any,
      })
    ).toThrow("requires authorizationEndpoint");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: { type: "oauth2-public", authorizationEndpoint: "http://x/auth", tokenEndpoint: "https://x/token", clientId: "cid" } as any,
      })
    ).toThrow("must be https");
    expect(
      validateConnectorManifest({
        ...base,
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://x/auth",
          tokenEndpoint: "https://x/token",
          clientId: "cid",
        },
      }).auth,
    ).toMatchObject({ type: "oauth2-public", clientId: "cid" });
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: { type: "oauth2-public", authorizationEndpoint: "https://x/auth", tokenEndpoint: "https://x/token", clientId: "" } as any,
      })
    ).toThrow("requires clientId");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://x/auth",
          tokenEndpoint: "https://x/token",
          clientId: "cid",
          tokenEndpointAuthMethod: "client_secret_post",
        } as any,
      })
    ).toThrow("unknown field: tokenEndpointAuthMethod");
    expect(
      validateConnectorManifest({
        ...base,
        auth: {
          type: "managedProvider",
          providerId: "oura",
        },
      }).auth,
    ).toMatchObject({ type: "managedProvider", providerId: "oura" });
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "managedProvider",
          providerId: "",
        } as any,
      })
    ).toThrow("requires a valid providerId");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "managedProvider",
          providerId: "oura",
          connectEndpoint: "https://app.lamarck.ai/providers/oura/connect",
        } as any,
      })
    ).toThrow("unknown field: connectEndpoint");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "managedProvider",
          providerId: "oura",
          scope: ["daily"],
        } as any,
      })
    ).toThrow("unknown field: scope");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "managedProvider",
          providerId: "oura",
          authorizationEndpoint: "https://x/auth",
        } as any,
      })
    ).toThrow("unknown field: authorizationEndpoint");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "managedProvider",
          providerId: "oura",
          tokenEndpointAuthMethod: "client_secret_post",
        } as any,
      })
    ).toThrow("unknown field: tokenEndpointAuthMethod");
    expect(() =>
      validateConnectorManifest({
        ...base,
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://x/auth",
          tokenEndpoint: "https://x/token",
          clientId: "cid",
          scope: "read" as any,
        },
      })
    ).toThrow("scope must be an array of strings");
    expect(() =>
      validateConnectorManifest({ ...base, auth: { type: "localPermission" } as any })
    ).toThrow("invalid auth type");

    // Config schema: a valid map of fields is accepted and normalized.
    expect(
      validateConnectorManifest({
        ...base,
        config: { interval: { type: "number", label: "Interval (ms)", default: 5000 } },
      }).config,
    ).toEqual({ interval: { type: "number", label: "Interval (ms)", default: 5000, required: true } });
    expect(
      validateConnectorManifest({
        ...base,
        config: { note: { type: "string", label: "Note", required: false } },
      }).config,
    ).toEqual({ note: { type: "string", label: "Note", required: false } });
    expect(
      validateConnectorManifest({
        ...base,
        config: {
          region: {
            type: "string",
            label: "Region",
            default: "TW",
            required: true,
            options: { TW: "Taiwan", KR: "Korea" } as any,
          },
        },
      }).config,
    ).toEqual({
      region: {
        type: "string",
        label: "Region",
        default: "TW",
        required: true,
        options: [
          { value: "TW", label: "Taiwan" },
          { value: "KR", label: "Korea" },
        ],
      },
    });
    expect(() =>
      validateConnectorManifest({ ...base, config: [] as any })
    ).toThrow("must be a map of fields");
    expect(() =>
      validateConnectorManifest({ ...base, config: { x: { type: "json" as any, label: "X" } } })
    ).toThrow("invalid type");
    expect(() =>
      validateConnectorManifest({ ...base, config: { x: { type: "number" } as any } })
    ).toThrow("requires a label");
    expect(() =>
      validateConnectorManifest({
        ...base,
        config: { x: { type: "number", label: "X", default: "five" as any } },
      })
    ).toThrow("default must be a number");
    expect(() =>
      validateConnectorManifest({
        ...base,
        config: { x: { type: "number", label: "X", options: { five: "Five" } as any } },
      })
    ).toThrow("option value must be a number");
    expect(() =>
      validateConnectorManifest({
        ...base,
        config: { x: { type: "string", label: "X", required: "yes" as any } },
      })
    ).toThrow("required must be a boolean");
  });

  test("requires manifest v1 and rejects unknown fields at every fixed-shape layer", () => {
    const base: ConnectorManifest = {
      manifestVersion: 1,
      id: "strict-demo",
      name: "Strict Demo",
      description: "Test connector manifest.",
      eventCatalog: "./events.json",
      entry: "./index.mjs",
      runtime: { mode: "manual" },
      source: { identity: "single" },
      auth: { type: "none" },
    };

    const missingVersion = { ...base } as Record<string, unknown>;
    delete missingVersion.manifestVersion;
    expect(() => validateConnectorManifest(missingVersion)).toThrow("manifestVersion must be 1");
    const missingDescription = { ...base } as Record<string, unknown>;
    delete missingDescription.description;
    expect(() => validateConnectorManifest(missingDescription)).toThrow("requires a valid description");
    expect(() => validateConnectorManifest({ ...base, description: " Padded " })).toThrow(
      "requires a valid description",
    );
    const missingEventCatalog = { ...base } as Record<string, unknown>;
    delete missingEventCatalog.eventCatalog;
    expect(() => validateConnectorManifest(missingEventCatalog)).toThrow(
      "requires an eventCatalog JSON path",
    );
    for (const eventCatalog of [
      "/events.json",
      "../events.json",
      "./nested/../events.json",
      ".\\events.json",
      "./events.yaml",
      "./events.json?raw=1",
    ]) {
      expect(() => validateConnectorManifest({ ...base, eventCatalog })).toThrow(
        "eventCatalog must be a package-relative JSON path",
      );
    }
    expect(() => validateConnectorManifest({ ...base, manifestVersion: 2 })).toThrow(
      "manifestVersion must be 1",
    );
    expect(() => validateConnectorManifest([])).toThrow("manifest must be a plain object");
    expect(() => validateConnectorManifest({ ...base, unexpected: true })).toThrow(
      "Connector manifest has unknown field: unexpected",
    );
    expect(() => validateConnectorManifest({
      ...base,
      sources: { mode: "singleton" },
    })).toThrow("Connector manifest has unknown field: sources");
    expect(() => validateConnectorManifest({
      ...base,
      runtime: { mode: "manual", unexpected: true },
    })).toThrow("runtime has unknown field: unexpected");
    expect(() => validateConnectorManifest({
      ...base,
      source: { identity: "single", unexpected: true },
    })).toThrow("source has unknown field: unexpected");
    expect(() => validateConnectorManifest({
      ...base,
      platforms: { darwin: { requirements: [], unexpected: true } },
    })).toThrow("platform darwin has unknown field: unexpected");
    expect(() => validateConnectorManifest({
      ...base,
      auth: { type: "none", unexpected: true },
    })).toThrow("none auth has unknown field: unexpected");
    expect(() => validateConnectorManifest({
      ...base,
      auth: { type: "apiKey", unexpected: true },
    })).toThrow("apiKey auth has unknown field: unexpected");
    expect(() => validateConnectorManifest({
      ...base,
      auth: {
        type: "oauth2-public",
        authorizationEndpoint: "https://example.test/authorize",
        tokenEndpoint: "https://example.test/token",
        clientId: "client",
        unexpected: true,
      },
    })).toThrow("oauth2-public auth has unknown field: unexpected");
    expect(() => validateConnectorManifest({
      ...base,
      auth: { type: "managedProvider", providerId: "provider", unexpected: true },
    })).toThrow("managedProvider auth has unknown field: unexpected");
    expect(() => validateConnectorManifest({
      ...base,
      config: {
        region: { type: "string", label: "Region", unexpected: true },
      },
    })).toThrow('config field "region" has unknown field: unexpected');
    expect(() => validateConnectorManifest({
      ...base,
      config: {
        region: {
          type: "string",
          label: "Region",
          options: [{ value: "tw", label: "Taiwan", unexpected: true }],
        },
      },
    })).toThrow('option 0 has unknown field: unexpected');
    expect(() => validateConnectorManifest({
      ...base,
      configPanels: {
        setup: { label: "Setup", unexpected: true },
      },
    })).toThrow('config panel "setup" has unknown field: unexpected');

    expect(validateConnectorManifest(base)).toEqual({
      manifestVersion: 1,
      id: "strict-demo",
      name: "Strict Demo",
      description: "Test connector manifest.",
      eventCatalog: "./events.json",
      entry: "./index.mjs",
      runtime: { mode: "manual" },
      source: { identity: "single" },
      platforms: {},
      auth: { type: "none" },
    });
  });

  test("enforces source identity resolver exports at the manifest boundary", () => {
    const run = vi.fn();
    const resolveSourceIdentity = vi.fn(() => ({ key: "account-1" }));

    expect(() => validateConnectorDefinition({ run }, "connector")).toThrow(
      "source.identity=connector requires a resolveSourceIdentity",
    );
    expect(() => validateConnectorDefinition({ run, resolveSourceIdentity }, "single")).toThrow(
      "source.identity=single forbids a resolveSourceIdentity",
    );
    expect(() => validateConnectorDefinition({ run, resolveSourceIdentity }, "device")).toThrow(
      "source.identity=device forbids a resolveSourceIdentity",
    );
    expect(() => validateConnectorDefinition({ run, resolveSourceIdentity }, "connector"))
      .not.toThrow();
  });

  test("strictly validates connector event catalogs", () => {
    expect(validateConnectorEventCatalog(TEST_EVENT_CATALOG)).toMatchObject(TEST_EVENT_CATALOG);
    expect(() => validateConnectorEventCatalog({
      ...TEST_EVENT_CATALOG,
      catalogVersion: 2,
    })).toThrow("catalogVersion must be 1");
    expect(() => validateConnectorEventCatalog({
      ...TEST_EVENT_CATALOG,
      unexpected: true,
    })).toThrow("unknown field: unexpected");
    expect(() => validateConnectorEventCatalog({
      catalogVersion: 1,
      eventTypes: {},
    })).toThrow("must be a non-empty map");
    expect(() => validateConnectorEventCatalog({
      catalogVersion: 1,
      eventTypes: {
        "Bad Event": TEST_EVENT_CATALOG.eventTypes["test.event"],
      },
    })).toThrow("invalid event type");
    expect(() => validateConnectorEventCatalog({
      catalogVersion: 1,
      eventTypes: {
        "test.event": {
          description: "",
          payloadSchema: {},
        },
      },
    })).toThrow("requires a valid description");
    expect(() => validateConnectorEventCatalog({
      catalogVersion: 1,
      eventTypes: {
        "test.event": {
          description: "Test",
          payloadSchema: [],
        },
      },
    })).toThrow("payloadSchema must be a JSON Schema object or boolean");
  });

  test("rejects event catalogs reached through an intermediate symlink", async () => {
    const connectorDir = join(workspace, "connectors", "linked-catalog");
    const externalDir = join(workspace, "external-catalog");
    mkdirSync(connectorDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    writeTestEventCatalog(externalDir);
    symlinkSync(
      externalDir,
      join(connectorDir, "catalog"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const manifest = validateConnectorManifest({
      manifestVersion: 1,
      id: "linked-catalog",
      name: "Linked Catalog",
      description: "Connector with an external event catalog.",
      eventCatalog: "./catalog/events.json",
      entry: "./index.mjs",
      runtime: { mode: "manual" },
      source: { identity: "single" },
      auth: { type: "none" },
    });

    await expect(loadConnectorEventCatalog(connectorDir, manifest)).rejects.toThrow(
      "eventCatalog path must not contain symlinks",
    );
  });

  test("reports missing event catalogs with Connector context", async () => {
    const connectorDir = join(workspace, "connectors", "missing-catalog");
    mkdirSync(connectorDir, { recursive: true });

    for (const eventCatalog of ["./events.json", "./missing/events.json"]) {
      const manifest = validateConnectorManifest({
        manifestVersion: 1,
        id: "missing-catalog",
        name: "Missing Catalog",
        description: "Connector whose event catalog is missing.",
        eventCatalog,
        entry: "./index.mjs",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
      });

      await expect(loadConnectorEventCatalog(connectorDir, manifest)).rejects.toThrow(
        `Connector missing-catalog eventCatalog not found: ${eventCatalog}`,
      );
    }
  });

  test("runs a connector with bound guard, config, and persistent state", async () => {
    const definition: ConnectorDefinition<{ label: string; extra?: boolean }, { cursor: string }> = {
      async run(context) {
        expect(context).not.toHaveProperty("host");
        const { guard, state, config } = context;
        expect(await state.get()).toBeUndefined();
        expect(config).toEqual({ label: "integration", extra: true });
        await guard.writeEvent({
          type: "app.commit",
          externalId: "abc123",
          startedAt: 1000,
          payload: { sha: "abc123", label: config.label },
        });
        await state.set({ cursor: "abc123" });
      },
    };

    supervisor.register(
      {
        manifestVersion: 1,
        id: "app-commits",
        name: "App Commits",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      definition,
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "app-commits",
      config: { label: "integration", extra: true },
    });

    expect(sourceRecord.id).not.toBe("app-commits");
    await supervisor.run(sourceRecord.id);

    const event = dataDb.prepare("SELECT * FROM events WHERE type = ?").get("app.commit") as any;
    expect(event.source).toBe("connector:app-commits");
    expect(event.external_id).toBe("abc123");
    expect(JSON.parse(event.payload)).toEqual({ sha: "abc123", label: "integration" });

    const stored = supervisor.getSource<unknown, { cursor: string }>(sourceRecord.id);
    expect(stored?.status).toBe("idle");
    expect(stored?.syncState).toEqual({ cursor: "abc123" });
    expect(stored?.lastRunAt).toBeGreaterThan(0);
    const listed = (await supervisor.list()).find((row) => row.id === sourceRecord.id)!;
    expect(listed.recentRuns).toHaveLength(1);
    expect(listed.recentRuns[0]).toMatchObject({
      sourceId: sourceRecord.id,
      connectorId: "app-commits",
      trigger: "manual",
      status: "success",
      error: undefined,
    });
    expect(listed.recentRuns[0].endedAt).toBeGreaterThanOrEqual(listed.recentRuns[0].startedAt);
    expect(listed.recentRuns[0].durationMs).toBeGreaterThanOrEqual(0);

    expect(() => dataDb.prepare("SELECT * FROM connector_sources").all()).toThrow("no such table");
    const storedState = systemDb
      .prepare("SELECT status, sync_state FROM connector_sources WHERE id = ?")
      .get(sourceRecord.id) as { status: string; sync_state: string };
    expect(storedState.status).toBe("idle");
    expect(JSON.parse(storedState.sync_state)).toEqual({ cursor: "abc123" });
  });

  test("recovers stale running observations after a core restart", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "restart-recovery",
        name: "Restart Recovery",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      { async run() {} },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "restart-recovery" });
    systemDb.prepare("UPDATE connector_sources SET status = 'running' WHERE id = ?").run(sourceRecord.id);
    systemDb.prepare(
      `INSERT INTO connector_runs
       (id, source_id, connector_id, trigger, status, started_at)
       VALUES ('stale-run', ?, 'restart-recovery', 'schedule', 'running', 1)`,
    ).run(sourceRecord.id);

    const restarted = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
    });
    expect(restarted.getSource(sourceRecord.id)?.status).toBe("idle");
    expect((await restarted.list())[0]).not.toHaveProperty("description");
    expect(systemDb.prepare(
      "SELECT status, ended_at, error FROM connector_runs WHERE id = 'stale-run'",
    ).get()).toEqual(expect.objectContaining({
      status: "aborted",
      error: "Core restarted before the run completed",
    }));
  });

  test("connectors can write logical text blob refs without exposing storage paths", async () => {
    const blobText = '{"kind":"large-redacted-transcript"}';
    let writtenRef: any;
    const definition: ConnectorDefinition = {
      async run({ guard }) {
        if (!guard.writeTextBlob) throw new Error("missing writeTextBlob capability");
        const result = await guard.writeTextBlob({
          text: blobText,
          variant: "redacted-text",
          mediaType: "application/json",
        });
        writtenRef = result.ref;
        await guard.writeEvent({
          type: "blob.ref",
          externalId: "blob-ref-1",
          startedAt: 1000,
          payload: {
            contentRef: result.ref,
            bytes: result.bytes,
            compressedBytes: result.compressedBytes,
          },
        });
      },
    };

    supervisor.register(
      {
        manifestVersion: 1,
        id: "blob-writer",
        name: "Blob Writer",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      definition,
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "blob-writer" });

    await supervisor.run(sourceRecord.id);

    const digestHex = createHash("sha256").update(blobText).digest("hex");
    expect(writtenRef).toEqual({
      kind: "content-blob",
      version: 1,
      digest: `sha256:${digestHex}`,
      variant: "redacted-text",
      mediaType: "application/json",
      encoding: "gzip",
    });
    expect(JSON.stringify(writtenRef)).not.toContain(".lamarck");
    const blobPath = join(
      workspace,
      ".lamarck",
      "blobs",
      "content",
      "v1",
      "sha256",
      digestHex.slice(0, 2),
      digestHex.slice(2, 4),
      `${digestHex}.gz`,
    );
    expect(gunzipSync(readFileSync(blobPath)).toString("utf8")).toBe(blobText);

    const event = dataDb.prepare("SELECT * FROM events WHERE type = ?").get("blob.ref") as any;
    const payload = JSON.parse(event.payload);
    expect(payload.contentRef).toEqual(writtenRef);
    expect(JSON.stringify(payload.contentRef)).not.toContain(blobPath);
  });

  test("content blob resolver returns text and explicit failure states", () => {
    const store = new ContentBlobStore(workspace);
    const text = "full redacted transcript text";
    const written = store.writeText({ text });

    expect(store.resolve(written.ref)).toEqual({
      status: "resolved",
      kind: "text",
      text,
      bytes: Buffer.byteLength(text),
      digest: written.ref.digest,
      mediaType: "text/plain; charset=utf-8",
      variant: "redacted-text",
    });

    const jsonText = '{"root":{"role":"main"},"childTrajectories":[]}';
    const writtenJson = store.writeText({
      text: jsonText,
      mediaType: "application/json",
    });
    expect(store.resolve(writtenJson.ref)).toEqual({
      status: "resolved",
      kind: "text",
      text: jsonText,
      bytes: Buffer.byteLength(jsonText),
      digest: writtenJson.ref.digest,
      mediaType: "application/json",
      variant: "redacted-text",
    });

    expect(() => store.writeText({
      text: '{"not":"closed"',
      mediaType: "application/json",
    })).toThrow("Content blob text must be valid JSON when mediaType is application/json");

    expect(store.resolve({ ...written.ref, mediaType: "application/json" })).toMatchObject({
      status: "decode_error",
      message: expect.stringContaining("Invalid JSON content blob"),
    });

    const missingDigest = `sha256:${"1".repeat(64)}`;
    expect(store.resolve({ ...written.ref, digest: missingDigest })).toEqual({
      status: "missing",
      digest: missingDigest,
    });

    const mismatchDigestHex = "2".repeat(64);
    const mismatchBytes = Buffer.from("different redacted text", "utf8");
    writeSyntheticContentBlob(workspace, mismatchDigestHex, gzipSync(mismatchBytes));
    expect(store.resolve({ ...written.ref, digest: `sha256:${mismatchDigestHex}` })).toEqual({
      status: "digest_mismatch",
      expected: `sha256:${mismatchDigestHex}`,
      actual: `sha256:${createHash("sha256").update(mismatchBytes).digest("hex")}`,
    });

    expect(store.resolve({ ...written.ref, mediaType: "application/pdf" })).toEqual({
      status: "unsupported",
      reason: "unsupported contentRef mediaType",
    });
    expect(store.resolve({ ...written.ref, mediaType: "application/json; charset=utf-8" })).toEqual({
      status: "unsupported",
      reason: "unsupported contentRef mediaType",
    });

    const decodeErrorDigestHex = "3".repeat(64);
    writeSyntheticContentBlob(workspace, decodeErrorDigestHex, Buffer.from("not gzip"));
    expect(store.resolve({ ...written.ref, digest: `sha256:${decodeErrorDigestHex}` })).toMatchObject({
      status: "decode_error",
    });
  });

  test("merges config-schema defaults with stored Source config", async () => {
    let received: unknown;
    const definition: ConnectorDefinition = {
      async run({ config }) {
        received = config;
      },
    };
    supervisor.register(
      {
        manifestVersion: 1,
        id: "cfg-merge",
        name: "Cfg Merge",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          interval: { type: "number", label: "Interval", default: 5000 },
          label: { type: "string", label: "Label", default: "base" },
          extra: { type: "boolean", label: "Extra", default: false },
        },
      },
      definition,
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "cfg-merge",
      config: { label: "integration", extra: true },
    });
    await supervisor.run(sourceRecord.id);

    // interval = schema default; label and extra = stored Source config.
    expect(received).toEqual({ interval: 5000, label: "integration", extra: true });
  });

	  test("starts connector-owned config UI and preserves opaque config payload", async () => {
	    const definition: ConnectorDefinition = {
	      async run({ state }) {
	        await state.set({ pendingUsers: { "123": { username: "alice" } } });
	      },
	      async configUi(context) {
	        expect(context).not.toHaveProperty("host");
	        const { panelId, config, configStore, state } = context;
	        expect(panelId).toBe("privacy-controls");
	        expect(config).toEqual({
	          mode: "rich-local",
	          opaque: { keep: true },
	        });
	        expect(await state.get()).toEqual({
	          pendingUsers: { "123": { username: "alice" } },
	        });
	        await configStore.patch({
	          set: {
	            privacyPolicy: {
	              version: 1,
	              apps: {
	                "com.apple.finder": { action: "metadata_only" },
	              },
	            },
	          },
	        });
	        await state.set({
	          pendingUsers: {},
	          approvedUsers: { "123": { username: "alice" } },
	        });
	        return { url: "http://127.0.0.1:49321/panel?token=abcdefghijklmnop" };
	      },
	    };
	    supervisor.register(
	      {
	        manifestVersion: 1,
	        id: "cfg-ui",
	        name: "Config UI",
	        description: "Test connector manifest.",
	        eventCatalog: "./events.json",
	        entry: "./index.ts",
	        runtime: { mode: "manual" },
	        source: { identity: "single" },
	        auth: { type: "none" },
	        config: {
	          mode: { type: "string", label: "Mode", default: "rich-local" },
	        },
	        configPanels: {
	          "privacy-controls": { label: "Privacy Controls" },
	        },
	      },
	      definition,
	    );
	    const sourceRecord = supervisor.ensureSource({
	      connectorId: "cfg-ui",
	      config: { opaque: { keep: true } },
	    });

	    await supervisor.run(sourceRecord.id);
	    const started = await supervisor.startConfigUi(sourceRecord.id, "privacy-controls");
	    expect(started.url).toContain("token=abcdefghijklmnop");
	    expect(supervisor.getSource(sourceRecord.id)?.config).toEqual({
	      opaque: { keep: true },
	      privacyPolicy: {
	        version: 1,
	        apps: {
	          "com.apple.finder": { action: "metadata_only" },
	        },
	      },
	    });
	    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({
	      pendingUsers: {},
	      approvedUsers: { "123": { username: "alice" } },
	    });
	    expect(await supervisor.stopConfigUiSession(started.sessionId)).toBe(true);
	    expect(await supervisor.stopConfigUiSession(started.sessionId)).toBe(false);
	    expect(systemDb.prepare("SELECT COUNT(*) AS count FROM connector_runs").get()).toEqual({ count: 1 });
	  });

	  test("required config fields keep sources in setup until configured", async () => {
    let runs = 0;
    const definition: ConnectorDefinition = {
      async run({ guard, config }) {
        runs += 1;
        await guard.writeEvent({
          type: "configured.sample",
          externalId: `run-${runs}`,
          startedAt: 1,
          payload: { name: (config as { name: string }).name },
        });
      },
    };
    supervisor.register(
      {
        manifestVersion: 1,
        id: "configured-feed",
        name: "Configured Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          region: {
            type: "string",
            label: "Region",
            default: "TW",
            options: [{ value: "TW", label: "Taiwan" }],
          },
          name: { type: "string", label: "Name", required: true },
        },
      },
      definition,
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "configured-feed" });
    expect(sourceRecord.setupStatus).toBe("setup");
    expect((await supervisor.list())[0].setupPending).toContain("config");
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("not set up");

    const scheduler = new ConnectorScheduler({ supervisor });
    await scheduler.tick();
    expect(runs).toBe(0);
    expect(supervisor.getSource(sourceRecord.id)?.nextRunAt).toBeUndefined();

    expect(
      (await supervisor.configureSource(sourceRecord.id, { config: { name: "" } })).setupStatus
    ).toBe("setup");

    expect(
      (await supervisor.configureSource(sourceRecord.id, { config: { name: "ready" } })).setupStatus
    ).toBe("ready");
    await scheduler.tick();

    expect(runs).toBe(1);
    const event = dataDb.prepare("SELECT type, payload FROM events WHERE type = ?").get("configured.sample") as any;
    expect(event.type).toBe("configured.sample");
    expect(JSON.parse(event.payload)).toEqual({ name: "ready" });
  });

  test("config-panel writes promote required setup before waking an idle watch", async () => {
    let runs = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "configured-panel-watch",
        name: "Configured Panel Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          identity: { type: "string", label: "Identity", required: true },
        },
        configPanels: {
          setup: { label: "Setup" },
        },
      },
      {
        async run() {
          runs += 1;
        },
        async configUi({ configStore }) {
          await configStore.replace({ identity: "person@example.com" });
          return { url: "http://127.0.0.1:49321/panel?token=abcdefghijklmnop" };
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "configured-panel-watch",
    });
    const scheduler = new ConnectorScheduler({ supervisor, tickMs: 60_000 });
    await scheduler.start();
    let configSessionId: string | undefined;

    try {
      expect(sourceRecord.setupStatus).toBe("setup");
      expect(runs).toBe(0);

      const started = await supervisor.startConfigUi(sourceRecord.id, "setup");
      configSessionId = started.sessionId;

      expect(supervisor.getSource(sourceRecord.id)?.setupStatus).toBe("ready");
      expect(await waitWithTestTimeout((async () => {
        while (runs < 1) await new Promise((resolve) => setTimeout(resolve, 1));
      })(), 2_000)).toBe(true);
    } finally {
      if (configSessionId) await supervisor.stopConfigUiSession(configSessionId);
      await scheduler.stop();
    }
  });

  test("supports multiple connector instances with resolved source identities and separate state", async () => {
    const definition: ConnectorDefinition<
      { accountId: string; externalId: string },
      { seen: string }
    > = {
      resolveSourceIdentity({ config }) {
        return { key: config.accountId };
      },
      async run({ guard, state, config }) {
        await guard.writeEvent({
          type: "calendar.event",
          externalId: config.externalId,
          startedAt: 2000,
          payload: { id: config.externalId },
        });
        await state.set({ seen: config.externalId });
      },
    };

    supervisor.register(
      {
        manifestVersion: 1,
        id: "calendar",
        name: "Calendar",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "connector" },
        auth: { type: "none" },
      },
      definition,
    );
    const personal = await supervisor.addSource({
      connectorId: "calendar",
      config: { accountId: "personal", externalId: "same" },
    });
    const work = await supervisor.addSource({
      connectorId: "calendar",
      config: { accountId: "work", externalId: "same" },
    });

    expect(personal.id).not.toBe("calendar:personal");
    expect(work.id).not.toBe("calendar:work");
    expect(personal).toMatchObject({ sourceKey: "personal", identityStatus: "resolved" });
    expect(work).toMatchObject({ sourceKey: "work", identityStatus: "resolved" });
    await supervisor.run(personal.id);
    await supervisor.run(work.id);

    const rows = dataDb.prepare("SELECT source, external_id FROM events ORDER BY source").all() as any[];
    expect(rows).toEqual([
      { source: "connector:calendar:personal", external_id: "same" },
      { source: "connector:calendar:work", external_id: "same" },
    ]);
    expect(supervisor.getSource(personal.id)?.syncState).toEqual({ seen: "same" });
    expect(supervisor.getSource(work.id)?.syncState).toEqual({ seen: "same" });
  });

  test("Add Source is create-only and installed Connectors remain visible with zero Sources", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "singleton-source",
        name: "Singleton Source",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      { async run() {} },
    );
    supervisor.register(
      {
        manifestVersion: 1,
        id: "many-sources",
        name: "Many Sources",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: { type: "none" },
      },
      {
        async run() {},
        resolveSourceIdentity({ config }) {
          const accountId = (config as { accountId: string }).accountId;
          return { key: accountId, label: `Suggested ${accountId}` };
        },
      },
    );

    expect(supervisor.listInstalledConnectors()).toEqual([
      expect.objectContaining({ connectorId: "many-sources", identityKind: "connector" }),
      expect.objectContaining({ connectorId: "singleton-source", identityKind: "single" }),
    ]);
    expect(await supervisor.list()).toEqual([]);

    const [singleton, sameSingleton] = await Promise.all([
      supervisor.addSource({ connectorId: "singleton-source" }),
      supervisor.addSource({ connectorId: "singleton-source" }),
    ]);
    expect(singleton.connectorId).toBe("singleton-source");
    expect(sameSingleton.id).toBe(singleton.id);
    expect((await supervisor.list()).filter(({ connectorId }) => connectorId === "singleton-source"))
      .toHaveLength(1);

    const personal = await supervisor.addSource({
      connectorId: "many-sources",
      config: { accountId: "personal" },
    });
    const work = await supervisor.addSource({
      connectorId: "many-sources",
      config: { accountId: "work" },
    });
    expect(work.id).not.toBe(personal.id);
    expect(work).toMatchObject({
      sourceKey: "work",
      identityStatus: "resolved",
      suggestedLabel: "Suggested work",
    });

    expect((await supervisor.list()).find(({ id }) => id === work.id)).toMatchObject({
      name: "Suggested work",
      connectorName: "Many Sources",
    });
    supervisor.renameSource(work.id, "My Work");
    expect((await supervisor.list()).find(({ id }) => id === work.id)).toMatchObject({
      name: "My Work",
      displayName: "My Work",
      sourceKey: "work",
    });
    supervisor.renameSource(work.id, null);
    expect((await supervisor.list()).find(({ id }) => id === work.id)?.name)
      .toBe("Suggested work");

    const duplicate = await supervisor.addSource({
      connectorId: "many-sources",
      config: { accountId: "work" },
    });
    expect(duplicate).toMatchObject({
      sourceKey: null,
      lastResolvedKey: "work",
      identityStatus: "conflict",
    });
    expect(duplicate.id).not.toBe(work.id);
    expect((await supervisor.list()).find(({ id }) => id === duplicate.id)).toMatchObject({
      conflictSourceId: work.id,
      setupPending: expect.arrayContaining(["identity"]),
    });
  });

  test("resolves connector-owned identity during setup and detects later identity changes", async () => {
    const definition: ConnectorDefinition<
      { "account-id": string; "external-id": string },
      { seen: string }
    > = {
      resolveSourceIdentity({ config }) {
        return { key: config["account-id"], label: `Account ${config["account-id"]}` };
      },
      async run({ guard, state, config }) {
        await guard.writeEvent({
          type: "calendar.event",
          externalId: config["external-id"],
          startedAt: 2100,
          payload: { id: config["external-id"] },
        });
        await state.set({ seen: config["external-id"] });
      },
    };

    supervisor.register(
      {
        manifestVersion: 1,
        id: "calendar",
        name: "Calendar",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "connector" },
        auth: { type: "none" },
        config: {
          "account-id": { type: "string", label: "Account ID" },
          "external-id": { type: "string", label: "External ID" },
        },
      },
      definition,
    );

    const setup = supervisor.ensureSource({ connectorId: "calendar" });
    expect(setup.sourceKey).toBeNull();
    expect(setup.identityStatus).toBe("unresolved");
    expect(setup.setupStatus).toBe("setup");
    expect((await supervisor.list())[0].source).toBeNull();
    expect((await supervisor.list())[0].setupPending).toEqual(
      expect.arrayContaining(["identity", "config"]),
    );

    const ready = await supervisor.configureSource<
      { "account-id": string; "external-id": string },
      { seen: string }
    >(setup.id, {
      config: { "account-id": "work", "external-id": "event-1" },
    });
    expect(ready.id).toBe(setup.id);
    expect(ready).toMatchObject({
      sourceKey: "work",
      lastResolvedKey: "work",
      identityStatus: "resolved",
      suggestedLabel: "Account work",
    });
    expect(ready.setupStatus).toBe("ready");
    expect((await supervisor.list())[0].source).toBe("connector:calendar:work");

    await supervisor.run(ready.id);

    const event = dataDb.prepare("SELECT source, external_id FROM events").get() as any;
    expect(event).toEqual({ source: "connector:calendar:work", external_id: "event-1" });
    expect(supervisor.getSource(ready.id)?.syncState).toEqual({ seen: "event-1" });

    const changed = await supervisor.configureSource(ready.id, {
      config: { "account-id": "personal", "external-id": "event-2" },
    });
    expect(changed).toMatchObject({
      sourceKey: "work",
      lastResolvedKey: "personal",
      identityStatus: "changed",
    });
    await expect(supervisor.run(ready.id)).rejects.toThrow("not set up");
  });

  test("delete and re-add reclaims the same Source key and absorbs a full rescan", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "reclaimed-source",
        name: "Reclaimed Source",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: { type: "none" },
      },
      {
        async resolveSourceIdentity() {
          return { key: "stable-account" };
        },
        async run({ guard }) {
          await guard.writeEvent({
            type: "reclaimed-source.item",
            externalId: "stable-item",
            startedAt: 2_150,
            payload: { complete: true },
          });
        },
      },
    );

    const first = await supervisor.addSource({ connectorId: "reclaimed-source" });
    await supervisor.run(first.id);
    await supervisor.removeSource(first.id);

    const second = await supervisor.addSource({ connectorId: "reclaimed-source" });
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({
      sourceKey: "stable-account",
      identityStatus: "resolved",
    });
    await supervisor.run(second.id);

    expect(dataDb.prepare(
      `SELECT source, external_id, COUNT(*) AS count
       FROM events
       WHERE type = 'reclaimed-source.item'`,
    ).get()).toEqual({
      source: "connector:reclaimed-source:stable-account",
      external_id: "stable-item",
      count: 1,
    });
  });

  test("persists sanitized identity errors and resolves them only through explicit retry", async () => {
    let failResolution = true;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "retry-identity",
        name: "Retry Identity",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: { type: "none" },
      },
      {
        async run() {},
        async resolveSourceIdentity() {
          if (failResolution) {
            throw new Error("Bearer super-secret access_token=also-secret");
          }
          return { key: "account-11", label: "Recovered account" };
        },
      },
    );

    const failed = await supervisor.addSource({ connectorId: "retry-identity" });
    expect(failed).toMatchObject({
      sourceKey: null,
      identityStatus: "error",
      setupStatus: "setup",
    });
    expect(failed.lastError).toContain("Bearer [redacted]");
    expect(failed.lastError).not.toContain("super-secret");
    expect(failed.lastError).not.toContain("also-secret");

    failResolution = false;
    const recovered = await supervisor.retrySourceIdentity(failed.id);
    expect(recovered).toMatchObject({
      sourceKey: "account-11",
      lastResolvedKey: "account-11",
      identityStatus: "resolved",
      suggestedLabel: "Recovered account",
      setupStatus: "ready",
      lastError: undefined,
    });
    await expect(supervisor.retrySourceIdentity(failed.id)).rejects.toThrow("already resolved");
  });

  test("startup recovery retries durable identity errors through the ordinary setup path", async () => {
    let resolverAvailable = false;
    const manifest: ConnectorManifest = {
      manifestVersion: 1,
      id: "startup-identity-error",
      name: "Startup Identity Error",
      description: "Test connector manifest.",
      eventCatalog: "./events.json",
      entry: "./index.ts",
      runtime: { mode: "manual" },
      source: { identity: "connector" },
      auth: { type: "none" },
    };
    const definition: ConnectorDefinition = {
      async run() {},
      async resolveSourceIdentity() {
        if (!resolverAvailable) throw new Error("provider temporarily unavailable");
        return { key: "recovered-account" };
      },
    };
    supervisor.register(manifest, definition);
    const failed = await supervisor.addSource({ connectorId: manifest.id });
    expect(failed.identityStatus).toBe("error");

    resolverAvailable = true;
    const restarted = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
    });
    restarted.register(manifest, definition);
    await restarted.recoverSourceIdentities();
    expect(restarted.getSource(failed.id)).toMatchObject({
      sourceKey: "recovered-account",
      identityStatus: "resolved",
      setupStatus: "ready",
    });
  });

  test("startup recovery reclaims a conflicted key after its owning Source is deleted", async () => {
    const manifest: ConnectorManifest = {
      manifestVersion: 1,
      id: "startup-identity-conflict",
      name: "Startup Identity Conflict",
      description: "Test connector manifest.",
      eventCatalog: "./events.json",
      entry: "./index.ts",
      runtime: { mode: "manual" },
      source: { identity: "connector" },
      auth: { type: "none" },
    };
    const definition: ConnectorDefinition<{ account: string }> = {
      async run() {},
      resolveSourceIdentity({ config }) {
        return { key: config.account };
      },
    };
    supervisor.register(manifest, definition);
    const owner = await supervisor.addSource({
      connectorId: manifest.id,
      config: { account: "shared-account" },
    });
    const conflicted = await supervisor.addSource({
      connectorId: manifest.id,
      config: { account: "shared-account" },
    });
    expect(conflicted).toMatchObject({
      sourceKey: null,
      lastResolvedKey: "shared-account",
      identityStatus: "conflict",
    });
    await supervisor.removeSource(owner.id);

    const restarted = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
    });
    restarted.register(manifest, definition);
    await restarted.recoverSourceIdentities();
    expect(restarted.getSource(conflicted.id)).toMatchObject({
      sourceKey: "shared-account",
      lastResolvedKey: "shared-account",
      identityStatus: "resolved",
      setupStatus: "ready",
    });
  });

  test("fences connector-scoped identity mutations from runs and concurrent writes", async () => {
    let entered!: () => void;
    let release!: () => void;
    const resolverEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resolverRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "identity-fence",
        name: "Identity Fence",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: { type: "none" },
      },
      {
        async run() {},
        async resolveSourceIdentity({ config }) {
          entered();
          await resolverRelease;
          return { key: (config as { accountId: string }).accountId };
        },
      },
    );
    const first = supervisor.ensureSource({
      connectorId: "identity-fence",
      config: { accountId: "first" },
    });
    const second = supervisor.ensureSource({
      connectorId: "identity-fence",
      config: { accountId: "second" },
    });

    const pending = supervisor.retrySourceIdentity(first.id);
    await resolverEntered;

    expect(() => supervisor.start(first.id)).toThrow("identity mutation in progress");
    await expect(supervisor.retrySourceIdentity(second.id)).rejects.toThrow(
      "identity mutation in progress",
    );
    await expect(supervisor.configureSource(second.id, {
      config: { accountId: "changed-while-fenced" },
    })).rejects.toThrow("identity mutation in progress");
    expect(supervisor.getSource(second.id)?.config).toEqual({ accountId: "second" });

    release();
    await expect(pending).resolves.toMatchObject({
      sourceKey: "first",
      identityStatus: "resolved",
    });
  });

  test("fails closed when a connector Source has an invalid resolved/null identity pair", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "invalid-identity-pair",
        name: "Invalid Identity Pair",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: { type: "none" },
      },
      {
        async run() {},
        async resolveSourceIdentity() {
          return { key: "valid-key" };
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "invalid-identity-pair" });
    systemDb.prepare(
      `UPDATE connector_sources
       SET identity_status = 'resolved', source_key = NULL, setup_status = 'ready'
       WHERE id = ?`,
    ).run(sourceRecord.id);

    expect((await supervisor.list())[0]).toMatchObject({
      source: null,
      setupStatus: "setup",
      setupPending: expect.arrayContaining(["identity"]),
    });
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("Source identity is not resolved");
  });

  test("classifies device Source ownership and blocks non-owning devices", async () => {
    const registration = {
      manifestVersion: 1,
      id: "device-owned-feed",
      name: "Device Owned Feed",
      description: "Test connector manifest.",
      eventCatalog: "./events.json",
      entry: "./index.ts",
      runtime: { mode: "watch" as const },
      source: { identity: "device" as const },
      auth: { type: "none" as const },
    } satisfies ConnectorManifest;
    const definition = { async run() {} };
    const makeSupervisor = (deviceIdentity: { status: "resolved"; value: string } | {
      status: "unavailable";
      reason: string;
    }) => new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      deviceIdentity,
      deviceDisplayName: "Test Mac",
    });

    const owning = makeSupervisor({ status: "resolved", value: "device-a" });
    owning.register(registration, definition);
    const sourceRecord = await owning.addSource({ connectorId: registration.id });
    expect(sourceRecord).toMatchObject({
      sourceKey: "device-a",
      identityStatus: "resolved",
      suggestedLabel: "Test Mac",
    });
    expect((await owning.list())[0]).toMatchObject({ ownership: "here" });
    await expect(owning.addSource({ connectorId: registration.id }))
      .rejects.toThrow("already has a Source for this device");

    const other = makeSupervisor({ status: "resolved", value: "device-b" });
    other.register(registration, definition);
    expect((await other.list())[0]).toMatchObject({ ownership: "other-device" });
    await expect(other.run(sourceRecord.id)).rejects.toThrow("belongs to another device");
    const otherScheduler = new ConnectorScheduler({ supervisor: other, tickMs: 60_000 });
    await otherScheduler.start();
    expect((await other.list())[0].running).toBe(false);
    await otherScheduler.stop();

    const unknown = makeSupervisor({ status: "unavailable", reason: "machine id unavailable" });
    unknown.register(registration, definition);
    expect((await unknown.list())[0]).toMatchObject({
      ownership: "device-unknown",
      ownershipReason: "machine id unavailable",
    });
    await expect(unknown.run(sourceRecord.id)).rejects.toThrow("Device identity unavailable");
    await expect(unknown.addSource({ connectorId: registration.id }))
      .rejects.toThrow("Device identity unavailable");
    const unknownScheduler = new ConnectorScheduler({ supervisor: unknown, tickMs: 60_000 });
    await unknownScheduler.start();
    expect((await unknown.list())[0].running).toBe(false);
    await unknownScheduler.stop();
  });

  test("provides auth as a capability handle", async () => {
    let tokenSeen = "";
    const definition: ConnectorDefinition = {
      async run({ auth, guard }) {
        if (auth.type === "none") throw new Error("expected auth");
        tokenSeen = await auth.getToken();
        await guard.writeEvent({
          type: "oura.sample",
          externalId: "sample-1",
          startedAt: 3000,
          payload: { ok: true },
        });
      },
    };

    supervisor.register(
      {
        manifestVersion: 1,
        id: "oura",
        name: "Oura",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "apiKey", label: "Oura Token" },
      },
      definition,
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oura" });
    expect(sourceRecord.setupStatus).toBe("setup");
    await expect(supervisor.connectSource(sourceRecord.id)).rejects.toThrow("requires credentials");
    expect(supervisor.updateSource(sourceRecord.id, { setupStatus: "ready" }).setupStatus)
      .toBe("setup");
    await supervisor.getAuthManager().setToken(sourceRecord.authRef!, "secret-token");
    const ready = await supervisor.connectSource(sourceRecord.id);
    expect(
      (await supervisor.configureSource(ready.id, { config: { sample: true } })).setupStatus
    ).toBe("ready");
    expect(() =>
      supervisor.updateSource(ready.id, { authRef: "missing-token-ref" })
    ).toThrow("authRef changes must use connectSource");

    await supervisor.getAuthManager().setToken("rotated-ref", "rotated-token");
    // @ts-expect-error connectSource is credential-only; config writes use configureSource.
    const rotated = await supervisor.connectSource(ready.id, { authRef: "rotated-ref", config: { smuggled: true } });
    expect(rotated.setupStatus).toBe("ready");
    expect(rotated.authRef).toBe("rotated-ref");
    expect(rotated.config).toEqual({ sample: true });

    await supervisor.run(rotated.id);

    expect(tokenSeen).toBe("rotated-token");
    const event = dataDb.prepare("SELECT source, type FROM events").get() as any;
    expect(event).toEqual({ source: "connector:oura", type: "oura.sample" });
  });

  test("connector guard accepts non-object JSON payloads and rejects non-JSON payloads", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "json-feed",
        name: "JSON Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          await guard.writeEvent({
            type: "json.string",
            externalId: "json-string",
            startedAt: 3100,
            payload: "hello",
          });
          await expect(guard.writeEvent({
            type: "json.bad",
            externalId: "json-bad",
            startedAt: 3101,
            payload: (() => undefined) as any,
          })).rejects.toThrow("JSON-serializable");
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "json-feed" });

    await supervisor.run(sourceRecord.id);

    const event = dataDb.prepare("SELECT payload FROM events WHERE type = ?").get("json.string") as any;
    expect(JSON.parse(event.payload)).toBe("hello");
  });

  test("connector guard requires externalId", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "id-feed",
        name: "ID Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          await expect(guard.writeEvent({
            type: "id-feed.event",
            startedAt: 3110,
            payload: { ok: true },
          } as any)).rejects.toThrow("externalId");
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "id-feed" });

    await supervisor.run(sourceRecord.id);
  });

  test("connector guard treats duplicate externalId writes as idempotent", async () => {
    const ids: string[] = [];
    supervisor.register(
      {
        manifestVersion: 1,
        id: "retry-feed",
        name: "Retry Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          const first = await guard.writeEvent({
            type: "retry.sample",
            externalId: "same-event",
            startedAt: 3500,
            payload: { attempt: 1 },
          });
          const second = await guard.writeEvent({
            type: "retry.sample",
            externalId: "same-event",
            startedAt: 3500,
            payload: { attempt: 2 },
          });
          ids.push(first.id, second.id);
        },
      },
    );

    const sourceRecord = supervisor.ensureSource({ connectorId: "retry-feed" });
    await supervisor.run(sourceRecord.id);

    expect(ids[0]).toBe(ids[1]);
    const rows = dataDb.prepare("SELECT source, external_id, payload FROM events").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("connector:retry-feed");
    expect(rows[0].external_id).toBe("same-event");
    expect(JSON.parse(rows[0].payload)).toEqual({ attempt: 1 });
  });

  test("connector warnings are keyed non-fatal Source metadata", async () => {
    let shouldClear = false;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "warning-feed",
        name: "Warning Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ warnings }) {
          if (shouldClear) {
            await warnings.clear("missing");
            await warnings.clear("backfill");
            return;
          }
          await warnings.set({
            key: "backfill",
            message: "Backfill paused",
            details: { stream: "sleep" },
          });
          await warnings.set({
            key: "backfill",
            message: "Backfill still paused",
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "warning-feed" });

    await supervisor.run(sourceRecord.id);
    const warned = supervisor.getSource(sourceRecord.id);
    expect(warned?.status).toBe("idle");
    expect(warned?.lastError).toBeUndefined();
    expect(warned?.warnings).toHaveLength(1);
    expect(warned?.warnings?.[0]).toMatchObject({
      key: "backfill",
      message: "Backfill still paused",
    });
    expect(warned?.warnings?.[0].details).toBeUndefined();
    expect(warned?.warnings?.[0].firstSeenAt).toBeLessThanOrEqual(warned?.warnings?.[0].lastSeenAt ?? 0);

    shouldClear = true;
    await supervisor.run(sourceRecord.id);
    expect(supervisor.getSource(sourceRecord.id)?.warnings).toBeUndefined();
  });

  test("blocks runs up front when credentials disappear after ready", async () => {
    let connectorSawAuth = false;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "revoked-feed",
        name: "Revoked Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "apiKey" },
      },
      {
        async run({ auth }) {
          connectorSawAuth = true;
          if (auth.type === "none") throw new Error("expected auth");
          await auth.getToken();
        },
      },
    );

    const sourceRecord = supervisor.ensureSource({ connectorId: "revoked-feed" });
    await supervisor.getAuthManager().setToken(sourceRecord.authRef!, "token");
    const ready = await supervisor.connectSource(sourceRecord.id);
    expect(ready.setupStatus).toBe("ready");

    // Token revoked after ready: the run must fail before connector code
    // executes, and the Source drops back to setup.
    await supervisor.getAuthManager().deleteToken(sourceRecord.authRef!);
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("credentials are missing");
    expect(connectorSawAuth).toBe(false);
    expect(supervisor.getSource(sourceRecord.id)?.setupStatus).toBe("setup");
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("error");
  });

  test("watch scheduler restarts sources after setup recovery", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "auth-watch",
        name: "Auth Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "apiKey" },
      },
      {
        async run({ signal }) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
        },
      },
    );

    const sourceRecord = supervisor.ensureSource({ connectorId: "auth-watch" });
    await supervisor.getAuthManager().setToken(sourceRecord.authRef!, "token");
    await supervisor.connectSource(sourceRecord.id);

    // Credentials revoked: the run-gate failure leaves a setup-blocked error.
    await supervisor.getAuthManager().deleteToken(sourceRecord.authRef!);
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("credentials are missing");
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("error");
    expect(supervisor.getSource(sourceRecord.id)?.setupStatus).toBe("setup");

    // Reconnect promotes back to ready and resets the setup-blocked error to
    // idle, so the watch scheduler picks the Source up again.
    await supervisor.getAuthManager().setToken(sourceRecord.authRef!, "token-2");
    const recovered = await supervisor.connectSource(sourceRecord.id);
    expect(recovered.setupStatus).toBe("ready");
    expect(recovered.status).toBe("idle");
    expect(recovered.lastError).toBeUndefined();

    const scheduler = new ConnectorScheduler({ supervisor });
    await scheduler.tick();
    expect((await supervisor.list())[0].running).toBe(true);
    await scheduler.stop();
    expect((await supervisor.list())[0].running).toBe(false);
  });

  test("crashed watch runs need explicit restart before the scheduler picks them up", async () => {
    let crash = true;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "crashy-watch",
        name: "Crashy Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ signal }) {
          if (crash) throw new Error("connector bug");
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "crashy-watch" });
    const scheduler = new ConnectorScheduler({ supervisor, onError() {} });

    // Crash leaves a needs-attention error that further ticks do not retry.
    await scheduler.tick();
    await Promise.resolve();
    while ((await supervisor.list())[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("error");
    expect(supervisor.getSource(sourceRecord.id)?.lastError).toContain("connector bug");

    crash = false;
    await scheduler.tick();
    expect((await supervisor.list())[0].running).toBe(false);
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("error");

    // Explicit restart resets to idle and the scheduler picks it up again.
    const restarted = supervisor.restartSource(sourceRecord.id);
    expect(restarted.status).toBe("idle");
    expect(restarted.lastError).toBeUndefined();

    await scheduler.tick();
    expect((await supervisor.list())[0].running).toBe(true);
    expect(() => supervisor.restartSource(sourceRecord.id)).toThrow("already running");
    await scheduler.stop();
  });

  test("records a rejected run without an error value as an error", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "undefined-rejection",
        name: "Undefined Rejection",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run() {
          await Promise.reject();
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "undefined-rejection",
    });
    let rejected = false;

    try {
      await supervisor.run(sourceRecord.id);
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }

    expect(rejected).toBe(true);
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("error");
    expect(supervisor.getSource(sourceRecord.id)?.lastError).toBe("undefined");
    expect((await supervisor.list())[0].recentRuns[0]).toMatchObject({
      status: "error",
      error: "undefined",
    });
  });

  test("restart guards Sources that still need setup", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "guarded-feed",
        name: "Guarded Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "apiKey" },
      },
      { async run() {} },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "guarded-feed" });
    expect(sourceRecord.setupStatus).toBe("setup");
    expect(() => supervisor.restartSource(sourceRecord.id)).toThrow("not set up");
    expect(() => supervisor.restartSource("missing-id")).toThrow("not found");
  });

  test("fails auth connectors without credentials and records Source error", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oura",
        name: "Oura",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: { type: "apiKey" },
      },
      {
        async run({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          await auth.getToken();
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oura" });

    expect(sourceRecord.setupStatus).toBe("setup");
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("not set up");
    const stored = supervisor.getSource(sourceRecord.id);
    expect(stored?.status).toBe("idle");
    expect(stored?.lastError).toBeUndefined();
  });

  test("gates sources by platform", async () => {
    const linuxSupervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "linux",
    });
    linuxSupervisor.register(
      {
        manifestVersion: 1,
        id: "macos-ax",
        name: "macOS Accessibility",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        platforms: {
          darwin: {
            requirements: ["macos-accessibility"],
          },
        },
        auth: { type: "none" },
      },
      { async run() {} },
    );

    expect(() =>
      linuxSupervisor.ensureSource({ connectorId: "macos-ax" })
    ).toThrow("not supported on linux");

    // Installing a connector never creates an unsupported placeholder Source.
    expect(linuxSupervisor.getSource("macos-ax")).toBeUndefined();
    expect(await linuxSupervisor.list()).toEqual([]);
  });

  test("gates no-auth sources behind platform requirement lifecycle", async () => {
    let granted = false;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "ax-watch",
        name: "AX Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        platforms: {
          darwin: { requirements: ["macos-accessibility"] },
        },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          await guard.writeEvent({
            type: "ax.sample",
            externalId: "ax-1",
            startedAt: 6000,
            payload: { ok: true },
          });
        },
        requirements: {
          "macos-accessibility": {
            label: "Accessibility",
            async check(context) {
              expect(context).not.toHaveProperty("host");
              return granted
                ? { status: "satisfied" }
                : { status: "missing", message: "Accessibility access is not granted." };
            },
            async request(context) {
              expect(context).not.toHaveProperty("host");
              granted = true;
              return { status: "pending", message: "Granting..." };
            },
          },
        },
      },
    );

    // First Source must not be ready while requirements are unchecked.
    const sourceRecord = supervisor.ensureSource({ connectorId: "ax-watch" });
    const reconcileReasons: string[] = [];
    supervisor.onRuntimeReconcileRequested((instanceId, reason) => {
      if (instanceId === sourceRecord.id) reconcileReasons.push(reason);
    });
    expect(sourceRecord.setupStatus).toBe("setup");
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("not set up");

    // setupStatus cannot bypass the requirement gate.
    expect(supervisor.updateSource(sourceRecord.id, { setupStatus: "ready" }).setupStatus)
      .toBe("setup");

    // check() persists status and keeps the Source in setup.
    const missing = await supervisor.checkSourceRequirements(sourceRecord.id);
    expect(missing["macos-accessibility"].status).toBe("missing");
    expect(missing["macos-accessibility"].message).toContain("not granted");
    const listed = (await supervisor.list())[0];
    expect(listed.requirements).toEqual([
      expect.objectContaining({ id: "macos-accessibility", status: "missing" }),
    ]);
    expect(supervisor.getSource(sourceRecord.id)?.setupStatus).toBe("setup");
    expect(reconcileReasons).toEqual([]);

    // request() resolves the requirement and the evaluator promotes to ready.
    const requested = await supervisor.requestSourceRequirement(
      sourceRecord.id,
      "macos-accessibility",
    );
    expect(requested.status).toBe("satisfied");
    expect(supervisor.getSource(sourceRecord.id)?.setupStatus).toBe("ready");
    expect(reconcileReasons).toEqual(["readiness_changed"]);

    await supervisor.run(sourceRecord.id);
    const event = dataDb.prepare("SELECT source, type FROM events").get() as any;
    expect(event).toEqual({ source: "connector:ax-watch", type: "ax.sample" });

    // Requirement regression blocks the next run and demotes back to setup.
    granted = false;
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("requirements not satisfied");
    expect(supervisor.getSource(sourceRecord.id)?.setupStatus).toBe("setup");
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("error");
  });

  test("allows connecting auth before requirements are granted", async () => {
    let granted = false;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "auth-ax",
        name: "Auth AX",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        platforms: {
          darwin: { requirements: ["macos-accessibility"] },
        },
        auth: { type: "apiKey" },
      },
      {
        async run() {},
        requirements: {
          "macos-accessibility": {
            label: "Accessibility",
            async check() {
              return granted
                ? { status: "satisfied" }
                : { status: "missing", message: "Not granted." };
            },
            async request() {
              return { status: "pending", message: "Grant access in System Settings." };
            },
          },
        },
      },
    );

    const sourceRecord = supervisor.ensureSource({ connectorId: "auth-ax" });
    expect(sourceRecord.setupStatus).toBe("setup");

    // Auth connects first: credentials bind, but the Source stays in
    // setup because the platform requirement is still missing.
    await supervisor.getAuthManager().setToken(sourceRecord.authRef!, "token");
    const connected = await supervisor.connectSource(sourceRecord.id);
    expect(connected.setupStatus).toBe("setup");
    expect(connected.authRef).toBe(sourceRecord.authRef);

    // request() reports pending and the immediate re-check still says missing:
    // the pending record must stay visible for the UI.
    const pending = await supervisor.requestSourceRequirement(
      sourceRecord.id,
      "macos-accessibility",
    );
    expect(pending.status).toBe("pending");
    expect(pending.message).toContain("System Settings");
    expect((await supervisor.list())[0].requirements).toEqual([
      expect.objectContaining({ id: "macos-accessibility", status: "pending" }),
    ]);

    // Once the requirement is granted, a check promotes to ready without
    // reconnecting auth.
    granted = true;
    const records = await supervisor.checkSourceRequirements(sourceRecord.id);
    expect(records["macos-accessibility"].status).toBe("satisfied");
    expect(supervisor.getSource(sourceRecord.id)?.setupStatus).toBe("ready");

    await supervisor.run(sourceRecord.id);
  });

  test("records an error when a declared requirement has no handler", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "no-handler",
        name: "No Handler",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        platforms: {
          darwin: { requirements: ["macos-accessibility"] },
        },
        auth: { type: "none" },
      },
      { async run() {} },
    );

    const sourceRecord = supervisor.ensureSource({ connectorId: "no-handler" });
    expect(sourceRecord.setupStatus).toBe("setup");

    const records = await supervisor.checkSourceRequirements(sourceRecord.id);
    expect(records["macos-accessibility"].status).toBe("error");
    expect(records["macos-accessibility"].message).toContain("does not implement requirement handler");
    await expect(
      supervisor.requestSourceRequirement(sourceRecord.id, "macos-accessibility")
    ).rejects.toThrow("does not implement requirement handler");
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("not set up");
  });

  test("requirement checks pass the trust gate before importing connector code", async () => {
    const sourceDir = join(workspace, "connectors", "untrusted-ax");
    mkdirSync(sourceDir, { recursive: true });
    writeConnectorManifestFixture(
      join(sourceDir, "connector.yaml"),
      `manifestVersion: 1
id: untrusted-ax
name: Untrusted AX
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: poll
source:
  identity: single
platforms:
  darwin:
    requirements:
      - macos-accessibility
auth:
  type: none
`,
    );
    writeFileSync(
      join(sourceDir, "index.mjs"),
      `export default {
  async run() {},
  requirements: {
    "macos-accessibility": {
      label: "Accessibility",
      async check(context) {
        if ("host" in context) throw new Error("host leaked into connector requirement context");
        return { status: "satisfied" };
      },
    },
  },
};
`,
    );

    await registerWorkspaceConnectors(supervisor, workspace);
    supervisor.ensureSource({ connectorId: "untrusted-ax" });
    const sourceRecord = (await supervisor.list())[0];
    expect(sourceRecord.packageTrust).toBe("untrusted");
    expect(sourceRecord.requirements).toEqual([
      expect.objectContaining({ id: "macos-accessibility", status: "unknown" }),
    ]);

    await expect(supervisor.checkSourceRequirements(sourceRecord.id)).rejects.toThrow("not trusted");

    await supervisor.approveCurrentPackage("untrusted-ax");
    const records = await supervisor.checkSourceRequirements(sourceRecord.id);
    expect(records["macos-accessibility"].status).toBe("satisfied");
    expect(supervisor.getSource(sourceRecord.id)?.setupStatus).toBe("ready");
  });

  test("starts and aborts watch connector runs", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "terminal",
        name: "Terminal",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ signal, state, guard }) {
          await guard.writeEvent({
            type: "terminal.session.started",
            externalId: "s1",
            startedAt: 4000,
            payload: { session: "s1" },
          });
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          await state.set({ stopped: true });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "terminal" });

    const handle = supervisor.start(sourceRecord.id);
    expect((await supervisor.list())[0].running).toBe(true);
    handle.abort();
    await handle.promise;

    expect((await supervisor.list())[0].running).toBe(false);
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("idle");
    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({ stopped: true });
  });

  test("scheduler starts watch connectors and stops them on shutdown", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "watch-feed",
        name: "Watch Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ signal, state }) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          await state.set({ stopped: true });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "watch-feed" });
    const scheduler = new ConnectorScheduler({ supervisor, tickMs: 60_000 });

    await scheduler.start();
    expect((await supervisor.list())[0].running).toBe(true);

    await scheduler.stop();
    expect((await supervisor.list())[0].running).toBe(false);
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("idle");
    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({ stopped: true });
  });

  test("creating a ready Source immediately wakes its idle watch without a timer tick", async () => {
    let starts = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "new-source-watch",
        name: "New Source Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "connector" },
        auth: { type: "none" },
        config: {
          "account-id": { type: "string", label: "Account ID" },
        },
      },
      {
        resolveSourceIdentity({ config }) {
          return { key: (config as { "account-id": string })["account-id"] };
        },
        async run({ signal, warnings }) {
          starts += 1;
          await warnings.set({
            key: "setup-needed",
            message: "Finish connector setup.",
          });
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const reconcileReasons: Array<{ instanceId: string; reason: string }> = [];
    supervisor.onRuntimeReconcileRequested((instanceId, reason) => {
      reconcileReasons.push({ instanceId, reason });
    });
    const scheduler = new ConnectorScheduler({ supervisor, tickMs: 60_000 });

    await scheduler.start();
    const draft = await supervisor.addSource({ connectorId: "new-source-watch" });
    expect(draft.setupStatus).toBe("setup");
    expect(draft.identityStatus).toBe("unresolved");
    expect(reconcileReasons).toEqual([]);
    expect(starts).toBe(0);

    const ready = await supervisor.addSource({
      connectorId: "new-source-watch",
      config: { "account-id": "device-a" },
    });
    expect(ready).toMatchObject({ sourceKey: "device-a", identityStatus: "resolved" });
    expect(ready.setupStatus).toBe("ready");
    expect(reconcileReasons).toEqual([
      { instanceId: ready.id, reason: "source_created" },
    ]);
    expect(await waitWithTestTimeout((async () => {
      while (!supervisor.getSource(ready.id)?.warnings?.length) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })(), 2_000)).toBe(true);
    expect(starts).toBe(1);
    expect(supervisor.getSource(ready.id)?.warnings).toEqual([
      expect.objectContaining({
        key: "setup-needed",
        message: "Finish connector setup.",
      }),
    ]);

    await scheduler.stop();
  });

  test("identity resolution during configuration immediately wakes an idle watch Source", async () => {
    let starts = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "identity-watch",
        name: "Identity Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "connector" },
        auth: { type: "none" },
        config: {
          "account-id": { type: "string", label: "Account ID" },
        },
      },
      {
        resolveSourceIdentity({ config }) {
          return { key: (config as { "account-id": string })["account-id"] };
        },
        async run({ signal }) {
          starts += 1;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "identity-watch" });
    const reconcileReasons: string[] = [];
    supervisor.onRuntimeReconcileRequested((instanceId, reason) => {
      if (instanceId === sourceRecord.id) reconcileReasons.push(reason);
    });
    const scheduler = new ConnectorScheduler({ supervisor, tickMs: 60_000 });

    await scheduler.start();
    expect(sourceRecord.setupStatus).toBe("setup");
    expect(starts).toBe(0);

    const ready = await supervisor.configureSource(sourceRecord.id, {
      config: { "account-id": "device-a" },
    });
    expect(ready).toMatchObject({ sourceKey: "device-a", identityStatus: "resolved" });
    expect(ready.setupStatus).toBe("ready");
    expect(reconcileReasons).toEqual(["config_changed"]);
    expect(await waitWithTestTimeout((async () => {
      while (starts < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);

    await scheduler.stop();
  });

  test("scheduler releases runtime reconcile listeners while stopped and resubscribes on restart", async () => {
    let watchStarts = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "restartable-scheduler-watch",
        name: "Restartable Scheduler Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          label: { type: "string", label: "Label" },
        },
      },
      {
        async run({ signal }) {
          watchStarts += 1;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "restartable-scheduler-watch",
    });
    const originalSubscribe = supervisor.onRuntimeReconcileRequested.bind(supervisor);
    let subscriptions = 0;
    let disposals = 0;
    supervisor.onRuntimeReconcileRequested = (listener) => {
      subscriptions += 1;
      const dispose = originalSubscribe(listener);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        disposals += 1;
        dispose();
      };
    };

    const scheduler = new ConnectorScheduler({ supervisor, tickMs: 60_000 });
    expect(subscriptions).toBe(0);

    await scheduler.start();
    expect(subscriptions).toBe(1);
    expect(disposals).toBe(0);
    expect(watchStarts).toBe(0);

    await scheduler.stop();
    expect(disposals).toBe(1);

    await scheduler.start();
    expect(subscriptions).toBe(2);

    await supervisor.configureSource(sourceRecord.id, {
      config: { label: "ready" },
    });
    expect(await waitWithTestTimeout((async () => {
      while (watchStarts < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);

    await scheduler.stop();
    expect(disposals).toBe(2);
  });

  test("effective config changes replace an active watch attempt without replacing its run intent", async () => {
    const configs: Array<Record<string, unknown>> = [];
    const signals: AbortSignal[] = [];
    supervisor.register(
      {
        manifestVersion: 1,
        id: "reconfigurable-watch",
        name: "Reconfigurable Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          label: { type: "string", label: "Label", default: "old" },
        },
      },
      {
        async run({ config, signal }) {
          configs.push(config as Record<string, unknown>);
          signals.push(signal);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "reconfigurable-watch",
      config: {
        label: "old",
        opaque: { first: 1, second: 2 },
      },
    });
    const scheduler = new ConnectorScheduler({ supervisor });

    await scheduler.start();
    while (configs.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));

    // JSON object key order is not an effective config change.
    await supervisor.configureSource(sourceRecord.id, {
      config: {
        opaque: { second: 2, first: 1 },
        label: "old",
      },
    });
    expect(signals[0].aborted).toBe(false);
    expect(configs).toHaveLength(1);

    const intermediateWrite = supervisor.configureSource(sourceRecord.id, {
      config: {
        label: "intermediate",
        opaque: { first: 1, second: 2 },
      },
    });
    const latestWrite = supervisor.configureSource(sourceRecord.id, {
      config: {
        label: "new",
        opaque: { first: 1, second: 2 },
      },
    });
    await Promise.all([intermediateWrite, latestWrite]);
    expect(signals[0].aborted).toBe(true);
    expect(await waitWithTestTimeout((async () => {
      while (configs.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);
    expect(configs[1]).toMatchObject({ label: "new" });

    const duringReplacement = (await supervisor.list())[0];
    expect(duringReplacement.running).toBe(true);
    expect(duringReplacement.recentRuns).toHaveLength(1);
    expect(duringReplacement.recentRuns[0].status).toBe("running");

    await scheduler.stop();
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("idle");
    expect((await supervisor.list())[0].recentRuns[0].status).toBe("aborted");
  });

  test("persists a connector API key only after the active attempt settles", async () => {
    let attemptSignal: AbortSignal | undefined;
    let markAttemptStarted!: () => void;
    let releaseAttempt!: () => void;
    const attemptStarted = new Promise<void>((resolve) => {
      markAttemptStarted = resolve;
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "identity-credential-fence",
        name: "Identity Credential Fence",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: { type: "apiKey" },
      },
      {
        async resolveSourceIdentity({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          return { key: await auth.getToken() };
        },
        async run({ signal }) {
          attemptSignal = signal;
          markAttemptStarted();
          await new Promise<void>((resolve) => {
            releaseAttempt = resolve;
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "identity-credential-fence" });
    const connected = await supervisor.connectSourceWithToken(sourceRecord.id, "old-token");
    expect(connected).toMatchObject({ sourceKey: "old-token", identityStatus: "resolved" });
    const handle = supervisor.start(sourceRecord.id, { trigger: "manual" });
    await attemptStarted;

    let connectSettled = false;
    const reconnecting = supervisor.connectSourceWithToken(sourceRecord.id, "new-token")
      .finally(() => {
        connectSettled = true;
      });
    expect(await waitWithTestTimeout((async () => {
      while (!attemptSignal?.aborted) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);

    expect(connectSettled).toBe(false);
    expect(JSON.parse((await secrets.get(sourceRecord.authRef!))!)).toMatchObject({
      kind: "apiKey",
      value: "old-token",
    });
    await expect(supervisor.connectSourceWithToken(sourceRecord.id, "third-token"))
      .rejects.toThrow("identity mutation in progress");

    releaseAttempt();
    await expect(reconnecting).resolves.toMatchObject({
      sourceKey: "old-token",
      lastResolvedKey: "new-token",
      identityStatus: "changed",
    });
    expect(JSON.parse((await secrets.get(sourceRecord.authRef!))!)).toMatchObject({
      kind: "apiKey",
      value: "new-token",
    });
    expect(await waitWithTestTimeout(handle.promise, 2_000)).toBe(true);
    expect(handle.signal.aborted).toBe(true);
  });

  test("a same-key mutation before the first attempt preserves the run intent behind its barrier", async () => {
    const attempts: string[] = [];
    supervisor.register(
      {
        manifestVersion: 1,
        id: "identity-pre-attempt-barrier",
        name: "Identity Pre-Attempt Barrier",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: { type: "none" },
        config: {
          account: { type: "string", label: "Account" },
          revision: { type: "string", label: "Revision" },
        },
      },
      {
        resolveSourceIdentity({ config }) {
          return { key: (config as { account: string }).account };
        },
        async run({ config, signal }) {
          attempts.push((config as { revision: string }).revision);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = await supervisor.addSource({
      connectorId: "identity-pre-attempt-barrier",
      config: { account: "work", revision: "old" },
    });

    const handle = supervisor.start(sourceRecord.id, { trigger: "manual" });
    const configured = supervisor.configureSource(sourceRecord.id, {
      config: { account: "work", revision: "same-key" },
    });

    await expect(configured).resolves.toMatchObject({
      sourceKey: "work",
      identityStatus: "resolved",
    });
    expect(await waitWithTestTimeout((async () => {
      while (attempts.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);
    expect(attempts).toEqual(["same-key"]);
    expect(handle.signal.aborted).toBe(false);

    handle.abort();
    await expect(handle.promise).resolves.toBeUndefined();
  });

  test("same-key identity mutation replaces one run attempt while changed identity blocks it", async () => {
    const resolutions: string[] = [];
    const attempts: Array<{ account: string; revision: string }> = [];
    supervisor.register(
      {
        manifestVersion: 1,
        id: "identity-run-intent",
        name: "Identity Run Intent",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: { type: "none" },
        config: {
          account: { type: "string", label: "Account" },
          revision: { type: "string", label: "Revision" },
        },
      },
      {
        resolveSourceIdentity({ config }) {
          const value = config as { account: string; revision: string };
          resolutions.push(value.revision);
          return { key: value.account, label: `Suggested ${value.revision}` };
        },
        async run({ config, guard, signal }) {
          const value = config as { account: string; revision: string };
          attempts.push(value);
          await guard.writeEvent({
            type: "identity.intent",
            externalId: value.revision,
            startedAt: attempts.length,
            payload: value,
          });
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = await supervisor.addSource({
      connectorId: "identity-run-intent",
      config: { account: "work", revision: "old" },
    });
    supervisor.renameSource(sourceRecord.id, "Pinned source name");
    const handle = supervisor.start(sourceRecord.id, { trigger: "manual" });
    expect(await waitWithTestTimeout((async () => {
      while (attempts.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);

    const same = await supervisor.configureSource(sourceRecord.id, {
      config: { account: "work", revision: "same-key" },
    });
    expect(same).toMatchObject({
      sourceKey: "work",
      identityStatus: "resolved",
      suggestedLabel: "Suggested same-key",
      displayName: "Pinned source name",
    });
    expect(await waitWithTestTimeout((async () => {
      while (attempts.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);
    expect(handle.signal.aborted).toBe(false);
    expect(resolutions).toEqual(["old", "same-key"]);
    expect(attempts.map(({ revision }) => revision)).toEqual(["old", "same-key"]);
    expect((await supervisor.list())[0]).toMatchObject({
      name: "Pinned source name",
      running: true,
      recentRuns: [expect.objectContaining({ status: "running" })],
    });

    const changed = await supervisor.configureSource(sourceRecord.id, {
      config: { account: "personal", revision: "changed-key" },
    });
    expect(changed).toMatchObject({
      sourceKey: "work",
      lastResolvedKey: "personal",
      identityStatus: "changed",
      suggestedLabel: "Suggested changed-key",
      displayName: "Pinned source name",
    });
    expect(await waitWithTestTimeout(handle.promise, 2_000)).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(attempts.map(({ revision }) => revision)).toEqual(["old", "same-key"]);
    expect((await supervisor.list())[0]).toMatchObject({
      name: "Pinned source name",
      running: false,
      setupPending: expect.arrayContaining(["identity"]),
    });
    expect(dataDb.prepare(
      "SELECT source, external_id FROM events WHERE type = 'identity.intent' ORDER BY started_at",
    ).all()).toEqual([
      { source: "connector:identity-run-intent:work", external_id: "old" },
      { source: "connector:identity-run-intent:work", external_id: "same-key" },
    ]);
  });

  test("explicit credential connect wakes an idle watch and reconnect replaces its active attempt", async () => {
    const tokens: string[] = [];
    const signals: AbortSignal[] = [];
    supervisor.register(
      {
        manifestVersion: 1,
        id: "credential-watch",
        name: "Credential Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "apiKey" },
      },
      {
        async run({ auth, signal }) {
          if (auth.type === "none") throw new Error("expected auth");
          tokens.push(await auth.getToken());
          signals.push(signal);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "credential-watch" });
    const scheduler = new ConnectorScheduler({ supervisor, tickMs: 60_000 });

    await scheduler.start();
    expect(tokens).toEqual([]);

    await supervisor.connectSourceWithToken(sourceRecord.id, "old-token");
    expect(await waitWithTestTimeout((async () => {
      while (tokens.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);
    expect(tokens).toEqual(["old-token"]);

    await supervisor.connectSourceWithToken(sourceRecord.id, "new-token");
    expect(signals[0].aborted).toBe(true);
    expect(await waitWithTestTimeout((async () => {
      while (tokens.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);
    expect(tokens).toEqual(["old-token", "new-token"]);

    const reconnected = (await supervisor.list())[0];
    expect(reconnected.running).toBe(true);
    expect(reconnected.recentRuns).toHaveLength(1);
    expect(reconnected.recentRuns[0].status).toBe("running");

    await scheduler.stop();
    expect((await supervisor.list())[0].recentRuns[0].status).toBe("aborted");
  });

  test("config changes resume a long manual run under the original handle", async () => {
    const configs: Array<Record<string, unknown>> = [];
    let finishReplacement!: () => void;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "reconfigurable-manual",
        name: "Reconfigurable Manual",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          label: { type: "string", label: "Label", default: "old" },
        },
      },
      {
        async run({ config, signal }) {
          configs.push(config as Record<string, unknown>);
          await new Promise<void>((resolve) => {
            if (configs.length > 1) finishReplacement = resolve;
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "reconfigurable-manual",
      config: { label: "old" },
    });
    const handle = supervisor.start(sourceRecord.id, { trigger: "manual" });
    while (configs.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    let settled = false;
    void handle.promise.finally(() => {
      settled = true;
    });

    await supervisor.configureSource(sourceRecord.id, { config: { label: "new" } });
    expect(await waitWithTestTimeout((async () => {
      while (configs.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);

    expect(handle.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(configs).toEqual([
      { label: "old" },
      { label: "new" },
    ]);

    finishReplacement();
    await handle.promise;
    const completed = (await supervisor.list())[0];
    expect(completed.status).toBe("idle");
    expect(completed.recentRuns).toHaveLength(1);
    expect(completed.recentRuns[0].status).toBe("success");
  });

  test("a config change that removes readiness stops rather than restarts the run intent", async () => {
    let attempts = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "invalidated-manual",
        name: "Invalidated Manual",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          identity: { type: "string", label: "Identity" },
        },
      },
      {
        async run({ signal }) {
          attempts += 1;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "invalidated-manual",
      config: { identity: "person@example.com" },
    });
    const handle = supervisor.start(sourceRecord.id, { trigger: "manual" });
    while (attempts < 1) await new Promise((resolve) => setTimeout(resolve, 1));

    await supervisor.configureSource(sourceRecord.id, { config: { identity: "" } });
    await handle.promise;

    const stopped = (await supervisor.list())[0];
    expect(attempts).toBe(1);
    expect(handle.signal.aborted).toBe(true);
    expect(stopped.running).toBe(false);
    expect(stopped.setupStatus).toBe("setup");
    expect(stopped.recentRuns[0].status).toBe("aborted");
  });

  test("an effective config change wakes an idle watch without waiting for the next timer tick", async () => {
    const labels: unknown[] = [];
    supervisor.register(
      {
        manifestVersion: 1,
        id: "idle-config-watch",
        name: "Idle Config Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          label: { type: "string", label: "Label", default: "old" },
        },
      },
      {
        async run({ config, warnings }) {
          const label = (config as Record<string, unknown>).label;
          if (label === "old") {
            await warnings.set({ key: "old-config", message: "Old config is incomplete" });
          } else {
            await warnings.clear("old-config");
          }
          labels.push(label);
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({
      connectorId: "idle-config-watch",
      config: { label: "old" },
    });
    const scheduler = new ConnectorScheduler({ supervisor, tickMs: 60_000 });

    await scheduler.start();
    while ((await supervisor.list())[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await Promise.resolve();
    expect(labels).toEqual(["old"]);
    expect(supervisor.getSource(sourceRecord.id)?.warnings).toHaveLength(1);

    await supervisor.configureSource(sourceRecord.id, { config: { label: "new" } });
    expect(await waitWithTestTimeout((async () => {
      while (labels.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 2_000)).toBe(true);
    expect(labels).toEqual(["old", "new"]);
    expect(supervisor.getSource(sourceRecord.id)?.warnings).toBeUndefined();

    await scheduler.stop();
    await supervisor.configureSource(sourceRecord.id, { config: { label: "after-stop" } });
    await Promise.resolve();
    expect(labels).toEqual(["old", "new"]);
  });

  test("a failed watch reconciliation retries independently of an active scheduler poll", async () => {
    let watchStarts = 0;
    let pollStarted = false;
    let pollFinished = false;
    let failNextList = false;
    let failedLists = 0;
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });

    supervisor.register(
      {
        manifestVersion: 1,
        id: "wake-during-poll-watch",
        name: "Wake During Poll Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
        config: {
          label: { type: "string", label: "Label", default: "old" },
        },
      },
      {
        async run() {
          watchStarts += 1;
        },
      },
    );
    supervisor.register(
      {
        manifestVersion: 1,
        id: "blocking-poll",
        name: "Blocking Poll",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run() {
          pollStarted = true;
          await pollGate;
          pollFinished = true;
        },
      },
    );

    const watch = supervisor.ensureSource({
      connectorId: "wake-during-poll-watch",
      config: { label: "old" },
    });
    supervisor.ensureSource({ connectorId: "blocking-poll" });
    const originalList = supervisor.list;
    supervisor.list = async function listWithOneFailure() {
      if (failNextList) {
        failNextList = false;
        failedLists += 1;
        throw new Error("temporary list failure");
      }
      return originalList.call(this);
    };
    const scheduler = new ConnectorScheduler({
      supervisor,
      tickMs: 60_000,
      watchReconcileRetryMs: 5,
    });
    const starting = scheduler.start();

    try {
      expect(await waitWithTestTimeout((async () => {
        while (!pollStarted || watchStarts < 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      })(), 2_000)).toBe(true);
      while ((await supervisor.list()).find((sourceRecord) => sourceRecord.id === watch.id)?.running) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      failNextList = true;
      await supervisor.configureSource(watch.id, {
        config: { label: "new" },
      });
      expect(await waitWithTestTimeout((async () => {
        while (watchStarts < 2) await new Promise((resolve) => setTimeout(resolve, 1));
      })(), 2_000)).toBe(true);
      expect(failedLists).toBe(1);
      expect(pollFinished).toBe(false);
    } finally {
      supervisor.list = originalList;
      releasePoll();
      await starting;
      await scheduler.stop();
    }
  });

  test("watch reconciliation uses exponential retry capped at 60 seconds", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let requestReconcile: ((instanceId: string) => void) | undefined;
    let failList = false;
    const failureTimes: number[] = [];
    const fakeSupervisor = {
      resumeExpiredPauses() {},
      async list() {
        if (failList) {
          failureTimes.push(Date.now());
          throw new Error("temporary list failure");
        }
        return [];
      },
      onRuntimeReconcileRequested(listener: (instanceId: string) => void) {
        requestReconcile = listener;
        return () => {
          requestReconcile = undefined;
        };
      },
    } as unknown as ConnectorSupervisor;
    const scheduler = new ConnectorScheduler({
      supervisor: fakeSupervisor,
      tickMs: 1_000_000,
    });

    try {
      await scheduler.start();
      const startedAt = Date.now();
      failList = true;

      requestReconcile?.("watch-source");
      await vi.advanceTimersByTimeAsync(0);
      expect(failureTimes.map((time) => time - startedAt)).toEqual([0]);

      // A fresh notification bypasses the pending one-second timer, but does
      // not reset the failure streak. Its next retry therefore waits 2 seconds.
      await vi.advanceTimersByTimeAsync(500);
      requestReconcile?.("watch-source");
      await vi.advanceTimersByTimeAsync(0);
      expect(failureTimes.map((time) => time - startedAt)).toEqual([0, 500]);

      for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(failureTimes.map((time) => time - startedAt)).toEqual([
        0,
        500,
        2_500,
        6_500,
        14_500,
        30_500,
        62_500,
        122_500,
        182_500,
      ]);

      // A successful pass resets the next failure to the one-second base.
      failList = false;
      await vi.advanceTimersByTimeAsync(60_000);
      failList = true;
      requestReconcile?.("watch-source");
      await vi.advanceTimersByTimeAsync(0);
      const failuresAfterReset = failureTimes.length;
      await vi.advanceTimersByTimeAsync(999);
      expect(failureTimes).toHaveLength(failuresAfterReset);
      await vi.advanceTimersByTimeAsync(1);
      expect(failureTimes.at(-1)! - failureTimes.at(-2)!).toBe(1_000);
    } finally {
      failList = false;
      await scheduler.stop();
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("Pause stops an active watch and Resume lets the scheduler start it again", async () => {
    let starts = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "pausable-watch",
        name: "Pausable Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ signal, state }) {
          starts += 1;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await state.set({ stoppedAtStart: starts });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "pausable-watch" });
    const scheduler = new ConnectorScheduler({ supervisor });

    await scheduler.tick();
    expect((await supervisor.list())[0].running).toBe(true);
    expect(starts).toBe(1);

    const paused = await supervisor.pauseSource(sourceRecord.id);
    expect(paused.pausedAt).toBeGreaterThan(0);
    expect((await supervisor.list())[0].running).toBe(false);
    await scheduler.tick();
    expect(starts).toBe(1);

    supervisor.resumeSource(sourceRecord.id);
    await scheduler.tick();
    expect(starts).toBe(2);
    expect((await supervisor.list())[0].running).toBe(true);
    await scheduler.stop();
  });

  test("scheduler stop aborts in-flight poll runs", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "slow-poll",
        name: "Slow Poll",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ signal, state }) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            } else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          await state.set({ aborted: true });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "slow-poll" });
    const scheduler = new ConnectorScheduler({ supervisor });

    const tick = scheduler.tick();
    while (!(await supervisor.list())[0].running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await scheduler.stop();
    await tick;

    expect((await supervisor.list())[0].running).toBe(false);
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("idle");
    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({ aborted: true });
    expect(supervisor.getSource(sourceRecord.id)?.nextRunAt).toBeGreaterThan(0);
  });

  test("scheduler stop does not hang when a run ignores the abort signal", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "stubborn-watch",
        name: "Stubborn Watch",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run() {
          await new Promise(() => {});
        },
      },
    );
    supervisor.ensureSource({ connectorId: "stubborn-watch" });
    const scheduler = new ConnectorScheduler({ supervisor, stopTimeoutMs: 50 });

    await scheduler.start();
    expect((await supervisor.list())[0].running).toBe(true);

    const stopped = await waitWithTestTimeout(scheduler.stop(), 2_000);
    expect(stopped).toBe(true);
  });

  test("scheduler runs due poll connectors and stores the next run time", async () => {
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    let runs = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "poll-feed",
        name: "Poll Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          runs += 1;
          await guard.writeEvent({
            type: "poll.sample",
            externalId: `run-${runs}`,
            startedAt: now,
            payload: { runs },
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "poll-feed" });
    expect(() =>
      supervisor.updateSource(sourceRecord.id, { scheduleCron: "every 1m" })
    ).toThrow("Unsupported connector schedule");
    const scheduler = new ConnectorScheduler({ supervisor, now: () => now });

    await scheduler.tick();
    expect(runs).toBe(1);
    const afterFirstRun = supervisor.getSource(sourceRecord.id);
    expect(afterFirstRun?.nextRunAt).toBe(nextCronRunAt("*/15 * * * *", now));

    await scheduler.tick();
    expect(runs).toBe(1);

    now = afterFirstRun!.nextRunAt!;
    await scheduler.tick();
    expect(runs).toBe(2);
    expect(supervisor.getSource(sourceRecord.id)?.nextRunAt).toBe(nextCronRunAt("*/15 * * * *", now));
  });

  test("timed Pause suppresses poll runs until the scheduler expires it", async () => {
    let runs = 0;
    let now = Date.now();
    supervisor.register(
      {
        manifestVersion: 1,
        id: "timed-poll",
        name: "Timed Poll",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      { async run() { runs += 1; } },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "timed-poll" });
    const paused = await supervisor.pauseSource(sourceRecord.id, 60_000);
    const scheduler = new ConnectorScheduler({ supervisor, now: () => now });

    now = paused.resumeAt! - 1;
    await scheduler.tick();
    expect(runs).toBe(0);
    expect(supervisor.getSource(sourceRecord.id)?.pausedAt).toBeDefined();

    now = paused.resumeAt!;
    await scheduler.tick();
    expect(runs).toBe(1);
    expect(supervisor.getSource(sourceRecord.id)?.pausedAt).toBeUndefined();
    expect(supervisor.getSource(sourceRecord.id)?.resumeAt).toBeUndefined();
  });

  test("Run now is an explicit one-off while a Source remains paused", async () => {
    let runs = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "paused-manual",
        name: "Paused Manual",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      { async run() { runs += 1; } },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "paused-manual" });
    await supervisor.pauseSource(sourceRecord.id);

    await supervisor.run(sourceRecord.id, { trigger: "manual" });
    expect(runs).toBe(1);
    expect(supervisor.getSource(sourceRecord.id)?.pausedAt).toBeDefined();
  });

  test("Pause changes automatic policy without aborting an active manual run", async () => {
    let finish!: () => void;
    let aborted = false;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "manual-in-flight",
        name: "Manual In Flight",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ signal }) {
          signal.addEventListener("abort", () => { aborted = true; }, { once: true });
          await new Promise<void>((resolve) => { finish = resolve; });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "manual-in-flight" });
    const handle = supervisor.start(sourceRecord.id, { trigger: "manual" });
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));

    await supervisor.pauseSource(sourceRecord.id);
    expect(aborted).toBe(false);
    expect((await supervisor.list())[0].running).toBe(true);
    expect(supervisor.getSource(sourceRecord.id)?.pausedAt).toBeDefined();

    finish();
    await handle.promise;
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("idle");
    expect(supervisor.getSource(sourceRecord.id)?.pausedAt).toBeDefined();
  });

  test("scheduler validates poll schedules before running", async () => {
    let runs = 0;
    supervisor.register(
      {
        manifestVersion: 1,
        id: "invalid-schedule-feed",
        name: "Invalid Schedule Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll", defaultSchedule: "*/15 * * * *" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      {
        async run({ guard }) {
          runs += 1;
          await guard.writeEvent({
            type: "invalid-schedule.sample",
            externalId: `run-${runs}`,
            startedAt: 1,
            payload: { runs },
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "invalid-schedule-feed" });
    systemDb.prepare("UPDATE connector_sources SET schedule_cron = ?, next_run_at = NULL WHERE id = ?")
      .run("every 1m", sourceRecord.id);
    const errors: unknown[] = [];
    const scheduler = new ConnectorScheduler({
      supervisor,
      onError(err) {
        errors.push(err);
      },
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(runs).toBe(0);
    expect(errors).toHaveLength(2);
    const event = dataDb.prepare("SELECT * FROM events WHERE type = ?").get("invalid-schedule.sample");
    expect(event).toBeFalsy();
  });

  test("scheduler does not run untrusted workspace connector packages", async () => {
    const sourceDir = join(workspace, "connectors", "untrusted-feed");
    mkdirSync(sourceDir, { recursive: true });
    writeConnectorManifestFixture(
      join(sourceDir, "connector.yaml"),
      `manifestVersion: 1
id: untrusted-feed
name: Untrusted Feed
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(sourceDir, "index.mjs"),
      `export default {
  async run({ guard }) {
    await guard.writeEvent({
      type: "untrusted.sample",
      externalId: "sample",
      startedAt: 1,
      payload: { ok: true },
    });
  },
};
`,
    );

    await registerWorkspaceConnectors(supervisor, workspace);
    supervisor.ensureSource({ connectorId: "untrusted-feed" });
    expect((await supervisor.list())[0].packageTrust).toBe("untrusted");

    const scheduler = new ConnectorScheduler({ supervisor });
    await scheduler.tick();

    const event = dataDb.prepare("SELECT * FROM events WHERE type = ?").get("untrusted.sample");
    expect(event).toBeFalsy();
  });

  test("app-commits syncs app git repos with per-app cursors", async () => {
    const appCommitsUrl = new URL("../../template/connectors/app-commits/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(appCommitsUrl) as {
      syncOnce(context: unknown): Promise<void>;
    };
    const appDir = join(workspace, "apps", "hello-world");
    mkdirSync(appDir, { recursive: true });
    execFileSync("git", ["-C", appDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", appDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", appDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    writeFileSync(join(appDir, "index.tsx"), "export default function App() { return null; }\n");
    execFileSync("git", ["-C", appDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", appDir, "commit", "-m", "Initial app"], { stdio: "ignore" });
    const firstSha = execFileSync("git", ["-C", appDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    let syncState: unknown;
    const events: any[] = [];
	    const context = {
      guard: {
        async writeEvent(event: any) {
          events.push(event);
          return { id: `event-${events.length}` };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      host: { workspacePath: workspace },
      signal: new AbortController().signal,
    };

    await syncOnce(context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "app.commit",
      externalId: `hello-world:${firstSha}`,
      payload: {
        appId: "hello-world",
        commitSha: firstSha,
        authorName: "Test User",
        authorEmail: "test@example.com",
        message: "Initial app",
      },
    });

    writeFileSync(join(appDir, "index.tsx"), "export default function App() { return 'updated'; }\n");
    execFileSync("git", ["-C", appDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", appDir, "commit", "-m", "Update app", "-m", "Refine the render path."], { stdio: "ignore" });
    const secondSha = execFileSync("git", ["-C", appDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    await syncOnce(context);
    expect(events).toHaveLength(2);
    expect(events[1].externalId).toBe(`hello-world:${secondSha}`);
    // Full multi-line message (subject + body) is captured, not just the subject.
    expect(events[1].payload.message).toBe("Update app\n\nRefine the render path.");
    expect(syncState).toEqual({
      apps: {
        "hello-world": { lastSha: secondSha },
      },
    });

    syncState = {
      apps: {
        "hello-world": { lastSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      },
    };
    const fallbackStart = events.length;
    await syncOnce(context);
    expect(events).toHaveLength(fallbackStart + 2);
    expect(events[fallbackStart].payload.message).toBe("Initial app");
    expect(events[fallbackStart + 1].payload.message).toBe("Update app\n\nRefine the render path.");
    expect(syncState).toEqual({
      apps: {
        "hello-world": { lastSha: secondSha },
      },
    });
  });

  test("local-git syncs matching commits from code roots", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown): Promise<void>;
    };
    const rootDir = join(workspace, "Projects");
    const repoDir = join(rootDir, "sample-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    writeFileSync(join(repoDir, "index.ts"), "export const value = 1;\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Initial local work", "-m", "Capture the full commit message."], { stdio: "ignore" });
    const firstSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const objectFormat = execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--show-object-format=storage"],
      { encoding: "utf8" },
    ).trim();

    let syncState: unknown;
    const events: any[] = [];
    const context = {
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${events.length + index}`) };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            capture: {
              commitMessage: "full",
              diffstat: "aggregate",
              codeDiff: false,
              emailInEvents: "raw_and_hash",
            },
          },
          roots: [{ path: rootDir }],
          identities: [{ email: "test@example.com", label: "test" }],
        },
      },
      signal: new AbortController().signal,
    };

    await syncOnce(context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "local_git.commit",
      externalId: `commit:${objectFormat}:${firstSha}`,
      payload: {
        schema: "local_git.commit.v1",
        objectFormat,
        commitSha: firstSha,
        authoredByUser: true,
        committedByUser: true,
        author: {
          name: "Test User",
          email: "test@example.com",
        },
        committer: {
          name: "Test User",
          email: "test@example.com",
        },
        message: {
          mode: "full",
          subject: "Initial local work",
          body: "Initial local work\n\nCapture the full commit message.",
        },
        diffstat: {
          mode: "aggregate",
          filesChanged: 1,
          additions: 1,
          deletions: 0,
        },
        codeDiff: {
          mode: "none",
        },
      },
    });
    expect(events[0].payload.author.emailHash).toMatch(/^sha256:/);

    await syncOnce(context);
    expect(events).toHaveLength(1);
    expect(Object.keys((syncState as any).repos)).toHaveLength(1);
  });

  test("local-git limits commit writes to the configured backfill days", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const rootDir = join(workspace, "Projects");
    const repoDir = join(rootDir, "backfill-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });

    const commitAt = (message: string, date: string) => {
      execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", message], {
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test User",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: "Test User",
          GIT_COMMITTER_EMAIL: "test@example.com",
          GIT_COMMITTER_DATE: date,
        },
      });
      return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    };
    const oldSha = commitAt("Outside default backfill", "2026-06-18T00:00:00Z");
    const recentSha = commitAt("Inside default backfill", "2026-07-08T00:00:00Z");

    let syncState: any;
    const events: any[] = [];
    const context: any = {
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${index}`) };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            capture: {
              commitMessage: "none",
              diffstat: "none",
              codeDiff: false,
              emailInEvents: "hash",
            },
          },
          roots: [{ path: rootDir }],
          identities: [{ email: "test@example.com", label: "test" }],
        },
      },
      signal: new AbortController().signal,
    };

    const now = () => Date.parse("2026-07-28T00:00:00Z");
    await syncOnce(context, { now });

    expect(events.map((event) => event.payload.commitSha)).toEqual([recentSha]);
    expect(Object.values(syncState.repos)[0]).toMatchObject({ backfillDays: 30 });

    context.config.localGit.global.backfillDays = 60;
    await syncOnce(context, { now });

    expect(events.map((event) => event.payload.commitSha)).toEqual([recentSha, oldSha]);
    expect(Object.values(syncState.repos)[0]).toMatchObject({ backfillDays: 60 });
  });

  test("local-git applies explicit repo capture overrides", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown): Promise<void>;
    };
    const rootDir = join(workspace, "Projects");
    const repoDir = join(rootDir, "override-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    writeFileSync(join(repoDir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repoDir, "b.ts"), "export const b = 2;\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Add files"], { stdio: "ignore" });

    let syncState: unknown;
    const events: any[] = [];
    const context = {
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${events.length + index}`) };
        },
        async writeTextBlob(input: any) {
          return {
            ref: { kind: "test", digest: "sha256:test" },
            bytes: input.text.length,
            compressedBytes: input.text.length,
          };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            capture: {
              commitMessage: "full",
              diffstat: "aggregate",
              codeDiff: false,
              emailInEvents: "raw_and_hash",
            },
          },
          roots: [{ path: rootDir }],
          repositories: [{
            path: repoDir,
            capture: {
              commitMessage: "subject",
              diffstat: "files",
              codeDiff: true,
              emailInEvents: "raw",
            },
          }],
          identities: [{ email: "test@example.com", label: "test" }],
        },
      },
      signal: new AbortController().signal,
    };

    await syncOnce(context);
    expect(events).toHaveLength(1);
    expect(events[0].payload.message).toEqual({
      mode: "subject",
      subject: "Add files",
    });
    expect(events[0].payload.diffstat).toMatchObject({
      mode: "files",
      filesChanged: 2,
      additions: 2,
      deletions: 0,
    });
    expect(events[0].payload.diffstat.files.map((file: any) => file.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(events[0].payload.codeDiff).toMatchObject({
      mode: "patch",
      contentRef: { kind: "test", digest: "sha256:test" },
    });
    expect(events[0].payload.author.email).toBe("test@example.com");
    expect(events[0].payload.author.emailHash).toBeUndefined();
  });

  test("local-git does not treat repo overrides as data sources", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown): Promise<void>;
    };
    const repoDir = join(workspace, "outside-root-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    writeFileSync(join(repoDir, "work.ts"), "export const work = true;\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Outside root"], { stdio: "ignore" });

    let syncState: unknown;
    const events: any[] = [];
    const context = {
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${index}`) };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            capture: {
              commitMessage: "full",
              diffstat: "aggregate",
              codeDiff: false,
              emailInEvents: "raw_and_hash",
            },
          },
          roots: [],
          repositories: [{
            path: repoDir,
            capture: {
              commitMessage: "full",
              diffstat: "files",
              codeDiff: false,
              emailInEvents: "raw_and_hash",
            },
          }],
          identities: [{ email: "test@example.com", label: "test" }],
        },
      },
      signal: new AbortController().signal,
    };

    await syncOnce(context);
    expect(events).toHaveLength(0);
    expect(syncState).toBeUndefined();
  });

  test("local-git aborts git scans without advancing repo state", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const rootDir = join(workspace, "Projects");
    const repoDir = join(rootDir, "abort-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    writeFileSync(join(repoDir, "work.ts"), "export const work = true;\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Abort work"], { stdio: "ignore" });

    let syncState: unknown;
    const events: any[] = [];
    const context = {
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${index}`) };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            capture: {
              commitMessage: "full",
              diffstat: "aggregate",
              codeDiff: false,
              emailInEvents: "raw_and_hash",
            },
          },
          roots: [{ path: rootDir }],
          identities: [{ email: "test@example.com", label: "test" }],
        },
      },
      signal: new AbortController().signal,
    };

    const execFileImpl = async (command: string, args: string[]) => {
      if (args.includes("log")) {
        const err = new Error("The operation was aborted");
        (err as any).name = "AbortError";
        throw err;
      }
      return {
        stdout: execFileSync(command, args, { encoding: "utf8" }),
        stderr: "",
      };
    };

    await expect(syncOnce(context, { execFileImpl })).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toHaveLength(0);
    expect(syncState).toBeUndefined();
  });

  test("local-git rescans history when identity emails change", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const rootDir = join(workspace, "Projects");
    const repoDir = join(rootDir, "identity-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });

    const commitAs = (email: string, message: string, date: string) => {
      execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", message], {
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test User",
          GIT_AUTHOR_EMAIL: email,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: "Test User",
          GIT_COMMITTER_EMAIL: email,
          GIT_COMMITTER_DATE: date,
        },
      });
      return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    };
    const oldSha = commitAs("old@example.com", "Old identity work", "2020-01-01T00:00:00Z");
    const newSha = commitAs("new@example.com", "New identity work", "2020-01-02T00:00:00Z");

    let syncState: any;
    const events: any[] = [];
    const context: any = {
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${index}`) };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            backfillDays: 3650,
            capture: {
              commitMessage: "full",
              diffstat: "aggregate",
              codeDiff: false,
              emailInEvents: "raw_and_hash",
            },
          },
          roots: [{ path: rootDir }],
          identities: [{ email: "old@example.com", label: "old" }],
        },
      },
      signal: new AbortController().signal,
    };

    await syncOnce(context, { now: () => Date.UTC(2026, 6, 9) });
    expect(events.map((event) => event.payload.commitSha)).toEqual([oldSha]);
    const oldRepoState = Object.values(syncState.repos)[0] as any;
    expect(oldRepoState.identityFingerprint).toMatch(/^sha256:/);

    context.config.localGit.identities.push({ email: "new@example.com", label: "new" });
    await syncOnce(context, { now: () => Date.UTC(2026, 6, 9, 1) });

    expect(events.map((event) => event.payload.commitSha)).toEqual([oldSha, newSha]);
    const newRepoState = Object.values(syncState.repos)[0] as any;
    expect(newRepoState.identityFingerprint).toMatch(/^sha256:/);
    expect(newRepoState.identityFingerprint).not.toBe(oldRepoState.identityFingerprint);
  });

  test("local-git commit ids do not depend on origin", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const rootDir = join(workspace, "Projects");
    const repoDir = join(rootDir, "origin-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });

    writeFileSync(join(repoDir, "one.ts"), "export const one = 1;\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Before origin"], { stdio: "ignore" });
    const firstSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const objectFormat = execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--show-object-format=storage"],
      { encoding: "utf8" },
    ).trim();

    let syncState: any;
    const events: any[] = [];
    const context = {
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${index}`) };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            capture: {
              commitMessage: "full",
              diffstat: "aggregate",
              codeDiff: false,
              emailInEvents: "raw_and_hash",
            },
          },
          roots: [{ path: rootDir }],
          identities: [{ email: "test@example.com", label: "test" }],
        },
      },
      signal: new AbortController().signal,
    };

    await syncOnce(context);
    expect(events).toHaveLength(1);
    expect(events[0].externalId).toBe(`commit:${objectFormat}:${firstSha}`);
    expect(events[0].payload.repo.normalizedOriginUrl).toBeUndefined();

    execFileSync(
      "git",
      ["-C", repoDir, "remote", "add", "origin", "https://token@example.com/ExampleOrg/Origin-Repo.git"],
      { stdio: "ignore" },
    );
    writeFileSync(join(repoDir, "two.ts"), "export const two = 2;\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "After origin"], { stdio: "ignore" });
    const secondSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    await syncOnce(context);
    expect(events).toHaveLength(2);
    expect(events[1].externalId).toBe(`commit:${objectFormat}:${secondSha}`);
    expect(events[1].payload.repo.normalizedOriginUrl).toBe("https://example.com/exampleorg/origin-repo");
    expect(JSON.stringify(events[1].payload.repo)).not.toContain("token");

    const repoState = Object.values(syncState.repos)[0] as any;
    expect(repoState.normalizedOriginUrl).toBe("https://example.com/exampleorg/origin-repo");
    expect(Object.keys(syncState.repos)).toHaveLength(1);
  });

  test("local-git commit ids survive moving a repo", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown): Promise<void>;
    };
    const rootDir = join(workspace, "Projects");
    const repoDir = join(rootDir, "before-move");
    const movedRepoDir = join(rootDir, "after-move");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "Move-safe commit"], { stdio: "ignore" });

    let syncState: unknown;
    const attempts: any[] = [];
    const materialized = new Map<string, any>();
    const context = {
      guard: {
        async writeEvents(batch: any[]) {
          attempts.push(...batch);
          for (const event of batch) {
            if (!materialized.has(event.externalId)) materialized.set(event.externalId, event);
          }
          return { ids: batch.map((event) => event.externalId) };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            capture: {
              commitMessage: "none",
              diffstat: "none",
              codeDiff: false,
              emailInEvents: "hash",
            },
          },
          roots: [{ path: rootDir }],
          identities: [{ email: "test@example.com", label: "test" }],
        },
      },
      signal: new AbortController().signal,
    };

    await syncOnce(context);
    renameSync(repoDir, movedRepoDir);
    await syncOnce(context);

    expect(attempts).toHaveLength(2);
    expect(attempts[1].externalId).toBe(attempts[0].externalId);
    expect(materialized.size).toBe(1);
    expect(attempts[0].payload.repo.key).toBeUndefined();
    expect(attempts[1].payload.repo.path).not.toBe(attempts[0].payload.repo.path);
  });

  test("local-git namespaces commit ids by Git object format", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(localGitUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const rootDir = join(workspace, "Projects");
    const repoDir = join(rootDir, "sha256-format-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "Format-aware commit"], { stdio: "ignore" });
    const commitSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    let syncState: unknown;
    const events: any[] = [];
    const context = {
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((event) => event.externalId) };
        },
      },
      warnings: {
        async set() {},
        async clear() {},
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        localGit: {
          global: {
            capture: {
              commitMessage: "none",
              diffstat: "none",
              codeDiff: false,
              emailInEvents: "hash",
            },
          },
          roots: [{ path: rootDir }],
          identities: [{ email: "test@example.com", label: "test" }],
        },
      },
      signal: new AbortController().signal,
    };
    const execFileImpl = async (command: string, args: string[]) => {
      if (args.includes("--show-object-format=storage")) {
        return { stdout: "sha256\n", stderr: "" };
      }
      return {
        stdout: execFileSync(command, args, { encoding: "utf8" }),
        stderr: "",
      };
    };

    await syncOnce(context, { execFileImpl });

    expect(events).toHaveLength(1);
    expect(events[0].externalId).toBe(`commit:sha256:${commitSha}`);
    expect(events[0].payload.objectFormat).toBe("sha256");
  });

  test("local-git opens code roots through the connector-owned macOS picker", async () => {
    const localGitUrl = new URL("../../template/connectors/local-git/index.mjs", import.meta.url).href;
    const { chooseCodeRoot } = await import(localGitUrl) as {
      chooseCodeRoot(deps?: unknown): Promise<{ paths: string[] }>;
    };
    const calls: any[] = [];

    const selected = await chooseCodeRoot({
      platform: "darwin",
      async execFileImpl(command: string, args: string[]) {
        calls.push({ command, args });
        return { stdout: "/tmp/local-git-root/\n", stderr: "" };
      },
    });

    expect(calls[0].command).toBe("osascript");
    expect(calls[0].args.join(" ")).toContain("choose folder");
    expect(selected).toEqual({ paths: ["/tmp/local-git-root"] });

    const canceled = await chooseCodeRoot({
      platform: "darwin",
      async execFileImpl() {
        const err = new Error("User canceled.");
        (err as any).code = 1;
        (err as any).stderr = "execution error: User canceled. (-128)";
        throw err;
      },
    });

    expect(canceled).toEqual({ paths: [] });
  });

  function makeCodeAgentContext(config: Record<string, unknown>) {
    let syncState: unknown;
    const events: any[] = [];
    const blobWrites: any[] = [];
    const warnings = new Map<string, any>();
    const context = {
      guard: {
        async writeTextBlob(input: any) {
          blobWrites.push(input);
          const digest = createHash("sha256").update(input.text).digest("hex");
          return {
            ref: {
              kind: "content-blob",
              version: 1,
              digest: "sha256:" + digest,
              variant: input.variant,
              mediaType: input.mediaType,
              encoding: "gzip",
            },
            bytes: Buffer.byteLength(input.text),
            compressedBytes: gzipSync(input.text).byteLength,
          };
        },
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => "event-" + index) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      warnings: {
        async set(warning: any) {
          warnings.set(warning.key, warning);
        },
        async clear(key: string) {
          warnings.delete(key);
        },
      },
      config,
      signal: new AbortController().signal,
    };
    return { context, events, blobWrites, getState: () => syncState, getWarnings: () => warnings };
  }

  test("code-agent-transcripts collapses Windows home paths without matching sibling names", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { collapseHome } = await import(agentUrl) as {
      collapseHome(value: string, homeValue: string): string;
    };
    const windowsHome = String.raw`C:\Users\Alice`;

    expect(collapseHome(
      String.raw`C:\Users\Alice\.codex\sessions\rollout.jsonl`,
      windowsHome,
    )).toBe("~/.codex/sessions/rollout.jsonl");
    expect(collapseHome(
      "c:/users/alice/.claude/projects/session.jsonl",
      windowsHome,
    )).toBe("~/.claude/projects/session.jsonl");
    expect(collapseHome(
      String.raw`C:\Users\Alice-Other\.codex\sessions\rollout.jsonl`,
      windowsHome,
    )).toBe(String.raw`C:\Users\Alice-Other\.codex\sessions\rollout.jsonl`);
  });

  test("code-agent-transcripts surfaces permission errors during transcript discovery", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const claudeRoot = join(workspace, "claude-permission-denied");
    mkdirSync(claudeRoot, { recursive: true });
    const run = makeCodeAgentContext({
      "include-codex": false,
      "include-claude": true,
      "claude-root": claudeRoot,
      "lookback-days": 30,
    });
    const permissionError = new Error("permission denied");
    (permissionError as any).code = "EACCES";

    await expect(syncOnce(run.context, {
      now: Date.UTC(2026, 6, 1, 3),
      async readdirImpl() {
        throw permissionError;
      },
    })).rejects.toMatchObject({ code: "EACCES" });

    expect(run.events).toEqual([]);
  });

  test("code-agent-transcripts discovers resumed Codex rollouts for 90 days while backfilling 30", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-discovery-horizon");
    const now = Date.UTC(2026, 6, 1, 3);

    function writeRollout(
      day: [string, string, string],
      sessionId: string,
      turnId: string,
      message: string,
      modifiedAt: Date,
    ) {
      const dayDir = join(codexRoot, ...day);
      mkdirSync(dayDir, { recursive: true });
      const path = join(dayDir, `${sessionId}.jsonl`);
      writeFileSync(
        path,
        [
          { timestamp: modifiedAt.toISOString(), type: "session_meta", payload: { id: sessionId } },
          { timestamp: modifiedAt.toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
          {
            timestamp: modifiedAt.toISOString(),
            type: "event_msg",
            payload: { type: "task_complete", turn_id: turnId, last_agent_message: message },
          },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      utimesSync(path, modifiedAt, modifiedAt);
    }

    writeRollout(
      ["2026", "04", "15"],
      "within-discovery-session",
      "within-discovery-turn",
      "Resumed inside discovery horizon.",
      new Date("2026-06-30T12:00:00.000Z"),
    );
    writeRollout(
      ["2026", "05", "01"],
      "outside-backfill-session",
      "outside-backfill-turn",
      "Old modification inside discovery horizon.",
      new Date("2026-05-01T12:00:00.000Z"),
    );
    writeRollout(
      ["2026", "03", "15"],
      "outside-discovery-session",
      "outside-discovery-turn",
      "Resumed outside discovery horizon.",
      new Date("2026-06-30T12:00:00.000Z"),
    );

    const defaultRun = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    await syncOnce(defaultRun.context, { now });

    expect(defaultRun.events.map((event) => event.payload.content?.text)).toEqual([
      "Resumed inside discovery horizon.",
    ]);

    const expandedRun = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 120,
    });
    await syncOnce(expandedRun.context, { now });

    expect(new Set(expandedRun.events.map((event) => event.payload.content?.text))).toEqual(new Set([
      "Resumed inside discovery horizon.",
      "Old modification inside discovery horizon.",
      "Resumed outside discovery horizon.",
    ]));
  });

  test("code-agent-transcripts applies lookback days to events inside a resumed transcript", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-event-lookback");
    const dayDir = join(codexRoot, "2026", "04", "15");
    const transcriptPath = join(dayDir, "resumed.jsonl");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        { timestamp: "2026-05-01T00:00:00.000Z", type: "session_meta", payload: { id: "event-lookback-session" } },
        { timestamp: "2026-05-01T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "old-turn" } },
        {
          timestamp: "2026-05-01T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", client_id: "old-human", message: "Old human." },
        },
        {
          timestamp: "2026-05-01T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "old-turn", last_agent_message: "Old agent." },
        },
        { timestamp: "2026-05-31T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "cross-turn" } },
        {
          timestamp: "2026-05-31T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", client_id: "cross-human", message: "Cross-boundary human." },
        },
        {
          timestamp: "2026-06-02T00:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "cross-turn", last_agent_message: "Cross-boundary agent." },
        },
        { timestamp: "2026-06-30T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "new-turn" } },
        {
          timestamp: "2026-06-30T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", client_id: "new-human", message: "New human." },
        },
        {
          timestamp: "2026-06-30T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "new-turn", last_agent_message: "New agent." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const recentMtime = new Date("2026-06-30T12:00:00.000Z");
    utimesSync(transcriptPath, recentMtime, recentMtime);
    const now = Date.UTC(2026, 6, 1, 3);

    const defaultRun = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    await syncOnce(defaultRun.context, { now });

    expect(defaultRun.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
      "code_agent.agent_turn",
    ]);
    expect(defaultRun.events.map((event) => event.payload.content?.text)).toEqual([
      "New human.",
      "Cross-boundary agent.",
      "New agent.",
    ]);
    expect(defaultRun.blobWrites).toHaveLength(2);
    expect(JSON.stringify({
      events: defaultRun.events,
      blobs: defaultRun.blobWrites.map((write) => write.text),
    })).not.toContain("Old human.");
    expect(JSON.stringify({
      events: defaultRun.events,
      blobs: defaultRun.blobWrites.map((write) => write.text),
    })).not.toContain("Old agent.");

    const expandedRun = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 120,
    });
    await syncOnce(expandedRun.context, { now });

    expect(expandedRun.events).toHaveLength(6);
    expect(new Set(expandedRun.events.map((event) => event.payload.content?.text))).toEqual(new Set([
      "Old human.",
      "Cross-boundary human.",
      "New human.",
      "Old agent.",
      "Cross-boundary agent.",
      "New agent.",
    ]));
  });

  test("code-agent-transcripts packs one Codex interaction into human and agent events", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-turn-sessions");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const transcriptPath = join(dayDir, "rollout.jsonl");
    const turnId = "turn-1";
    writeFileSync(
      transcriptPath,
      [
        {
          timestamp: "2026-07-01T02:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-1", cwd: "/Users/alice/project", model: "gpt-5-codex" },
        },
        {
          timestamp: "2026-07-01T02:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: turnId },
        },
        {
          timestamp: "2026-07-01T02:00:01.100Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Run the focused tests." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:01.100Z",
          type: "event_msg",
          payload: { type: "user_message", client_id: "client-1", message: "Run the focused tests." },
        },
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "commentary-1",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Running tests." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "shell",
            arguments: "{\"cmd\":\"npm test\"}",
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:03.500Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "passed",
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:04.000Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Private reasoning." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "final-1",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Focused tests passed." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:05.100Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Focused tests passed." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    const observedAt = Date.UTC(2026, 6, 1, 3);
    await syncOnce(run.context, { now: observedAt });

    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[0]).toMatchObject({
      startedAt: Date.parse("2026-07-01T02:00:01.100Z"),
      payload: {
        provider: "codex",
        content: { text: "Run the focused tests.", truncated: false },
        raw: {
          format: "codex-records",
          recordCount: 1,
          firstSourceLineIndex: 4,
          lastSourceLineIndex: 4,
          ids: { sessionId: "codex-session-1", turnId, clientId: "client-1" },
        },
      },
    });
    expect(run.events[0].payload.raw.contentRef).toBeUndefined();
    expect(run.events[1]).toMatchObject({
      startedAt: Date.parse("2026-07-01T02:00:02.000Z"),
      endedAt: Date.parse("2026-07-01T02:00:05.100Z"),
      payload: {
        provider: "codex",
        interactionId: run.events[0].payload.interactionId,
        status: "completed",
        content: { text: "Focused tests passed.", truncated: false },
        raw: {
          format: "codex-turn-bundle-v1",
          recordCount: 6,
          rootFirstSourceLineIndex: 2,
          rootLastSourceLineIndex: 10,
          ids: { sessionId: "codex-session-1", turnId },
          contentRef: { kind: "content-blob", encoding: "gzip" },
        },
      },
    });
    expect(run.blobWrites).toHaveLength(1);
    expect(run.blobWrites[0].mediaType).toBe("application/json");
    expect(run.events[1].payload.raw.contentRef.mediaType).toBe("application/json");
    const bundle = JSON.parse(run.blobWrites[0].text);
    expect(bundle).toMatchObject({
      version: 1,
      root: {
        role: "main",
        sessionId: "codex-session-1",
        turnId,
        recordCount: 6,
      },
      childTrajectories: [],
    });
    expect(run.blobWrites[0].text).toContain('"type":"function_call_output"');
    expect(run.blobWrites[0].text).toContain('"phase":"final_answer"');
    expect(run.blobWrites[0].text).not.toContain("Private reasoning.");
    expect(run.blobWrites[0].text).not.toContain('"type":"user_message"');
  });

  test("code-agent-transcripts preserves current Codex tool calls and outputs in selected raw", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-current-tool-items");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const turnId = "current-tool-items-turn";
    const toolTypes = [
      "tool_search_call",
      "tool_search_output",
      "local_shell_call",
      "local_shell_call_output",
      "image_generation_call",
    ];
    const records = [
      { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "current-tool-items-session" } },
      { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      ...toolTypes.map((type, index) => ({
        timestamp: `2026-07-01T02:00:0${index + 2}.000Z`,
        type: "response_item",
        payload: {
          type,
          call_id: `current-tool-call-${index}`,
          output: `current-tool-output-${index}`,
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      })),
      {
        timestamp: "2026-07-01T02:00:08.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Current tools captured." },
      },
    ];
    writeFileSync(
      join(dayDir, "rollout.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 3) });

    expect(run.events).toHaveLength(1);
    expect(run.events[0].payload.content.text).toBe("Current tools captured.");
    const bundle = JSON.parse(run.blobWrites[0].text);
    const selectedTypes = bundle.root.records
      .map((wrapper: any) => wrapper.record.payload?.type)
      .filter((type: unknown) => toolTypes.includes(String(type)));
    expect(selectedTypes).toEqual(toolTypes);
  });

  test("code-agent-transcripts preserves Codex inter-agent communication in root raw", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-inter-agent-communication");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const turnId = "inter-agent-turn";
    writeFileSync(
      join(dayDir, "rollout.jsonl"),
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "inter-agent-session" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "inter_agent_communication",
          payload: {
            author: "/root/worker",
            recipient: "/root",
            other_recipients: [],
            content: "Worker result for this turn.",
            trigger_turn: false,
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:02.500Z",
          type: "inter_agent_communication",
          payload: {
            author: "/root/other",
            recipient: "/root",
            other_recipients: [],
            content: "Message from a different turn.",
            trigger_turn: false,
            internal_chat_message_metadata_passthrough: { turn_id: "different-turn" },
          },
        },
        {
          timestamp: "2026-07-01T02:00:03.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Root turn complete." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 3) });

    expect(run.events).toHaveLength(1);
    expect(run.events[0].payload.content.text).toBe("Root turn complete.");
    const bundle = JSON.parse(run.blobWrites[0].text);
    const communications = bundle.root.records
      .map((wrapper: any) => wrapper.record)
      .filter((record: any) => record.type === "inter_agent_communication");
    expect(communications).toHaveLength(1);
    expect(communications[0].payload.content).toBe("Worker result for this turn.");
    expect(run.blobWrites[0].text).not.toContain("Message from a different turn.");
  });

  test("code-agent-transcripts redacts structured secrets inside JSON-encoded tool payloads", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-json-tool-secrets");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const turnId = "json-secret-turn";
    const password = "short-secret-value";
    const apiKey = "another-short-secret";
    const argumentsJson = `{ "username": "alice", "exactInteger": 9007199254740993, "negativeZero": -0, "password": "${password}" }`;
    const losslessJson = '{ "exactInteger": 9007199254740993, "negativeZero": -0 }';
    writeFileSync(
      join(dayDir, "rollout.jsonl"),
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "json-secret-session" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "json-secret-call",
            name: "authenticate",
            arguments: argumentsJson,
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:02.500Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "json-lossless-call",
            name: "inspect",
            arguments: losslessJson,
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "json-secret-call",
            output: JSON.stringify({ ok: true, nested: { apiKey } }),
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:04.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Authenticated." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 3) });

    const bundle = JSON.parse(run.blobWrites[0].text);
    const payloads = bundle.root.records.map((wrapper: any) => wrapper.record.payload);
    const call = payloads.find((payload: any) => payload.call_id === "json-secret-call");
    const losslessCall = payloads.find((payload: any) => payload.call_id === "json-lossless-call");
    const output = payloads.find((payload: any) => payload.type === "function_call_output");
    expect(call.arguments).toBe("[REDACTED_STRUCTURED_VALUE]");
    expect(losslessCall.arguments).toBe(losslessJson);
    expect(output.output).toBe("[REDACTED_STRUCTURED_VALUE]");
    expect(run.blobWrites[0].text).not.toContain(password);
    expect(run.blobWrites[0].text).not.toContain(apiKey);
  });

  test("code-agent-transcripts redacts a structured field that exceeds its inspection depth", async () => {
    const redactionUrl = new URL(
      "../../template/connectors/code-agent-transcripts/redaction.mjs",
      import.meta.url,
    ).href;
    const { redactValue } = await import(redactionUrl) as {
      redactValue(value: unknown, fieldName?: string, depth?: number): any;
    };
    const secret = "tiny-secret";
    const nestedJson = "[".repeat(50_000)
      + `{"password":"${secret}"}`
      + "]".repeat(50_000);

    expect(() => JSON.parse(nestedJson)).not.toThrow();
    const redacted = redactValue({ arguments: nestedJson }).arguments;
    expect(redacted).toBe("[REDACTED_STRUCTURED_VALUE]");
    expect(redacted).not.toContain(secret);
  });

  test("code-agent-transcripts elides only explicit provider-native base64 payloads", async () => {
    const redactionUrl = new URL(
      "../../template/connectors/code-agent-transcripts/redaction.mjs",
      import.meta.url,
    ).href;
    const { redactValue } = await import(redactionUrl) as {
      redactValue(value: unknown, fieldName?: string, depth?: number): any;
    };
    const codexImage = "A".repeat(5_000);
    const claudeImage = "B".repeat(5_000);
    const unrelatedEncodedValue = "C".repeat(5_000);

    expect(redactValue({
      codex: { type: "image_generation_call", result: codexImage },
      claude: { source: { type: "base64", data: claudeImage } },
      checksum: unrelatedEncodedValue,
    })).toEqual({
      codex: { type: "image_generation_call", result: "[REDACTED_PAYLOAD]" },
      claude: { source: { type: "base64", data: "[REDACTED_PAYLOAD]" } },
      checksum: unrelatedEncodedValue,
    });
  });

  test("code-agent-transcripts keeps replayed parent turns and native fork turns on their own sessions", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-forked-session-identity");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const parentSessionId = "019ef405-c421-7cc0-9eae-94a7049df323";
    const parentTurnId = "019efbb0-834d-7150-91ba-7e14b20724f4";
    const forkSessionId = "019efe12-e569-7440-892a-6f4dd49937bd";
    const forkTurnId = "019efe12-f09c-7fe1-ad1f-d0a2848b4453";
    const transcriptPath = join(dayDir, "rollout.jsonl");
    const records = [
      {
        timestamp: "2026-06-25T09:18:31.923Z",
        type: "session_meta",
        payload: {
          id: forkSessionId,
          session_id: forkSessionId,
          timestamp: "2026-06-25T09:18:31.814Z",
          forked_from_id: parentSessionId,
          thread_source: "cli",
        },
      },
      {
        timestamp: "2026-06-25T09:18:31.923Z",
        type: "session_meta",
        payload: {
          id: parentSessionId,
          session_id: parentSessionId,
          timestamp: "2026-06-23T10:27:59.179Z",
          thread_source: "cli",
        },
      },
      { timestamp: "2026-06-25T09:18:31.924Z", type: "event_msg", payload: { type: "task_started", turn_id: parentTurnId } },
      { timestamp: "2026-06-25T09:18:31.924Z", type: "event_msg", payload: { type: "user_message", client_id: "parent-client", message: "Parent prompt." } },
      {
        timestamp: "2026-06-25T09:18:31.924Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Parent answer." }],
          internal_chat_message_metadata_passthrough: { turn_id: parentTurnId },
        },
      },
      { timestamp: "2026-06-25T09:18:31.924Z", type: "event_msg", payload: { type: "task_complete", turn_id: parentTurnId, last_agent_message: "Parent answer." } },
      { timestamp: "2026-06-25T09:18:34.658Z", type: "event_msg", payload: { type: "task_started", turn_id: forkTurnId } },
      { timestamp: "2026-06-25T09:18:34.688Z", type: "event_msg", payload: { type: "user_message", client_id: "fork-client", message: "Fork prompt." } },
      {
        timestamp: "2026-06-25T09:18:35.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Fork answer." }],
          internal_chat_message_metadata_passthrough: { turn_id: forkTurnId },
        },
      },
      { timestamp: "2026-06-25T09:19:22.444Z", type: "event_msg", payload: { type: "task_complete", turn_id: forkTurnId, last_agent_message: "Fork answer." } },
    ];
    writeFileSync(
      transcriptPath,
      records.slice(0, 4).map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    const observedAt = Date.UTC(2026, 6, 1, 3);
    await syncOnce(run.context, { now: observedAt });
    const firstCursor = Object.values((run.getState() as any).files)[0] as any;
    expect(firstCursor.openInteractions[parentTurnId].sessionId).toBe(parentSessionId);
    expect(firstCursor.session).toMatchObject({
      id: parentSessionId,
      canonicalSessionId: forkSessionId,
      canonicalMetadataSeen: true,
    });

    appendFileSync(
      transcriptPath,
      records.slice(4).map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    await syncOnce(run.context, { now: observedAt + 1_000 });

    const parentEvents = run.events.filter((event) => event.payload.raw.ids.turnId === parentTurnId);
    const forkEvents = run.events.filter((event) => event.payload.raw.ids.turnId === forkTurnId);
    expect(parentEvents).toHaveLength(2);
    expect(parentEvents[0].payload.interactionId).toBe(parentEvents[1].payload.interactionId);
    expect(parentEvents.map((event) => event.payload.raw.ids.sessionId)).toEqual([
      parentSessionId,
      parentSessionId,
    ]);
    expect(forkEvents).toHaveLength(2);
    expect(forkEvents[0].payload.interactionId).toBe(forkEvents[1].payload.interactionId);
    expect(forkEvents.map((event) => event.payload.raw.ids.sessionId)).toEqual([
      forkSessionId,
      forkSessionId,
    ]);
    expect(run.blobWrites.map((write) => JSON.parse(write.text).root.sessionId)).toEqual([
      parentSessionId,
      forkSessionId,
    ]);
  });

  test("code-agent-transcripts preserves the model for each Codex turn closed in one scan", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-turn-models");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const records: any[] = [
      {
        timestamp: "2026-07-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "model-session", model: "session-default", thread_source: "cli" },
      },
    ];
    for (const [index, turn] of [
      { id: "model-turn-one", model: "model-one", prompt: "First model?", answer: "First model." },
      { id: "model-turn-two", model: "model-two", prompt: "Second model?", answer: "Second model." },
    ].entries()) {
      const second = index + 1;
      records.push(
        {
          timestamp: `2026-07-01T02:00:0${second}.000Z`,
          type: "event_msg",
          payload: { type: "task_started", turn_id: turn.id },
        },
        {
          timestamp: `2026-07-01T02:00:0${second}.010Z`,
          type: "turn_context",
          payload: { model: turn.model },
        },
        {
          timestamp: `2026-07-01T02:00:0${second}.020Z`,
          type: "event_msg",
          payload: { type: "user_message", client_id: `${turn.id}-client`, message: turn.prompt },
        },
        {
          timestamp: `2026-07-01T02:00:0${second}.030Z`,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: turn.answer }],
            internal_chat_message_metadata_passthrough: { turn_id: turn.id },
          },
        },
        {
          timestamp: `2026-07-01T02:00:0${second}.040Z`,
          type: "event_msg",
          payload: { type: "task_complete", turn_id: turn.id, last_agent_message: turn.answer },
        },
      );
    }
    writeFileSync(
      join(dayDir, "rollout.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 3) });

    expect(run.events.filter((event) => event.type === "code_agent.agent_turn")
      .map((event) => event.payload.content.text)).toEqual([
      "First model.",
      "Second model.",
    ]);
    expect(run.blobWrites.map((write) => JSON.parse(write.text).root.model)).toEqual([
      "model-one",
      "model-two",
    ]);
  });

  test("code-agent-transcripts excludes internal Codex sessions from D0", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-internal-sessions");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const turnId = "memory-turn";
    writeFileSync(
      join(dayDir, "memory-rollout.jsonl"),
      [
        {
          timestamp: "2026-07-01T02:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "memory-session",
            source: { internal: "memory_consolidation" },
          },
        },
        {
          timestamp: "2026-07-01T02:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: turnId },
        },
        {
          timestamp: "2026-07-01T02:00:01.100Z",
          type: "event_msg",
          payload: { type: "user_message", client_id: "memory-client", message: "Consolidate memory." },
        },
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Memory consolidated." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:02.100Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Memory consolidated." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 3) });

    expect(run.events).toEqual([]);
    expect(run.blobWrites).toEqual([]);
  });

  test("code-agent-transcripts marks a Codex task_complete terminal error as failed", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-failed-turn");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const turnId = "failed-turn";
    const terminalError = {
      message: "stream disconnected before completion",
      codex_error_info: "other",
    };
    writeFileSync(
      join(dayDir, "rollout.jsonl"),
      [
        {
          timestamp: "2026-07-01T02:00:00.000Z",
          type: "session_meta",
          payload: { id: "failed-session", thread_source: "user" },
        },
        {
          timestamp: "2026-07-01T02:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: turnId },
        },
        {
          timestamp: "2026-07-01T02:00:01.100Z",
          type: "event_msg",
          payload: { type: "user_message", client_id: "failed-client", message: "Finish the task." },
        },
        {
          timestamp: "2026-07-01T02:00:02.100Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: turnId,
            last_agent_message: null,
            error: terminalError,
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 3) });

    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[1].startedAt).toBe(Date.parse("2026-07-01T02:00:01.000Z"));
    expect(run.events[1].endedAt).toBe(Date.parse("2026-07-01T02:00:02.100Z"));
    expect(run.events[1].payload.status).toBe("failed");
    expect(run.events[1].payload.content).toBeUndefined();
    expect(run.blobWrites).toHaveLength(1);
    const bundle = JSON.parse(run.blobWrites[0].text);
    expect(bundle.root.status).toBe("failed");
    expect(bundle.root.records.at(-1).record.payload.error).toEqual(terminalError);
  });

  test("code-agent-transcripts ignores Codex subagents and emits the root without waiting", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-subagent-sessions");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const rootPath = join(dayDir, "root-rollout.jsonl");
    const childPath = join(dayDir, "guardian-rollout.jsonl");
    const rootSessionId = "root-session";
    const rootTurnId = "root-turn";
    const childSessionId = "guardian-session";
    const childTurnId = "guardian-turn";

    writeFileSync(
      rootPath,
      [
        {
          timestamp: "2026-07-01T02:00:00.000Z",
          type: "session_meta",
          payload: { id: rootSessionId, thread_source: "cli", cwd: "/Users/alice/project" },
        },
        {
          timestamp: "2026-07-01T02:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: rootTurnId },
        },
        {
          timestamp: "2026-07-01T02:00:01.100Z",
          type: "event_msg",
          payload: { type: "user_message", client_id: "root-client", message: "Inspect the build." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    writeFileSync(
      childPath,
      [
        {
          timestamp: "2026-07-01T02:00:01.200Z",
          type: "session_meta",
          payload: {
            id: childSessionId,
            parent_thread_id: rootSessionId,
            thread_source: "subagent",
            source: { subagent: { other: "guardian" } },
          },
        },
        {
          timestamp: "2026-07-01T02:00:01.300Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: childTurnId },
        },
        {
          timestamp: "2026-07-01T02:00:01.400Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Assess this approval request." }],
            internal_chat_message_metadata_passthrough: { turn_id: childTurnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:01.400Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Assess this approval request." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    const observedAt = Date.UTC(2026, 6, 1, 3);
    await syncOnce(run.context, { now: observedAt });

    expect(run.events.map((event) => event.type)).toEqual(["code_agent.human_message"]);
    expect(JSON.stringify(run.events)).not.toContain('{\\"outcome\\":\\"allow\\"}');

    appendFileSync(
      rootPath,
      [
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "The build is safe." }],
            internal_chat_message_metadata_passthrough: { turn_id: rootTurnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:02.100Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: rootTurnId, last_agent_message: "The build is safe." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    await syncOnce(run.context, { now: observedAt });

    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[1]).toMatchObject({
      payload: {
        conversationKey: expect.stringContaining("root-rollout.jsonl"),
        content: { text: "The build is safe.", truncated: false },
        raw: {
          format: "codex-turn-bundle-v1",
          recordCount: 3,
          ids: { sessionId: rootSessionId, turnId: rootTurnId },
          contentRef: { kind: "content-blob", encoding: "gzip" },
        },
      },
    });
    expect(run.blobWrites).toHaveLength(1);
    const bundle = JSON.parse(run.blobWrites[0].text);
    expect(bundle.root).toMatchObject({ role: "main", sessionId: rootSessionId, turnId: rootTurnId, recordCount: 3 });
    expect(bundle.childTrajectories).toEqual([]);

    appendFileSync(
      childPath,
      [
        {
          timestamp: "2026-07-01T02:00:02.200Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: '{"outcome":"allow"}' }],
            internal_chat_message_metadata_passthrough: { turn_id: childTurnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:02.300Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: childTurnId, last_agent_message: '{"outcome":"allow"}' },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    await syncOnce(run.context, { now: observedAt + 1_000 });

    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    const d0AgentTurn = JSON.stringify(run.events[1]);
    expect(d0AgentTurn).not.toContain("allow");
    expect(d0AgentTurn).not.toContain(childSessionId);
    expect(d0AgentTurn).not.toContain("Assess this approval request.");
    expect(run.blobWrites).toHaveLength(1);
    expect(run.blobWrites[0].text).not.toContain("allow");
  });

  test("code-agent-transcripts fast-forwards a non-root Codex transcript after canonical metadata", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncTranscriptFile } = await import(agentUrl) as {
      syncTranscriptFile(options: unknown): Promise<any>;
    };
    const codexRoot = join(workspace, "codex-fast-forward-child");
    const childPath = join(codexRoot, "2026", "07", "01", "guardian.jsonl");
    mkdirSync(dirname(childPath), { recursive: true });
    const metadataLine = JSON.stringify({
      timestamp: "2026-07-01T02:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "child-session",
        thread_source: "subagent",
        source: { subagent: { other: "guardian" } },
      },
    });
    writeFileSync(
      childPath,
      `${metadataLine}\n${Array.from({ length: 100 }, (_, index) => JSON.stringify({
        type: "response_item",
        payload: { type: "message", index },
      })).join("\n")}\n`,
    );
    const fileInfo = statSync(childPath);
    let recordsRead = 0;

    const result = await syncTranscriptFile({
      provider: "codex",
      root: codexRoot,
      file: {
        path: childPath,
        size: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs,
      },
      cursor: {
        lineCount: 0,
        byteOffset: 0,
        size: 0,
        mtimeMs: 0,
        session: {},
        openInteractions: {},
      },
      config: {
        "include-reasoning": false,
      },
      signal: new AbortController().signal,
      async *readLinesImpl() {
        recordsRead += 1;
        yield metadataLine;
        recordsRead += 1;
        throw new Error("non-root transcript tail was read");
      },
    });

    expect(recordsRead).toBe(1);
    expect(result.events).toEqual([]);
    expect(result.cursor).toMatchObject({
      byteOffset: fileInfo.size,
      session: {
        canonicalSessionId: "child-session",
        canonicalMetadataSeen: true,
        isSubagent: true,
      },
      openInteractions: {},
    });
  });

  test("code-agent-transcripts keeps a persistent unreadable child isolated from root capture", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { runWatch } = await import(agentUrl) as {
      runWatch(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-unreadable-child");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const childPath = join(dayDir, "00-guardian.jsonl");
    const rootPath = join(dayDir, "99-root.jsonl");
    writeFileSync(childPath, JSON.stringify({ type: "session_meta", payload: { id: "child-session", thread_source: "subagent" } }) + "\n");
    writeFileSync(
      rootPath,
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "root-session", thread_source: "cli" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "root-turn" } },
        { timestamp: "2026-07-01T02:00:01.100Z", type: "event_msg", payload: { type: "user_message", client_id: "root-client", message: "Capture the root." } },
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Root captured." }],
            internal_chat_message_metadata_passthrough: { turn_id: "root-turn" },
          },
        },
        { timestamp: "2026-07-01T02:00:02.100Z", type: "event_msg", payload: { type: "task_complete", turn_id: "root-turn", last_agent_message: "Root captured." } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    const controller = new AbortController();
    (run.context as any).signal = controller.signal;
    let childReadAttempts = 0;
    async function* readLinesImpl(path: string, startOffset: number) {
      if (path === childPath) {
        childReadAttempts += 1;
        const error = new Error("child disappeared");
        (error as any).code = "ENOENT";
        throw error;
      }
      const text = readFileSync(path).subarray(startOffset).toString("utf8");
      for (const line of text.split("\n")) {
        if (line) yield line;
      }
    }

    let waits = 0;
    await runWatch(run.context, {
      syncOnceDeps: {
        now: Date.UTC(2026, 6, 1, 3),
        readLinesImpl,
      },
      async waitImpl() {
        waits += 1;
        if (waits === 4) controller.abort();
      },
    });

    expect(childReadAttempts).toBe(4);
    expect(waits).toBe(4);
    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[1].payload.content.text).toBe("Root captured.");
    expect(run.getWarnings().get("code-agent-transcripts-files")).toMatchObject({
      details: {
        failures: [{ provider: "codex", sourceFile: childPath, error: "child disappeared" }],
      },
    });
  });

  test("code-agent-transcripts suppresses Claude subagent transcript files and inline sidechain records", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const claudeRoot = join(workspace, "claude-subagent-suppression");
    const projectDir = join(claudeRoot, "Users-alice-project");
    const subagentsDir = join(projectDir, "session-root", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session.jsonl"),
      [
        {
          type: "user",
          uuid: "human-root",
          promptId: "prompt-root",
          userType: "external",
          sessionId: "claude-session-root",
          timestamp: "2026-07-01T01:00:01.000Z",
          message: { role: "user", content: "Start the root." },
        },
        {
          type: "assistant",
          uuid: "sidechain-final",
          isSidechain: true,
          agentId: "agent-abc",
          sessionId: "claude-session-root",
          timestamp: "2026-07-01T01:00:02.000Z",
          message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Sidechain aside." }] },
        },
        {
          type: "assistant",
          uuid: "assistant-root",
          sessionId: "claude-session-root",
          timestamp: "2026-07-01T01:00:03.000Z",
          message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Root done." }] },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    writeFileSync(
      join(subagentsDir, "agent-abc.jsonl"),
      [
        {
          type: "user",
          uuid: "child-prompt",
          isSidechain: true,
          agentId: "agent-abc",
          sessionId: "claude-session-root",
          timestamp: "2026-07-01T01:00:01.500Z",
          message: { role: "user", content: "Child prompt." },
        },
        {
          type: "assistant",
          uuid: "child-final",
          isSidechain: true,
          agentId: "agent-abc",
          sessionId: "claude-session-root",
          timestamp: "2026-07-01T01:00:01.900Z",
          message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Child done." }] },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": false,
      "include-claude": true,
      "claude-root": claudeRoot,
      "lookback-days": 30,
    });
    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 2) });

    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[1].payload.content.text).toBe("Root done.");
    expect(run.events[1].endedAt).toBe(Date.parse("2026-07-01T01:00:03.000Z"));
    const serializedEvents = JSON.stringify(run.events);
    expect(serializedEvents).not.toContain("Sidechain aside.");
    expect(serializedEvents).not.toContain("Child done.");
    expect(run.blobWrites).toHaveLength(1);
    expect(run.blobWrites[0].text).not.toContain("Sidechain aside.");
    const stateFiles = Object.keys((run.getState() as any).files);
    expect(stateFiles).toHaveLength(1);
    expect(stateFiles[0]).not.toContain("subagents");
  });

  test("code-agent-transcripts keeps bounded cursor state while a Codex turn is open", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-open-turn");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const transcriptPath = join(dayDir, "rollout.jsonl");
    const turnId = "turn-open";
    writeFileSync(
      transcriptPath,
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "session-open" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
        { timestamp: "2026-07-01T02:00:01.100Z", type: "event_msg", payload: { type: "user_message", client_id: "client-open", message: "Start." } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });

    const observedAt = Date.UTC(2026, 6, 1, 3);
    await syncOnce(run.context, { now: observedAt });
    expect(run.events.map((event) => event.type)).toEqual(["code_agent.human_message"]);
    expect(run.blobWrites).toHaveLength(0);
    const firstState = run.getState() as any;
    expect(firstState.version).toBe(1);
    expect(Object.values(firstState.files)[0]).toMatchObject({
      activeInteractionId: turnId,
      openInteractions: {
        [turnId]: {
          providerInteractionId: turnId,
          startLineIndex: 2,
        },
      },
    });
    expect(JSON.stringify(firstState)).not.toContain("Start.");

    appendFileSync(
      transcriptPath,
      [
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Done." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        {
          timestamp: "2026-07-01T02:00:02.100Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Done." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    await syncOnce(run.context, { now: observedAt });
    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.blobWrites).toHaveLength(1);
    expect(run.blobWrites[0].text).toContain('"type":"task_started"');
    expect((run.getState() as any).files[Object.keys((run.getState() as any).files)[0]].openInteractions).toEqual({});
  });

  test("code-agent-transcripts leaves a complete JSON record pending until its newline arrives", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-partial-turn");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const transcriptPath = join(dayDir, "rollout.jsonl");
    const turnId = "turn-partial";
    const completePrefix = [
      { timestamp: "2026-07-01T02:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-01T02:00:00.100Z", type: "event_msg", payload: { type: "user_message", client_id: "client-partial", message: "Wait for closure." } },
      {
        timestamp: "2026-07-01T02:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Closed." }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    const closure = JSON.stringify({
      timestamp: "2026-07-01T02:00:01.100Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Closed." },
    });
    writeFileSync(transcriptPath, completePrefix + closure);
    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });

    const observedAt = Date.UTC(2026, 6, 1, 3);
    await syncOnce(run.context, { now: observedAt });
    expect(run.events.map((event) => event.type)).toEqual(["code_agent.human_message"]);
    const firstCursor = Object.values((run.getState() as any).files)[0] as any;
    expect(firstCursor.lineCount).toBe(3);
    expect(firstCursor.byteOffset).toBe(Buffer.byteLength(completePrefix));

    appendFileSync(transcriptPath, "\n");
    await syncOnce(run.context, { now: observedAt });
    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[1].payload.content.text).toBe("Closed.");
  });

  test("code-agent-transcripts isolates an unsignaled AbortError during root materialization", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-aborted-materialization");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const transcriptPath = join(dayDir, "rollout.jsonl");
    const turnId = "turn-aborted-materialization";
    writeFileSync(
      transcriptPath,
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "session-aborted-materialization" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
        { timestamp: "2026-07-01T02:00:01.100Z", type: "event_msg", payload: { type: "user_message", client_id: "client-aborted-materialization", message: "Finish safely." } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });

    const observedAt = Date.UTC(2026, 6, 1, 3);
    await syncOnce(run.context, { now: observedAt });
    appendFileSync(
      transcriptPath,
      [
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Safely finished." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        { timestamp: "2026-07-01T02:00:02.100Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Safely finished." } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const stateBeforeMaterialization = JSON.parse(JSON.stringify(run.getState()));
    const originalWriteTextBlob = (run.context as any).guard.writeTextBlob;
    (run.context as any).guard.writeTextBlob = async () => {
      const error = new Error("materialization aborted");
      error.name = "AbortError";
      throw error;
    };

    await syncOnce(run.context, { now: observedAt });
    expect((run.context as any).signal.aborted).toBe(false);
    expect(run.getState()).toEqual(stateBeforeMaterialization);
    expect(run.events.map((event) => event.type)).toEqual(["code_agent.human_message"]);
    expect(run.blobWrites).toEqual([]);
    expect(run.getWarnings().get("code-agent-transcripts-files")).toMatchObject({
      details: {
        failures: [{ provider: "codex", error: "materialization aborted" }],
      },
    });

    (run.context as any).guard.writeTextBlob = originalWriteTextBlob;
    await syncOnce(run.context, { now: observedAt + 30_000 });
    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[1].payload.content.text).toBe("Safely finished.");
    expect(run.getWarnings().size).toBe(0);
  });

  test("code-agent-transcripts exhausts retries for a root identified during initial materialization", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { runWatch } = await import(agentUrl) as {
      runWatch(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-initial-materialization-failure");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const transcriptPath = join(dayDir, "rollout.jsonl");
    const turnId = "initial-materialization-turn";
    writeFileSync(
      transcriptPath,
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "initial-materialization-session", thread_source: "cli" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
        { timestamp: "2026-07-01T02:00:01.100Z", type: "event_msg", payload: { type: "user_message", client_id: "initial-materialization-client", message: "Capture this root." } },
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Root captured." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        },
        { timestamp: "2026-07-01T02:00:02.100Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Root captured." } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    let materializationAttempts = 0;
    async function* readLinesImpl(path: string, startOffset: number) {
      if (startOffset > 0) {
        materializationAttempts += 1;
        throw new Error("permanent initial root materialization failure");
      }
      const text = readFileSync(path).subarray(startOffset).toString("utf8");
      for (const line of text.split("\n")) {
        if (line) yield line;
      }
    }
    const warningScopes: string[] = [];
    let waits = 0;

    await expect(runWatch(run.context, {
      syncOnceDeps: {
        now: Date.UTC(2026, 6, 1, 3),
        readLinesImpl,
      },
      async waitImpl() {
        waits += 1;
        const failure = run.getWarnings()
          .get("code-agent-transcripts-files")
          ?.details?.failures?.[0];
        if (failure?.scope) warningScopes.push(failure.scope);
      },
    })).rejects.toThrow(
      "failed after 3 retries: permanent initial root materialization failure",
    );

    expect(materializationAttempts).toBe(4);
    expect(waits).toBe(3);
    expect(warningScopes).toEqual(["root", "root", "root"]);
    expect(run.events).toEqual([]);
    expect(run.getWarnings().size).toBe(0);
  });

  test("code-agent-transcripts watch retries transient failures, exits on cancellation, and enforces its retry budget", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { runWatch } = await import(agentUrl) as {
      runWatch(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-watch-retry");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, "rollout.jsonl"),
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "watch-session" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "watch-turn" } },
        { timestamp: "2026-07-01T02:00:01.100Z", type: "event_msg", payload: { type: "user_message", client_id: "watch-client", message: "Retry this root." } },
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Retry succeeded." }],
            internal_chat_message_metadata_passthrough: { turn_id: "watch-turn" },
          },
        },
        { timestamp: "2026-07-01T02:00:02.100Z", type: "event_msg", payload: { type: "task_complete", turn_id: "watch-turn", last_agent_message: "Retry succeeded." } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    const controller = new AbortController();
    (run.context as any).signal = controller.signal;

    const originalStateGet = (run.context as any).state.get;
    let stateGetAttempts = 0;
    (run.context as any).state.get = async () => {
      stateGetAttempts += 1;
      if (stateGetAttempts === 1) throw new Error("temporary state read failure");
      return originalStateGet();
    };

    const originalWriteTextBlob = (run.context as any).guard.writeTextBlob;
    let blobAttempts = 0;
    (run.context as any).guard.writeTextBlob = async (input: any) => {
      blobAttempts += 1;
      if (blobAttempts === 1) {
        const error = new Error("temporary blob write abort");
        error.name = "AbortError";
        throw error;
      }
      return originalWriteTextBlob(input);
    };

    const originalWriteEvents = (run.context as any).guard.writeEvents;
    (run.context as any).guard.writeEvents = async (events: any[]) => {
      const result = await originalWriteEvents(events);
      controller.abort();
      return result;
    };

    let waits = 0;
    await runWatch(run.context, {
      syncOnceDeps: { now: Date.UTC(2026, 6, 1, 3) },
      async waitImpl() {
        waits += 1;
        if (waits > 3) throw new Error("watch did not recover");
      },
    });

    expect(stateGetAttempts).toBe(3);
    expect(blobAttempts).toBe(2);
    expect(waits).toBe(2);
    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[1].payload.content.text).toBe("Retry succeeded.");
    expect(run.getWarnings().size).toBe(0);

    const canceledRun = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    const canceledController = new AbortController();
    (canceledRun.context as any).signal = canceledController.signal;
    let canceledBlobAttempts = 0;
    (canceledRun.context as any).guard.writeTextBlob = async () => {
      canceledBlobAttempts += 1;
      canceledController.abort();
      const error = new Error("connector canceled");
      error.name = "AbortError";
      throw error;
    };
    let canceledWaits = 0;

    await runWatch(canceledRun.context, {
      syncOnceDeps: { now: Date.UTC(2026, 6, 1, 3) },
      async waitImpl() {
        canceledWaits += 1;
      },
    });

    expect(canceledController.signal.aborted).toBe(true);
    expect(canceledBlobAttempts).toBe(1);
    expect(canceledWaits).toBe(0);
    expect(canceledRun.events).toEqual([]);
    expect(canceledRun.getWarnings().size).toBe(0);

    const exhaustedRootRun = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    let exhaustedRootAttempts = 0;
    (exhaustedRootRun.context as any).guard.writeTextBlob = async () => {
      exhaustedRootAttempts += 1;
      throw new Error("permanent root blob failure");
    };
    let exhaustedRootWaits = 0;
    let rootWarningSeenDuringRetries = false;

    await expect(runWatch(exhaustedRootRun.context, {
      syncOnceDeps: { now: Date.UTC(2026, 6, 1, 3) },
      async waitImpl() {
        exhaustedRootWaits += 1;
        rootWarningSeenDuringRetries ||= exhaustedRootRun.getWarnings().has("code-agent-transcripts-files");
      },
    })).rejects.toThrow("failed after 3 retries: permanent root blob failure");

    expect(exhaustedRootAttempts).toBe(4);
    expect(exhaustedRootWaits).toBe(3);
    expect(exhaustedRootRun.events).toEqual([]);
    expect(rootWarningSeenDuringRetries).toBe(true);
    expect(exhaustedRootRun.getWarnings().size).toBe(0);

    const exhaustedSyncRun = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    let exhaustedSyncAttempts = 0;
    (exhaustedSyncRun.context as any).state.get = async () => {
      exhaustedSyncAttempts += 1;
      throw new Error("permanent state failure");
    };
    let exhaustedSyncWaits = 0;
    const syncWarningSnapshots: unknown[] = [];

    await expect(runWatch(exhaustedSyncRun.context, {
      syncOnceDeps: { now: Date.UTC(2026, 6, 1, 3) },
      async waitImpl() {
        exhaustedSyncWaits += 1;
        syncWarningSnapshots.push(exhaustedSyncRun.getWarnings().get("code-agent-transcripts-watch"));
      },
    })).rejects.toThrow("sync failed after 3 retries: permanent state failure");

    expect(exhaustedSyncAttempts).toBe(4);
    expect(exhaustedSyncWaits).toBe(3);
    expect(syncWarningSnapshots.at(-1)).toMatchObject({
      details: { failureCount: 3, retriesRemaining: 1 },
    });
    expect(exhaustedSyncRun.getWarnings().size).toBe(0);
  });

  test("code-agent-transcripts applies the 8192-byte content and human raw limits", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-inline-limit");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const longMessage = "界".repeat(3000);
    writeFileSync(
      join(dayDir, "rollout.jsonl"),
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "session-limit" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-limit" } },
        { timestamp: "2026-07-01T02:00:01.100Z", type: "event_msg", payload: { type: "user_message", client_id: "client-limit", message: longMessage } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });

    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 3) });
    expect(run.events).toHaveLength(1);
    const event = run.events[0];
    expect(event.payload.content).toMatchObject({
      bytes: 9000,
      truncated: true,
      contentRef: { kind: "content-blob", encoding: "gzip" },
    });
    expect(Buffer.byteLength(event.payload.content.text)).toBeLessThanOrEqual(8192);
    expect(event.payload.raw).toMatchObject({
      format: "codex-jsonl",
      recordCount: 1,
      contentRef: { kind: "content-blob", encoding: "gzip" },
    });
    expect(event.payload.raw.records).toBeUndefined();
    expect(run.blobWrites).toHaveLength(2);
    expect(run.blobWrites.map((write) => write.text)).toContain(longMessage);
  });

  test("code-agent-transcripts elides multi-megabyte data URLs without overflowing", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const codexRoot = join(workspace, "codex-large-data-url");
    const dayDir = join(codexRoot, "2026", "07", "01");
    mkdirSync(dayDir, { recursive: true });
    const transcriptPath = join(dayDir, "rollout.jsonl");
    const dataUrl = `data:image/png;base64,${"A".repeat(5_800_000)}=`;
    const githubToken = `ghp_${"x".repeat(30)}`;
    const commitSha = "a".repeat(40);
    const encodedChecksum = `${"B".repeat(46)}==`;
    const jwt = `${"h".repeat(24)}.${"p".repeat(24)}.${"s".repeat(24)}`;
    const structuredSecret = "Ab9+/".repeat(8);
    writeFileSync(
      transcriptPath,
      [
        { timestamp: "2026-07-01T02:00:00.000Z", type: "session_meta", payload: { id: "large-data-session" } },
        { timestamp: "2026-07-01T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "large-data-turn" } },
        {
          timestamp: "2026-07-01T02:00:02.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "image-output",
            output: [
              { type: "text", text: `token=${githubToken}` },
              { type: "image", image_url: dataUrl },
              {
                type: "metadata",
                commitSha,
                encodedChecksum,
                jwt,
                secretAccessKey: structuredSecret,
                tokenCount: 42,
              },
            ],
            internal_chat_message_metadata_passthrough: { turn_id: "large-data-turn" },
          },
        },
        {
          timestamp: "2026-07-01T02:00:03.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "large-data-turn", last_agent_message: "Image inspected." },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const run = makeCodeAgentContext({
      "include-codex": true,
      "include-claude": false,
      "codex-root": codexRoot,
      "lookback-days": 30,
    });
    const originalBufferConcat = Buffer.concat;
    let concatenatedBytes = 0;
    (Buffer as any).concat = (buffers: Uint8Array[], totalLength?: number) => {
      const byteLength = totalLength
        ?? buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
      concatenatedBytes += byteLength;
      return originalBufferConcat(buffers, totalLength);
    };
    try {
      await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 3) });
    } finally {
      (Buffer as any).concat = originalBufferConcat;
    }

    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toMatchObject({
      type: "code_agent.agent_turn",
      payload: {
        content: { text: "Image inspected." },
        raw: { recordCount: 3, contentRef: { kind: "content-blob" } },
      },
    });
    expect(run.getWarnings().size).toBe(0);
    expect(run.blobWrites).toHaveLength(1);
    expect(run.blobWrites[0].text).toContain("data:image/png;base64,[REDACTED_PAYLOAD]");
    expect(run.blobWrites[0].text).not.toContain(githubToken);
    expect(run.blobWrites[0].text).toContain(commitSha);
    expect(run.blobWrites[0].text).toContain(encodedChecksum);
    expect(run.blobWrites[0].text).not.toContain(jwt);
    expect(run.blobWrites[0].text).not.toContain(structuredSecret);
    expect(run.blobWrites[0].text).toContain('"secretAccessKey":"[REDACTED_SECRET]"');
    expect(run.blobWrites[0].text).toContain('"tokenCount":42');
    expect(run.blobWrites[0].text.length).toBeLessThan(10_000);
    expect(concatenatedBytes).toBeLessThan(dataUrl.length * 5);
    const cursor = Object.values((run.getState() as any).files)[0] as any;
    expect(cursor.byteOffset).toBe(statSync(transcriptPath).size);
  });

  test("code-agent-transcripts packs Claude Code tool activity and strips reasoning by default", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const claudeRoot = join(workspace, "claude-turns");
    const projectDir = join(claudeRoot, "Users-alice-project");
    mkdirSync(projectDir, { recursive: true });
    const promptId = "prompt-1";
    const toolResultSecret = "claude-short-secret";
    writeFileSync(
      join(projectDir, "session.jsonl"),
      [
        {
          type: "user",
          uuid: "human-1",
          promptId,
          origin: { kind: "human" },
          sessionId: "claude-session-1",
          timestamp: "2026-07-01T01:00:00.000Z",
          message: { role: "user", content: "Inspect the connector." },
        },
        {
          type: "assistant",
          uuid: "assistant-tool",
          sessionId: "claude-session-1",
          timestamp: "2026-07-01T01:00:01.000Z",
          message: {
            role: "assistant",
            stop_reason: "tool_use",
            content: [
              { type: "thinking", thinking: "Reasoning notes." },
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "index.mjs" } },
            ],
          },
        },
        {
          type: "user",
          uuid: "tool-result-1",
          promptId,
          sessionId: "claude-session-1",
          timestamp: "2026-07-01T01:00:02.000Z",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "tool-1",
              content: JSON.stringify({ file: "contents", password: toolResultSecret }),
            }],
          },
        },
        {
          type: "assistant",
          uuid: "assistant-thinking",
          sessionId: "claude-session-1",
          timestamp: "2026-07-01T01:00:03.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "thinking", thinking: "Final private reasoning." }],
          },
        },
        {
          type: "assistant",
          uuid: "assistant-final",
          sessionId: "claude-session-1",
          timestamp: "2026-07-01T01:00:04.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Connector inspected." }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const run = makeCodeAgentContext({
      "include-codex": false,
      "include-claude": true,
      "include-reasoning": false,
      "claude-root": claudeRoot,
      "lookback-days": 30,
    });

    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 2) });
    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    expect(run.events[1]).toMatchObject({
      startedAt: Date.parse("2026-07-01T01:00:01.000Z"),
      endedAt: Date.parse("2026-07-01T01:00:04.000Z"),
      payload: {
        provider: "claude-code",
        interactionId: run.events[0].payload.interactionId,
        status: "completed",
        content: { text: "Connector inspected." },
        raw: {
          format: "claude-code-jsonl",
          recordCount: 3,
          ids: { sessionId: "claude-session-1", promptId },
          contentRef: { kind: "content-blob", encoding: "gzip" },
        },
      },
    });
    expect(run.blobWrites).toHaveLength(1);
    expect(run.blobWrites[0].text).toContain('"type":"tool_use"');
    expect(run.blobWrites[0].text).toContain('"type":"tool_result"');
    expect(run.blobWrites[0].text).not.toContain("Reasoning notes.");
    expect(run.blobWrites[0].text).not.toContain("Final private reasoning.");
    expect(run.blobWrites[0].text).not.toContain(toolResultSecret);
    const rawRecords = run.blobWrites[0].text
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line).record);
    const toolResultRecord = rawRecords.find((record: any) => record.uuid === "tool-result-1");
    const toolResult = toolResultRecord.message.content.find((part: any) => part.type === "tool_result");
    expect(toolResult.content).toBe("[REDACTED_STRUCTURED_VALUE]");
  });

  test("code-agent-transcripts accepts Claude prompts without origin and keeps steering in one agent turn", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const claudeRoot = join(workspace, "claude-steered-turn");
    const projectDir = join(claudeRoot, "Users-alice-project");
    mkdirSync(projectDir, { recursive: true });
    const promptId = "prompt-steered";
    writeFileSync(
      join(projectDir, "session.jsonl"),
      [
        {
          type: "user",
          uuid: "task-notification",
          promptId: "synthetic-task",
          origin: { kind: "task-notification" },
          sessionId: "claude-session-steered",
          timestamp: "2026-07-01T01:00:00.000Z",
          message: { role: "user", content: "Synthetic task notification." },
        },
        {
          type: "user",
          uuid: "compact-summary",
          promptId: "synthetic-summary",
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
          sessionId: "claude-session-steered",
          timestamp: "2026-07-01T01:00:00.050Z",
          message: { role: "user", content: "Synthetic compact summary." },
        },
        {
          type: "user",
          uuid: "human-original",
          promptId,
          userType: "external",
          sessionId: "claude-session-steered",
          timestamp: "2026-07-01T01:00:01.000Z",
          message: { role: "user", content: "Start the audit." },
        },
        {
          type: "assistant",
          uuid: "assistant-before-steer",
          sessionId: "claude-session-steered",
          timestamp: "2026-07-01T01:00:02.000Z",
          message: {
            role: "assistant",
            stop_reason: "tool_use",
            content: [{ type: "text", text: "Audit started." }],
          },
        },
        {
          type: "user",
          uuid: "human-steer",
          promptId,
          userType: "external",
          sessionId: "claude-session-steered",
          timestamp: "2026-07-01T01:00:03.000Z",
          message: { role: "user", content: "Also check the catalog." },
        },
        {
          type: "assistant",
          uuid: "assistant-after-steer",
          sessionId: "claude-session-steered",
          timestamp: "2026-07-01T01:00:04.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Audit and catalog checked." }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const run = makeCodeAgentContext({
      "include-codex": false,
      "include-claude": true,
      "claude-root": claudeRoot,
      "lookback-days": 30,
    });

    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 2) });
    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    const [original, steer, agent] = run.events;
    expect(original.externalId).not.toBe(steer.externalId);
    expect(original.payload.interactionId).toBe(steer.payload.interactionId);
    expect(agent.payload.interactionId).toBe(original.payload.interactionId);
    expect(agent).toMatchObject({
      startedAt: Date.parse("2026-07-01T01:00:02.000Z"),
      endedAt: Date.parse("2026-07-01T01:00:04.000Z"),
      payload: {
        status: "completed",
        content: { text: "Audit and catalog checked." },
        raw: { ids: { sessionId: "claude-session-steered", promptId } },
      },
    });
    expect(run.blobWrites).toHaveLength(1);
    expect(run.blobWrites[0].text).toContain("Audit started.");
    expect(run.blobWrites[0].text).toContain("Audit and catalog checked.");
    expect(run.blobWrites[0].text).not.toContain("Also check the catalog.");
    expect(run.blobWrites[0].text).not.toContain("Synthetic task notification.");
  });

  test("code-agent-transcripts keeps a Claude interaction on its opening session", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const claudeRoot = join(workspace, "claude-session-identity");
    const projectDir = join(claudeRoot, "Users-alice-project");
    mkdirSync(projectDir, { recursive: true });
    const promptId = "prompt-session-bound";
    writeFileSync(
      join(projectDir, "session.jsonl"),
      [
        {
          type: "user",
          uuid: "human-session-a",
          promptId,
          origin: { kind: "human" },
          sessionId: "claude-session-a",
          timestamp: "2026-07-01T01:00:00.000Z",
          message: { role: "user", content: "Keep this interaction joined." },
        },
        {
          type: "assistant",
          uuid: "assistant-session-a",
          sessionId: "claude-session-a",
          timestamp: "2026-07-01T01:00:01.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Interaction joined." }],
          },
        },
        {
          type: "ai-title",
          sessionId: "claude-session-b",
          timestamp: "2026-07-01T01:00:02.000Z",
          aiTitle: "Later session metadata",
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const run = makeCodeAgentContext({
      "include-codex": false,
      "include-claude": true,
      "claude-root": claudeRoot,
      "lookback-days": 30,
    });

    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 2) });

    expect(run.events.map((event) => event.type)).toEqual([
      "code_agent.human_message",
      "code_agent.agent_turn",
    ]);
    const [human, agent] = run.events;
    expect(human.payload.interactionId).toBe(`claude-code:claude-session-a:${promptId}`);
    expect(agent.payload.interactionId).toBe(human.payload.interactionId);
    expect(agent.payload.raw.ids).toMatchObject({
      sessionId: "claude-session-a",
      promptId,
    });
  });

  test("code-agent-transcripts includes redacted Claude reasoning only when enabled", async () => {
    const agentUrl = new URL("../../template/connectors/code-agent-transcripts/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(agentUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };
    const claudeRoot = join(workspace, "claude-reasoning-turn");
    const projectDir = join(claudeRoot, "Users-alice-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session.jsonl"),
      [
        {
          type: "user",
          uuid: "human-reasoning",
          promptId: "prompt-reasoning",
          origin: { kind: "human" },
          sessionId: "claude-session-reasoning",
          timestamp: "2026-07-01T01:00:00.000Z",
          message: { role: "user", content: "Think." },
        },
        {
          type: "assistant",
          uuid: "assistant-reasoning",
          sessionId: "claude-session-reasoning",
          timestamp: "2026-07-01T01:00:01.000Z",
          message: {
            role: "assistant",
            stop_reason: "tool_use",
            content: [{ type: "thinking", thinking: "Reason with sk-secretsecretsecretsecretsecret." }],
          },
        },
        {
          type: "assistant",
          uuid: "assistant-final",
          sessionId: "claude-session-reasoning",
          timestamp: "2026-07-01T01:00:02.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Done." }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const run = makeCodeAgentContext({
      "include-codex": false,
      "include-claude": true,
      "include-reasoning": true,
      "claude-root": claudeRoot,
      "lookback-days": 30,
    });

    await syncOnce(run.context, { now: Date.UTC(2026, 6, 1, 2) });
    expect(run.blobWrites).toHaveLength(1);
    expect(run.blobWrites[0].text).toContain("Reason with [REDACTED_SECRET].");
    expect(run.blobWrites[0].text).not.toContain("sk-secretsecretsecretsecretsecret");
  });

  test("telegram-bot records its rolling Bot API compatibility reference", () => {
    expect(existsSync(new URL("../../template/connectors/telegram-bot/docs", import.meta.url))).toBe(false);
    expect(telegramBotApiReference).toMatchObject({
      schemaVersion: 1,
      provider: "telegram",
      api: "Bot API",
      transport: "cloud",
      compatibility: {
        minimumVersion: "10.0",
        testedAgainstVersion: "10.1",
        testedAgainstReleaseDate: "2026-06-11",
      },
    });
    expect(telegramBotApiReference.references.testedAgainstRelease).toBe(
      "https://core.telegram.org/bots/api-changelog#june-11-2026",
    );
    expect(telegramBotApiReference.methods).toEqual([
      "deleteWebhook",
      "getMe",
      "getUpdates",
    ]);
  });

  test("telegram-bot resolves Source identity from getMe and rejects invalid bot ids", async () => {
    const telegramUrl = new URL("../../template/connectors/telegram-bot/index.mjs", import.meta.url).href;
    const { resolveSourceIdentity } = await import(telegramUrl) as {
      resolveSourceIdentity(context: unknown, deps?: unknown): Promise<{
        key: string;
        label?: string;
      }>;
    };
    const signal = new AbortController().signal;
    const context = {
      auth: {
        type: "apiKey",
        async getToken() {
          return "telegram-token";
        },
      },
      config: {},
      signal,
    };
    const requests: Array<{ url: string; init: RequestInit }> = [];

    await expect(resolveSourceIdentity(context, {
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), init });
        return Response.json({
          ok: true,
          result: { id: 42, username: "lamarck_test_bot" },
        });
      },
    })).resolves.toEqual({ key: "42", label: "lamarck_test_bot" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/bottelegram-token/getMe");
    expect(requests[0].init).toMatchObject({ method: "POST", signal });

    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1e100, "42"]) {
      await expect(resolveSourceIdentity(context, {
        fetchImpl: async () => Response.json({ ok: true, result: { id } }),
      })).rejects.toThrow("invalid bot id");
    }
  });

  test("telegram-bot connect verifies bot identity and stores connection state", async () => {
    const telegramUrl = new URL("../../template/connectors/telegram-bot/index.mjs", import.meta.url).href;
    const { connectOnce } = await import(telegramUrl) as {
      connectOnce(context: unknown, deps?: unknown): Promise<unknown>;
    };

    let syncState: unknown;
    const calls: Array<{ url: string; body: any }> = [];
    const context = {
      auth: {
        type: "apiKey",
        async getToken() {
          return "telegram-token";
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      warnings: {
        async clear() {},
      },
      config: {},
      signal: new AbortController().signal,
    };

    const bot = await connectOnce(context, {
      now: () => 1000,
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json({
          ok: true,
          result: {
            id: 42,
            username: "lamarck_test_bot",
            first_name: "Lamarck Test",
            can_join_groups: true,
            can_read_all_group_messages: false,
          },
        });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/getMe");
    expect(telegramBotApiReference.methods).toContain("getMe");
    expect(calls[0].body).toEqual({});
    expect(bot).toEqual({
      id: 42,
      username: "lamarck_test_bot",
      firstName: "Lamarck Test",
      canJoinGroups: true,
      canReadAllGroupMessages: false,
    });
    expect(syncState).toMatchObject({
      version: 1,
      connection: { status: "connected", checkedAt: 1000 },
      bot,
    });
  });

  test("telegram-bot captures inbound messages as raw-first events", async () => {
    const telegramUrl = new URL("../../template/connectors/telegram-bot/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(telegramUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<{ updates: number; events: number }>;
    };

    let syncState: any = {
      version: 1,
      bot: { id: 42, username: "lamarck_test_bot" },
    };
    const events: any[] = [];
    const requests: any[] = [];
    const context = {
      auth: {
        type: "apiKey",
        async getToken() {
          return "telegram-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      warnings: {
        async clear() {},
        async set() {},
      },
      config: {},
      signal: new AbortController().signal,
    };

    const result = await syncOnce(context, {
      now: () => 2000,
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                message_id: 1,
                date: 1700000000,
                text: "/start",
                from: {
                  id: 123,
                  is_bot: false,
                  username: "alice",
                  first_name: "Alice",
                },
                chat: {
                  id: 123,
                  type: "private",
                  username: "alice",
                  first_name: "Alice",
                },
              },
            },
            {
              update_id: 11,
              message: {
                message_id: 2,
                date: 1700000001,
                text: "@lamarck_test_bot capture this",
                from: {
                  id: 123,
                  is_bot: false,
                  username: "alice",
                  first_name: "Alice",
                },
                chat: {
                  id: -100,
                  type: "group",
                  title: "Test Group",
                },
              },
            },
            {
              update_id: 12,
              callback_query: {
                id: "callback-1",
                from: { id: 123, is_bot: false, username: "alice" },
                data: "ignored",
              },
            },
          ],
        });
      },
    });

    expect(result).toEqual({ updates: 3, events: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/getUpdates");
    expect(requests[0].body).toMatchObject({
      timeout: 25,
      limit: 100,
      allowed_updates: telegramBotApiReference.updateTypes,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "telegram.message.received",
      externalId: "bot:42:update:10",
      startedAt: 1700000000000,
      payload: {
        schema: "telegram.message.v1",
        provider: "telegram",
        transport: "telegram-bot-api",
        telegram: { botId: 42, updateId: 10, updateType: "message" },
        messageKey: "bot:42:chat:123:message:1",
        chatKey: "bot:42:chat:123",
        text: "/start",
        textKind: "text",
        message: {
          message_id: 1,
          date: 1700000000,
          text: "/start",
          from: { id: 123, is_bot: false, username: "alice", first_name: "Alice" },
          chat: { id: 123, type: "private", username: "alice", first_name: "Alice" },
        },
      },
    });
    expect(events[0].payload.placeholder).toBeUndefined();
    expect(events[0].payload.update).toBeUndefined();
    expect(events[0].payload.messageTransport).toBeUndefined();
    expect(events[0].payload.from).toBeUndefined();
    expect(events[0].payload.chat).toBeUndefined();
    expect(events[0].payload.mediaRefs).toBeUndefined();
    expect(syncState.cursor.lastUpdateId).toBe(12);
    expect(syncState.setup.pendingUsers["123"]).toMatchObject({
      id: 123,
      username: "alice",
      lastText: "/start",
      lastUpdateId: 10,
    });
    expect(syncState.setup.pendingGroups["-100"]).toMatchObject({
      id: -100,
      title: "Test Group",
      lastUpdateId: 11,
    });
  });

  test("telegram-bot preserves raw messages and extracts media refs", async () => {
    const telegramUrl = new URL("../../template/connectors/telegram-bot/index.mjs", import.meta.url).href;
    const { eventFromUpdate } = await import(telegramUrl) as {
      eventFromUpdate(update: unknown, opts?: unknown): any;
    };

    const photoEvent = eventFromUpdate({
      update_id: 30,
      message: {
        message_id: 7,
        message_thread_id: 777,
        media_group_id: "album-1",
        date: 1700000100,
        caption: "/save this photo",
        caption_entities: [{ type: "bot_command", offset: 0, length: 5 }],
        sender_chat: { id: -100, type: "supergroup", title: "Project Notes" },
        author_signature: "Project Admin",
        from: { id: 123, is_bot: false, username: "alice", first_name: "Alice" },
        chat: { id: -100, type: "supergroup", title: "Project Notes" },
        photo: [
          { file_id: "photo-small", file_unique_id: "photo-u-small", width: 160, height: 120, file_size: 9000 },
          { file_id: "photo-large", file_unique_id: "photo-u-large", width: 1280, height: 960, file_size: 234567 },
        ],
        reply_to_message: {
          message_id: 6,
          date: 1700000099,
          text: "previous note",
          from: { id: 456, is_bot: false, username: "alice", first_name: "Alice" },
          chat: { id: -100, type: "supergroup", title: "Project Notes" },
        },
        forward_origin: {
          type: "channel",
          date: 1699999999,
          chat: { id: -200, type: "channel", title: "News" },
          message_id: 99,
          author_signature: "News Desk",
        },
      },
    }, { bot: { id: 42, username: "lamarck_test_bot" } });

    expect(photoEvent).toMatchObject({
      type: "telegram.message.received",
      externalId: "bot:42:update:30",
      payload: {
        schema: "telegram.message.v1",
        provider: "telegram",
        transport: "telegram-bot-api",
        telegram: { botId: 42, updateId: 30, updateType: "message" },
        messageKey: "bot:42:chat:-100:message:7",
        chatKey: "bot:42:chat:-100",
        text: "/save this photo",
        textKind: "caption",
        attachmentTypes: ["photo"],
        message: {
          message_id: 7,
          message_thread_id: 777,
          media_group_id: "album-1",
          caption_entities: [{ type: "bot_command", offset: 0, length: 5 }],
          reply_to_message: {
            message_id: 6,
            text: "previous note",
            from: { id: 456, is_bot: false, username: "alice", first_name: "Alice" },
          },
          forward_origin: {
            type: "channel",
            date: 1699999999,
            chat: { id: -200, type: "channel", title: "News" },
            message_id: 99,
            author_signature: "News Desk",
          },
        },
        mediaRefs: [{
          kind: "telegram-file",
          telegramType: "photo",
          fileId: "photo-large",
          fileUniqueId: "photo-u-large",
          width: 1280,
          height: 960,
          mimeType: "image/jpeg",
          sizeBytes: 234567,
        }],
      },
    });
    expect(photoEvent.payload.update).toBeUndefined();
    expect(photoEvent.payload.textEntities).toBeUndefined();
    expect(photoEvent.payload.attachments).toBeUndefined();
    expect(photoEvent.payload.replyTo).toBeUndefined();
    expect(photoEvent.payload.forward).toBeUndefined();

    const documentEvent = eventFromUpdate({
      update_id: 31,
      message: {
        message_id: 8,
        date: 1700000200,
        caption: "read this",
        from: { id: 123, is_bot: false, username: "alice", first_name: "Alice" },
        chat: { id: 123, type: "private", username: "alice", first_name: "Alice" },
        document: {
          file_id: "doc-file",
          file_unique_id: "doc-unique",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 123456,
          thumbnail: {
            file_id: "thumb-file",
            file_unique_id: "thumb-unique",
            width: 320,
            height: 180,
            file_size: 12000,
          },
        },
      },
    }, { bot: { id: 42, username: "lamarck_test_bot" } });

    expect(documentEvent).toMatchObject({
      externalId: "bot:42:update:31",
      payload: {
        text: "read this",
        textKind: "caption",
        attachmentTypes: ["document"],
        mediaRefs: [{
          kind: "telegram-file",
          telegramType: "document",
          fileId: "doc-file",
          fileUniqueId: "doc-unique",
          fileName: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 123456,
        }],
        message: {
          document: {
            thumbnail: {
              file_id: "thumb-file",
              file_unique_id: "thumb-unique",
              width: 320,
              height: 180,
              file_size: 12000,
            },
          },
        },
      },
    });
    expect(documentEvent.payload.update).toBeUndefined();

    const messageBearingUpdates = [
      "business_message",
      "edited_business_message",
      "guest_message",
    ];
    for (const [index, updateType] of messageBearingUpdates.entries()) {
      const event = eventFromUpdate({
        update_id: 40 + index,
        [updateType]: {
          message_id: 20 + index,
          date: 1700000400 + index,
          text: `${updateType} text`,
          from: { id: 123, is_bot: false, username: "alice" },
          chat: { id: 123, type: "private", username: "alice" },
        },
      }, { bot: { id: 42 } });

      expect(event).toMatchObject({
        type: "telegram.message.received",
        externalId: `bot:42:update:${40 + index}`,
        payload: {
          telegram: { botId: 42, updateId: 40 + index, updateType },
          messageKey: `bot:42:chat:123:message:${20 + index}`,
          chatKey: "bot:42:chat:123",
          text: `${updateType} text`,
          textKind: "text",
          message: {
            message_id: 20 + index,
            text: `${updateType} text`,
          },
        },
      });
    }

    const allMediaEvent = eventFromUpdate({
      update_id: 32,
      message: {
        message_id: 9,
        date: 1700000300,
        chat: { id: 123, type: "private" },
        from: { id: 123, is_bot: false },
        animation: { file_id: "anim-file", file_unique_id: "anim-u", width: 640, height: 360, duration: 2, file_name: "clip.gif", mime_type: "image/gif", file_size: 111 },
        audio: { file_id: "audio-file", file_unique_id: "audio-u", duration: 120, file_name: "song.mp3", mime_type: "audio/mpeg", file_size: 222 },
        video: { file_id: "video-file", file_unique_id: "video-u", width: 1920, height: 1080, duration: 60, file_name: "movie.mp4", mime_type: "video/mp4", file_size: 333 },
        voice: { file_id: "voice-file", file_unique_id: "voice-u", duration: 5, mime_type: "audio/ogg", file_size: 444 },
        sticker: { file_id: "sticker-file", file_unique_id: "sticker-u", width: 512, height: 512, file_size: 555, is_animated: false, is_video: false },
        video_note: { file_id: "note-file", file_unique_id: "note-u", length: 240, duration: 7, file_size: 666 },
        live_photo: { file_id: "live-file", file_unique_id: "live-u", width: 1440, height: 1080, duration: 3, mime_type: "video/mp4", file_size: 777 },
        paid_media: {
          star_count: 10,
          paid_media: [
            { type: "photo", photo: [{ file_id: "paid-photo", file_unique_id: "paid-photo-u", width: 800, height: 600, file_size: 888 }] },
            { type: "video", video: { file_id: "paid-video", file_unique_id: "paid-video-u", width: 1280, height: 720, duration: 9, mime_type: "video/mp4", file_size: 999 } },
            { type: "live_photo", live_photo: { file_id: "paid-live", file_unique_id: "paid-live-u", width: 1024, height: 768, duration: 4, mime_type: "video/mp4", file_size: 1000 } },
            { type: "preview", width: 100, height: 100 },
          ],
        },
        contact: { phone_number: "+15555555555", first_name: "Alice" },
        location: { latitude: 25.03, longitude: 121.56 },
        poll: { id: "poll-1", question: "Ship?", options: [] },
      },
    }, { bot: { id: 42 } });

    expect(allMediaEvent.payload.attachmentTypes).toEqual([
      "video",
      "voice",
      "audio",
      "animation",
      "sticker",
      "video_note",
      "live_photo",
      "paid_media",
      "contact",
      "location",
      "poll",
    ]);
    expect(allMediaEvent.payload.mediaRefs).toEqual([
      { kind: "telegram-file", telegramType: "video", fileId: "video-file", fileUniqueId: "video-u", fileName: "movie.mp4", width: 1920, height: 1080, durationSec: 60, mimeType: "video/mp4", sizeBytes: 333 },
      { kind: "telegram-file", telegramType: "voice", fileId: "voice-file", fileUniqueId: "voice-u", durationSec: 5, mimeType: "audio/ogg", sizeBytes: 444 },
      { kind: "telegram-file", telegramType: "audio", fileId: "audio-file", fileUniqueId: "audio-u", fileName: "song.mp3", durationSec: 120, mimeType: "audio/mpeg", sizeBytes: 222 },
      { kind: "telegram-file", telegramType: "animation", fileId: "anim-file", fileUniqueId: "anim-u", fileName: "clip.gif", width: 640, height: 360, durationSec: 2, mimeType: "image/gif", sizeBytes: 111 },
      { kind: "telegram-file", telegramType: "sticker", fileId: "sticker-file", fileUniqueId: "sticker-u", width: 512, height: 512, sizeBytes: 555 },
      { kind: "telegram-file", telegramType: "video_note", fileId: "note-file", fileUniqueId: "note-u", width: 240, height: 240, durationSec: 7, sizeBytes: 666 },
      { kind: "telegram-file", telegramType: "live_photo", fileId: "live-file", fileUniqueId: "live-u", width: 1440, height: 1080, durationSec: 3, mimeType: "video/mp4", sizeBytes: 777 },
      { kind: "telegram-file", telegramType: "paid_media", paidMediaType: "photo", paidMediaIndex: 0, fileId: "paid-photo", fileUniqueId: "paid-photo-u", width: 800, height: 600, mimeType: "image/jpeg", sizeBytes: 888 },
      { kind: "telegram-file", telegramType: "paid_media", paidMediaType: "video", paidMediaIndex: 1, fileId: "paid-video", fileUniqueId: "paid-video-u", width: 1280, height: 720, durationSec: 9, mimeType: "video/mp4", sizeBytes: 999 },
      { kind: "telegram-file", telegramType: "paid_media", paidMediaType: "live_photo", paidMediaIndex: 2, fileId: "paid-live", fileUniqueId: "paid-live-u", width: 1024, height: 768, durationSec: 4, mimeType: "video/mp4", sizeBytes: 1000 },
    ]);
  });

  test("telegram-bot pairs a direct-message user with a one-time code", async () => {
    const telegramUrl = new URL("../../template/connectors/telegram-bot/index.mjs", import.meta.url).href;
    const { syncOnce, pairingChallengeForCode } = await import(telegramUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<{ updates: number; events: number }>;
      pairingChallengeForCode(code: string, nowMs: number, opts?: { salt?: string }): unknown;
    };

    let syncState: any = {
      version: 1,
      bot: { id: 42, username: "lamarck_test_bot" },
      setup: {
        pendingUsers: {},
        pendingGroups: {},
        pairingChallenge: pairingChallengeForCode("842913", 1000, { salt: "test-salt" }),
      },
    };
    const events: any[] = [];
    let requestCount = 0;
    const context = {
      auth: {
        type: "apiKey",
        async getToken() {
          return "telegram-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      warnings: {
        async clear() {},
        async set() {},
      },
      config: {
        telegramSetup: {
          dm: { mode: "paired_only" },
          groups: { mode: "disabled", requireMention: true },
        },
      },
      signal: new AbortController().signal,
    };
    const updates = [
      [
        {
          update_id: 12,
          message: {
            message_id: 1,
            date: 1700000002,
            text: "/pair 842913",
            from: {
              id: 123,
              is_bot: false,
              username: "alice",
              first_name: "Alice",
            },
            chat: {
              id: 123,
              type: "private",
              username: "alice",
              first_name: "Alice",
            },
          },
        },
      ],
      [
        {
          update_id: 13,
          message: {
            message_id: 2,
            date: 1700000003,
            text: "capture after pairing",
            from: {
              id: 123,
              is_bot: false,
              username: "alice",
              first_name: "Alice",
            },
            chat: {
              id: 123,
              type: "private",
              username: "alice",
              first_name: "Alice",
            },
          },
        },
      ],
    ];
    const fetchImpl = async () => {
      const result = updates[requestCount++] ?? [];
      return Response.json({ ok: true, result });
    };

    expect(await syncOnce(context, { now: () => 2000, fetchImpl })).toEqual({ updates: 1, events: 0 });
    expect(events).toHaveLength(0);
    expect(syncState.setup.pairingChallenge).toBeUndefined();
    expect(syncState.setup.pairedUsers["123"]).toMatchObject({
      id: 123,
      username: "alice",
      pairingMethod: "otp",
      lastUpdateId: 12,
    });
    expect(syncState.setup.lastPairingAttempt).toMatchObject({
      status: "paired_user",
      id: "123",
    });

    expect(await syncOnce(context, { now: () => 3000, fetchImpl })).toEqual({ updates: 1, events: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "telegram.message.received",
      externalId: "bot:42:update:13",
      payload: {
        text: "capture after pairing",
        messageKey: "bot:42:chat:123:message:2",
        message: {
          message_id: 2,
          from: { id: 123, username: "alice" },
        },
      },
    });
  });

  test("telegram-bot pairs a group with a one-time code", async () => {
    const telegramUrl = new URL("../../template/connectors/telegram-bot/index.mjs", import.meta.url).href;
    const { syncOnce, pairingChallengeForCode } = await import(telegramUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<{ updates: number; events: number }>;
      pairingChallengeForCode(code: string, nowMs: number, opts?: { salt?: string }): unknown;
    };

    let syncState: any = {
      version: 1,
      bot: { id: 42, username: "lamarck_test_bot" },
      setup: {
        pendingUsers: {},
        pendingGroups: {},
        pairingChallenge: pairingChallengeForCode("112233", 1000, { salt: "group-salt" }),
      },
    };
    const events: any[] = [];
    let requestCount = 0;
    const context = {
      auth: {
        type: "apiKey",
        async getToken() {
          return "telegram-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      warnings: {
        async clear() {},
        async set() {},
      },
      config: {
        telegramSetup: {
          dm: { mode: "disabled" },
          groups: { mode: "paired_only", requireMention: true },
        },
      },
      signal: new AbortController().signal,
    };
    const updates = [
      [
        {
          update_id: 20,
          message: {
            message_id: 1,
            date: 1700000010,
            text: "/pair 112233",
            from: {
              id: 123,
              is_bot: false,
              username: "alice",
              first_name: "Alice",
            },
            chat: {
              id: -100,
              type: "group",
              title: "Project Notes",
            },
          },
        },
      ],
      [
        {
          update_id: 21,
          message: {
            message_id: 2,
            date: 1700000011,
            text: "@lamarck_test_bot capture group note",
            from: {
              id: 123,
              is_bot: false,
              username: "alice",
              first_name: "Alice",
            },
            chat: {
              id: -100,
              type: "group",
              title: "Project Notes",
            },
          },
        },
      ],
    ];
    const fetchImpl = async () => Response.json({ ok: true, result: updates[requestCount++] ?? [] });

    expect(await syncOnce(context, { now: () => 2000, fetchImpl })).toEqual({ updates: 1, events: 0 });
    expect(syncState.setup.pairingChallenge).toBeUndefined();
    expect(syncState.setup.pairedGroups["-100"]).toMatchObject({
      id: -100,
      title: "Project Notes",
      pairingMethod: "otp",
      lastUpdateId: 20,
      pairedBy: { id: 123, username: "alice" },
    });
    expect(syncState.setup.lastPairingAttempt).toMatchObject({
      status: "paired_group",
      id: "-100",
    });

    expect(await syncOnce(context, { now: () => 3000, fetchImpl })).toEqual({ updates: 1, events: 1 });
    expect(events[0]).toMatchObject({
      type: "telegram.message.received",
      externalId: "bot:42:update:21",
      payload: {
        text: "@lamarck_test_bot capture group note",
        messageKey: "bot:42:chat:-100:message:2",
        message: {
          message_id: 2,
          chat: { id: -100, type: "group", title: "Project Notes" },
        },
      },
    });
  });

  test("oura resolves Source identity through the managed provider origin", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { resolveSourceIdentity } = await import(ouraUrl) as {
      resolveSourceIdentity(context: unknown, deps?: unknown): Promise<{
        key: string;
        label?: string;
      }>;
    };
    const signal = new AbortController().signal;
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://api.example.test",
        async getToken() {
          return "oura-capability-token";
        },
      },
      config: {},
      signal,
    };
    const requests: Array<{ url: string; init: RequestInit }> = [];

    await expect(resolveSourceIdentity(context, {
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), init });
        return Response.json({ id: "oura-user-7", email: "alice@example.test" });
      },
    })).resolves.toEqual({ key: "oura-user-7", label: "alice@example.test" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.example.test/providers/oura/v1/identity");
    expect(requests[0].init).toMatchObject({
      method: "GET",
      signal,
      headers: {
        Accept: "application/json",
        Authorization: "Bearer oura-capability-token",
      },
    });

    await expect(resolveSourceIdentity({
      ...context,
      auth: { ...context.auth, providerOrigin: undefined },
    }, {
      fetchImpl: async () => Response.json({ id: "unused" }),
    })).rejects.toThrow("managed provider origin is unavailable");
    await expect(resolveSourceIdentity(context, {
      fetchImpl: async () => Response.json({ email: "missing-id@example.test" }),
    })).rejects.toThrow("missing a stable id");
  });

  test("oura sync uses revision-aware external ids and per-stream cursors", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    let score = 90;
    const events: any[] = [];
    const requests: URL[] = [];
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://dev-api.example.test",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          const start = events.length;
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${start + index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        lookbackDays: 1,
        backfillYears: 0,
        streams: ["daily_sleep"],
      },
      signal: new AbortController().signal,
    };

    const fetchImpl = async (url: string, init: RequestInit) => {
      const requestUrl = new URL(url);
      requests.push(requestUrl);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer oura-token");
      return new Response(JSON.stringify({
        data: [{
          id: "sleep-doc-1",
          day: "2026-01-02",
          timestamp: "2026-01-02T08:00:00+00:00",
          contributors: { total_sleep: score },
          score,
        }],
        next_token: null,
      }), { status: 200 });
    };

    const now = Date.UTC(2026, 0, 3, 12);
    await syncOnce(context, { fetchImpl, now });
    const firstExternalId = events[0].externalId;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "oura.daily_sleep",
      externalId: expect.stringMatching(/^daily_sleep:sleep-doc-1:[a-f0-9]{16}$/),
      startedAt: Date.UTC(2026, 0, 2),
      payload: {
        schema: "oura.daily_sleep.v1",
        provider: "oura",
        stream: "daily_sleep",
        record: {
          id: "sleep-doc-1",
          day: "2026-01-02",
          score: 90,
        },
      },
    });
    expect(syncState).toEqual({
      version: 2,
      incremental: {
        streams: {
          daily_sleep: {
            lastSyncedDate: "2026-01-03",
            lastSyncedAt: now,
          },
        },
      },
      backfill: undefined,
    });
    expect(requests[0].origin).toBe("https://dev-api.example.test");
    expect(requests[0].pathname).toBe("/providers/oura/v1/streams/daily_sleep");
    expect(requests[0].searchParams.get("start_date")).toBe("2026-01-02");
    expect(requests[0].searchParams.get("end_date")).toBe("2026-01-03");

    score = 91;
    await syncOnce(context, { fetchImpl, now });

    expect(events).toHaveLength(2);
    expect(events[1].externalId).not.toBe(firstExternalId);
    expect(events[1].externalId).toMatch(/^daily_sleep:sleep-doc-1:[a-f0-9]{16}$/);
    expect(requests[1].searchParams.get("start_date")).toBe("2026-01-02");
    expect(requests[1].searchParams.get("end_date")).toBe("2026-01-03");
  });

  test("oura backfill completes available chunks after incremental sync", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    const events: any[] = [];
    const requests: URL[] = [];
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://dev-api.example.test",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          const start = events.length;
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${start + index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        lookbackDays: 1,
        backfillYears: 1,
        streams: ["daily_sleep"],
      },
      signal: new AbortController().signal,
    };

    const fetchImpl = async (url: string) => {
      const requestUrl = new URL(url);
      requests.push(requestUrl);
      const day = requestUrl.searchParams.get("start_date") ?? "2026-01-02";
      return new Response(JSON.stringify({
        data: [{
          id: `sleep-${day}`,
          day,
          timestamp: `${day}T08:00:00+00:00`,
          score: 90,
        }],
        next_token: null,
      }), { status: 200 });
    };

    const now = Date.UTC(2026, 0, 3, 12);
    await syncOnce(context, { fetchImpl, now });

    expect(requests).toHaveLength(6);
    expect(requests[0].searchParams.get("start_date")).toBe("2026-01-02");
    expect(requests[0].searchParams.get("end_date")).toBe("2026-01-03");
    expect(requests[1].searchParams.get("start_date")).toBe("2025-01-03");
    expect(requests[1].searchParams.get("end_date")).toBe("2025-04-03");
    expect(requests[5].searchParams.get("start_date")).toBe("2025-12-29");
    expect(requests[5].searchParams.get("end_date")).toBe("2026-01-03");
    expect(events).toHaveLength(6);
    expect(syncState).toEqual({
      version: 2,
      incremental: {
        streams: {
          daily_sleep: {
            lastSyncedDate: "2026-01-03",
            lastSyncedAt: now,
          },
        },
      },
      backfill: {
        fromDate: "2025-01-03",
        untilDate: "2026-01-03",
        streams: {
          daily_sleep: {
            nextDate: "2026-01-03",
            done: true,
            lastSyncedAt: now,
          },
        },
        done: true,
      },
    });

    await syncOnce(context, { fetchImpl, now });
    expect(requests).toHaveLength(7);
    expect(requests[6].searchParams.get("start_date")).toBe("2026-01-02");
    expect(requests[6].searchParams.get("end_date")).toBe("2026-01-03");
  });

  test("oura datetime backfill uses provider-safe 30 day chunks", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    const requests: URL[] = [];
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://dev-api.example.test",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents() {
          return { ids: [] };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        lookbackDays: 1,
        backfillYears: 1,
        streams: ["ring_battery_level"],
      },
      signal: new AbortController().signal,
    };

    const fetchImpl = async (url: string) => {
      requests.push(new URL(url));
      return new Response(JSON.stringify({
        data: [],
        next_token: null,
      }), { status: 200 });
    };

    const now = Date.UTC(2026, 0, 3, 12);
    await syncOnce(context, { fetchImpl, now });

    expect(requests[0].searchParams.get("start_datetime")).toBe("2026-01-02T12:00:00.000Z");
    expect(requests[0].searchParams.get("end_datetime")).toBe("2026-01-03T12:00:00.000Z");
    expect(requests[1].searchParams.get("start_datetime")).toBe("2025-01-03T00:00:00.000Z");
    expect(requests[1].searchParams.get("end_datetime")).toBe("2025-02-02T00:00:00.000Z");
    for (const request of requests.slice(1)) {
      const start = Date.parse(request.searchParams.get("start_datetime") ?? "");
      const end = Date.parse(request.searchParams.get("end_datetime") ?? "");
      expect(end - start).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
    }
  });

  test("oura backfill records errors and resumes from the failed chunk", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    const events: any[] = [];
    const requests: URL[] = [];
    const warnings = new Map<string, any>();
    let failSecondBackfillChunk = true;
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://dev-api.example.test",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          const start = events.length;
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${start + index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      warnings: {
        async set(warning: any) {
          warnings.set(warning.key, warning);
        },
        async clear(key: string) {
          warnings.delete(key);
        },
      },
      config: {
        lookbackDays: 1,
        backfillYears: 1,
        streams: ["daily_sleep"],
      },
      signal: new AbortController().signal,
    };

    const fetchImpl = async (url: string) => {
      const requestUrl = new URL(url);
      requests.push(requestUrl);
      const startDate = requestUrl.searchParams.get("start_date") ?? "2026-01-02";
      if (failSecondBackfillChunk && startDate === "2025-04-03") {
        throw new Error("synthetic rate limit");
      }
      return new Response(JSON.stringify({
        data: [{
          id: `sleep-${startDate}`,
          day: startDate,
          timestamp: `${startDate}T08:00:00+00:00`,
          score: 90,
        }],
        next_token: null,
      }), { status: 200 });
    };

    const now = Date.UTC(2026, 0, 3, 12);
    await syncOnce(context, { fetchImpl, now });

    expect(requests).toHaveLength(3);
    expect(requests[1].searchParams.get("start_date")).toBe("2025-01-03");
    expect(requests[2].searchParams.get("start_date")).toBe("2025-04-03");
    expect(syncState).toMatchObject({
      version: 2,
      backfill: {
        fromDate: "2025-01-03",
        untilDate: "2026-01-03",
        streams: {
          daily_sleep: {
            nextDate: "2025-04-03",
            done: false,
          },
        },
        lastError: {
          stream: "daily_sleep",
          nextDate: "2025-04-03",
          chunkEndDate: "2025-07-02",
          message: "synthetic rate limit",
          at: now,
        },
      },
    });
    expect(warnings.get("backfill")).toMatchObject({
      key: "backfill",
      message: "Oura backfill paused at daily_sleep 2025-04-03: synthetic rate limit",
      details: {
        provider: "oura",
        stream: "daily_sleep",
        nextDate: "2025-04-03",
        chunkEndDate: "2025-07-02",
      },
    });

    failSecondBackfillChunk = false;
    await syncOnce(context, { fetchImpl, now });

    expect(requests[4].searchParams.get("start_date")).toBe("2025-04-03");
    expect(syncState).toMatchObject({
      backfill: {
        streams: {
          daily_sleep: {
            nextDate: "2026-01-03",
            done: true,
          },
        },
        done: true,
      },
    });
    expect(warnings.has("backfill")).toBe(false);
  });

  test("oura heartrate sync emits 15 minute batch events", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    const events: any[] = [];
    const requests: URL[] = [];
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://dev-api.example.test",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          const start = events.length;
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${start + index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        lookbackDays: 1,
        backfillYears: 0,
        streams: ["heartrate"],
      },
      signal: new AbortController().signal,
    };

    const fetchImpl = async (url: string) => {
      requests.push(new URL(url));
      return new Response(JSON.stringify({
        data: [
          { timestamp: "2026-01-03T11:01:00+00:00", bpm: 60, source: "awake" },
          { timestamp: "2026-01-03T11:14:00+00:00", bpm: 66, source: "awake" },
          { timestamp: "2026-01-03T11:16:00+00:00", bpm: 72, source: "workout" },
        ],
        next_token: null,
      }), { status: 200 });
    };

    const now = Date.UTC(2026, 0, 3, 12);
    await syncOnce(context, { fetchImpl, now });

    expect(requests[0].searchParams.get("start_datetime")).toBe("2026-01-02T12:00:00.000Z");
    expect(requests[0].searchParams.get("end_datetime")).toBe("2026-01-03T12:00:00.000Z");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "oura.heartrate.batch",
      externalId: expect.stringMatching(/^heartrate:2026-01-03T11:00:00\.000Z:[a-f0-9]{16}$/),
      startedAt: Date.UTC(2026, 0, 3, 11),
      endedAt: Date.UTC(2026, 0, 3, 11, 15),
      payload: {
        schema: "oura.heartrate.batch.v1",
        provider: "oura",
        stream: "heartrate",
        bucketMs: 15 * 60 * 1000,
        sampleCount: 2,
        sourceCounts: { awake: 2 },
        minBpm: 60,
        maxBpm: 66,
        avgBpm: 63,
      },
    });
    expect(events[0].payload.samples).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "oura.heartrate.batch",
      startedAt: Date.UTC(2026, 0, 3, 11, 15),
      payload: {
        sampleCount: 1,
        sourceCounts: { workout: 1 },
        minBpm: 72,
        maxBpm: 72,
        avgBpm: 72,
      },
    });
    expect(syncState).toEqual({
      version: 2,
      incremental: {
        streams: {
          heartrate: {
            lastSyncedDateTime: "2026-01-03T12:00:00.000Z",
            lastSyncedAt: now,
          },
        },
      },
      backfill: undefined,
    });
  });

  test("oura ring battery sync emits threshold transition events", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    const events: any[] = [];
    const requests: URL[] = [];
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://dev-api.example.test",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          const start = events.length;
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${start + index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        lookbackDays: 1,
        backfillYears: 0,
        streams: ["ring_battery_level"],
      },
      signal: new AbortController().signal,
    };

    const batteryRows = [
      { timestamp: "2026-01-03T00:00:00Z", level: 12, charging: false, in_charger: false },
      { timestamp: "2026-01-03T01:00:00Z", level: 9, charging: false, in_charger: false },
      { timestamp: "2026-01-03T02:00:00Z", level: 4, charging: false, in_charger: false },
      { timestamp: "2026-01-03T03:00:00Z", level: 3, charging: false, in_charger: false },
      { timestamp: "2026-01-03T04:00:00Z", level: 4, charging: true, in_charger: true },
      { timestamp: "2026-01-03T05:00:00Z", level: 21, charging: false, in_charger: false },
    ];

    const fetchImpl = async (url: string) => {
      requests.push(new URL(url));
      return new Response(JSON.stringify({
        data: batteryRows,
        next_token: null,
      }), { status: 200 });
    };

    const now = Date.UTC(2026, 0, 3, 12);
    await syncOnce(context, { fetchImpl, now });

    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("start_datetime")).toBe("2026-01-02T12:00:00.000Z");
    expect(requests[0].searchParams.get("end_datetime")).toBe("2026-01-03T12:00:00.000Z");
    expect(events.map((event) => event.type)).toEqual([
      "oura.ring_battery.low",
      "oura.ring_battery.critical",
      "oura.ring_battery.recovered",
    ]);
    expect(events[0]).toMatchObject({
      externalId: "ring_battery:low:2026-01-03T01:00:00.000Z",
      startedAt: Date.UTC(2026, 0, 3, 1),
      payload: {
        schema: "oura.ring_battery.transition.v1",
        level: 9,
        threshold: 10,
        lowLevel: 10,
        criticalLevel: 5,
        recoveredLevel: 20,
        charging: false,
        inCharger: false,
      },
    });
    expect(events[1]).toMatchObject({
      externalId: "ring_battery:critical:2026-01-03T02:00:00.000Z",
      payload: {
        level: 4,
        threshold: 5,
        lowStartedAt: "2026-01-03T01:00:00.000Z",
      },
    });
    expect(events[2]).toMatchObject({
      externalId: "ring_battery:recovered:2026-01-03T04:00:00.000Z",
      payload: {
        level: 4,
        previousLowStartedAt: "2026-01-03T01:00:00.000Z",
        previousCriticalStartedAt: "2026-01-03T02:00:00.000Z",
        charging: true,
        inCharger: true,
      },
    });
    expect(syncState).toMatchObject({
      version: 2,
      incremental: {
        streams: {
          ring_battery_level: {
            lastSyncedDateTime: "2026-01-03T12:00:00.000Z",
            lastSyncedAt: now,
            ringBattery: {
              lowActive: false,
              criticalActive: false,
              lastTimestamp: "2026-01-03T05:00:00.000Z",
              lastLevel: 21,
            },
          },
        },
      },
      backfill: undefined,
    });

    await syncOnce(context, { fetchImpl, now });
    expect(requests).toHaveLength(2);
    expect(events).toHaveLength(3);
  });

  test("oura ring battery sync debounces charge-state recovery flaps", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    const events: any[] = [];
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://dev-api.example.test",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          const start = events.length;
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${start + index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        lookbackDays: 1,
        backfillYears: 0,
        streams: ["ring_battery_level"],
      },
      signal: new AbortController().signal,
    };

    const producerTimestamp = 1779462666737;
    const batteryRows = [
      { timestamp: "2026-05-22T03:09:14.900Z", level: 9, charging: false, in_charger: false, producer_timestamp: 1779414803228 },
      { timestamp: "2026-05-22T12:41:38.200Z", level: 4, charging: false, in_charger: false, producer_timestamp: producerTimestamp },
      { timestamp: "2026-05-22T18:37:32.500Z", level: 4, charging: true, in_charger: false, producer_timestamp: producerTimestamp },
      { timestamp: "2026-05-22T18:37:36.100Z", level: 4, charging: false, in_charger: false, producer_timestamp: producerTimestamp },
      { timestamp: "2026-05-22T18:37:36.200Z", level: 4, charging: true, in_charger: false, producer_timestamp: producerTimestamp },
      { timestamp: "2026-05-22T18:37:40.500Z", level: 4, charging: false, in_charger: false, producer_timestamp: producerTimestamp },
      { timestamp: "2026-05-22T18:37:47.900Z", level: 10, charging: false, in_charger: true, producer_timestamp: producerTimestamp },
    ];

    const fetchImpl = async () => {
      return new Response(JSON.stringify({
        data: batteryRows,
        next_token: null,
      }), { status: 200 });
    };

    await syncOnce(context, { fetchImpl, now: Date.UTC(2026, 4, 23) });

    expect(events.map((event) => event.type)).toEqual([
      "oura.ring_battery.low",
      "oura.ring_battery.critical",
      "oura.ring_battery.recovered",
    ]);
    expect(events.map((event) => event.externalId)).toEqual([
      "ring_battery:low:2026-05-22T03:09:14.900Z",
      "ring_battery:critical:2026-05-22T12:41:38.200Z",
      "ring_battery:recovered:2026-05-22T18:37:47.900Z",
    ]);
    expect(events[2]).toMatchObject({
      startedAt: Date.UTC(2026, 4, 22, 18, 37, 47, 900),
      payload: {
        level: 10,
        previousLowStartedAt: "2026-05-22T03:09:14.900Z",
        previousCriticalStartedAt: "2026-05-22T12:41:38.200Z",
        charging: false,
        inCharger: true,
      },
    });
    expect(syncState).toMatchObject({
      incremental: {
        streams: {
          ring_battery_level: {
            ringBattery: {
              lowActive: false,
              criticalActive: false,
              lastTimestamp: "2026-05-22T18:37:47.900Z",
              lastLevel: 10,
              lastInCharger: true,
            },
          },
        },
      },
    });
  });

  test("oura ring configuration sync is throttled by state", async () => {
    const ouraUrl = new URL("../../template/connectors/oura/index.mjs", import.meta.url).href;
    const { syncOnce } = await import(ouraUrl) as {
      syncOnce(context: unknown, deps?: unknown): Promise<void>;
    };

    let syncState: unknown;
    const events: any[] = [];
    const requests: URL[] = [];
    const context = {
      auth: {
        type: "managedProvider",
        providerOrigin: "https://dev-api.example.test",
        async getToken() {
          return "oura-token";
        },
      },
      guard: {
        async writeEvents(batch: any[]) {
          const start = events.length;
          events.push(...batch);
          return { ids: batch.map((_, index) => `event-${start + index}`) };
        },
      },
      state: {
        async get() {
          return syncState;
        },
        async set(next: unknown) {
          syncState = next;
        },
      },
      config: {
        backfillYears: 0,
        streams: ["ring_configuration"],
      },
      signal: new AbortController().signal,
    };

    const fetchImpl = async (url: string) => {
      requests.push(new URL(url));
      return new Response(JSON.stringify({
        data: [{
          id: "ring-1",
          set_up_at: "2025-01-01T00:00:00Z",
          hardware_type: "gen4",
          firmware_version: "3.0.0",
        }],
        next_token: null,
      }), { status: 200 });
    };

    const firstRun = Date.UTC(2026, 0, 3, 12);
    await syncOnce(context, { fetchImpl, now: firstRun });
    expect(requests).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(syncState).toEqual({
      version: 2,
      incremental: {
        streams: {
          ring_configuration: {
            lastSyncedAt: firstRun,
          },
        },
      },
      backfill: undefined,
    });

    await syncOnce(context, { fetchImpl, now: firstRun + 6 * 60 * 60 * 1000 });
    expect(requests).toHaveLength(1);
    expect(events).toHaveLength(1);

    await syncOnce(context, { fetchImpl, now: firstRun + 31 * 24 * 60 * 60 * 1000 });
    expect(requests).toHaveLength(2);
    expect(events).toHaveLength(2);
  });

  test("installs connectors as workspace folders, registers them, and removes the folder", async () => {
    const sourceDir = join(workspace, "source-connectors", "calendar");
    mkdirSync(sourceDir, { recursive: true });
    writeConnectorManifestFixture(
      join(sourceDir, "connector.yaml"),
      `manifestVersion: 1
id: calendar
name: Calendar
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(sourceDir, "index.mjs"),
      `export default {
  async run(context) {
    if ("host" in context) throw new Error("host leaked into connector run context");
    const { guard, state } = context;
    await guard.writeEvent({
      type: "calendar.install-test",
      externalId: "installed",
      startedAt: 4500,
      payload: { installed: true },
    });
    await state.set({ installed: true });
  },
};
`,
    );

    const installed = await installConnector({ sourceDir, workspacePath: workspace });
    expect(installed.dir).toBe(join(workspace, "connectors", "calendar"));
    expect(readFileSync(join(installed.dir, "connector.yaml"), "utf8")).toContain("id: calendar");
    expect(await listInstalledConnectorDirs(workspace)).toEqual([installed.dir]);

    const manifests = await registerWorkspaceConnectors(supervisor, workspace);
    expect(manifests.map((manifest) => manifest.id)).toEqual(["calendar"]);
    expect(await supervisor.list()).toEqual([]);
    const sourceRecord = supervisor.ensureSource({ connectorId: "calendar" });
    expect(sourceRecord.id).not.toBe("calendar");

    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("not trusted");
    await supervisor.approveCurrentPackage("calendar");
    await supervisor.run(sourceRecord.id);

    const event = dataDb.prepare("SELECT source, type, external_id FROM events WHERE type = ?")
      .get("calendar.install-test") as any;
    expect(event).toEqual({
      source: "connector:calendar",
      type: "calendar.install-test",
      external_id: "installed",
    });
    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({ installed: true });
    expect(supervisor.getSource(sourceRecord.id)?.trustStatus).toBe("custom");

    expect(await removeInstalledConnector(workspace, "calendar")).toBe(true);
    expect(existsSync(installed.dir)).toBe(false);
    expect(await listInstalledConnectorDirs(workspace)).toEqual([]);
  });

  test("materializes built-in connectors through the same workspace connectors path", async () => {
    const sourceDir = join(workspace, "built-in-connectors", "app-commits");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "connector.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "app-commits",
        name: "App Commits",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.mjs",
        runtime: { mode: "watch" },
        source: { identity: "single" },
        platforms: { darwin: {} },
        auth: { type: "none" },
      }),
    );
    writeFileSync(
      join(sourceDir, "index.mjs"),
      "export default { async run() {} };\n",
    );
    writeTestEventCatalog(sourceDir);

    const installed = await materializeBuiltInConnector({ sourceDir, workspacePath: workspace });
    expect(installed.dir).toBe(join(workspace, "connectors", "app-commits"));
    expect((await loadConnectorManifest(installed.dir)).id).toBe("app-commits");
    await expect(materializeBuiltInConnector({ sourceDir, workspacePath: workspace }))
      .rejects.toThrow("Connector already installed: app-commits");
  });

  test("workspace boot cascades Sources whose Connector package is truly absent", async () => {
    const authManager = new ConnectorAuthManager(secrets);
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "removed-outside-core",
        name: "Removed Outside Core",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "single" },
        auth: { type: "none" },
      },
      { async run() {} },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "removed-outside-core" });
    await authManager.setToken(sourceRecord.authRef!, "orphan-token");

    const restarted = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    expect(await registerWorkspaceConnectors(restarted, workspace)).toEqual([]);
    expect(restarted.getSource(sourceRecord.id)).toBeUndefined();
    expect(await authManager.hasToken(sourceRecord.authRef!)).toBe(false);
    expect(
      dataDb.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'connector.removed'").get(),
    ).toMatchObject({ n: 1 });
  });

  function writeBuiltIn(
    builtinsDir: string,
    id: string,
    identityKind: "single" | "connector" = "single",
  ): string {
    const dir = join(builtinsDir, id);
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: ${id}
name: ${id}
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: ${identityKind}
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      identityKind === "connector"
        ? `export default {
  async run() {},
  async resolveSourceIdentity({ config }) {
    return { key: String(config?.accountId ?? "work") };
  },
};
`
        : "export default { async run() {} };\n",
    );
    return dir;
  }

  test("an omitted platforms map means supported everywhere", () => {
    const manifest = validateConnectorManifest({
      manifestVersion: 1,
      id: "anywhere",
      name: "Anywhere",
      description: "Test connector manifest.",
      eventCatalog: "./events.json",
      entry: "./index.mjs",
      runtime: { mode: "manual" },
      source: { identity: "single" },
      auth: { type: "none" },
    } as ConnectorManifest);
    expect(isPlatformSupported(manifest, "darwin")).toBe(true);
    expect(isPlatformSupported(manifest, "linux")).toBe(true);

    const darwinOnly = validateConnectorManifest({
      ...manifest,
      platforms: { darwin: {} },
    });
    expect(isPlatformSupported(darwinOnly, "darwin")).toBe(true);
    expect(isPlatformSupported(darwinOnly, "linux")).toBe(false);
  });

  test("lists bundled built-ins as available and installs one explicitly", async () => {
    const guard = new Guard({ db: dataDb, source: "system:test" });
    const builtins = join(workspace, "builtins");
    writeBuiltIn(builtins, "seed");
    const broken = join(builtins, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "connector.yaml"), "id: broken\n");

    // Listing is read-only: valid entries surface, invalid ones are reported.
    const errors: string[] = [];
    const available = await listAvailableBuiltIns(builtins, (dir) => errors.push(dir));
    expect(available.map((entry) => entry.manifest.id)).toEqual(["seed"]);
    expect(errors).toEqual([broken]);
    expect(existsSync(join(workspace, "connectors", "seed"))).toBe(false);
    // Missing builtins dir (packaged without templates) is a quiet no-op.
    expect(await listAvailableBuiltIns(join(workspace, "no-such-dir"))).toEqual([]);

    // Explicit install: copies the package and records connector.installed.
    const installed = await installConnectorFromSource({
      sourceDir: join(builtins, "seed"),
      workspacePath: workspace,
      connectorId: "seed",
      guard,
    });
    expect(installed.dir).toBe(join(workspace, "connectors", "seed"));
    expect(existsSync(join(installed.dir, "index.mjs"))).toBe(true);

    const event = dataDb
      .prepare("SELECT payload FROM events WHERE type = ?")
      .get("connector.installed") as any;
    const payload = JSON.parse(event.payload);
    expect(payload.connector_id).toBe("seed");
    expect(typeof payload.package_hash).toBe("string");

    // Double-install is rejected and leaves no extra D0 record.
    await expect(
      installConnectorFromSource({
        sourceDir: join(builtins, "seed"),
        workspacePath: workspace,
        connectorId: "seed",
        guard,
      }),
    ).rejects.toThrow("Connector already installed: seed");
    expect(
      dataDb.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?").get("connector.installed"),
    ).toMatchObject({ n: 1 });
  });

  test("updates a same-id Connector by hash while preserving every Source", async () => {
    const guard = new Guard({ db: dataDb, source: "system:test" });
    const builtins = join(workspace, "builtins");
    const candidateDir = writeBuiltIn(builtins, "seed", "connector");
    await installConnectorFromSource({
      sourceDir: candidateDir,
      workspacePath: workspace,
      connectorId: "seed",
      guard,
    });
    const installedDir = join(workspace, "connectors", "seed");
    await supervisor.registerDirectory(installedDir);
    await supervisor.approveCurrentPackage("seed");
    const sourceRecord = await supervisor.addSource({
      connectorId: "seed",
      config: { accountId: "work", folder: "inbox" },
      scheduleCron: "0 * * * *",
    });
    systemDb.prepare(
      "UPDATE connector_sources SET sync_state = ? WHERE id = ?",
    ).run(JSON.stringify({ cursor: 42 }), sourceRecord.id);
    const paused = await supervisor.pauseSource(sourceRecord.id);
    const oldHash = await hashConnectorPackage(installedDir);

    writeFileSync(
      join(candidateDir, "index.mjs"),
      `export default {
  async run() { /* revision 2 */ },
  async resolveSourceIdentity() { return { key: "work", label: "revision-2" }; },
};
`,
    );
    const newHash = await hashConnectorPackage(candidateDir);
    expect(newHash).not.toBe(oldHash);

    const updated = await updateConnectorFromSource({
      sourceDir: candidateDir,
      workspacePath: workspace,
      connectorId: "seed",
      supervisor,
      guard,
    });
    expect(updated).toMatchObject({
      updated: true,
      fromHash: oldHash,
      toHash: newHash,
    });
    expect(readFileSync(join(installedDir, "index.mjs"), "utf8")).toContain("revision 2");

    const awaitingApproval = supervisor.getSource(sourceRecord.id)!;
    expect(awaitingApproval).toMatchObject({
      sourceKey: "work",
      identityStatus: "error",
      setupStatus: "setup",
    });
    await supervisor.approveCurrentPackage("seed");
    const preserved = supervisor.getSource(sourceRecord.id)!;
    expect(preserved.id).toBe(sourceRecord.id);
    expect(preserved.sourceKey).toBe("work");
    expect(preserved.identityStatus).toBe("resolved");
    expect(preserved.suggestedLabel).toBe("revision-2");
    expect(preserved.config).toEqual({ accountId: "work", folder: "inbox" });
    expect(preserved.syncState).toEqual({ cursor: 42 });
    expect(preserved.scheduleCron).toBe("0 * * * *");
    expect(preserved.pausedAt).toBe(paused.pausedAt);
    expect(preserved.packageHash).toBe(newHash);
    expect((await supervisor.list()).filter((item) => item.connectorId === "seed")).toHaveLength(1);

    const event = dataDb.prepare(
      "SELECT payload FROM events WHERE type = 'connector.updated'",
    ).get() as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({
      connector_id: "seed",
      from_hash: oldHash,
      to_hash: newHash,
    });

    const noOp = await updateConnectorFromSource({
      sourceDir: candidateDir,
      workspacePath: workspace,
      connectorId: "seed",
      supervisor,
      guard,
    });
    expect(noOp.updated).toBe(false);
    expect(
      dataDb.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'connector.updated'").get(),
    ).toMatchObject({ n: 1 });
  });

  test("rejects a package update while credential-driven identity resolution owns the Connector", async () => {
    const guard = new Guard({ db: dataDb, source: "system:test" });
    const sourceDir = join(workspace, "builtins", "credential-update-fence");
    const enteredPath = join(workspace, "identity-resolver-entered");
    const releasePath = join(workspace, "identity-resolver-release");
    mkdirSync(sourceDir, { recursive: true });
    writeConnectorManifestFixture(
      join(sourceDir, "connector.yaml"),
      `manifestVersion: 1
id: credential-update-fence
name: Credential Update Fence
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: connector
platforms:
  darwin: {}
auth:
  type: apiKey
`,
    );
    const packageSource = (revision: number) => `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export default {
  async run() {},
  async resolveSourceIdentity({ auth }) {
    const token = await auth.getToken();
    if (token === "new-token") {
      writeFileSync(${JSON.stringify(enteredPath)}, "entered");
      while (!existsSync(${JSON.stringify(releasePath)})) await delay(5);
    }
    return { key: "same-account", label: "revision-${revision}" };
  },
};
`;
    writeFileSync(join(sourceDir, "index.mjs"), packageSource(1));
    await installConnectorFromSource({
      sourceDir,
      workspacePath: workspace,
      connectorId: "credential-update-fence",
      guard,
    });
    const installedDir = join(workspace, "connectors", "credential-update-fence");
    await supervisor.registerDirectory(installedDir);
    await supervisor.approveCurrentPackage("credential-update-fence");
    const sourceRecord = supervisor.ensureSource({ connectorId: "credential-update-fence" });
    await expect(supervisor.connectSourceWithToken(sourceRecord.id, "old-token"))
      .resolves.toMatchObject({ sourceKey: "same-account", identityStatus: "resolved" });

    writeFileSync(join(sourceDir, "index.mjs"), packageSource(2));
    const connecting = supervisor.connectSourceWithToken(sourceRecord.id, "new-token");
    expect(await waitWithTestTimeout((async () => {
      while (!existsSync(enteredPath)) await new Promise((resolve) => setTimeout(resolve, 1));
    })(), 3_000)).toBe(true);

    await expect(updateConnectorFromSource({
      sourceDir,
      workspacePath: workspace,
      connectorId: "credential-update-fence",
      supervisor,
      guard,
    })).rejects.toThrow("identity mutation in progress");
    expect(readFileSync(join(installedDir, "index.mjs"), "utf8")).toContain("revision-1");

    writeFileSync(releasePath, "release");
    await expect(connecting).resolves.toMatchObject({
      sourceKey: "same-account",
      identityStatus: "resolved",
      suggestedLabel: "revision-1",
    });

    let markUpdateEntered!: () => void;
    let releaseUpdate!: () => void;
    const updateEntered = new Promise<void>((resolve) => {
      markUpdateEntered = resolve;
    });
    const updateRelease = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const coordinatingUpdate = supervisor.withConnectorUpdate(
      "credential-update-fence",
      await loadConnectorManifest(installedDir),
      async () => {
        markUpdateEntered();
        await updateRelease;
      },
    );
    await updateEntered;
    await expect(supervisor.connectSourceWithToken(sourceRecord.id, "third-token"))
      .rejects.toThrow("identity mutation in progress");
    await expect(supervisor.removeSource(sourceRecord.id))
      .rejects.toThrow("identity mutation in progress");
    await expect(supervisor.addSource({ connectorId: "credential-update-fence" }))
      .rejects.toThrow("Connector credential-update-fence is updating");
    expect((await supervisor.list()).filter((item) => (
      item.connectorId === "credential-update-fence"
    )).map((item) => item.id)).toEqual([sourceRecord.id]);
    releaseUpdate();
    await expect(coordinatingUpdate).resolves.toBeUndefined();
  });

  test("rejects incompatible Connector updates and rolls back failed audit", async () => {
    const guard = new Guard({ db: dataDb, source: "system:test" });
    const builtins = join(workspace, "builtins");
    const candidateDir = writeBuiltIn(builtins, "seed", "connector");
    await installConnectorFromSource({
      sourceDir: candidateDir,
      workspacePath: workspace,
      connectorId: "seed",
      guard,
    });
    const installedDir = join(workspace, "connectors", "seed");
    await supervisor.registerDirectory(installedDir);
    const sourceRecord = await supervisor.addSource({
      connectorId: "seed",
      config: { accountId: "work" },
    });
    const oldHash = await hashConnectorPackage(installedDir);

    writeBuiltIn(builtins, "seed", "single");
    await expect(updateConnectorFromSource({
      sourceDir: candidateDir,
      workspacePath: workspace,
      connectorId: "seed",
      supervisor,
      guard,
    })).rejects.toThrow("cannot change source.identity while Sources exist");
    expect(await hashConnectorPackage(installedDir)).toBe(oldHash);
    expect(supervisor.getSource(sourceRecord.id)).toBeDefined();

    writeBuiltIn(builtins, "seed", "connector");
    writeFileSync(
      join(candidateDir, "index.mjs"),
      `export default {
  async run() { /* rejected revision */ },
  async resolveSourceIdentity() { return { key: "work" }; },
};
`,
    );
    const failingGuard = {
      withSource: (sourceName: string) => guard.withSource(sourceName),
      queryOne: (sql: string, params?: any) => guard.queryOne(sql, params),
      writeEvent: (event: any) => {
        if (event.type === "connector.updated") throw new Error("D0 unavailable");
        return guard.writeEvent(event);
      },
    };
    await expect(updateConnectorFromSource({
      sourceDir: candidateDir,
      workspacePath: workspace,
      connectorId: "seed",
      supervisor,
      guard: failingGuard,
    })).rejects.toThrow("D0 unavailable");
    expect(await hashConnectorPackage(installedDir)).toBe(oldHash);
    expect(supervisor.getSource(sourceRecord.id)?.packageHash).toBe(oldHash);
    expect(
      dataDb.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'connector.updated'").get(),
    ).toMatchObject({ n: 0 });
  });

  test("reinstall after removal works and D0 keeps the full history", async () => {
    const guard = new Guard({ db: dataDb, source: "system:test" });
    const builtins = join(workspace, "builtins");
    writeBuiltIn(builtins, "seed");
    const installOnce = () =>
      installConnectorFromSource({
        sourceDir: join(builtins, "seed"),
        workspacePath: workspace,
        connectorId: "seed",
        guard,
      });

    await installOnce();
    await supervisor.registerDirectory(join(workspace, "connectors", "seed"));
    expect(supervisor.isRegistered("seed")).toBe(true);

    // The remove-connector flow cascades Sources before deleting the package,
    // then unregisters and records connector.removed in D0.
    expect(await removeConnectorFromWorkspace({
      workspacePath: workspace,
      connectorId: "seed",
      supervisor,
    })).toBe(true);
    expect(supervisor.isRegistered("seed")).toBe(false);

    // Nothing restores it implicitly — reinstalling is an explicit action.
    await installOnce();
    await supervisor.registerDirectory(join(workspace, "connectors", "seed"));
    expect(existsSync(join(workspace, "connectors", "seed", "index.mjs"))).toBe(true);

    const history = dataDb
      .prepare(
        "SELECT type, COUNT(*) AS n FROM events WHERE type LIKE 'connector.%' GROUP BY type ORDER BY type",
      )
      .all() as Array<{ type: string; n: number }>;
    expect(history).toEqual([
      { type: "connector.installed", n: 2 },
      { type: "connector.removed", n: 1 },
    ]);
  });

  test("remove connector cascades Sources and reinstall starts with zero Sources", async () => {
    const guard = new Guard({ db: dataDb, source: "system:test" });
    const builtins = join(workspace, "builtins");
    writeBuiltIn(builtins, "seed", "connector");
    const installOnce = () =>
      installConnectorFromSource({
        sourceDir: join(builtins, "seed"),
        workspacePath: workspace,
        connectorId: "seed",
        guard,
      });

    await installOnce();
    await supervisor.registerDirectory(join(workspace, "connectors", "seed"));
    const work = await supervisor.addSource({
      connectorId: "seed",
      config: { accountId: "work" },
    });

    expect(await removeConnectorFromWorkspace({
      workspacePath: workspace,
      connectorId: "seed",
      supervisor,
    })).toBe(true);
    expect(supervisor.getSource(work.id)).toBeUndefined();

    await installOnce();
    await supervisor.registerDirectory(join(workspace, "connectors", "seed"));
    expect((await supervisor.list()).filter((row) => row.connectorId === "seed")).toEqual([]);

    const replacement = await supervisor.addSource({
      connectorId: "seed",
      config: { accountId: "work" },
    });
    expect(replacement.id).not.toBe(work.id);
  });

  test("loads connector runtime from directory entry", async () => {
    const dir = join(workspace, "connectors", "demo");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: demo
name: Demo
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ guard, state }) {
    await guard.writeEvent({
      type: "demo.event",
      externalId: "loaded",
      startedAt: 5000,
      payload: { loaded: true },
    });
    await state.set({ loaded: true });
  },
};
`,
    );

    const manifest = await supervisor.registerDirectory(dir);
    const sourceRecord = supervisor.ensureSource({ connectorId: manifest.id });
    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("not trusted");
    await supervisor.approveCurrentPackage("demo");
    await supervisor.run(sourceRecord.id);

    const event = dataDb.prepare("SELECT source, type, external_id FROM events WHERE type = ?")
      .get("demo.event") as any;
    expect(event).toEqual({
      source: "connector:demo",
      type: "demo.event",
      external_id: "loaded",
    });
    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({ loaded: true });
  });

  test("manages Source lifecycle: connect, pause, resume, remove", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "managed-feed",
        name: "Managed Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "connector" },
        auth: { type: "apiKey" },
      },
      {
        async run() {},
        async resolveSourceIdentity() {
          return { key: "work" };
        },
      },
    );

    const sourceRecord = supervisor.ensureSource({ connectorId: "managed-feed" });
    expect(sourceRecord.setupStatus).toBe("setup");

    // apiKey connect stores the token and promotes through the evaluator.
    await expect(
      supervisor.connectSourceWithToken(sourceRecord.id, "  ")
    ).rejects.toThrow("non-empty token");
    const connected = await supervisor.connectSourceWithToken(sourceRecord.id, "tok-1");
    expect(connected.setupStatus).toBe("ready");
    expect(await supervisor.getAuthManager().hasToken(connected.authRef!)).toBe(true);

    await supervisor.configureSource(sourceRecord.id, {
      config: { folder: "inbox" },
      scheduleCron: "0 * * * *",
    });
    const paused = await supervisor.pauseSource(sourceRecord.id);
    expect(paused.pausedAt).toBeGreaterThan(0);
    expect(paused.resumeAt).toBeUndefined();
    expect(paused.status).toBe("idle");

    // Disconnect removes only account readiness. The Source and all other
    // Source-owned state survive, and a later reconnect is explicit.
    const disconnected = await supervisor.disconnectSource(sourceRecord.id);
    expect(disconnected.setupStatus).toBe("setup");
    expect(disconnected.pausedAt).toBe(paused.pausedAt);
    expect(disconnected.config).toEqual({ folder: "inbox" });
    expect(disconnected.scheduleCron).toBe("0 * * * *");
    expect(await supervisor.getAuthManager().hasToken(connected.authRef!)).toBe(false);
    const reconnected = await supervisor.connectSourceWithToken(sourceRecord.id, "tok-2");
    expect(reconnected.setupStatus).toBe("ready");
    expect(reconnected.pausedAt).toBe(paused.pausedAt);

    const resumed = supervisor.resumeSource(sourceRecord.id);
    expect(resumed.pausedAt).toBeUndefined();
    expect(resumed.resumeAt).toBeUndefined();

    // Remove purges credentials and deletes the row.
    await supervisor.removeSource(sourceRecord.id);
    expect(supervisor.getSource(sourceRecord.id)).toBeUndefined();
    expect(await supervisor.getAuthManager().hasToken(connected.authRef!)).toBe(false);

    // Removing the last Source leaves the Connector installed with zero
    // Sources; no setup placeholder is recreated.
    expect((await supervisor.list()).find((c) => c.connectorId === "managed-feed")).toBeUndefined();
    expect(supervisor.isRegistered("managed-feed")).toBe(true);
  });

  test("Remove Connector cascades active Sources, credentials, and run history", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "cascade-feed",
        name: "Cascade Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "connector" },
        auth: { type: "apiKey" },
      },
      {
        async resolveSourceIdentity({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          const token = await auth.getToken();
          return { key: token.startsWith("work-") ? "work" : "personal" };
        },
        async run({ signal }) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const work = supervisor.ensureSource({ connectorId: "cascade-feed" });
    const personal = supervisor.ensureSource({ connectorId: "cascade-feed" });
    const connectedWork = await supervisor.connectSourceWithToken(work.id, "work-token");
    const connectedPersonal = await supervisor.connectSourceWithToken(personal.id, "personal-token");
    expect(connectedWork).toMatchObject({ sourceKey: "work", identityStatus: "resolved" });
    expect(connectedPersonal).toMatchObject({ sourceKey: "personal", identityStatus: "resolved" });
    supervisor.start(work.id, { trigger: "watch" });
    expect((await supervisor.list()).find((sourceRecord) => sourceRecord.id === work.id)?.running).toBe(true);

    expect(await supervisor.unregister("cascade-feed")).toBe(true);
    expect(supervisor.isRegistered("cascade-feed")).toBe(false);
    expect((await supervisor.list()).filter((sourceRecord) => sourceRecord.connectorId === "cascade-feed")).toEqual([]);
    expect(await supervisor.getAuthManager().hasToken(connectedWork.authRef!)).toBe(false);
    expect(await supervisor.getAuthManager().hasToken(connectedPersonal.authRef!)).toBe(false);
    expect(systemDb.prepare(
      "SELECT COUNT(*) AS count FROM connector_runs WHERE connector_id = ?",
    ).get("cascade-feed")).toEqual({ count: 0 });
  });

  test("rejects browser auth token connect because it uses the browser flow", async () => {
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-feed",
        name: "OAuth Feed",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          clientId: "feed-client-id",
        },
      },
      { async run() {} },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-feed" });
    await expect(
      supervisor.connectSourceWithToken(sourceRecord.id, "tok")
    ).rejects.toThrow("browser auth");
  });

  test("holds connector identity ownership through pending browser auth and releases it on terminal status", async () => {
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager: new ConnectorAuthManager(secrets, {
        fetchImpl: async () => new Response(JSON.stringify({
          access_token: "oauth-account-1",
          token_type: "Bearer",
          expires_in: 3600,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      }),
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-identity-claim",
        name: "OAuth Identity Claim",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "identity-client",
        },
      },
      {
        async run() {},
        async resolveSourceIdentity({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          return { key: await auth.getToken(), label: "OAuth account" };
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-identity-claim" });
    const first = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    await expect(supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    })).rejects.toThrow("identity mutation in progress");
    await expect(supervisor.configureSource(sourceRecord.id, { config: { note: "blocked" } }))
      .rejects.toThrow("identity mutation in progress");

    const firstState = new URL(first.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: firstState,
      error: "access_denied",
    }))).resolves.toMatchObject({ status: "failed", error: "access_denied" });

    const second = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const secondState = new URL(second.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: secondState,
      code: "code-1",
    }))).resolves.toMatchObject({ status: "connected", sourceId: sourceRecord.id });
    expect(supervisor.getSource(sourceRecord.id)).toMatchObject({
      sourceKey: "oauth-account-1",
      identityStatus: "resolved",
      suggestedLabel: "OAuth account",
      setupStatus: "ready",
    });
  });

  test("keeps browser identity finalization non-expiring while its resolver runs", async () => {
    let markResolverEntered!: () => void;
    let releaseResolver!: () => void;
    const resolverEntered = new Promise<void>((resolve) => {
      markResolverEntered = resolve;
    });
    const resolverRelease = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    const authManager = new ConnectorAuthManager(secrets, {
      attemptTtlMs: 100,
      now: () => 1,
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: "finalizing-account",
        expires_in: 3_600,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-finalization-claim",
        name: "OAuth Finalization Claim",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "finalization-client",
        },
      },
      {
        async run() {},
        async resolveSourceIdentity({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          const key = await auth.getToken();
          markResolverEntered();
          await resolverRelease;
          return { key };
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-finalization-claim" });
    const started = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const completion = supervisor.completeOAuthCallback(new URLSearchParams({
      state,
      code: "code-1",
    }));

    await resolverEntered;
    try {
      await expect(supervisor.startOAuthSource(sourceRecord.id, {
        redirectUri: "http://localhost:32123/oauth/callback",
      })).rejects.toThrow("identity mutation in progress");
      await expect(supervisor.disconnectSource(sourceRecord.id))
        .rejects.toThrow("identity mutation in progress");
    } finally {
      releaseResolver();
    }

    await expect(completion).resolves.toMatchObject({
      status: "connected",
      sourceId: sourceRecord.id,
    });
    expect(supervisor.getSource(sourceRecord.id)).toMatchObject({
      sourceKey: "finalizing-account",
      identityStatus: "resolved",
      setupStatus: "ready",
    });
    expect(await authManager.hasToken(sourceRecord.authRef!)).toBe(true);
  });

  test("a stale expired callback cannot release its replacement browser identity claim", async () => {
    let now = Date.now();
    let markExchangeStarted!: () => void;
    let releaseExchange!: (response: Response) => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    const exchangeResponse = new Promise<Response>((resolve) => {
      releaseExchange = resolve;
    });
    const authManager = new ConnectorAuthManager(secrets, {
      attemptTtlMs: 60_000,
      now: () => now,
      fetchImpl: async () => {
        markExchangeStarted();
        return exchangeResponse;
      },
    });
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-stale-finalizer",
        name: "OAuth Stale Finalizer",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "stale-finalizer-client",
        },
      },
      {
        async run() {},
        async resolveSourceIdentity({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          return { key: await auth.getToken() };
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-stale-finalizer" });
    const expired = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const expiredState = new URL(expired.authorizationUrl).searchParams.get("state")!;
    const staleCompletion = supervisor.completeOAuthCallback(new URLSearchParams({
      state: expiredState,
      code: "stale-code",
    }));

    await exchangeStarted;
    now = expired.expiresAt + 1;
    await expect(supervisor.getOAuthAttempt(sourceRecord.id, expired.attemptId)).resolves.toMatchObject({
      status: "expired",
      sourceId: sourceRecord.id,
    });

    now = Date.now();
    const replacement = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    releaseExchange(new Response(JSON.stringify({ access_token: "must-not-survive" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const staleResult = await staleCompletion;
    expect(staleResult).toMatchObject({
      status: "failed",
      error: "Authentication was cancelled for this Source",
    });
    expect(staleResult).not.toHaveProperty("sourceId");
    await expect(supervisor.configureSource(sourceRecord.id, { config: { account: "blocked" } }))
      .rejects.toThrow("identity mutation in progress");

    const replacementState = new URL(replacement.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: replacementState,
      error: "cancelled",
    }))).resolves.toMatchObject({ status: "failed", error: "cancelled" });
    expect(await authManager.hasToken(sourceRecord.authRef!)).toBe(false);
  });

  test("sweeps an expired browser identity claim and cancels its stale callback", async () => {
    const authManager = new ConnectorAuthManager(secrets, { now: () => 1 });
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-expired-claim",
        name: "OAuth Expired Claim",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "expired-client",
        },
      },
      {
        async run() {},
        async resolveSourceIdentity() {
          return { key: "never-used" };
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-expired-claim" });
    const expired = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const replacement = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const expiredState = new URL(expired.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: expiredState,
      code: "stale-code",
    }))).resolves.toEqual({
      status: "failed",
      error: "OAuth state is invalid or already used",
    });
    expect(await authManager.hasToken(sourceRecord.authRef!)).toBe(false);

    const replacementState = new URL(replacement.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: replacementState,
      error: "cancelled",
    }))).resolves.toMatchObject({ status: "failed", error: "cancelled" });
    await expect(supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    })).resolves.toHaveProperty("authorizationUrl");
    await supervisor.removeSource(sourceRecord.id);
  });

  test("holds a cancelled browser identity claim until Source credential deletion finishes", async () => {
    let markDeletionStarted!: () => void;
    let releaseDeletion!: () => void;
    const deletionStarted = new Promise<void>((resolve) => {
      markDeletionStarted = resolve;
    });
    const deletionRelease = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const authManager = new ConnectorAuthManager(secrets);
    const deleteCredentials = authManager.deleteSourceCredentials.bind(authManager);
    const deleteSpy = vi.spyOn(authManager, "deleteSourceCredentials")
      .mockImplementation(async (...args) => {
        markDeletionStarted();
        await deletionRelease;
        await deleteCredentials(...args);
      });
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-remove-claim",
        name: "OAuth Remove Claim",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "remove-claim-client",
        },
      },
      {
        async run() {},
        async resolveSourceIdentity() {
          return { key: "unused" };
        },
      },
    );
    const removingSource = supervisor.ensureSource({ connectorId: "oauth-remove-claim" });
    const waitingSource = supervisor.ensureSource({ connectorId: "oauth-remove-claim" });
    await supervisor.startOAuthSource(removingSource.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });

    const removal = supervisor.removeSource(removingSource.id);
    await deletionStarted;
    try {
      await expect(supervisor.retrySourceIdentity(waitingSource.id))
        .rejects.toThrow("identity mutation in progress");
    } finally {
      releaseDeletion();
    }
    await expect(removal).resolves.toBeUndefined();
    expect(supervisor.getSource(removingSource.id)).toBeUndefined();

    const replacement = await supervisor.startOAuthSource(waitingSource.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const replacementState = new URL(replacement.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: replacementState,
      error: "cancelled",
    }))).resolves.toMatchObject({ status: "failed", error: "cancelled" });
    deleteSpy.mockRestore();
  });

  test("disconnect releases a pending browser barrier without releasing its Connector claim", async () => {
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const authManager = new ConnectorAuthManager(secrets, {
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: "connected-account",
        expires_in: 3_600,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-disconnect-barrier",
        name: "OAuth Disconnect Barrier",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "manual" },
        source: { identity: "connector" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "disconnect-barrier-client",
        },
      },
      {
        async resolveSourceIdentity({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          return { key: await auth.getToken() };
        },
        async run({ signal }) {
          markRunStarted();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-disconnect-barrier" });
    const waitingSource = supervisor.ensureSource({ connectorId: "oauth-disconnect-barrier" });
    const initial = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const initialState = new URL(initial.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: initialState,
      code: "initial-code",
    }))).resolves.toMatchObject({ status: "connected" });

    const handle = supervisor.start(sourceRecord.id, { trigger: "manual" });
    await runStarted;
    await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });

    let markDeletionStarted!: () => void;
    let releaseDeletion!: () => void;
    const deletionStarted = new Promise<void>((resolve) => {
      markDeletionStarted = resolve;
    });
    const deletionRelease = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const deleteCredentials = authManager.deleteSourceCredentials.bind(authManager);
    const deleteSpy = vi.spyOn(authManager, "deleteSourceCredentials")
      .mockImplementation(async (...args) => {
        markDeletionStarted();
        await deletionRelease;
        await deleteCredentials(...args);
      });

    const disconnecting = supervisor.disconnectSource(sourceRecord.id);
    try {
      expect(await waitWithTestTimeout(deletionStarted, 2_000)).toBe(true);
      expect(handle.signal.aborted).toBe(true);
      await expect(supervisor.retrySourceIdentity(waitingSource.id))
        .rejects.toThrow("identity mutation in progress");
    } finally {
      releaseDeletion();
    }
    expect(await waitWithTestTimeout(disconnecting, 2_000)).toBe(true);
    await expect(disconnecting).resolves.toMatchObject({
      identityStatus: "unresolved",
      setupStatus: "setup",
    });
    expect(await waitWithTestTimeout(handle.promise, 2_000)).toBe(true);
    expect(await authManager.hasToken(sourceRecord.authRef!)).toBe(false);
    deleteSpy.mockRestore();

    const replacement = await supervisor.startOAuthSource(waitingSource.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const replacementState = new URL(replacement.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: replacementState,
      error: "cancelled",
    }))).resolves.toMatchObject({ status: "failed", error: "cancelled" });
  });

  test("Pause stops a watch behind a pending browser barrier without releasing its Connector claim", async () => {
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const authManager = new ConnectorAuthManager(secrets, {
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: "paused-account",
        expires_in: 3_600,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-pause-barrier",
        name: "OAuth Pause Barrier",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "watch" },
        source: { identity: "connector" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "pause-barrier-client",
        },
      },
      {
        async resolveSourceIdentity({ auth }) {
          if (auth.type === "none") throw new Error("expected auth");
          return { key: await auth.getToken() };
        },
        async run({ signal }) {
          markRunStarted();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-pause-barrier" });
    const waitingSource = supervisor.ensureSource({ connectorId: "oauth-pause-barrier" });
    const initial = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const initialState = new URL(initial.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: initialState,
      code: "initial-code",
    }))).resolves.toMatchObject({ status: "connected" });

    const handle = supervisor.start(sourceRecord.id, { trigger: "watch" });
    await runStarted;
    const pending = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });

    const pausing = supervisor.pauseSource(sourceRecord.id);
    expect(await waitWithTestTimeout(pausing, 2_000)).toBe(true);
    await expect(pausing).resolves.toMatchObject({
      pausedAt: expect.any(Number),
      identityStatus: "unresolved",
    });
    expect(await waitWithTestTimeout(handle.promise, 2_000)).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    await expect(supervisor.retrySourceIdentity(waitingSource.id))
      .rejects.toThrow("identity mutation in progress");

    const pendingState = new URL(pending.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({
      state: pendingState,
      error: "cancelled",
    }))).resolves.toMatchObject({ status: "failed", error: "cancelled" });
  });

  test("oauth callback binds auth_ref to first-connect setup rows", async () => {
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager: new ConnectorAuthManager(secrets, {
        managedProviderApiOrigin: "https://api.lamarck.ai",
        lamarckSession: {
          accessToken: async () => "desktop-session-token",
          clearLocalSession: async () => {},
        },
        fetchImpl: async (url, init) => {
          if (String(url).includes("/capability-token")) {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            expect(body).toEqual({ sourceId: expect.any(String) });
            return new Response(JSON.stringify({
              tokenType: "Bearer",
              accessToken: "lamarck-capability-token",
              expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
              providerId: "oura",
              sourceId: body.sourceId,
            }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-bind",
        name: "OAuth Bind",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          clientId: "feed-client-id",
        },
      },
      { async run() {} },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-bind" });
    systemDb.prepare("UPDATE connector_sources SET auth_ref = NULL WHERE id = ?").run(sourceRecord.id);
    expect(supervisor.getSource(sourceRecord.id)?.authRef).toBeUndefined();

    const started = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" })))
      .resolves.toMatchObject({ status: "connected", sourceId: sourceRecord.id });

    const connected = supervisor.getSource(sourceRecord.id)!;
    expect(connected.authRef).toBe(defaultAuthRef(sourceRecord.id));
    expect(connected.setupStatus).toBe("ready");
    expect(await supervisor.getAuthManager().hasToken(connected.authRef!)).toBe(true);
  });

  test("removing a Source cancels pending OAuth so a late callback cannot recreate credentials", async () => {
    let tokenExchanges = 0;
    const authManager = new ConnectorAuthManager(secrets, {
      fetchImpl: async () => {
        tokenExchanges += 1;
        return new Response(JSON.stringify({ access_token: "late-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-remove",
        name: "OAuth Remove",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          clientId: "remove-client-id",
        },
      },
      { async run() {} },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-remove" });
    const started = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await supervisor.removeSource(sourceRecord.id);
    await expect(supervisor.completeOAuthCallback(new URLSearchParams({ state, code: "late" })))
      .resolves.toEqual({ status: "failed", error: "OAuth state is invalid or already used" });
    expect(tokenExchanges).toBe(0);
    expect(await authManager.hasToken(sourceRecord.authRef!)).toBe(false);
  });

  test("removing a Source prevents an in-flight OAuth exchange from writing credentials", async () => {
    let releaseExchange!: (response: Response) => void;
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    const exchangeResponse = new Promise<Response>((resolve) => {
      releaseExchange = resolve;
    });
    const authManager = new ConnectorAuthManager(secrets, {
      fetchImpl: async () => {
        markExchangeStarted();
        return exchangeResponse;
      },
    });
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager,
    });
    supervisor.register(
      {
        manifestVersion: 1,
        id: "oauth-in-flight-remove",
        name: "OAuth In-flight Remove",
        description: "Test connector manifest.",
        eventCatalog: "./events.json",
        entry: "./index.ts",
        runtime: { mode: "poll" },
        source: { identity: "single" },
        auth: {
          type: "oauth2-public",
          authorizationEndpoint: "https://accounts.example.test/authorize",
          tokenEndpoint: "https://accounts.example.test/token",
          clientId: "in-flight-client",
        },
      },
      { async run() {} },
    );
    const sourceRecord = supervisor.ensureSource({ connectorId: "oauth-in-flight-remove" });
    const started = await supervisor.startOAuthSource(sourceRecord.id, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const completion = supervisor.completeOAuthCallback(new URLSearchParams({ state, code: "code" }));

    await exchangeStarted;
    await supervisor.removeSource(sourceRecord.id);
    releaseExchange(new Response(JSON.stringify({ access_token: "must-not-survive" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(completion).resolves.toMatchObject({
      status: "failed",
      error: "Source was removed during authentication",
    });
    expect(await authManager.hasToken(sourceRecord.authRef!)).toBe(false);
  });

  test("browser auth manifest flows expose the intended runtime handles", async () => {
    const seenAuthTypes: string[] = [];
    const seenTokens: string[] = [];
    const reconciledSourceIds: string[] = [];
    let directOAuthTokenCalls = 0;
    supervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      authManager: new ConnectorAuthManager(secrets, {
        managedProviderApiOrigin: "https://api.lamarck.ai",
        lamarckSession: {
          accessToken: async () => "desktop-session-token",
          clearLocalSession: async () => {},
        },
        fetchImpl: async (url, init) => {
          if (String(url).includes("/capability-token")) {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            expect(body).toEqual({ sourceId: expect.any(String) });
            return new Response(JSON.stringify({
              tokenType: "Bearer",
              accessToken: "lamarck-capability-token",
              expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
              providerId: "oura",
              sourceId: body.sourceId,
            }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          directOAuthTokenCalls += 1;
          const refreshing = String(init?.body ?? "").includes("grant_type=refresh_token");
          return new Response(JSON.stringify({
            access_token: refreshing ? "refreshed-access-token" : "expired-access-token",
            refresh_token: "refresh-token",
            expires_in: refreshing ? 3600 : -1,
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
    });
    supervisor.onRuntimeReconcileRequested((instanceId, reason) => {
      if (reason === "credential_connected") reconciledSourceIds.push(instanceId);
    });

    const manifests: Array<{
      manifest: ConnectorManifest;
      connect: (sourceId: string) => Promise<void>;
    }> = [
      {
        manifest: {
          manifestVersion: 1,
          id: "oauth-public",
          name: "OAuth Public",
          description: "Test connector manifest.",
          eventCatalog: "./events.json",
          entry: "./index.ts",
          runtime: { mode: "poll" },
          source: { identity: "single" },
          auth: {
            type: "oauth2-public",
            authorizationEndpoint: "https://provider.example/oauth/authorize",
            tokenEndpoint: "https://provider.example/oauth/token",
            clientId: "public-client",
          },
        },
        connect: async (sourceId) => {
          const started = await supervisor.startOAuthSource(sourceId, {
            redirectUri: "http://localhost:32123/oauth/callback",
          });
          const state = new URL(started.authorizationUrl).searchParams.get("state")!;
          await supervisor.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" }));
          await supervisor.getOAuthAttempt(sourceId, started.attemptId);
        },
      },
      {
        manifest: {
          manifestVersion: 1,
          id: "managed-oura",
          name: "Managed Oura",
          description: "Test connector manifest.",
          eventCatalog: "./events.json",
          entry: "./index.ts",
          runtime: { mode: "poll" },
          source: { identity: "single" },
          auth: {
            type: "managedProvider",
            providerId: "oura",
          },
        },
        connect: async (sourceId) => {
          const started = await supervisor.startAuthSource(sourceId, {
            redirectUri: "http://localhost:32123/oauth/callback",
          });
          await expect(supervisor.getOAuthAttempt(sourceId, started.attemptId))
            .resolves.toMatchObject({ status: "connected" });
          await supervisor.getOAuthAttempt(sourceId, started.attemptId);
        },
      },
    ];

    const sourceIds: string[] = [];
    for (const { manifest, connect } of manifests) {
      supervisor.register(manifest, {
        async run({ auth }) {
          seenAuthTypes.push(auth.type);
          if (auth.type !== "none") {
            seenTokens.push(await auth.getToken());
          }
        },
      });
      const sourceRecord = supervisor.ensureSource({ connectorId: manifest.id });
      sourceIds.push(sourceRecord.id);
      await connect(sourceRecord.id);
      await supervisor.run(sourceRecord.id);
    }

    expect(seenAuthTypes).toEqual(["oauth2", "managedProvider"]);
    expect(seenTokens).toEqual(["refreshed-access-token", "lamarck-capability-token"]);
    expect(directOAuthTokenCalls).toBe(2);
    expect(reconciledSourceIds).toEqual(sourceIds);
  });

  test("emits D0 audit events for connector approve and remove", async () => {
    const dir = join(workspace, "connectors", "audited");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: audited
name: Audited
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(join(dir, "index.mjs"), "export default { async run() {} };\n");

    await supervisor.registerDirectory(dir);
    supervisor.ensureSource({ connectorId: "audited" });
    await supervisor.approveCurrentPackage("audited");

    const approved = dataDb
      .prepare("SELECT source, payload FROM events WHERE type = ?")
      .get("connector.approved") as any;
    expect(approved.source).toBe("system:test");
    const approvedPayload = JSON.parse(approved.payload);
    expect(approvedPayload.connector_id).toBe("audited");
    expect(approvedPayload.approved_hash).toMatch(/^sha256:/);
    const approvalState = systemDb
      .prepare("SELECT approved_hash FROM connector_custom_approvals WHERE connector_id = ?")
      .get("audited") as { approved_hash: string };
    expect(approvalState.approved_hash).toBe(approvedPayload.approved_hash);

    expect(await supervisor.unregister("audited")).toBe(true);
    expect(
      systemDb.prepare(
        "SELECT approved_hash FROM connector_custom_approvals WHERE connector_id = ?",
      ).get("audited"),
    ).toBeUndefined();
    const removed = dataDb
      .prepare("SELECT source, payload FROM events WHERE type = ?")
      .get("connector.removed") as any;
    expect(removed.source).toBe("system:test");
    expect(JSON.parse(removed.payload)).toEqual({ connector_id: "audited" });

    // Connector removal cascades its Sources; no missing-package row survives.
    expect((await supervisor.list()).find((c) => c.connectorId === "audited")).toBeUndefined();

    await supervisor.registerDirectory(dir);
    expect(supervisor.listInstalledConnectors()).toEqual([
      expect.objectContaining({ connectorId: "audited", packageTrust: "untrusted" }),
    ]);
  });

  test("runs workspace package connectors with only the allowlisted OS environment", async () => {
    const dir = join(workspace, "connectors", "pid-probe");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: pid-probe
name: PID Probe
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ guard, state, config }) {
    await guard.writeEvent({
      type: "pid.sample",
      externalId: "pid",
      startedAt: 1,
      payload: {
        pid: process.pid,
        configType: typeof config,
        env: {
          marker: process.env.LAMARCK_CONNECTOR_ENV_MARKER ?? null,
          ambientSecret: process.env.OPENAI_API_KEY ?? null,
          guardToken: process.env.LAMARCK_GUARD_TOKEN ?? null,
          guardOrigin: process.env.LAMARCK_GUARD_ORIGIN ?? null,
          coreToken: process.env.LAMARCK_CORE_TOKEN ?? null,
          vaultKey: process.env.LAMARCK_VAULT_KEY ?? null,
          locale: process.env.LANG ?? null,
          timeLocale: process.env.LC_TIME ?? null,
          inventedLocale: process.env.LC_LAMARCK_SECRET ?? null,
          electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
        },
      },
    });
    await state.set({ pid: process.pid });
  },
};
`,
    );

    await supervisor.registerDirectory(dir);
    const sourceRecord = supervisor.ensureSource({ connectorId: "pid-probe" });
    await supervisor.approveCurrentPackage("pid-probe");
    const childEnvironment = {
      LAMARCK_CONNECTOR_ENV_MARKER: "ordinary-runtime-value",
      OPENAI_API_KEY: "ambient-secret",
      LAMARCK_GUARD_TOKEN: "guard-secret",
      LAMARCK_GUARD_ORIGIN: "http://127.0.0.1:49999",
      LAMARCK_CORE_TOKEN: "core-secret",
      LAMARCK_VAULT_KEY: "vault-secret",
      LANG: "connector-test-locale",
      LC_TIME: "connector-test-time-locale",
      LC_LAMARCK_SECRET: "locale-prefixed-secret",
      ELECTRON_RUN_AS_NODE: "host-private-value",
    };
    const previousEnvironment = Object.fromEntries(
      Object.keys(childEnvironment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, childEnvironment);
    try {
      await supervisor.run(sourceRecord.id);
    } finally {
      for (const [key, previous] of Object.entries(previousEnvironment)) {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }

    const event = dataDb.prepare("SELECT payload FROM events WHERE type = ?").get("pid.sample") as any;
    const payload = JSON.parse(event.payload);
    expect(typeof payload.pid).toBe("number");
    // The whole point: connector code did not execute in this process.
    expect(payload.pid).not.toBe(process.pid);
    // mergeConfig normalizes absent config to {} on both runner paths; the
    // process boundary must not degrade it to null.
    expect(payload.configType).toBe("object");
    expect(payload.env).toEqual({
      marker: null,
      ambientSecret: null,
      guardToken: null,
      guardOrigin: null,
      coreToken: null,
      vaultKey: null,
      locale: "connector-test-locale",
      timeLocale: "connector-test-time-locale",
      inventedLocale: null,
      electronRunAsNode: "1",
    });
    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({ pid: payload.pid });
  });

  test("workspace package connectors can write text blobs over runner RPC", async () => {
    const dir = join(workspace, "connectors", "blob-rpc");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: blob-rpc
name: Blob RPC
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `const blobText = "runner process redacted blob payload";

export default {
  async run({ guard }) {
    const result = await guard.writeTextBlob({
      text: blobText,
      variant: "redacted-text",
      mediaType: "text/plain; charset=utf-8",
    });
    await guard.writeEvent({
      type: "blob.rpc",
      externalId: "blob-rpc",
      startedAt: 1,
      payload: {
        contentRef: result.ref,
        bytes: result.bytes,
        compressedBytes: result.compressedBytes,
        pid: process.pid,
      },
    });
  },
};
`,
    );

    await supervisor.registerDirectory(dir);
    const sourceRecord = supervisor.ensureSource({ connectorId: "blob-rpc" });
    await supervisor.approveCurrentPackage("blob-rpc");
    await supervisor.run(sourceRecord.id);

    const blobText = "runner process redacted blob payload";
    const digestHex = createHash("sha256").update(blobText).digest("hex");
    const event = dataDb.prepare("SELECT payload FROM events WHERE type = ?").get("blob.rpc") as any;
    const payload = JSON.parse(event.payload);
    expect(payload.pid).not.toBe(process.pid);
    expect(payload.contentRef).toEqual({
      kind: "content-blob",
      version: 1,
      digest: `sha256:${digestHex}`,
      variant: "redacted-text",
      mediaType: "text/plain; charset=utf-8",
      encoding: "gzip",
    });

    const blobPath = join(
      workspace,
      ".lamarck",
      "blobs",
      "content",
      "v1",
      "sha256",
      digestHex.slice(0, 2),
      digestHex.slice(2, 4),
      `${digestHex}.gz`,
    );
    expect(gunzipSync(readFileSync(blobPath)).toString("utf8")).toBe(blobText);
    expect(JSON.stringify(payload.contentRef)).not.toContain(blobPath);
  });

	  test("workspace package connectors can patch config from config UI sessions", async () => {
	    const dir = join(workspace, "connectors", "config-ui-rpc");
	    mkdirSync(dir, { recursive: true });
	    writeConnectorManifestFixture(
	      join(dir, "connector.yaml"),
	      `manifestVersion: 1
id: config-ui-rpc
name: Config UI RPC
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
config:
  mode:
    type: string
    label: Mode
    default: rich-local
configPanels:
  privacy-controls:
    label: Privacy Controls
platforms:
  darwin: {}
auth:
  type: none
`,
	    );
	    writeFileSync(
	      join(dir, "index.mjs"),
	      `export default {
  async run() {},
  async configUi(context) {
    if ("host" in context) throw new Error("host leaked into connector config UI context");
    const { panelId, config, configStore, state } = context;
    if (panelId !== "privacy-controls") throw new Error("wrong panel");
    if (config.mode !== "rich-local") throw new Error("missing default");
    const previous = await state.get();
    if (previous !== undefined) throw new Error("unexpected existing state");
    await configStore.patch({
      set: {
        privacyPolicy: {
          version: 1,
          apps: { "com.apple.finder": { action: "metadata_only" } },
        },
      },
    });
    await state.set({ pendingUsers: {}, approvedUsers: { "123": { username: "alice" } } });
    return { url: "http://127.0.0.1:49321/panel?token=abcdefghijklmnop" };
  },
};
`,
	    );

	    await supervisor.registerDirectory(dir);
	    const sourceRecord = supervisor.ensureSource({ connectorId: "config-ui-rpc" });
	    await supervisor.configureSource(sourceRecord.id, { config: { opaque: { keep: true } } });
	    await supervisor.approveCurrentPackage("config-ui-rpc");

	    const started = await supervisor.startConfigUi(sourceRecord.id, "privacy-controls");
	    expect(started.url).toContain("token=abcdefghijklmnop");
	    expect(supervisor.getSource(sourceRecord.id)?.config).toEqual({
	      opaque: { keep: true },
	      privacyPolicy: {
	        version: 1,
	        apps: { "com.apple.finder": { action: "metadata_only" } },
	      },
	    });
	    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({
	      pendingUsers: {},
	      approvedUsers: { "123": { username: "alice" } },
	    });
	    expect(await supervisor.stopConfigUiSession(started.sessionId)).toBe(true);
	  });

  test("config replacement restarts a package process while preserving its manual run intent", async () => {
    const reconfigSupervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      runnerKillGraceMs: 150,
    });
    const dir = join(workspace, "connectors", "process-reconfigure");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: process-reconfigure
name: Process Reconfigure
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
config:
  label:
    type: string
    label: Label
    default: old
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ config, state, signal }) {
    const previous = await state.get() ?? { attempts: [] };
    await state.set({
      attempts: [...previous.attempts, { label: config.label, pid: process.pid }],
    });
    if (config.label === "old") {
      await new Promise(() => {});
      return;
    }
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
  },
};
`,
    );

    await reconfigSupervisor.registerDirectory(dir);
    const sourceRecord = reconfigSupervisor.ensureSource({
      connectorId: "process-reconfigure",
      config: { label: "old" },
    });
    await reconfigSupervisor.approveCurrentPackage("process-reconfigure");
    const handle = reconfigSupervisor.start(sourceRecord.id, { trigger: "manual" });
    expect(await waitWithTestTimeout((async () => {
      while (
        ((reconfigSupervisor.getSource(sourceRecord.id)?.syncState as any)?.attempts?.length ?? 0) < 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })(), 3_000)).toBe(true);

    await reconfigSupervisor.configureSource(sourceRecord.id, { config: { label: "new" } });
    expect(await waitWithTestTimeout((async () => {
      while (
        ((reconfigSupervisor.getSource(sourceRecord.id)?.syncState as any)?.attempts?.length ?? 0) < 2
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })(), 3_000)).toBe(true);

    const attempts = (reconfigSupervisor.getSource(sourceRecord.id)?.syncState as any).attempts;
    expect(attempts.map((attempt: any) => attempt.label)).toEqual(["old", "new"]);
    expect(attempts[0].pid).not.toBe(attempts[1].pid);
    expect(handle.signal.aborted).toBe(false);
    expect((await reconfigSupervisor.list())[0].recentRuns).toHaveLength(1);

    handle.abort();
    await handle.promise;
    expect((await reconfigSupervisor.list())[0].recentRuns[0].status).toBe("aborted");
  });

	  test("workspace package connectors can report warnings over runner RPC", async () => {
    const dir = join(workspace, "connectors", "warning-rpc");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: warning-rpc
name: Warning RPC
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: manual
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ warnings }) {
    await warnings.set({ key: "stale", message: "old warning" });
    await warnings.clear("stale");
    await warnings.set({
      key: "backfill",
      message: "Backfill paused from child",
      details: { stream: "daily_sleep" },
    });
  },
};
`,
    );

    await supervisor.registerDirectory(dir);
    const sourceRecord = supervisor.ensureSource({ connectorId: "warning-rpc" });
    await supervisor.approveCurrentPackage("warning-rpc");
    await supervisor.run(sourceRecord.id);

    const stored = supervisor.getSource(sourceRecord.id);
    expect(stored?.status).toBe("idle");
    expect(stored?.lastError).toBeUndefined();
    expect(stored?.warnings).toHaveLength(1);
    expect(stored?.warnings?.[0]).toMatchObject({
      key: "backfill",
      message: "Backfill paused from child",
      details: { stream: "daily_sleep" },
    });
  });

  test("force-kills runner processes that ignore abort", async () => {
    const fastKillSupervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      runnerKillGraceMs: 150,
    });
    const dir = join(workspace, "connectors", "stubborn");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: stubborn
name: Stubborn
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: watch
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `// Survives polite kills: ignores both the abort signal and SIGTERM.
process.on("SIGTERM", () => {});
export default {
  async run() {
    await new Promise(() => {});
  },
};
`,
    );

    await fastKillSupervisor.registerDirectory(dir);
    const sourceRecord = fastKillSupervisor.ensureSource({ connectorId: "stubborn" });
    await fastKillSupervisor.approveCurrentPackage("stubborn");

    const handle = fastKillSupervisor.start(sourceRecord.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    handle.abort();
    const settled = await waitWithTestTimeout(handle.promise, 3_000);
    expect(settled).toBe(true);
    expect(fastKillSupervisor.getSource(sourceRecord.id)?.status).toBe("idle");
  });

  test("package runner abort is cooperative: the connector cleans up before any kill", async () => {
    const dir = join(workspace, "connectors", "tidy");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: tidy
name: Tidy
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: watch
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run({ guard, state, signal }) {
    await guard.writeEvent({ type: "tidy.start", externalId: "start", startedAt: 1, payload: {} });
    await new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await state.set({ cleanedUp: true });
  },
};
`,
    );

    await supervisor.registerDirectory(dir);
    const sourceRecord = supervisor.ensureSource({ connectorId: "tidy" });
    await supervisor.approveCurrentPackage("tidy");

    const handle = supervisor.start(sourceRecord.id);
    const started = await waitWithTestTimeout(
      (async () => {
        while (!dataDb.prepare("SELECT id FROM events WHERE type = ?").get("tidy.start")) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })(),
      5_000,
    );
    expect(started).toBe(true);

    handle.abort();
    const settled = await waitWithTestTimeout(handle.promise, 3_000);
    expect(settled).toBe(true);
    // The cleanup write only lands if abort stayed cooperative — an immediate
    // SIGKILL would have killed the child before state.set.
    expect(supervisor.getSource(sourceRecord.id)?.syncState).toEqual({ cleanedUp: true });
    expect(supervisor.getSource(sourceRecord.id)?.status).toBe("idle");
  });

  test("kills runner processes that hang during top-level import", async () => {
    const hangSupervisor = new ConnectorSupervisor({
      systemDb,
      guard: new Guard({ db: dataDb, source: "system:test" }),
      workspacePath: workspace,
      platform: "darwin",
      runnerCommandTimeoutMs: 300,
    });
    const dir = join(workspace, "connectors", "import-hang");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: import-hang
name: Import Hang
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `await new Promise(() => {}); // top-level hang
export default { async run() {} };
`,
    );

    await hangSupervisor.registerDirectory(dir);
    const sourceRecord = hangSupervisor.ensureSource({ connectorId: "import-hang" });
    await hangSupervisor.approveCurrentPackage("import-hang");

    // Bounded by runnerCommandTimeoutMs: the hanging import is killed and the
    // run fails instead of waiting forever.
    await expect(hangSupervisor.run(sourceRecord.id)).rejects.toThrow("timed out");
    expect(hangSupervisor.getSource(sourceRecord.id)?.status).toBe("error");
  });

  test("isolates runner process crashes from the core", async () => {
    const dir = join(workspace, "connectors", "crasher");
    mkdirSync(dir, { recursive: true });
    writeConnectorManifestFixture(
      join(dir, "connector.yaml"),
      `manifestVersion: 1
id: crasher
name: Crasher
description: Test connector manifest.
eventCatalog: ./events.json
entry: ./index.mjs
runtime:
  mode: poll
  defaultSchedule: "*/15 * * * *"
source:
  identity: single
platforms:
  darwin: {}
auth:
  type: none
`,
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
  async run() {
    process.exit(7);
  },
};
`,
    );

    await supervisor.registerDirectory(dir);
    const sourceRecord = supervisor.ensureSource({ connectorId: "crasher" });
    await supervisor.approveCurrentPackage("crasher");

    await expect(supervisor.run(sourceRecord.id)).rejects.toThrow("exited unexpectedly");
    const stored = supervisor.getSource(sourceRecord.id);
    expect(stored?.status).toBe("error");
    expect(stored?.lastError).toContain("exited unexpectedly");
  });

  test("rejects Connector entries outside the package or reached through symlinks", async () => {
    const connectorDir = join(workspace, "connectors", "linked-entry");
    const externalDir = join(workspace, "external-entry");
    mkdirSync(connectorDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, "index.mjs"), "export default {};\n");

    await expect(resolveConnectorEntry(connectorDir, "../outside.mjs")).rejects.toThrow(
      "inside connector directory",
    );

    symlinkSync(
      join(externalDir, "index.mjs"),
      join(connectorDir, "index.mjs"),
      "file",
    );
    await expect(resolveConnectorEntry(connectorDir, "./index.mjs")).rejects.toThrow(
      "entry path must not contain symlinks",
    );

    rmSync(join(connectorDir, "index.mjs"));
    symlinkSync(
      externalDir,
      join(connectorDir, "lib"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(resolveConnectorEntry(connectorDir, "./lib/index.mjs")).rejects.toThrow(
      "entry path must not contain symlinks",
    );
  });

  test("includes symbolic-link identity in the Connector package hash", async () => {
    const connectorDir = join(workspace, "connectors", "linked-package-material");
    mkdirSync(connectorDir, { recursive: true });
    writeFileSync(join(connectorDir, "a.txt"), "a\n");
    writeFileSync(join(connectorDir, "b.txt"), "b\n");
    const link = join(connectorDir, "current.txt");
    symlinkSync("a.txt", link, "file");

    const first = await hashConnectorPackage(connectorDir);
    expect(await hashConnectorPackage(connectorDir)).toBe(first);

    rmSync(link);
    symlinkSync("b.txt", link, "file");
    const retargeted = await hashConnectorPackage(connectorDir);
    expect(retargeted).not.toBe(first);

    rmSync(link);
    expect(await hashConnectorPackage(connectorDir)).not.toBe(retargeted);
  });

  test("uses the connector source namespace helper", () => {
    expect(sourceForConnector("terminal")).toBe("connector:terminal");
    expect(sourceForConnector("calendar", "work")).toBe("connector:calendar:work");
    expect(() => sourceForConnector("../terminal")).toThrow("Invalid connector id");
    expect(() => sourceForConnector("calendar", "")).toThrow("Invalid connector source key");
    expect(() => sourceForConnector("calendar", "work account"))
      .toThrow("Invalid connector source key");
    expect(() => sourceForConnector("calendar", "work/account"))
      .toThrow("Invalid connector source key");
  });
});
