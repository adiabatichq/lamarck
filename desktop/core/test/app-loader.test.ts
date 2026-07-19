import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  archiveApp,
  loadApps,
  sourceForAppUi,
  sourceForAppWorkload,
  type AppManifest,
} from "../src/app-loader";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

describe("App Loader", () => {
  let workspace: string;
  let appsDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-test-"));
    appsDir = join(workspace, "apps");
    mkdirSync(appsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function validManifest(id: string): AppManifest {
    return {
      manifestVersion: 1,
      id,
      name: id,
      runtime: { ui: { command: ["npm", "run", "start"], port: 3000 } },
      permissions: { docs: [], tables: [] },
    };
  }

  function writeApp(
    directoryName: string,
    manifest: unknown = validManifest(directoryName),
    files: Record<string, string> = { "ui/index.tsx": "export default function App() { return null; }" },
  ): string {
    const appDir = join(appsDir, directoryName);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "manifest.json"), JSON.stringify(manifest));
    for (const [path, contents] of Object.entries(files)) {
      const target = join(appDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    return appDir;
  }

  async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      return { result: await run(), warnings };
    } finally {
      console.warn = originalWarn;
    }
  }

  test("loads valid v1 UI, Service, and Job workload conventions", async () => {
    const manifest = validManifest("test-app");
    manifest.name = "Test App";
    manifest.runtime.services = {
      indexer: { command: ["npm", "run", "indexer"] },
    };
    manifest.runtime.jobs = {
      "daily-etl": { command: ["npm", "run", "daily-etl", ""] },
    };
    manifest.permissions.docs = ["notes/"];
    manifest.permissions.tables = ["my_table"];
    writeApp("test-app", manifest);

    const registry = await loadApps(appsDir);
    const app = registry.apps.get("test-app");

    expect(registry.apps.size).toBe(1);
    expect(app?.manifest).toEqual(manifest);
    expect(registry.getTableGrants("test-app")).toEqual(["my_table"]);
    expect(registry.getTableGrants("unknown-app")).toEqual([]);
  });

  test("keeps bundled App templates valid under the V1 loader", async () => {
    const templateApps = fileURLToPath(new URL("../../template/apps", import.meta.url));
    const registry = await loadApps(templateApps);

    expect([...registry.apps.keys()].sort()).toEqual(["hello-world", "tools"]);
    expect(registry.apps.get("hello-world")?.manifest.runtime.ui).toEqual({
      command: ["npm", "run", "start"],
      port: 3000,
    });
  });

  test("builds stable workload sources from validated ids", () => {
    expect(sourceForAppUi("daily-review")).toBe("app:daily-review:ui");
    expect(sourceForAppWorkload("daily-review", { kind: "service", entryId: "indexer" }))
      .toBe("app:daily-review:service:indexer");
    expect(sourceForAppWorkload("daily-review", { kind: "job", entryId: "daily-etl", runId: "run-1" }))
      .toBe("app:daily-review:job:daily-etl");
    expect(() => sourceForAppUi("Daily:Review")).toThrow("Invalid app id");
    expect(() => sourceForAppWorkload("daily-review", { kind: "service", entryId: "Bad_Service" }))
      .toThrow("Invalid service entry id");
  });

  test("accepts service-only and job-only Apps", async () => {
    writeApp("service-only", {
      ...validManifest("service-only"),
      runtime: { services: { watcher: { command: ["node", "watcher.mjs"] } } },
    });
    writeApp("job-only", {
      ...validManifest("job-only"),
      runtime: { jobs: { export: { command: ["node", "export.mjs"] } } },
    });

    const registry = await loadApps(appsDir);
    expect([...registry.apps.keys()].sort()).toEqual(["job-only", "service-only"]);
  });

  test("normalizes named workload maps without an object prototype", async () => {
    writeApp("prototype-safe", {
      ...validManifest("prototype-safe"),
      runtime: {
        services: {
          constructor: { command: ["node", "service.mjs"] },
        },
      },
    });

    const registry = await loadApps(appsDir);
    const services = registry.apps.get("prototype-safe")?.manifest.runtime.services;
    expect(services).toBeDefined();
    expect(Object.getPrototypeOf(services)).toBeNull();
    expect(Object.hasOwn(services!, "constructor")).toBe(true);
    expect(services?.["constructor"].command).toEqual(["node", "service.mjs"]);
  });

  test("canWriteDoc grants the implicit home prefix and declared grants", async () => {
    const manifest = validManifest("focus");
    manifest.permissions.docs = ["notes/", "shared/pinned"];
    writeApp("focus", manifest);

    const registry = await loadApps(appsDir);
    expect(registry.canWriteDoc("focus", "apps/focus/brief", "write")).toBe(true);
    expect(registry.canWriteDoc("focus", "apps/focus/deep/nested", "delete")).toBe(true);
    expect(registry.canWriteDoc("focus", "notes/ideas", "write")).toBe(true);
    expect(registry.canWriteDoc("focus", "shared/pinned", "write")).toBe(true);
    expect(registry.canWriteDoc("focus", "notes", "write")).toBe(false);
    expect(registry.canWriteDoc("focus", "shared/pinned-2", "write")).toBe(false);
    expect(registry.canWriteDoc("focus", "apps/focus-2/brief", "write")).toBe(false);
    expect(registry.canWriteDoc("focus", "apps/other/brief", "write")).toBe(false);
    expect(registry.canWriteDoc("unknown-app", "apps/unknown-app/x", "write")).toBe(false);
  });

  test("requires manifestVersion 1 and rejects unknown fields", async () => {
    const missingVersion = validManifest("missing-version") as unknown as Record<string, unknown>;
    delete missingVersion.manifestVersion;
    writeApp("missing-version", missingVersion);
    writeApp("future-version", { ...validManifest("future-version"), manifestVersion: 2 });
    writeApp("unknown-field", { ...validManifest("unknown-field"), unexpected: true });
    writeApp("non-object", []);

    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(0);
  });

  test("strictly validates id, directory match, and name", async () => {
    writeApp("bad-id", { ...validManifest("bad-id"), id: "Bad_ID" });
    writeApp("mismatch", { ...validManifest("mismatch"), id: "other" });
    writeApp("empty-name", { ...validManifest("empty-name"), name: "" });
    writeApp("padded-name", { ...validManifest("padded-name"), name: " Padded " });

    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(0);
  });

  test("strictly validates runtime.ui command and port", async () => {
    const missingRuntime = validManifest("missing-runtime") as unknown as Record<string, unknown>;
    delete missingRuntime.runtime;
    writeApp("missing-runtime", missingRuntime);
    writeApp("missing-ui", { ...validManifest("missing-ui"), runtime: {} });
    writeApp("missing-command", { ...validManifest("missing-command"), runtime: { ui: { port: 3000 } } });
    writeApp("string-command", { ...validManifest("string-command"), runtime: { ui: { command: "npm start", port: 3000 } } });
    writeApp("empty-command", { ...validManifest("empty-command"), runtime: { ui: { command: [], port: 3000 } } });
    writeApp("empty-executable", { ...validManifest("empty-executable"), runtime: { ui: { command: [""], port: 3000 } } });
    writeApp("missing-port", { ...validManifest("missing-port"), runtime: { ui: { command: ["node", "server.mjs"] } } });
    writeApp("zero-port", { ...validManifest("zero-port"), runtime: { ui: { command: ["node"], port: 0 } } });
    writeApp("fractional-port", { ...validManifest("fractional-port"), runtime: { ui: { command: ["node"], port: 3000.5 } } });
    writeApp("extra-runtime", {
      ...validManifest("extra-runtime"),
      runtime: { ui: { command: ["node"], port: 3000 }, worker: {} },
    });
    writeApp("extra-ui", {
      ...validManifest("extra-ui"),
      runtime: { ui: { command: ["node"], port: 3000, route: "/" } },
    });

    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(0);
  });

  test("strictly validates named Services and Jobs and rejects agents", async () => {
    writeApp("empty-services", { ...validManifest("empty-services"), runtime: { services: {} } });
    writeApp("bad-service-id", {
      ...validManifest("bad-service-id"),
      runtime: { services: { "Bad_Service": { command: ["node"] } } },
    });
    writeApp("extra-job-field", {
      ...validManifest("extra-job-field"),
      runtime: { jobs: { export: { command: ["node"], timeout: 5 } } },
    });
    writeApp("agent-app", {
      ...validManifest("agent-app"),
      runtime: { agents: { assistant: { command: ["node"] } } },
    });

    const { result: registry, warnings } = await captureWarnings(() => loadApps(appsDir));
    expect(registry.apps.size).toBe(0);
    expect(warnings.some((warning) => warning.includes("runtime.services must be a non-empty object"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("entry id"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("unknown runtime.jobs.export field"))).toBe(true);
    expect(warnings.some((warning) => warning.includes('unknown runtime field "agents"'))).toBe(true);
  });

  test("requires explicit docs and tables arrays", async () => {
    const missingPermissions = validManifest("missing-permissions") as unknown as Record<string, unknown>;
    delete missingPermissions.permissions;
    writeApp("missing-permissions", missingPermissions);
    writeApp("missing-docs", {
      ...validManifest("missing-docs"),
      permissions: { tables: [] },
    });
    writeApp("missing-tables", {
      ...validManifest("missing-tables"),
      permissions: { docs: [] },
    });
    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(0);
  });

  test("rejects invalid D1 and D2 grants", async () => {
    writeApp("docs-not-array", {
      ...validManifest("docs-not-array"),
      permissions: { docs: "notes/", tables: [] },
    });
    writeApp("unsafe-doc", {
      ...validManifest("unsafe-doc"),
      permissions: { docs: ["../outside/"], tables: [] },
    });
    writeApp("tables-not-array", {
      ...validManifest("tables-not-array"),
      permissions: { docs: [], tables: "focus_sessions" },
    });
    writeApp("wildcard-table", {
      ...validManifest("wildcard-table"),
      permissions: { docs: [], tables: ["*"] },
    });
    writeApp("padded-table", {
      ...validManifest("padded-table"),
      permissions: { docs: [], tables: [" focus_sessions"] },
    });

    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(0);
  });

  test("skips missing or malformed manifests and handles a missing apps directory", async () => {
    mkdirSync(join(appsDir, "no-manifest"));
    const malformedDir = join(appsDir, "malformed");
    mkdirSync(malformedDir);
    writeFileSync(join(malformedDir, "manifest.json"), "{");

    expect((await loadApps(appsDir)).apps.size).toBe(0);
    expect((await loadApps(join(workspace, "nonexistent"))).apps.size).toBe(0);
  });

  test("archiveApp moves the app out of apps and the registry", async () => {
    const appDir = writeApp("retired");
    const archiveRoot = join(workspace, ".lamarck", "archived-apps");
    const archivedTo = await archiveApp(appsDir, archiveRoot, "retired");

    expect(archivedTo).toBe(join(archiveRoot, "retired"));
    expect(existsSync(appDir)).toBe(false);
    expect(existsSync(join(archivedTo, "manifest.json"))).toBe(true);
    expect((await loadApps(appsDir)).apps.has("retired")).toBe(false);
  });

  test("archiveApp keeps prior archives on id collision", async () => {
    const archiveRoot = join(workspace, ".lamarck", "archived-apps");

    writeApp("dup");
    const first = await archiveApp(appsDir, archiveRoot, "dup");
    writeApp("dup");
    const second = await archiveApp(appsDir, archiveRoot, "dup");

    expect(first).toBe(join(archiveRoot, "dup"));
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  test("archiveApp throws for a missing app", async () => {
    const archiveRoot = join(workspace, ".lamarck", "archived-apps");
    await expect(archiveApp(appsDir, archiveRoot, "ghost")).rejects.toThrow("not found");
  });
});
