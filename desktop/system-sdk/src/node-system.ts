import type { SystemInvoke } from "./protocol.js";
import {
  createSystem,
  type System,
  type VfsCommandOptions,
  type VfsCommandResult,
} from "./create-system.js";
import {
  executeReadVfsCommand,
  isReadVfsCommand,
  parseVfsCommand,
  validateVfsMetadata,
} from "./vfs-internal.js";

export function createNodeSystem(invoke: SystemInvoke, filesRoot: string): System {
  const brokered = createSystem(invoke);
  return Object.freeze({
    ...brokered,
    vfs: Object.freeze({
      command: (command: string, options?: VfsCommandOptions) => (
        nodeVfsCommand(brokered, filesRoot, command, options)
      ),
      open: brokered.vfs.open,
    }),
  });
}

async function nodeVfsCommand(
  brokered: System,
  filesRoot: string,
  command: string,
  options?: VfsCommandOptions,
): Promise<VfsCommandResult> {
  let parsed;
  try {
    parsed = parseVfsCommand(command);
  } catch (error) {
    return failed(error);
  }
  if (!isReadVfsCommand(parsed)) return brokered.vfs.command(command, options);
  try {
    if (options !== undefined) validateVfsMetadata(options);
    const stdout = await executeReadVfsCommand(filesRoot, parsed, {
      captureOutput: options?.stdout !== "ignore",
    });
    return {
      success: true,
      exitCode: 0,
      stdout: options?.stdout === "ignore" ? new Uint8Array() : stdout,
      stderr: new Uint8Array(),
    };
  } catch (error) {
    return failed(error);
  }
}

function failed(error: unknown): VfsCommandResult {
  return {
    success: false,
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: Buffer.from(`${error instanceof Error ? error.message : String(error)}\n`),
  };
}
