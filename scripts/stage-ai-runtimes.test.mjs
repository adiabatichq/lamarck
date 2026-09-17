import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateAiRuntimes } from './stage-ai-runtimes.mjs';

test('release AI asset gate rejects wrong targets, modified executable bytes and unexpected assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-assets-'));
  try {
    const files = {};
    for (const [name, version] of [['codex', '0.154.0'], ['claude', '2.1.263']]) {
      const bytes = Buffer.from(`fixture executable ${name}`);
      await writeFile(join(root, name), bytes);
      files[name] = { version, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', files };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await validateAiRuntimes(root, 'darwin', 'arm64');
    await assert.rejects(validateAiRuntimes(root, 'linux', 'arm64'), /target mismatch/);
    await writeFile(join(root, 'codex'), 'modified');
    await assert.rejects(validateAiRuntimes(root, 'darwin', 'arm64'), /bytes differ/);
    manifest.files.extra = files.codex;
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(validateAiRuntimes(root, 'darwin', 'arm64'), /Unexpected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
