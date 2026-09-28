import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArm64MachO, stageComputerUse, validateComputerUse } from './stage-computer-use.mjs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function universal() {
  const fat = Buffer.alloc(256);
  fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8); fat.writeUInt32BE(64, 16); fat.writeUInt32BE(64, 20);
  fat.writeUInt32BE(0x0100000c, 28); fat.writeUInt32BE(128, 36); fat.writeUInt32BE(128, 40);
  fat.writeUInt32LE(0xfeedfacf, 128); fat.writeUInt32LE(0x0100000c, 132);
  return fat;
}
test('selects exact ARM64 bytes without requiring macOS build tools', () => {
  const fat = universal();
  assert.deepEqual(extractArm64MachO(fat), fat.subarray(128));
  for (const mutate of [b => b.writeUInt32BE(9, 4), b => b.writeUInt32BE(0x01000007, 28), b => b.writeUInt32BE(0x0100000c, 8), b => b.writeUInt32BE(240, 36), b => b.writeUInt32LE(0x01000007, 132)]) {
    const bad = universal(); mutate(bad); assert.throws(() => extractArm64MachO(bad));
  }
  assert.throws(() => extractArm64MachO(Buffer.alloc(4)));
});
test('rejects an altered pinned archive before extraction and marks unsupported platforms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-package-'));
  try {
    const archive = join(root, 'bad.tgz'); await writeFile(archive, 'not the pinned release');
    await assert.rejects(stageComputerUse(root, 'darwin', archive), /integrity/);
    await stageComputerUse(root, 'linux');
    assert.equal(JSON.parse(await readFile(join(root, 'computer-use/manifest.json'))).supported, false);
    await assert.rejects(validateComputerUse(join(root, 'computer-use')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
