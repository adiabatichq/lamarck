import fs from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import type { EventInput } from "../src/guard-types";
import { archiveApp } from "../src/app-loader";
import { AppRepositoryService } from "../src/apps/repository";
import { collectAppPackageTree, hashAppPackageTree } from "../src/apps/package-tree";
import { canonicalizeAppVersionRecordV1 } from "../src/apps/version-record";
import type {
  AppVersionEventWriter,
  AppVersionTransactionBoundary,
} from "../src/apps/version-transaction";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AppRepositoryService", () => {
  test("first save initializes one root version and unchanged save/activation are no-ops", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events, now: () => 1_700_000_000_000 });

    const saved = await service.save({ appId: "example", appDir });
    const savedAgain = await service.save({ appId: "example", appDir });
    const activated = await service.activate({ appId: "example", appDir });

    expect(saved.created).toBe(true);
    expect(saved.version).toMatch(/^[0-9a-f]{40}$/);
    expect(saved.record).toMatchObject({
      schemaVersion: 1,
      parentVersion: null,
      trigger: "save",
      message: "Save app",
    });
    expect(savedAgain).toMatchObject({ created: false, version: saved.version });
    expect(activated).toMatchObject({ created: false, version: saved.version });
    expect(events.values()).toHaveLength(1);
    expect(events.values()[0]).toMatchObject({
      type: "app.version.created",
      externalId: `example:${saved.version}`,
      payload: { appId: "example", version: saved.version, parentVersion: null, trigger: "save" },
    });
  });

  test("versions ignored, untracked, and dist changes and keeps excluded roots out of identity", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events });
    const first = await service.save({ appId: "example", appDir });
    await writeFile(join(appDir, ".gitignore"), "dist/\nignored.txt\n");
    await writeFile(join(appDir, "ignored.txt"), "ignored by Git, included by product\n");
    await mkdir(join(appDir, "dist"));
    await writeFile(join(appDir, "dist", "bundle.js"), "runtime bytes\n");
    const second = await service.save({ appId: "example", appDir });
    await writeFile(join(appDir, ".git", "private"), "not package identity\n");
    await mkdir(join(appDir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(appDir, "node_modules", "dep", "index.js"), "not package identity\n");
    const unchanged = await service.activate({ appId: "example", appDir });

    expect(second.created).toBe(true);
    expect(second.record.parentVersion).toBe(first.version);
    expect(unchanged).toMatchObject({ created: false, version: second.version });
    expect(events.values()).toHaveLength(2);
  });

  test("restore creates a new forward version and never rewinds or activates", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    let now = 1_700_000_000_000;
    const service = new AppRepositoryService({ eventWriter: events, now: () => now++ });
    const first = await service.save({ appId: "example", appDir, message: "First", author: "Ada" });
    await writeFile(join(appDir, "src", "index.ts"), "export const version = 2;\n");
    const second = await service.save({ appId: "example", appDir, message: "Second" });

    const restored = await service.restore({
      appId: "example",
      appDir,
      version: first.version.slice(0, 8),
      author: "Grace",
    });
    expect(restored.created).toBe(true);
    expect(restored.version).not.toBe(first.version);
    expect(restored.record).toMatchObject({
      parentVersion: second.version,
      trigger: "restore",
      restoredFrom: first.version,
      author: "Grace",
    });
    expect(await readFile(join(appDir, "src", "index.ts"), "utf8")).toBe("export const version = 1;\n");
    expect((await service.listVersions({ appId: "example", appDir })).versions.map((value) => value.version))
      .toEqual([restored.version, second.version, first.version]);
    expect(events.values()).toHaveLength(3);

    const sameTree = await service.restore({ appId: "example", appDir, version: first.version });
    expect(sameTree).toMatchObject({ created: false, version: restored.version });
    expect(events.values()).toHaveLength(3);
  });

  test("Capsule writeback conflicts on either base version or canonical digest", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events });
    const first = await service.save({ appId: "example", appDir });
    const base = await collectAppPackageTree(appDir);
    const edited = base.map((entry) => entry.path === "src/index.ts"
      ? { path: entry.path, kind: "file" as const, bytes: Buffer.from("export const capsule = true;\n") }
      : entry);
    await writeFile(join(appDir, "host-edit.txt"), "concurrent\n");
    await expect(service.savePackage({
      appId: "example",
      appDir,
      entries: edited,
      baseVersion: first.version,
      basePackageDigest: hashAppPackageTree(base),
    })).rejects.toMatchObject({ code: "APP_VERSION_CONFLICT" });
    expect(await readFile(join(appDir, "host-edit.txt"), "utf8")).toBe("concurrent\n");
    expect(events.values()).toHaveLength(1);

    const hostVersion = await service.save({ appId: "example", appDir });
    const current = await collectAppPackageTree(appDir);
    await expect(service.savePackage({
      appId: "example",
      appDir,
      entries: edited,
      baseVersion: first.version,
      basePackageDigest: hashAppPackageTree(current),
    })).rejects.toMatchObject({ code: "APP_VERSION_CONFLICT" });
    expect(hostVersion.version).not.toBe(first.version);
    expect(events.values()).toHaveLength(2);
  });

  test("Capsule writeback recovery makes a same-candidate stale retry idempotent", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const initial = new AppRepositoryService({ eventWriter: events });
    const first = await initial.save({ appId: "example", appDir });
    const base = await collectAppPackageTree(appDir);
    const edited = base.map((entry) => entry.path === "src/index.ts"
      ? { path: entry.path, kind: "file" as const, bytes: Buffer.from("export const recovered = true;\n") }
      : entry).concat([
        { path: "src/.git/reference.txt", kind: "file" as const, bytes: Buffer.from("nested git content\n") },
        { path: "src/.lamarck/reference.txt", kind: "file" as const, bytes: Buffer.from("nested state content\n") },
        { path: "vendor/node_modules/reference.js", kind: "file" as const, bytes: Buffer.from("nested module content\n") },
      ]);
    let crash = true;
    const crashing = new AppRepositoryService({
      eventWriter: events,
      transactionHooks: {
        afterBoundary(boundary) {
          if (crash && boundary === "after-current-ref") {
            crash = false;
            throw new Error("crash:writeback");
          }
        },
      },
    });
    await expect(crashing.savePackage({
      appId: "example",
      appDir,
      entries: edited,
      baseVersion: first.version,
      basePackageDigest: hashAppPackageTree(base),
    })).rejects.toThrow("crash:writeback");
    expect(await readFile(join(appDir, "src", "index.ts"), "utf8")).toBe("export const version = 1;\n");

    const recovered = new AppRepositoryService({ eventWriter: events });
    const finalizedVersion = await recovered.currentVersion("example", appDir);
    expect(await readFile(join(appDir, "src", "index.ts"), "utf8"))
      .toBe("export const recovered = true;\n");
    expect(await readFile(join(appDir, "src", ".git", "reference.txt"), "utf8"))
      .toBe("nested git content\n");
    expect(await readFile(join(appDir, "src", ".lamarck", "reference.txt"), "utf8"))
      .toBe("nested state content\n");
    expect(await readFile(join(appDir, "vendor", "node_modules", "reference.js"), "utf8"))
      .toBe("nested module content\n");

    const retry = await recovered.savePackage({
      appId: "example",
      appDir,
      entries: edited,
      baseVersion: first.version,
      basePackageDigest: hashAppPackageTree(base),
    });
    expect(retry).toMatchObject({ created: false, version: finalizedVersion });
    expect(events.values()).toHaveLength(2);
    expect((await recovered.listVersions({ appId: "example", appDir })).versions).toHaveLength(2);

    const differentStaleCandidate = edited.map((entry) => entry.path === "src/index.ts"
      ? { ...entry, bytes: Buffer.from("export const genuinelyDifferent = true;\n") }
      : entry);
    await expect(recovered.savePackage({
      appId: "example",
      appDir,
      entries: differentStaleCandidate,
      baseVersion: first.version,
      basePackageDigest: hashAppPackageTree(base),
    })).rejects.toMatchObject({ code: "APP_VERSION_CONFLICT" });
    expect(events.values()).toHaveLength(2);
    expect((await recovered.listVersions({ appId: "example", appDir })).versions).toHaveLength(2);
  });

  test("rejects invalid manifests before a version or D0 event for save, activation, and restore", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events });
    await writeFile(join(appDir, "manifest.json"), "{broken\n");
    await expect(service.save({ appId: "example", appDir })).rejects.toMatchObject({
      code: "APP_PACKAGE_INVALID",
    });
    await expect(service.activate({ appId: "example", appDir })).rejects.toMatchObject({
      code: "APP_PACKAGE_INVALID",
    });
    expect(events.values()).toHaveLength(0);

    await writeFile(join(appDir, "manifest.json"), `${JSON.stringify(manifest())}\n`);
    const first = await service.save({ appId: "example", appDir });
    const invalid = await appendRecordedVersion(appDir, first.version, "{broken\n", 2);
    await appendRecordedVersion(
      appDir,
      invalid,
      `${JSON.stringify(manifest())}\n`,
      3,
    );
    await expect(service.restore({ appId: "example", appDir, version: invalid }))
      .rejects.toMatchObject({ code: "APP_PACKAGE_INVALID" });
    expect(events.values()).toHaveLength(1);
  });

  test("adopts a raw descendant once, preserves divergence, and lists only product versions", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events });
    const root = await service.save({ appId: "example", appDir });

    await writeFile(join(appDir, "src", "index.ts"), "export const raw = 1;\n");
    await git.add({ fs, dir: appDir, filepath: "src/index.ts" });
    const rawDescendant = await git.commit({
      fs,
      dir: appDir,
      message: "Raw descendant",
      author: { name: "Raw", email: "raw@example.invalid" },
    });
    const adopted = await service.save({ appId: "example", appDir });
    expect(adopted.version).toBe(rawDescendant);
    expect((await service.listVersions({ appId: "example", appDir })).versions).toHaveLength(2);

    await writeFile(join(appDir, "src", "index.ts"), "export const divergent = 1;\n");
    await git.add({ fs, dir: appDir, filepath: "src/index.ts" });
    const divergentTree = (await git.writeTree({
      fs,
      dir: appDir,
      tree: [{
        mode: "100755",
        path: "manifest.json",
        oid: await git.writeBlob({ fs, dir: appDir, blob: Buffer.from(`${JSON.stringify(manifest())}\n`) }),
        type: "blob",
      }, {
        mode: "040000",
        path: "src",
        oid: await git.writeTree({
          fs,
          dir: appDir,
          tree: [{
            mode: "100755",
            path: "index.ts",
            oid: await git.writeBlob({ fs, dir: appDir, blob: Buffer.from("export const divergent = 1;\n") }),
            type: "blob",
          }],
        }),
        type: "tree",
      }],
    }));
    const rawDivergent = await git.writeCommit({
      fs,
      dir: appDir,
      commit: {
        tree: divergentTree,
        parent: [],
        message: "Divergent raw root",
        author: gitPerson(),
        committer: gitPerson(),
      },
    });
    await git.writeRef({ fs, dir: appDir, ref: "refs/heads/main", value: rawDivergent, force: true });
    const forward = await service.save({ appId: "example", appDir });
    expect(forward.version).not.toBe(rawDivergent);
    expect(forward.record.parentVersion).toBe(adopted.version);
    expect(await git.resolveRef({
      fs,
      dir: appDir,
      ref: `refs/lamarck/external/${rawDivergent}`,
    })).toBe(rawDivergent);
    const listed = (await service.listVersions({ appId: "example", appDir })).versions;
    expect(listed.map((value) => value.version)).toEqual([forward.version, adopted.version, root.version]);
    expect(listed.some((value) => value.version === rawDivergent)).toBe(false);
  });

  test.each<AppVersionTransactionBoundary>([
    "after-commit-object",
    "after-pending-ref",
    "after-d0",
    "after-final-ref",
    "after-current-ref",
    "after-head",
    "after-publication",
    "after-pending-delete",
  ])("recovers crash injection at %s with exactly one event and final ref", async (boundary) => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    let injected = false;
    const crashing = new AppRepositoryService({
      eventWriter: events,
      now: () => 1_700_000_000_000,
      transactionHooks: {
        afterBoundary(actual) {
          if (!injected && actual === boundary) {
            injected = true;
            throw new Error(`crash:${boundary}`);
          }
        },
      },
    });
    await expect(crashing.save({ appId: "example", appDir })).rejects.toThrow(`crash:${boundary}`);

    const recovered = new AppRepositoryService({
      eventWriter: events,
      now: () => 1_700_000_000_000,
    });
    const retry = await recovered.save({ appId: "example", appDir });
    const versions = (await recovered.listVersions({ appId: "example", appDir })).versions;
    expect(retry.version).toBe(versions[0].version);
    expect(versions).toHaveLength(1);
    expect(events.values()).toHaveLength(1);
    await recovered.verifyRetainedVersions("example", appDir);
  });

  test("leaves a failed D0 append pending and converges on retry", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    events.failNext = true;
    const service = new AppRepositoryService({ eventWriter: events, now: () => 1_700_000_000_000 });
    await expect(service.save({ appId: "example", appDir })).rejects.toThrow("D0 unavailable");
    expect(events.values()).toHaveLength(0);

    const retry = await service.save({ appId: "example", appDir });
    expect(retry.version).toMatch(/^[0-9a-f]{40}$/);
    expect(events.values()).toHaveLength(1);
    expect((await service.listVersions({ appId: "example", appDir })).versions).toHaveLength(1);
  });

  test("paginates newest-first and retains every finalized commit through explicit refs", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events });
    const versions: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(appDir, "src", "index.ts"), `export const version = ${index};\n`);
      versions.unshift((await service.save({ appId: "example", appDir })).version);
    }
    const firstPage = await service.listVersions({ appId: "example", appDir, limit: 2 });
    const secondPage = await service.listVersions({
      appId: "example",
      appDir,
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect([...firstPage.versions, ...secondPage.versions].map((record) => record.version))
      .toEqual(versions);
    for (const version of versions) {
      expect(await git.resolveRef({ fs, dir: appDir, ref: `refs/lamarck/versions/${version}` }))
        .toMatch(/^[0-9a-f]{40}$/);
      expect((await git.readCommit({ fs, dir: appDir, oid: version })).oid).toBe(version);
    }
  });

  test("keeps every finalized commit and version ref reachable after archive", async () => {
    const appDir = await fixture();
    const service = new AppRepositoryService({ eventWriter: new IdempotentEvents() });
    const first = await service.save({ appId: "example", appDir });
    await writeFile(join(appDir, "src", "index.ts"), "export const version = 2;\n");
    const second = await service.save({ appId: "example", appDir });
    await service.verifyRetainedVersions("example", appDir);

    const archived = await archiveApp(
      join(appDir, ".."),
      join(appDir, "..", "archives"),
      "example",
    );
    await service.verifyRetainedVersions("example", archived);
    for (const version of [first.version, second.version]) {
      expect(await git.resolveRef({
        fs,
        dir: archived,
        ref: `refs/lamarck/versions/${version}`,
      })).toMatch(/^[0-9a-f]{40}$/);
      expect((await git.readCommit({ fs, dir: archived, oid: version })).oid).toBe(version);
    }
  });

  test("explicit rebuild reconstructs the unique readable forward chain without D0", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events });
    const first = await service.save({ appId: "example", appDir });
    await writeFile(join(appDir, "src", "index.ts"), "export const version = 2;\n");
    const second = await service.save({ appId: "example", appDir });
    await writeFile(
      join(appDir, ".git", "refs", "lamarck", "current", "example"),
      "not-a-commit\n",
    );

    const rebuilt = await service.rebuildVersionHistory({
      appId: "example",
      appDir,
      archiveRoot: join(appDir, "..", "archives"),
    });

    expect(rebuilt).toEqual({
      schemaVersion: 1,
      outcome: "reconstructed",
      currentVersion: second.version,
    });
    expect((await service.listVersions({ appId: "example", appDir })).versions
      .map((record) => record.version)).toEqual([second.version, first.version]);
    expect(events.values()).toHaveLength(2);
  });

  test("bounded rebuild recovers matching retained objects from an existing App archive", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events });
    const saved = await service.save({ appId: "example", appDir });
    const archiveRoot = join(appDir, "..", "archives");
    await mkdir(archiveRoot);
    await cp(appDir, join(archiveRoot, "example"), { recursive: true });
    await rm(
      join(appDir, ".git", "objects", saved.version.slice(0, 2), saved.version.slice(2)),
      { force: true },
    );

    const rebuilt = await service.rebuildVersionHistory({
      appId: "example",
      appDir,
      archiveRoot,
    });

    expect(rebuilt).toEqual({
      schemaVersion: 1,
      outcome: "reconstructed",
      currentVersion: saved.version,
    });
    expect(events.values()).toHaveLength(1);
    expect(await readFile(join(appDir, "src", "index.ts"), "utf8"))
      .toBe("export const version = 1;\n");
  });

  test("confirmed rebuild resets unrecoverable Git while preserving the package", async () => {
    const appDir = await fixture();
    const events = new IdempotentEvents();
    const service = new AppRepositoryService({ eventWriter: events });
    await service.save({ appId: "example", appDir });
    await rm(join(appDir, ".git", "objects"), { recursive: true, force: true });

    const rebuilt = await service.rebuildVersionHistory({
      appId: "example",
      appDir,
      archiveRoot: join(appDir, "..", "archives"),
    });

    expect(rebuilt).toEqual({ schemaVersion: 1, outcome: "reset", currentVersion: null });
    expect(await readFile(join(appDir, "src", "index.ts"), "utf8"))
      .toBe("export const version = 1;\n");
    expect(events.values()).toHaveLength(1);
    const next = await service.save({ appId: "example", appDir });
    expect(next.record.parentVersion).toBeNull();
    expect(events.values()).toHaveLength(2);
  });
});

