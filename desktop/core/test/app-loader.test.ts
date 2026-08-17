import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  archiveApp,
  loadApps,
  sourceForAppUi,
  sourceForAppWorkload,
  validateAppManifest,
  type AppManifest,
} from "../src/app-loader";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { open } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

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
      description: `${id} description`,
      runtime: { ui: { command: ["npm", "run", "start"], port: 3000 } },
      permissions: { writes: { files: [], tables: [] } },
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
    manifest.permissions.writes.files = ["notes/"];
    manifest.permissions.writes.tables = ["my_table"];
    writeApp("test-app", manifest);

    const registry = await loadApps(appsDir);
    const app = registry.apps.get("test-app");

    expect(registry.apps.size).toBe(1);
    expect(app?.manifest).toEqual(manifest);
    expect(app?.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(registry.getTableGrants("test-app")).toEqual(["my_table"]);
    expect(registry.getFileGrants("test-app")).toEqual(["apps/test-app/", "notes/"]);
    expect(registry.getTableGrants("unknown-app")).toEqual([]);
  });

  test("accepts dotted package ids while named workload ids remain unscoped", async () => {
    const manifest = validManifest("lamarck.daily-review");
    manifest.runtime.services = {
      indexer: { command: ["node", "indexer.mjs"] },
    };
    writeApp("lamarck.daily-review", manifest);
    writeApp("lamarck.bad-workload", {
      ...validManifest("lamarck.bad-workload"),
      runtime: { services: { "not.scoped": { command: ["node", "service.mjs"] } } },
    });

    const registry = await loadApps(appsDir);
    expect([...registry.apps.keys()]).toEqual(["lamarck.daily-review"]);
    expect(sourceForAppUi("lamarck.daily-review")).toBe("app:lamarck.daily-review:ui");
    expect(sourceForAppWorkload("lamarck.daily-review", {
      kind: "service",
      entryId: "indexer",
    })).toBe("app:lamarck.daily-review:service:indexer");
    expect(() => sourceForAppWorkload("lamarck.daily-review", {
      kind: "service",
      entryId: "not.scoped",
    })).toThrow("Invalid service entry id");
  });

  test.each([
    ".lamarck-tools",
    "lamarck-tools.",
    "lamarck..tools",
    "lamarck.Tools",
    "lamarck_tools",
    "lamarck/tools",
  ])("rejects malformed dotted package id %s", async (id) => {
    writeApp("candidate", { ...validManifest("candidate"), id });
    expect((await loadApps(appsDir)).apps.size).toBe(0);
  });

  test("accepts strict optional Marketplace template provenance", async () => {
    const manifest = {
      ...validManifest("my-tools"),
      createdFrom: {
        packageId: "lamarck.tools",
        releaseId: "rel_01HXYZ",
      },
    } satisfies AppManifest;
    writeApp("my-tools", manifest);

    const app = (await loadApps(appsDir)).apps.get("my-tools");
    expect(app?.manifest.createdFrom).toEqual(manifest.createdFrom);
    expect(app?.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test.each([
    { packageId: "tools", releaseId: "rel_1" },
    { packageId: ".tools", releaseId: "rel_1" },
    { packageId: "lamarck..tools", releaseId: "rel_1" },
    { packageId: "lamarck.tools", releaseId: "" },
    { packageId: "lamarck.tools", releaseId: " padded " },
    { packageId: "lamarck.tools", releaseId: "rel_1", unexpected: true },
  ])("rejects malformed createdFrom provenance %#", async (createdFrom) => {
    writeApp("candidate", { ...validManifest("candidate"), createdFrom });
    expect((await loadApps(appsDir)).apps.size).toBe(0);
  });

  test("derives one deterministic digest from the normalized authority manifest", async () => {
    const manifest = validManifest("authority");
    manifest.permissions.writes.tables = ["reviews"];
    writeApp("authority", manifest);
    const first = (await loadApps(appsDir)).apps.get("authority")!;

    writeFileSync(join(appsDir, "authority", "manifest.json"), JSON.stringify({
      permissions: { writes: { tables: ["reviews"], files: [] } },
      runtime: { ui: { port: 3000, command: ["npm", "run", "start"] } },
      description: "authority description",
      name: "authority",
      id: "authority",
      manifestVersion: 1,
    }));
    const reordered = (await loadApps(appsDir)).apps.get("authority")!;
    expect(reordered.manifestDigest).toBe(first.manifestDigest);

    writeFileSync(join(appsDir, "authority", "manifest.json"), JSON.stringify({
      ...manifest,
      permissions: { writes: { files: [], tables: [] } },
    }));
    expect((await loadApps(appsDir)).apps.get("authority")?.manifestDigest)
      .not.toBe(first.manifestDigest);
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

  test("file grants include the implicit home prefix and declared grants", async () => {
    const manifest = validManifest("focus");
    manifest.permissions.writes.files = ["notes/", "shared/pinned.md"];
    writeApp("focus", manifest);

    const registry = await loadApps(appsDir);
    expect(registry.getFileGrants("focus")).toEqual([
      "apps/focus/",
      "notes/",
      "shared/pinned.md",
    ]);
    expect(registry.getFileGrants("unknown-app")).toEqual([]);
  });

  test("provisions validated App D1 homes on load without granting the parent", async () => {
    const manifest = validManifest("focus");
    manifest.permissions.writes.files = ["notes/"];
    writeApp("focus", manifest);

    const firstRegistry = await loadApps(appsDir);
    const home = join(workspace, "files", "apps", "focus");
    expect(statSync(home).isDirectory()).toBe(true);
    expect(firstRegistry.getFileGrants("focus")).toEqual(["apps/focus/", "notes/"]);
    expect(firstRegistry.getFileGrants("focus")).not.toContain("apps/");

    rmSync(home, { recursive: true });
    const refreshedRegistry = await loadApps(appsDir);
    expect(refreshedRegistry.apps.has("focus")).toBe(true);
    expect(statSync(home).isDirectory()).toBe(true);

    await archiveApp(appsDir, join(workspace, "app-archive"), "focus");
    expect((await loadApps(appsDir)).apps.has("focus")).toBe(false);
    expect(statSync(home).isDirectory()).toBe(true);
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

  test("strictly validates id, directory match, name, and description", async () => {
    writeApp("bad-id", { ...validManifest("bad-id"), id: "Bad_ID" });
    writeApp("mismatch", { ...validManifest("mismatch"), id: "other" });
    writeApp("empty-name", { ...validManifest("empty-name"), name: "" });
    writeApp("padded-name", { ...validManifest("padded-name"), name: " Padded " });
    const missingDescription = validManifest("missing-description") as unknown as Record<string, unknown>;
    delete missingDescription.description;
    writeApp("missing-description", missingDescription);
    writeApp("empty-description", {
      ...validManifest("empty-description"),
      description: "",
    });
    writeApp("padded-description", {
      ...validManifest("padded-description"),
      description: " Padded ",
    });

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

  test("requires an explicit writes object with files and tables arrays", async () => {
    const missingPermissions = validManifest("missing-permissions") as unknown as Record<string, unknown>;
    delete missingPermissions.permissions;
    writeApp("missing-permissions", missingPermissions);
    writeApp("missing-writes", {
      ...validManifest("missing-writes"),
      permissions: {},
    });
    writeApp("missing-files", {
      ...validManifest("missing-files"),
      permissions: { writes: { tables: [] } },
    });
    writeApp("missing-tables", {
      ...validManifest("missing-tables"),
      permissions: { writes: { files: [] } },
    });
    const registry = await loadApps(appsDir);
    expect(registry.apps.size).toBe(0);
  });

  test("rejects invalid D1 and D2 grants", async () => {
    writeApp("files-not-array", {
      ...validManifest("files-not-array"),
      permissions: { writes: { files: "notes/", tables: [] } },
    });
    writeApp("unsafe-file", {
      ...validManifest("unsafe-file"),
      permissions: { writes: { files: ["../outside/"], tables: [] } },
    });
    writeApp("tables-not-array", {
      ...validManifest("tables-not-array"),
      permissions: { writes: { files: [], tables: "focus_sessions" } },
    });
    writeApp("wildcard-table", {
      ...validManifest("wildcard-table"),
      permissions: { writes: { files: [], tables: ["*"] } },
    });
    writeApp("padded-table", {
      ...validManifest("padded-table"),
      permissions: { writes: { files: [], tables: [" focus_sessions"] } },
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

  test("propagates apps directory read errors other than ENOENT", async () => {
    const notADirectory = join(workspace, "not-a-directory");
    writeFileSync(notADirectory, "not a directory");

    await expect(loadApps(notADirectory)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  test("propagates per-manifest I/O and authority errors instead of publishing a partial registry", async () => {
    const manifestPath = join(writeApp("keep-authority"), "manifest.json");
    const probe = await open(manifestPath, "r");
    type FileHandlePrototype = {
      readFile(this: FileHandlePrototype): Promise<Buffer>;
    };
    const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
    const originalReadFile = prototype.readFile;
    await probe.close();

    for (const code of ["EIO", "EACCES"] as const) {
      prototype.readFile = async function () {
        throw Object.assign(new Error(`injected ${code}`), { code });
      };
      try {
        await expect(loadApps(appsDir)).rejects.toMatchObject({ code });
      } finally {
        prototype.readFile = originalReadFile;
      }
    }
  });

  test("publishes only a settled manifest snapshot during an in-place write", async () => {
    const appDir = join(appsDir, "settling");
    const manifestPath = join(appDir, "manifest.json");
    mkdirSync(appDir);
    writeFileSync(manifestPath, "{");

    const loading = loadApps(appsDir);
    const replacement = setTimeout(() => {
      writeFileSync(manifestPath, JSON.stringify(validManifest("settling")));
    }, 5);
    const registry = await loading.finally(() => clearTimeout(replacement));

    expect(registry.apps.get("settling")?.manifest).toEqual(validManifest("settling"));
  });

  test("retries when manifest.json is atomically replaced after reading the old inode", async () => {
    const appDir = join(appsDir, "atomic-replace");
    const manifestPath = join(appDir, "manifest.json");
    const replacementPath = join(appDir, ".manifest.next");
    const oldManifest = { ...validManifest("atomic-replace"), name: "Old snapshot" };
    const newManifest = { ...validManifest("atomic-replace"), name: "New snapshot" };
    mkdirSync(appDir);
    writeFileSync(manifestPath, JSON.stringify(oldManifest));
    writeFileSync(replacementPath, JSON.stringify(newManifest));

    const probe = await open(manifestPath, "r");
    type FileHandlePrototype = {
      readFile(this: FileHandlePrototype): Promise<Buffer>;
    };
    const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
    const originalReadFile = prototype.readFile;
    await probe.close();

    let replaced = false;
    prototype.readFile = async function () {
      const bytes = await originalReadFile.call(this);
      if (!replaced) {
        replaced = true;
        renameSync(replacementPath, manifestPath);
      }
      return bytes;
    };

    try {
      const registry = await loadApps(appsDir);
      expect(replaced).toBe(true);
      expect(registry.apps.get("atomic-replace")?.manifest).toEqual(newManifest);
    } finally {
      prototype.readFile = originalReadFile;
    }
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
