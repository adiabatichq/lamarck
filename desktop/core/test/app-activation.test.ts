import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { EventInput } from "../src/guard-types";
import { AppActivationCoordinator } from "../src/apps/activation";
import { collectAppPackageTree, validateAppPackageTree } from "../src/apps/package-tree";
import { AppRepositoryService } from "../src/apps/repository";
import type { AppVersionEventWriter } from "../src/apps/version-transaction";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }));
});

describe("AppActivationCoordinator", () => {
  test("prepares UI, Service, and Job through one exact-version path", async () => {
    const { appDir, cacheDir } = await fixture();
    const events = new Events();
    const repository = new AppRepositoryService({ eventWriter: events });
    const coordinator = new AppActivationCoordinator(repository, cacheDir);

    const ui = await coordinator.prepare({ appId: "example", appDir, workload: "ui" });
    const service = await coordinator.prepare({
      appId: "example",
      appDir,
      workload: "service:sync",
    });
    const job = await coordinator.prepare({ appId: "example", appDir, workload: "job:daily" });

    expect(ui).toMatchObject({ schemaVersion: 1, workload: "ui" });
    expect(service.version).toBe(ui.version);
    expect(job.version).toBe(ui.version);
    expect(service.packageDigest).toBe(ui.packageDigest);
    expect(job.manifestDigest).toBe(ui.manifestDigest);
    expect(events.values).toHaveLength(1);
    expect(coordinator.require(ui.activationId, "example", "ui")).toBe(ui);
    expect(() => coordinator.require(ui.activationId, "example", "job:daily")).toThrow(
      "does not match",
    );
    expect(await coordinator.release(ui.activationId)).toBe(true);
    expect((await lstat(ui.immutablePackagePath)).isDirectory()).toBe(true);
    expect(await coordinator.release(service.activationId)).toBe(true);
    expect(await coordinator.release(job.activationId)).toBe(true);
    await expect(lstat(ui.immutablePackagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("source changes after preparation cannot change immutable launch bytes", async () => {
    const { appDir, cacheDir } = await fixture();
    const repository = new AppRepositoryService({ eventWriter: new Events() });
    const coordinator = new AppActivationCoordinator(repository, cacheDir);
    const activation = await coordinator.prepare({ appId: "example", appDir, workload: "ui" });

    await writeFile(join(appDir, "src", "index.ts"), "export const version = 2;\n");
    expect(await readFile(join(activation.immutablePackagePath, "src", "index.ts"), "utf8"))
      .toBe("export const version = 1;\n");
    expect(validateAppPackageTree(
      await collectAppPackageTree(activation.immutablePackagePath),
      "example",
    ).digest).toBe(activation.packageDigest);
  });

  test("rejects undeclared workloads without issuing an activation record", async () => {
    const { appDir, cacheDir } = await fixture();
    const events = new Events();
    const coordinator = new AppActivationCoordinator(
      new AppRepositoryService({ eventWriter: events }),
      cacheDir,
    );
    await expect(coordinator.prepare({
      appId: "example",
      appDir,
      workload: "service:missing",
    })).rejects.toThrow("does not declare workload");
    expect(events.values).toHaveLength(0);
  });
});

class Events implements AppVersionEventWriter {
  readonly values: EventInput[] = [];

  writeLifecycleEvent(event: EventInput): string {
    if (!this.values.some((value) => value.externalId === event.externalId)) {
      this.values.push(structuredClone(event));
    }
    return event.externalId!;
  }
}

async function fixture(): Promise<{ appDir: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-activation-"));
  roots.push(root);
  const appDir = join(root, "example");
  const cacheDir = join(root, "cache");
  await mkdir(join(appDir, "src"), { recursive: true });
  await writeFile(join(appDir, "manifest.json"), `${JSON.stringify({
    manifestVersion: 1,
    id: "example",
    name: "Example",
    description: "An exact-version fixture.",
    runtime: {
      ui: { command: ["npm", "run", "start"], port: 3000 },
      services: { sync: { command: ["node", "sync.mjs"] } },
      jobs: { daily: { command: ["node", "daily.mjs"] } },
    },
    permissions: { writes: { files: ["notes/"], tables: ["notes"] } },
  })}\n`);
  await writeFile(join(appDir, "src", "index.ts"), "export const version = 1;\n");
  await chmod(appDir, 0o755);
  return { appDir, cacheDir };
}

async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeWritable(child);
    else if (entry.isFile()) await chmod(child, 0o600);
  }
}
