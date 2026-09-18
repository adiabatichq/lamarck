import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { smokeAiRuntimes, smokeCodexCodeMode, stageAiRuntimes, validateAiRuntimes } from './stage-ai-runtimes.mjs';
import { macOsReleaseEntitlementsForPath } from './package-macos-release-contract.mjs';

test('release AI asset gate rejects wrong targets, modified executable bytes and unexpected assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-assets-'));
  try {
    const files = {};
    for (const [name, version] of [['codex', '0.154.0'], ['codex-code-mode-host', '0.154.0'], ['claude', '2.1.263']]) {
      const bytes = Buffer.from(`fixture executable ${name}`);
      await writeFile(join(root, name), bytes);
      files[name] = { version, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', files };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await validateAiRuntimes(root, 'darwin', 'arm64');
    await assert.rejects(validateAiRuntimes(root, 'linux', 'arm64'), /target mismatch/);
    await rm(join(root, 'codex-code-mode-host'));
    await assert.rejects(validateAiRuntimes(root, 'darwin', 'arm64'), /ENOENT/);
    await writeFile(join(root, 'codex-code-mode-host'), 'fixture executable codex-code-mode-host');
    await writeFile(join(root, 'codex'), 'modified');
    await assert.rejects(validateAiRuntimes(root, 'darwin', 'arm64'), /bytes differ/);
    manifest.files.extra = files.codex;
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(validateAiRuntimes(root, 'darwin', 'arm64'), /Unexpected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('code-mode release smoke rejects a missing helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-missing-helper-'));
  try {
    await assert.rejects(smokeCodexCodeMode(root, { cwd: root, env: {} }), /Packaged Codex code-mode smoke failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native code-mode callback fails with empty entitlements and passes with the release policy', {
  skip: process.env.LAMARCK_AI_NATIVE_SMOKE !== '1' || process.platform !== 'darwin' || process.arch !== 'arm64',
  timeout: 45000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-signed-helper-'));
  try {
    const require = createRequire(import.meta.url);
    const source = process.env.LAMARCK_AI_CODEX_TEST_EXECUTABLE
      ? dirname(process.env.LAMARCK_AI_CODEX_TEST_EXECUTABLE)
      : join(dirname(require.resolve('@openai/codex-darwin-arm64/package.json')), 'vendor', 'aarch64-apple-darwin', 'bin');
    const helper = join(root, 'codex-code-mode-host');
    const plist = join(root, 'entitlements.plist');
    await cp(join(source, 'codex-code-mode-host'), helper);
    const appPath = join(root, 'Lamarck.app');
    const packagedHelper = join(appPath, 'Contents', 'Resources', 'app', 'dist-electron', 'ai-runtimes', 'codex-code-mode-host');
    const policy = macOsReleaseEntitlementsForPath(packagedHelper, { appPath, capsuleHelper: join(appPath, 'capsule-helper') });
    const options = { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root } };
    for (const [keys, shouldPass] of [[[], false], [policy, true]]) {
      await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${keys.map(key => `<key>${key}</key><true/>`).join('')}</dict></plist>`);
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', '--entitlements', plist, helper], { stdio: 'pipe' });
      if (shouldPass) await smokeCodexCodeMode(root, options);
      else await assert.rejects(smokeCodexCodeMode(root, options), /helper exited/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native packaged runtimes initialize under the release policy and reject Claude without JIT', {
  skip: process.env.LAMARCK_AI_NATIVE_SMOKE !== '1' || process.platform !== 'darwin' || process.arch !== 'arm64',
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-signed-runtimes-'));
  try {
    await stageAiRuntimes(root);
    const directory = join(root, 'ai-runtimes');
    await validateAiRuntimes(directory, 'darwin', 'arm64');
    const appPath = join(root, 'Lamarck.app');
    const sign = async (name, keys) => {
      const plist = join(root, 'entitlements.plist');
      await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${keys.map(key => `<key>${key}</key><true/>`).join('')}</dict></plist>`);
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', '--entitlements', plist, join(directory, name)], { stdio: 'pipe' });
    };
    const policy = name => macOsReleaseEntitlementsForPath(join(appPath, 'Contents', 'Resources', 'app', 'dist-electron', 'ai-runtimes', name), { appPath, capsuleHelper: join(appPath, 'capsule-helper') });
    for (const name of ['codex', 'codex-code-mode-host', 'claude']) await sign(name, name === 'claude' ? [] : policy(name));
    await assert.rejects(smokeAiRuntimes(directory), /Claude runtime did not initialize/);
    await sign('claude', policy('claude'));
    await smokeAiRuntimes(directory);
  } finally { await rm(root, { recursive: true, force: true }); }
});
