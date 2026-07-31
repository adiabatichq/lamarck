import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDeviceIdentityNativeResourceLayout,
  deviceIdentityNativeAddonPath,
} from "./resource-path.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const sourceDirectory = dirname(scriptPath);
const coreDirectory = resolve(sourceDirectory, "../../..");

export function deviceIdentityNativeRequired(platform = process.platform) {
  return platform === "darwin" || platform === "win32";
}

export async function requireDeviceIdentityNativeArtifact(nativeRoot) {
  const addon = deviceIdentityNativeAddonPath(nativeRoot);
  const details = await lstat(addon);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error("Device identity native addon is not a nonempty regular file.");
  }
  return addon;
}

export async function buildDeviceIdentityNative(options = {}) {
  const platform = options.platform ?? process.platform;
  const nativeRoot = resolve(options.nativeRoot ?? join(coreDirectory, "dist", "native"));
  const bundleDirectory = options.bundleDirectory
    ? resolve(options.bundleDirectory)
    : options.nativeRoot
      ? undefined
      : join(coreDirectory, "dist");
  const destinationDirectory = dirname(deviceIdentityNativeAddonPath(nativeRoot));

  if (bundleDirectory) {
    assertDeviceIdentityNativeResourceLayout(bundleDirectory, nativeRoot);
  }

  const required = deviceIdentityNativeRequired(platform);
  let nodeGyp;
  if (required) {
    assertNode24Runtime();
    nodeGyp = await resolveNodeGyp(options.env ?? process.env);
  }

  // This removes only this generated addon's dedicated directory. Other
  // staged native resources under the same root are preserved.
  await rm(destinationDirectory, { recursive: true, force: true });
  if (!required) return undefined;

  const buildRoot = await mkdtemp(join(tmpdir(), "lamarck-device-identity-native-"));
  try {
    for (const name of ["binding.gyp", "device_identity.cc"]) {
      const source = join(options.sourceDirectory ?? sourceDirectory, name);
      const details = await lstat(source);
      if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
        throw new Error("Device identity native build input is not a nonempty regular file.");
      }
      await copyFile(source, join(buildRoot, name));
    }

    const args = [nodeGyp, "rebuild"];
    const runtimePrefix = resolve(dirname(process.execPath), "..");
    try {
      const header = await lstat(join(runtimePrefix, "include", "node", "node_api.h"));
      if (header.isFile() && !header.isSymbolicLink()) {
        args.push(`--nodedir=${runtimePrefix}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const result = spawnSync(process.execPath, args, {
      cwd: buildRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    if (result.error) {
      throw new Error("Unable to start the native device-identity build.");
    }
    if (result.status !== 0) {
      throw new Error("The native device-identity build failed.");
    }

    const builtAddon = join(buildRoot, "build", "Release", "lamarck_device_identity.node");
    const builtDetails = await lstat(builtAddon);
    if (!builtDetails.isFile() || builtDetails.isSymbolicLink() || builtDetails.size < 1) {
      throw new Error("The native device-identity build produced no addon.");
    }

    await mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
    const destination = deviceIdentityNativeAddonPath(nativeRoot);
    await copyFile(builtAddon, destination);
    await chmod(destination, 0o644);
    return await requireDeviceIdentityNativeArtifact(nativeRoot);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

function assertNode24Runtime() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 12)) {
    throw new Error(`Device identity native build requires Node 24.12+ (current: ${process.version}).`);
  }
}

async function resolveNodeGyp(env) {
  const value = env.npm_config_node_gyp?.trim();
  if (!value || !isAbsolute(value)) {
    throw new Error("The pinned npm node-gyp entry is unavailable; run this build through npm.");
  }
  const details = await lstat(value);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error("The pinned npm node-gyp entry is invalid.");
  }
  return value;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--native-root" && argv[index + 1]) {
      options.nativeRoot = argv[++index];
      continue;
    }
    if (argument === "--bundle-directory" && argv[index + 1]) {
      options.bundleDirectory = argv[++index];
      continue;
    }
    throw new Error(
      "usage: build.mjs [--native-root <path>] [--bundle-directory <path>]",
    );
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await buildDeviceIdentityNative(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${result ?? "not-required"}\n`);
}
