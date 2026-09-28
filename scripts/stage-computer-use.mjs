import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerifiedFile } from './download-verified-file.mjs';

export const CUA_DRIVER = Object.freeze({
  version: '0.30.1',
  url: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.30.1/cua-driver-rs-0.30.1-darwin-universal-binary.tar.gz',
  bytes: 46095206,
  sha256: '463d64ba749a2912b1506ce6980210544f404ab3fad1c13cb6768749bc854ec2',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Build-time only. The installed desktop never downloads or updates this driver. */
export async function stageComputerUse(output, platform = process.platform, archivePath,
  cacheDirectory = fileURLToPath(new URL('../.lamarck/build/computer-use/', import.meta.url))) {
  const target = join(output, 'computer-use');
  await mkdir(target, { recursive: true });
  await cp(new URL('./ai-runtime-licenses/CUA-LICENSE', import.meta.url), join(target, 'LICENSE'));
  if (platform !== 'darwin') {
    await writeFile(join(target, 'manifest.json'), JSON.stringify({ schemaVersion: 1, supported: false, platform }));
    return;
  }
  if (!archivePath) await mkdir(cacheDirectory, { recursive: true });
  const archive = archivePath ?? join(cacheDirectory, `${CUA_DRIVER.sha256}.tar.gz`);
  let bytes = await readFile(archive).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!bytes) {
    await downloadVerifiedFile({
      url: CUA_DRIVER.url, label: 'Cua Driver', target: archive,
      expectedBytes: CUA_DRIVER.bytes, expectedSha256: CUA_DRIVER.sha256,
      fetchImpl: (url, options) => fetch(url, { ...options, redirect: 'follow' }),
    });
    bytes = await readFile(archive);
  }
  if (bytes.length !== CUA_DRIVER.bytes || digest(bytes) !== CUA_DRIVER.sha256) throw new Error('Cua Driver archive integrity mismatch');
  const binary = extractArm64MachO(execFileSync('tar', ['-xOzf', archive, 'cua-driver'], { maxBuffer: 128 * 1024 * 1024 }));
  if (binary.length < 1024) throw new Error('Cua Driver executable is empty');
  await writeFile(join(target, 'cua-driver'), binary, { mode: 0o755 });
  await chmod(join(target, 'cua-driver'), 0o755);
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', version: CUA_DRIVER.version, bytes: binary.length, sha256: digest(binary) }, null, 2)}\n`);
  await validateComputerUse(target);
}

export async function validateComputerUse(directory) {
  if ((await readdir(directory)).sort().join() !== 'LICENSE,cua-driver,manifest.json') throw new Error('Unexpected Computer Use assets');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const bytes = await readFile(join(directory, 'cua-driver'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'darwin' || manifest.arch !== 'arm64' || manifest.version !== CUA_DRIVER.version || manifest.bytes !== bytes.length || manifest.sha256 !== digest(bytes)) throw new Error('Computer Use runtime manifest mismatch');
}

/** The pinned release is fat even in its "arm64" archive. Extract the ARM64
 * member on Linux too, preserving the desktop's exact-architecture gate. */
export function extractArm64MachO(fat) {
  if (fat.length < 8 || fat.readUInt32BE(0) !== 0xcafebabe) throw new Error('Expected a universal Cua Driver executable');
  const count = fat.readUInt32BE(4);
  if (count !== 2 || fat.length < 8 + count * 20) throw new Error('Unexpected Cua Driver architecture inventory');
  const entries = Array.from({ length: count }, (_, index) => 8 + index * 20).filter(offset => fat.readUInt32BE(offset) === 0x0100000c);
  if (entries.length !== 1) throw new Error('Cua Driver requires exactly one ARM64 member');
  const offset = fat.readUInt32BE(entries[0] + 8), size = fat.readUInt32BE(entries[0] + 12);
  if (offset < 8 + count * 20 || size < 32 || offset + size > fat.length) throw new Error('Invalid Cua Driver member bounds');
  const binary = fat.subarray(offset, offset + size);
  if (binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== 0x0100000c) throw new Error('Cua Driver member is not ARM64 Mach-O');
  return binary;
}

export function smokeComputerUse(directory) {
  const version = execFileSync(join(directory, 'cua-driver'), ['--version'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_DRIVER_RS_UPDATE_CHECK: 'false' } });
  if (!version.includes(CUA_DRIVER.version)) throw new Error('Packaged Computer Use runtime failed to start');
}
