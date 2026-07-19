import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchPublishedRelease, updateConsumerLocks } from "./update-system-sdk-consumers.mjs";

const release = {
  version: "0.1.1",
  resolved: "https://registry.npmjs.org/@lamarck/system/-/system-0.1.1.tgz",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  engines: { node: ">=24.10.0" },
};

test("updates every compatible starter lock from one registry release", async (t) => {
  const appsDirectory = await createApps(t, ["hello-world", "tools"]);
  const changed = await updateConsumerLocks({ appsDirectory, release });
  assert.equal(changed.length, 2);

  for (const appId of ["hello-world", "tools"]) {
    const lock = await readJson(join(appsDirectory, appId, "package-lock.json"));
    assert.deepEqual(lock.packages["node_modules/@lamarck/system"], {
      version: release.version,
      resolved: release.resolved,
      integrity: release.integrity,
      engines: release.engines,
    });
  }

  assert.deepEqual(await updateConsumerLocks({ appsDirectory, release }), []);
});

test("rejects an incompatible release without partially rewriting locks", async (t) => {
  const appsDirectory = await createApps(t, ["hello-world", "tools"]);
  const toolsPackagePath = join(appsDirectory, "tools", "package.json");
  const toolsLockPath = join(appsDirectory, "tools", "package-lock.json");
  const toolsPackage = await readJson(toolsPackagePath);
  const toolsLock = await readJson(toolsLockPath);
  toolsPackage.dependencies["@lamarck/system"] = "^0.2.0";
  toolsLock.packages[""].dependencies["@lamarck/system"] = "^0.2.0";
  await writeFile(toolsPackagePath, `${JSON.stringify(toolsPackage, null, 2)}\n`);
  await writeFile(toolsLockPath, `${JSON.stringify(toolsLock, null, 2)}\n`);
  const before = await readFile(join(appsDirectory, "hello-world", "package-lock.json"), "utf8");

  await assert.rejects(
    updateConsumerLocks({ appsDirectory, release }),
    /does not declare a compatible SDK range/,
  );
  assert.equal(
    await readFile(join(appsDirectory, "hello-world", "package-lock.json"), "utf8"),
    before,
  );
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

test("rejects registry metadata that introduces SDK runtime dependencies", async () => {
  await assert.rejects(
    fetchPublishedRelease("0.1.1", async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          name: "@lamarck/system",
          version: release.version,
          engines: release.engines,
          dependencies: { unexpected: "1.0.0" },
          dist: { tarball: release.resolved, integrity: release.integrity },
        };
      },
    })),
    /no runtime dependencies/,
  );
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
