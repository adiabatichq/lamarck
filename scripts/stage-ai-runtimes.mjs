import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
export async function stageAiRuntimes(outputDirectory, platform = process.platform, arch = process.arch) {
  const target = join(outputDirectory, 'ai-runtimes');
  await mkdir(target, { recursive: true });
  const triple = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`;
  const codexRoot = dirname(require.resolve(`@openai/codex-${platform}-${arch}/package.json`));
  const claudeRoot = dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/package.json`));
  for (const [root, version] of [[codexRoot, `0.154.0-${platform}-${arch}`], [claudeRoot, '0.3.263']]) {
    if (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version !== version) throw new Error('AI runtime package version differs from the pinned contract');
  }
  const extension = platform === 'win32' ? '.exe' : '';
  const paths = { codex: join(codexRoot, 'vendor', triple, 'bin', `codex${extension}`), claude: join(claudeRoot, `claude${extension}`) };
  const versions = { codex: '0.154.0', claude: '2.1.263' };
  const files = {};
  for (const [name, path] of Object.entries(paths)) {
    const bytes = await readFile(path);
    const filename = `${name}${extension}`;
    await cp(path, join(target, filename));
    await chmod(join(target, filename), 0o755);
    files[filename] = { version: versions[name], bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  await cp(new URL('./ai-runtime-licenses/CODEX-LICENSE', import.meta.url), join(target, 'CODEX-LICENSE'));
  await cp(join(claudeRoot, 'LICENSE.md'), join(target, 'CLAUDE-LICENSE.md'));
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, platform, arch, files }, null, 2)}\n`);
}

export async function validateAiRuntimes(directory, platform, arch) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch) throw new Error('AI runtime target mismatch');
  const extension = platform === 'win32' ? '.exe' : '';
  const expected = { [`codex${extension}`]: '0.154.0', [`claude${extension}`]: '2.1.263' };
  if (Object.keys(manifest.files).sort().join() !== Object.keys(expected).sort().join()) throw new Error('Unexpected AI runtime assets');
  for (const [name, version] of Object.entries(expected)) {
    const file = await readFile(join(directory, name)); const descriptor = manifest.files[name];
    if (descriptor.version !== version || descriptor.bytes !== file.length || descriptor.sha256 !== createHash('sha256').update(file).digest('hex')) throw new Error('AI runtime bytes differ from the build manifest');
  }
}
/** Runs after signing, before publication, without using accounts or inference. */
export async function smokeAiRuntimes(directory) {
  const root = await mkdtemp(join(tmpdir(), 'lamarck-ai-package-'));
  const env = { PATH: '/usr/bin:/bin', HOME: root, USERPROFILE: root, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, TMPDIR: root, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  try {
    const codex = spawnSync(join(directory, 'codex'), ['--version'], { cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    if (codex.status !== 0 || !codex.stdout.includes('0.154.0')) throw new Error('Packaged Codex runtime did not start');
    const claude = spawnSync(join(directory, 'claude'), ['auth', 'status', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    let auth;
    try { auth = JSON.parse(claude.stdout); } catch { throw new Error('Packaged Claude runtime did not initialize under its signing policy'); }
    if (auth.loggedIn !== false) throw new Error('Packaged Claude inherited an ambient account');
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** The hermetic macOS builder runs on Linux; export only locked Darwin assets. */
export async function stageMacOsAiRuntimesFromLock(sourceRoot, outputDirectory) {
  const lock = JSON.parse(await readFile(join(sourceRoot, 'package-lock.json'), 'utf8'));
  const target = join(outputDirectory, 'ai-runtimes');
  const scratch = await mkdtemp(join(tmpdir(), 'lamarck-ai-assets-'));
  const specs = [
    { key: '@openai/codex-darwin-arm64', packageName: '@openai/codex', version: '0.154.0-darwin-arm64', name: 'codex', runtimeVersion: '0.154.0', member: 'package/vendor/aarch64-apple-darwin/bin/codex' },
    { key: '@anthropic-ai/claude-agent-sdk-darwin-arm64', packageName: '@anthropic-ai/claude-agent-sdk-darwin-arm64', version: '0.3.263', name: 'claude', runtimeVersion: '2.1.263', member: 'package/claude' },
  ];
  await mkdir(target, { recursive: true });
  const files = {};
  try {
    for (const spec of specs) {
      const entry = lock.packages?.[`node_modules/${spec.key}`];
      if (entry?.version !== spec.version || new URL(entry.resolved).origin !== 'https://registry.npmjs.org' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) throw new Error('Untrusted AI runtime lock entry');
      const response = await fetch(entry.resolved, { redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('Locked AI runtime download failed');
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.length > 256 * 1024 * 1024 || `sha512-${createHash('sha512').update(archive).digest('base64')}` !== entry.integrity) throw new Error('AI runtime archive integrity mismatch');
      const archivePath = join(scratch, `${spec.name}.tgz`); await writeFile(archivePath, archive);
      const extract = member => execFileSync('tar', ['-xOzf', archivePath, member], { maxBuffer: 512 * 1024 * 1024 });
      const pkg = JSON.parse(extract('package/package.json').toString('utf8'));
      if (pkg.name !== spec.packageName || pkg.version !== spec.version) throw new Error('AI runtime package identity mismatch');
      const bytes = extract(spec.member);
      if (bytes.length < 1024) throw new Error('AI executable is empty');
      await writeFile(join(target, spec.name), bytes, { mode: 0o755 }); await chmod(join(target, spec.name), 0o755);
      files[spec.name] = { version: spec.runtimeVersion, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      if (spec.name === 'claude') await writeFile(join(target, 'CLAUDE-LICENSE.md'), extract('package/LICENSE.md'));
    }
    await cp(new URL('./ai-runtime-licenses/CODEX-LICENSE', import.meta.url), join(target, 'CODEX-LICENSE'));
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch: 'arm64', files }, null, 2)}\n`);
    await validateAiRuntimes(target, 'darwin', 'arm64');
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
