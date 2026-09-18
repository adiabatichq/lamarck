import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export async function copyRealFile(source, destination) {
  const details = await lstat(source);
  // Locked dependencies may contain empty files (for example node-addon-api's
  // nothing.c). Executable/resource validators enforce nonempty inputs separately.
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error(`release copy source is not a single-link regular file: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
  await chmod(destination, (details.mode & 0o111) === 0 ? 0o644 : 0o755);
}

export function maxOutputFileBytes(path) {
  return /^dist-electron\/ai-runtimes\/(?:codex|claude|codex-code-mode-host)$/.test(path)
    ? 512 * 1024 * 1024 : 64 * 1024 * 1024;
}

export async function copyStableOutputFile(sourcePath, destinationPath, mode, maximumBytes = maxOutputFileBytes("")) {
  const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) {
      throw new Error(`macOS release build output is not a bounded single-link file: ${sourcePath}`);
    }
    destinationHandle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, Number(before.size) - offset),
        offset,
      );
      if (bytesRead < 1) throw new Error(`macOS release build output ended during copy: ${sourcePath}`);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        if (result.bytesWritten < 1) throw new Error("macOS release output copy made no progress");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await destinationHandle.sync();
    await destinationHandle.chmod(mode);
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error(`macOS release build output changed during copy: ${sourcePath}`);
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
}
