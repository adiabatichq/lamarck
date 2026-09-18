import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function readSigningCertificateSha1(path) {
  const directory = await mkdtemp(join(tmpdir(), "lamarck-signature-certificate-"));
  try {
    const prefix = join(directory, "certificate-");
    execFileSync("codesign", ["-d", `--extract-certificates=${prefix}`, path], { stdio: "pipe" });
    const certificate = await readFile(`${prefix}0`);
    return createHash("sha1").update(certificate).digest("hex").toUpperCase();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function loadFrozenOsxSign(shellBuildExport) {
  const hostToolsRoot = await realpath(resolve(shellBuildExport, "host-tools"));
  const entry = join(
    hostToolsRoot,
    "node_modules", "@electron", "osx-sign", "dist", "index.js",
  );
  await requireSingleLinkFile(entry, "frozen @electron/osx-sign entrypoint");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith("node:")) return result;
      if (!result.url.startsWith("file:")) {
        throw new Error(`frozen signer attempted unsupported module resolution ${result.url}`);
      }
      const path = fileURLToPath(result.url);
      const pathWithinTools = relative(hostToolsRoot, path);
      if (
        path !== hostToolsRoot
        && (
          pathWithinTools === ".."
          || pathWithinTools.startsWith(`..${sep}`)
          || isAbsolute(pathWithinTools)
        )
      ) throw new Error(`frozen signer attempted ambient module resolution ${path}`);
      return result;
    },
  });
  try {
    const loaded = await import(pathToFileURL(entry).href);
    if (typeof loaded.sign !== "function") {
      throw new Error("frozen @electron/osx-sign does not export sign()");
    }
    let active = true;
    return Object.freeze({
      sign: loaded.sign,
      deregister() {
        if (!active) return;
        active = false;
        hooks.deregister();
      },
    });
  } catch (error) {
    hooks.deregister();
    throw error;
  }
}

async function requireSingleLinkFile(path, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1 || details.size < 1) {
      throw new Error(`${label} is not a nonempty single-link regular file`);
    }
  } finally {
    await handle.close();
  }
}
