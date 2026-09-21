import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import electron from 'electron';

// Characterize the pinned SDK separately from the existing full-path Electron
// suite and its Console tests. No upstream provider is contacted.
const out = resolve('.lamarck/build/ai-turn-telemetry');
const aiVersion = createRequire(import.meta.url)('ai/package.json').version;
if (aiVersion !== '7.0.105') throw new Error('Re-evaluate the telemetry contract against the new official ai version');
await mkdir(out, { recursive: true });
await build({
  entryPoints: ['test/ai/turn-telemetry-electron.ts'], bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['electron'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  outfile: join(out, 'main.mjs'),
});
await build({
  entryPoints: ['test/ai/turn-telemetry-fixture.ts'], bundle: true,
  platform: 'browser', format: 'iife', globalName: 'turnTelemetryFixture',
  minify: true, outfile: join(out, 'renderer.js'),
});
await writeFile(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="renderer.js"></script>');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [join(out, 'main.mjs')], { env, stdio: 'inherit' });
// Harness deadline only; the ordering proof itself uses explicit promise gates.
const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
child.once('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
