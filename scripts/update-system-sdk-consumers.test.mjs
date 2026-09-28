import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverConsumerDirectories,
  fetchPublishedRelease,
  updateConsumerLocks,
} from "./update-system-sdk-consumers.mjs";

const release = {
  version: "0.1.1",
  resolved: "https://registry.npmjs.org/@lamarck/system/-/system-0.1.1.tgz",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  engines: { node: ">=24.10.0" },
};

test("updates every compatible App consumer lock from one registry release", async (t) => {
  const appsDirectory = await createApps(t, ["calendar", "journal"]);
  const consumerDirectories = ["calendar", "journal"].map((id) => join(appsDirectory, id));
  const changed = await updateConsumerLocks({ consumerDirectories, release });
  assert.equal(changed.length, 2);

  for (const appId of ["calendar", "journal"]) {
    const lock = await readJson(join(appsDirectory, appId, "package-lock.json"));
    assert.deepEqual(lock.packages["node_modules/@lamarck/system"], {
      version: release.version,
      resolved: release.resolved,
      integrity: release.integrity,
      engines: release.engines,
    });
  }

  assert.deepEqual(await updateConsumerLocks({ consumerDirectories, release }), []);
});

test("rejects an incompatible release without partially rewriting locks", async (t) => {
  const appsDirectory = await createApps(t, ["calendar", "journal"]);
  const journalPackagePath = join(appsDirectory, "journal", "package.json");
  const journalLockPath = join(appsDirectory, "journal", "package-lock.json");
  const journalPackage = await readJson(journalPackagePath);
  const journalLock = await readJson(journalLockPath);
  journalPackage.dependencies["@lamarck/system"] = "^0.2.0";
  journalLock.packages[""].dependencies["@lamarck/system"] = "^0.2.0";
  await writeFile(journalPackagePath, `${JSON.stringify(journalPackage, null, 2)}\n`);
  await writeFile(journalLockPath, `${JSON.stringify(journalLock, null, 2)}\n`);
  const before = await readFile(join(appsDirectory, "calendar", "package-lock.json"), "utf8");

  await assert.rejects(
    updateConsumerLocks({
      consumerDirectories: ["calendar", "journal"].map((id) => join(appsDirectory, id)),
      release,
    }),
    /does not declare a compatible SDK range/,
  );
  assert.equal(
    await readFile(join(appsDirectory, "calendar", "package-lock.json"), "utf8"),
    before,
  );
});

test("treats a missing Official App collection as an empty collection", async (t) => {
  const fixtureRoot = await createApps(t, ["app-v1"]);
  const scaffoldDirectory = join(fixtureRoot, "app-v1");
  assert.deepEqual(await discoverConsumerDirectories({
    appsDirectory: join(fixtureRoot, "absent-apps"),
    scaffoldDirectory,
  }), [scaffoldDirectory]);
});

test("accepts exact dependency-free npm registry metadata", async () => {
  let requestedUrl;
  const actual = await fetchPublishedRelease("0.1.1", async (url, options) => {
    requestedUrl = url;
    assert.equal(options.redirect, "error");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          name: "@lamarck/system",
          version: release.version,
          engines: release.engines,
          dist: { tarball: release.resolved, integrity: release.integrity },
        };
      },
    };
  });

  assert.equal(requestedUrl, "https://registry.npmjs.org/@lamarck%2fsystem/0.1.1");
  assert.deepEqual(actual, release);
});

test("retains SDK runtime dependencies from verified registry metadata", async () => {
  const actual = await
    fetchPublishedRelease("0.1.1", async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          name: "@lamarck/system",
          version: release.version,
          engines: release.engines,
          dependencies: { "@ai-sdk/provider": "4.0.17" },
          dist: { tarball: release.resolved, integrity: release.integrity },
        };
      },
    }));
  assert.deepEqual(actual.dependencies, { "@ai-sdk/provider": "4.0.17" });
});

test("resolves the dependency graph and preserves App ranges without rewriting package.json", async (t) => {
  const directory = await createApps(t, ["app-v1"]);
  const appDirectory = join(directory, "app-v1");
  const packagePath = join(appDirectory, "package.json");
  const before = await readFile(packagePath, "utf8");
  const withDependencies = { ...release, dependencies: { "@ai-sdk/provider": "4.0.17" } };
  const resolveDependencies = async (pkg, lock, version) => {
    assert.equal(pkg.dependencies["@lamarck/system"], "^0.1.0");
    assert.equal(version, release.version);
    lock.packages[""].dependencies["@lamarck/system"] = version;
    const { version: sdkVersion, resolved, integrity, engines, dependencies } = withDependencies;
    lock.packages["node_modules/@lamarck/system"] = { version: sdkVersion, resolved, integrity, engines, dependencies };
    lock.packages["node_modules/@ai-sdk/provider"] = { version: "4.0.17" };
    return lock;
  };
  assert.deepEqual(await updateConsumerLocks({ consumerDirectories: [appDirectory], release: withDependencies, resolveDependencies }), [join(appDirectory, "package-lock.json")]);
  const lock = await readJson(join(appDirectory, "package-lock.json"));
  assert.equal(lock.packages[""].dependencies["@lamarck/system"], "^0.1.0");
  assert.equal(lock.packages["node_modules/@ai-sdk/provider"].version, "4.0.17");
  assert.equal(await readFile(packagePath, "utf8"), before);
  await assert.rejects(updateConsumerLocks({ consumerDirectories: [appDirectory], release: { ...withDependencies, integrity: `sha512-${Buffer.alloc(64, 3).toString("base64")}` }, resolveDependencies }), /does not match/);
});

async function createApps(t, appIds) {
  const directory = await mkdtemp(join(tmpdir(), "lamarck-sdk-consumers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const appId of appIds) {
    const appDirectory = join(directory, appId);
    await mkdir(appDirectory, { recursive: true });
    const dependencies = { "@lamarck/system": "^0.1.0" };
    await writeFile(join(appDirectory, "package.json"), `${JSON.stringify({
      name: appId,
      private: true,
      dependencies,
    }, null, 2)}\n`);
    await writeFile(join(appDirectory, "package-lock.json"), `${JSON.stringify({
      name: appId,
      version: "0.1.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: appId, version: "0.1.0", dependencies },
        "node_modules/@lamarck/system": {
          version: "0.1.0",
          resolved: "https://registry.npmjs.org/@lamarck/system/-/system-0.1.0.tgz",
          integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
          engines: { node: ">=24.10.0" },
        },
      },
    }, null, 2)}\n`);
  }
  return directory;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
