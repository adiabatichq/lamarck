import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AiError } from './errors';
const require = createRequire(import.meta.url);
/** Packaged assets win; development resolves only version-pinned npm packages. */
export function aiExecutable(provider: string): string {
  const bundled = join(import.meta.dirname, 'ai-runtimes', `${provider === 'openai' ? 'codex' : 'claude'}${process.platform === 'win32' ? '.exe' : ''}`);
  if (existsSync(bundled)) return bundled;
  if (provider === 'openai') {
    const os = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl';
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const packageName = `@openai/codex-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
    const root = dirname(require.resolve(`${packageName}/package.json`));
    return join(root, 'vendor', `${arch}-${os}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  }
  const root = dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`));
  return join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
}
export function subscriptionEnv(directory: string): NodeJS.ProcessEnv {
  // Do not merge process.env: no ambient keys, SDK endpoints, hooks, MCP, proxy,
  // Node loaders, telemetry, or paid-provider switches enter these processes.
  return {
    PATH: '/usr/bin:/bin', HOME: directory, USERPROFILE: directory,
    CODEX_HOME: directory, CLAUDE_CONFIG_DIR: directory,
    TMPDIR: directory, TEMP: directory, TMP: directory,
    LANG: 'en_US.UTF-8', RUST_LOG: 'off',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  };
}
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private callbacks = 0;
  private buffer = '';
  private closed = false;
  private closePromise?: Promise<void>;
  onClose: () => void = () => {};
  onEvent: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<unknown> = async () => ({ decision: 'decline' });
  constructor(directory: string, executable = aiExecutable('openai')) {
    this.child = spawn(executable, ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', 'app-server', '--listen', 'stdio://'], { cwd: directory, env: subscriptionEnv(directory), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume(); // Never retain secret-bearing CLI diagnostics.
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) { void this.close(); return; }
      for (;;) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        try { this.receive(JSON.parse(line)); } catch { void this.close(); }
      }
    });
    this.child.once('error', () => { this.onClose(); void this.close(); });
    this.child.once('exit', () => { this.onClose(); void this.close(); });
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'lamarck', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new AiError('runtime_closed', 'Codex runtime is unavailable'));
    if (this.pending.size >= 32) return Promise.reject(new AiError('busy', 'Too many subscription requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AiError('runtime_timeout', 'Codex runtime timed out')); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private send(value: unknown): void {
    if (this.closed || this.child.stdin.destroyed) return;
    const frame = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(frame) + this.child.stdin.writableLength > 8 * 1024 * 1024) { this.onClose(); void this.close(); return; }
    this.child.stdin.write(frame, () => {});
  }
  private receive(message: any): void {
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (++this.callbacks > 32) { this.onClose(); void this.close(); return; }
        void this.onRequest(message.method, message.params).then(result => this.send({ id: message.id, result }), () => this.send({ id: message.id, error: { code: -32603, message: 'Tool callback failed' } })).finally(() => { this.callbacks--; });
      }
      else this.onEvent(message.method, message.params);
    } else {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new AiError('runtime_error', 'Codex rejected the request; check source login and model support'));
      else pending.resolve(message.result);
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AiError('runtime_closed', 'Codex runtime closed')); }
    this.pending.clear();
    const child = this.child;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    this.closePromise = new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    return this.closePromise;
  }
}
