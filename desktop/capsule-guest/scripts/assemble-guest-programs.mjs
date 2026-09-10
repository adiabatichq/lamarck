#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describeOsBaseInputs, verifyOsBase, copyOsBaseFile } from "./os-base.mjs";
import { validateJavaScriptBuilderOutput } from "./js-builder-inventory.mjs";
import { copyTreeNoLinks, sha256File } from "./release-contract.mjs";

export const GUEST_PROGRAM_FILES = Object.freeze([
  ["build-phase-worker.js", "/usr/libexec/lamarck-build-phase-worker.js"],
  ["supervisor.js", "/usr/libexec/lamarck-supervisor.js"],
  ["offline-npm.js", "/usr/libexec/lamarck-offline-npm"],
  ["offline-npm.js", "/opt/lamarck/rootfs/build-node24/usr/libexec/lamarck-offline-npm"],
  ["release-runc-smoke.js", "/usr/libexec/lamarck-release-runc-smoke.js"],
]);

/** Offline ext4 assembly: no mount, native compilation, npm, or runtime update. */
export async function assembleGuestPrograms({ base, pin, prebuilt, snapshot, output, builderImageId, epoch = "0", jobs = "4" }) {
  const start = performance.now();
  const identity = await describeOsBaseInputs(snapshot, builderImageId, epoch, jobs);
  const verified = await verifyOsBase(base, pin, identity);
  const js = await validateJavaScriptBuilderOutput(prebuilt, snapshot);
  const expectedPrograms = [...new Set(GUEST_PROGRAM_FILES.map(([source]) => `capsule-guest/dist/${source}`))].sort();
  if (JSON.stringify(js.inventory.outputs.map(file => file.path).sort()) !== JSON.stringify(expectedPrograms)) throw new Error("Guest program inventory contains missing or unexpected programs");
  await mkdir(output, { recursive: false, mode: 0o700 });
  for (const file of verified.manifest.outputs) {
    if (file.path.startsWith("os-source/")) continue;
    await copyOsBaseFile(join(base, file.path), join(output, file.path), file.mode);
  }
  const image = join(output, "image-input/rootfs.ext4");
  const scratch = await mkdtemp(join(tmpdir(), "lamarck-guest-assembly-"));
  try {
    run("e2fsck", ["-fn", image]);
    // libext2fs treats a zero clock as wall time; use one second for its
    // internal clock while preserving the requested epoch on program inodes.
    const commands = [`set_current_time @${Math.max(1, Number(epoch))}`];
    for (const [source, destination] of GUEST_PROGRAM_FILES) {
      const before = run("debugfs", ["-R", `stat ${quoted(destination)}`, image]);
      if (!before.includes("File not found")) throw new Error(`OS base must not embed Guest programs: ${destination}`);
      commands.push(
        `write ${quoted(join(prebuilt, "capsule-guest/dist", source))} ${quoted(destination)}`,
        `set_inode_field ${quoted(destination)} mode 0100755`,
        `set_inode_field ${quoted(destination)} uid 0`,
        `set_inode_field ${quoted(destination)} gid 0`,
        ...["atime", "ctime", "mtime", "crtime"].map(field => `set_inode_field ${quoted(destination)} ${field} @${Number(epoch)}`),
      );
    }
    const script = join(scratch, "assemble.debugfs");
    await writeFile(script, `${commands.join("\n")}\n`, { flag: "wx" });
    run("debugfs", ["-w", "-f", script, image]);
    // debugfs can return zero on command errors. Verify every installed inode
    // and its exact bytes rather than treating process exit as success.
    for (const [index, [source, destination]] of GUEST_PROGRAM_FILES.entries()) {
      const extracted = join(scratch, `program-${index}`);
      run("debugfs", ["-R", `dump ${quoted(destination)} ${quoted(extracted)}`, image]);
      if (await sha256File(extracted) !== await sha256File(join(prebuilt, "capsule-guest/dist", source))) throw new Error(`Guest program assembly digest mismatch: ${destination}`);
      const metadata = run("debugfs", ["-R", `stat ${quoted(destination)}`, image]);
      if (!/Type: regular\s+Mode:\s+0755\b/.test(metadata) || !/User:\s+0\s+Group:\s+0\b/.test(metadata)) throw new Error(`Guest program assembly ownership or mode mismatch: ${destination}`);
    }
    run("e2fsck", ["-fn", image]);
    await validateJavaScriptBuilderOutput(prebuilt, snapshot);
    await copyTreeNoLinks(prebuilt, join(output, "prebuilt-verification"));
    for (const [source, destination] of [
      [join(prebuilt, "js-builder-environment.json"), "js-builder-environment.json"],
      [join(snapshot, "build-input-manifest.json"), "build-input-manifest.json"],
    ]) await writeFile(join(output, "image-input", destination), await readFile(source), { flag: "wx", mode: 0o600 });
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { osBaseDigest: pin, assemblyMs: Math.round(performance.now() - start), reused: ["Linux", "Node", "runc", "native helpers", "Runtime and Build roots", "Buildroot toolchain", "Buildroot legal-info"] };
}

function quoted(value) {
  if (/["\\\n\r]/.test(value)) throw new Error("Invalid path for fixed Guest image assembly");
  return `"${value}"`;
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}${result.stdout}`);
  return `${result.stdout}${result.stderr}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, pin, prebuilt, snapshot, output, builderImageId, epoch, jobs] = process.argv.slice(2);
  console.log(JSON.stringify(await assembleGuestPrograms({ base, pin, prebuilt, snapshot, output, builderImageId, epoch, jobs })));
}
