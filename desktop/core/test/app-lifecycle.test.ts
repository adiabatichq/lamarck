import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { EventInput } from "../src/guard-types";
import { archiveApp } from "../src/app-loader";
import { AppActivationCoordinator } from "../src/apps/activation";
import { AppEditMaterializationCoordinator } from "../src/apps/edit-materialization";
import { AppLifecycleService } from "../src/apps/lifecycle";
import { AppRepositoryService } from "../src/apps/repository";
import type { AppVersionEventWriter } from "../src/apps/version-transaction";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("AppLifecycleService inventory", () => {
  test("lists unversioned physical Apps with editable Host paths and actual grants", async () => {
    const fixture = await setup();
    const [app] = await fixture.lifecycle.inventory();

    expect(app).toMatchObject({
      schemaVersion: 1,
      id: "example",
      name: "Example",
      path: fixture.appDir,
      version: null,
      packageDirty: true,
      manifestHealth: { status: "valid" },
      versionHealth: { status: "unversioned" },
      permissions: { writes: { files: ["notes/"], tables: ["notes"] } },
    });
  });

  test("keeps an invalid draft visible and uses the latest recorded valid details", async () => {
    const fixture = await setup();
    const saved = await fixture.lifecycle.save("example");
    await writeFile(join(fixture.appDir, "manifest.json"), "{broken\n");

    const [app] = await fixture.lifecycle.inventory();
    expect(app).toMatchObject({
      id: "example",
      name: "Example",
      version: saved.version,
      packageDirty: true,
      manifestHealth: { status: "invalid" },
      versionHealth: { status: "healthy" },
      permissions: { writes: { files: ["notes/"], tables: ["notes"] } },
    });
  });

  test("uses neutral placeholders when no valid manifest details are available", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.appDir, "manifest.json"), "{broken\n");

    const [app] = await fixture.lifecycle.inventory();
    expect(app).toMatchObject({
      id: "example",
      name: "Unavailable",
      description: "N/A",
      manifestHealth: { status: "invalid" },
    });
    expect(app.manifestHealth).toHaveProperty("message");
  });

  test("reports corrupt history without hiding the current package", async () => {
    const fixture = await setup();
    await fixture.lifecycle.save("example");
    await writeFile(
      join(fixture.appDir, ".git", "refs", "lamarck", "current", "example"),
      "not-a-commit\n",
    );

    const [app] = await fixture.lifecycle.inventory();
    expect(app).toMatchObject({
      id: "example",
      version: null,
      packageDirty: true,
      manifestHealth: { status: "valid" },
      versionHealth: {
        status: "unavailable",
        message: "App version history is unavailable",
      },
    });
  });

  test("clears history-unavailable state only through explicit rebuild", async () => {
    const fixture = await setup();
    const saved = await fixture.lifecycle.save("example");
    await writeFile(
      join(fixture.appDir, ".git", "refs", "lamarck", "current", "example"),
      "not-a-commit\n",
    );
    expect((await fixture.lifecycle.inventory())[0].versionHealth.status).toBe("unavailable");

    await expect(fixture.lifecycle.rebuildVersionHistory("example")).resolves.toEqual({
      schemaVersion: 1,
      outcome: "reconstructed",
      currentVersion: saved.version,
    });
    expect((await fixture.lifecycle.inventory())[0]).toMatchObject({
      version: saved.version,
      versionHealth: { status: "healthy" },
    });
  });

  test("materializes an invalid draft privately without creating a version or event", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.appDir, "manifest.json"), "{broken\n");
    const base = await fixture.lifecycle.prepareEditBase("example");

    expect(base).toMatchObject({
      schemaVersion: 1,
      appId: "example",
      version: null,
    });
    expect(base.lowerPath).toMatch(/^example\/draft-[0-9a-f]{64}$/);
    expect(await readFile(join(fixture.editCache, base.lowerPath, "manifest.json"), "utf8"))
      .toBe("{broken\n");
    expect((await lstat(join(fixture.editCache, base.lowerPath))).mode & 0o777).toBe(0o555);
    expect((await lstat(join(fixture.editCache, base.lowerPath, "manifest.json"))).mode & 0o777)
      .toBe(0o444);
    expect((await fixture.lifecycle.versions("example")).versions).toHaveLength(0);
    const lower = join(fixture.editCache, base.lowerPath);
    await chmod(lower, 0o700);
    await chmod(join(lower, "manifest.json"), 0o600);
  });

  test("prepares immutable edit bases for every current App without requiring inventory", async () => {
    const fixture = await setup();
    const secondDir = join(fixture.root, "apps", "second.app");
    await mkdir(secondDir, { recursive: true });
    await writeFile(join(secondDir, "manifest.json"), `${JSON.stringify({
      manifestVersion: 1,
      id: "second.app",
      name: "Second",
      description: "Second fixture.",
      runtime: { ui: { command: ["node", "server.mjs"], port: 3001 } },
      permissions: {},
    })}\n`);

    const bases = await fixture.lifecycle.prepareEditBases();
    expect(bases.map(({ appId }) => appId)).toEqual(["example", "second.app"]);
    for (const base of bases) {
      const lower = join(fixture.editCache, base.lowerPath);
      expect(await readFile(join(lower, "manifest.json"), "utf8")).toContain(`\"id\":\"${base.appId}\"`);
      expect((await lstat(lower)).mode & 0o777).toBe(0o555);
      await chmod(lower, 0o700);
      await chmod(join(lower, "manifest.json"), 0o600);
    }

    await archiveApp(fixture.appsDir, fixture.archiveRoot, "second.app");
    expect((await fixture.lifecycle.prepareEditBases()).map(({ appId }) => appId)).toEqual(["example"]);
    await expect(lstat(join(fixture.editCache, "second.app")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retains one current edit lower without pruning a running activation package", async () => {
    const fixture = await setup();
    const lowers: string[] = [];
    lowers.push((await fixture.lifecycle.prepareEditBase("example")).lowerPath);
    const activation = await fixture.lifecycle.prepareActivation("example", "ui");
    lowers.push((await fixture.lifecycle.prepareEditBase("example")).lowerPath);

    for (let revision = 1; revision <= 4; revision += 1) {
      await writeFile(join(fixture.appDir, "index.ts"), `export const revision = ${revision};\n`);
      lowers.push((await fixture.lifecycle.prepareEditBase("example")).lowerPath);
      if (revision % 2 === 0) {
        await fixture.lifecycle.save("example");
        lowers.push((await fixture.lifecycle.prepareEditBase("example")).lowerPath);
      }
      const current = lowers.at(-1)!.split("/")[1]!;
      expect(await readdir(join(fixture.editCache, "example"))).toEqual([current]);
      expect((await lstat(activation.immutablePackagePath)).isDirectory()).toBe(true);
    }

    expect(new Set(lowers).size).toBeGreaterThan(4);
    expect(activation.immutablePackagePath.startsWith(`${fixture.activationCache}/`)).toBe(true);
    expect(lowers.at(-1)!.startsWith("example/")).toBe(true);
    await makeWritable(join(fixture.editCache, lowers.at(-1)!));
  });
});

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(path);
    else await chmod(path, 0o600);
  }
}

class Events implements AppVersionEventWriter {
  writeLifecycleEvent(event: EventInput): string {
    return event.externalId!;
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-lifecycle-"));
  roots.push(root);
  const appsDir = join(root, "apps");
  const archiveRoot = join(root, "archived-apps");
  const appDir = join(appsDir, "example");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "manifest.json"), `${JSON.stringify({
    manifestVersion: 1,
    id: "example",
    name: "Example",
    description: "Inventory fixture.",
    runtime: { ui: { command: ["node", "server.mjs"], port: 3000 } },
    permissions: { writes: { files: ["notes/"], tables: ["notes"] } },
  })}\n`);
  const repository = new AppRepositoryService({ eventWriter: new Events() });
  const activationCache = join(root, "cache", "app-versions");
  const editCache = join(root, "cache", "app-edit-bases");
  const lifecycle = new AppLifecycleService(
    appsDir,
    archiveRoot,
    repository,
    new AppActivationCoordinator(repository, activationCache),
    new AppEditMaterializationCoordinator(repository, editCache),
  );
  return { root, appsDir, appDir, archiveRoot, lifecycle, activationCache, editCache };
}
