import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LINUX_WARM_NODE_MODULES_MOUNTS } from "../src/build-manager";

const [sourceValue, destinationValue] = process.argv.slice(2);
assert.ok(sourceValue && destinationValue, "warm mount gate requires source and destination paths");
const source = resolve(sourceValue);
const destination = resolve(destinationValue);
const sourceEntries = await readdir(source);

await LINUX_WARM_NODE_MODULES_MOUNTS.attach(source, destination);
try {
  assert.deepEqual(await readdir(destination), sourceEntries);
  assert.equal(
    await readFile(`${destination}/warm-fixture/index.txt`, "utf8"),
    "sealed-dependency\n",
  );
  await assert.rejects(
    writeFile(`${destination}/warm-fixture/should-not-write`, "mutated\n"),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && ["EROFS", "EACCES", "EPERM"].includes(String(error.code))
    ),
    "warm dependency bind accepted a write",
  );
} finally {
  await LINUX_WARM_NODE_MODULES_MOUNTS.detach(destination);
}

await assert.rejects(access(destination, constants.F_OK), { code: "ENOENT" });
const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
assert.equal(
  mountInfo.split("\n").some((line) => line.split(" ")[4] === destination),
  false,
  "warm dependency bind survived authoritative detach",
);
process.stdout.write("production read-only warm node_modules bind + detach passed\n");
