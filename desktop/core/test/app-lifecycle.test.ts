import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { EventInput } from "../src/guard-types";
import { AppActivationCoordinator } from "../src/apps/activation";
import { AppEditMaterializationCoordinator } from "../src/apps/edit-materialization";
import { AppLifecycleService } from "../src/apps/lifecycle";
import { AppRepositoryService } from "../src/apps/repository";
import type { AppVersionEventWriter } from "../src/apps/version-transaction";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
    expect(await readFile(join(fixture.root, "cache", base.lowerPath, "manifest.json"), "utf8"))
      .toBe("{broken\n");
    expect((await lstat(join(fixture.root, "cache", base.lowerPath))).mode & 0o777).toBe(0o555);
    expect((await lstat(join(fixture.root, "cache", base.lowerPath, "manifest.json"))).mode & 0o777)
      .toBe(0o444);
    expect((await fixture.lifecycle.versions("example")).versions).toHaveLength(0);
    const lower = join(fixture.root, "cache", base.lowerPath);
    await chmod(lower, 0o700);
    await chmod(join(lower, "manifest.json"), 0o600);
  });
});

class Events implements AppVersionEventWriter {
  writeEvent(event: EventInput): string {
    return event.externalId!;
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-lifecycle-"));
  roots.push(root);
  const appsDir = join(root, "apps");
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
  const lifecycle = new AppLifecycleService(
    appsDir,
    join(root, "archived-apps"),
    repository,
    new AppActivationCoordinator(repository, join(root, "cache")),
    new AppEditMaterializationCoordinator(repository, join(root, "cache")),
  );
  return { root, appDir, lifecycle };
}
