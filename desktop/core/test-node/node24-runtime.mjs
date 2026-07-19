import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveNode24Runtime(version = process.versions.node) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > 24 || (major === 24 && minor >= 10)) {
    return { command: process.execPath, env: {} };
  }

  try {
    return {
      command: require("electron"),
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  } catch {
    throw new Error(
      `Tests require Node.js 24.10+ (current: ${version}). `
      + "Install Node 24 or the desktop shell's Electron 42 development dependency.",
    );
  }
}