class IdempotentEvents implements AppVersionEventWriter {
  readonly events = new Map<string, EventInput>();
  failNext = false;

  writeEvent(event: EventInput): string {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("D0 unavailable");
    }
    const key = event.externalId!;
    if (!this.events.has(key)) this.events.set(key, structuredClone(event));
    return key;
  }

  values(): EventInput[] {
    return [...this.events.values()];
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lamarck-app-repository-"));
  roots.push(root);
  const appDir = join(root, "example");
  await mkdir(join(appDir, "src"), { recursive: true });
  await writeFile(join(appDir, "manifest.json"), `${JSON.stringify(manifest())}\n`);
  await writeFile(join(appDir, "src", "index.ts"), "export const version = 1;\n");
  return appDir;
}

function manifest() {
  return {
    manifestVersion: 1,
    id: "example",
    name: "Example",
    description: "An example App.",
    runtime: { ui: { command: ["npm", "run", "start"], port: 3000 } },
    permissions: { writes: { files: [], tables: [] } },
  };
}

function gitPerson() {
  return {
    name: "Raw",
    email: "raw@example.invalid",
    timestamp: 1_700_000_000,
    timezoneOffset: 0,
  };
}

async function appendRecordedVersion(
  appDir: string,
  parentVersion: string,
  manifestBytes: string,
  sequence: number,
): Promise<string> {
  const { commit } = await git.readCommit({ fs, dir: appDir, oid: parentVersion });
  const { tree } = await git.readTree({ fs, dir: appDir, oid: commit.tree });
  const manifestEntry = tree.find((entry) => entry.path === "manifest.json")!;
  const manifestBlob = await git.writeBlob({ fs, dir: appDir, blob: Buffer.from(manifestBytes) });
  const nextTree = await git.writeTree({
    fs,
    dir: appDir,
    tree: tree.map((entry) => entry === manifestEntry ? { ...entry, oid: manifestBlob } : entry),
  });
  const version = await git.writeCommit({
    fs,
    dir: appDir,
    commit: {
      ...commit,
      tree: nextTree,
      parent: [parentVersion],
      message: `Forged historical fixture ${sequence}`,
      author: { ...gitPerson(), timestamp: gitPerson().timestamp + sequence },
      committer: { ...gitPerson(), timestamp: gitPerson().timestamp + sequence },
    },
  });
  const record = {
    schemaVersion: 1 as const,
    appId: "example",
    version,
    parentVersion,
    trigger: "save" as const,
    createdAt: 1_700_000_000_000 + sequence,
    message: `Fixture ${sequence}`,
  };
  const tagOid = await git.writeTag({
    fs,
    dir: appDir,
    tag: {
      object: version,
      type: "commit",
      tag: `lamarck-version-${version}`,
      tagger: { ...gitPerson(), timestamp: gitPerson().timestamp + sequence },
      message: canonicalizeAppVersionRecordV1(record),
    },
  });
  await git.writeRef({
    fs,
    dir: appDir,
    ref: `refs/lamarck/versions/${version}`,
    value: tagOid,
  });
  await git.writeRef({
    fs,
    dir: appDir,
    ref: "refs/lamarck/current/example",
    value: version,
    force: true,
  });
  await git.writeRef({ fs, dir: appDir, ref: "refs/heads/main", value: version, force: true });
  return version;
}
