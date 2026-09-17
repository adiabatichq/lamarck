import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createClaudeCode } from 'ai-sdk-provider-claude-code';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LanguageModelV4, LanguageModelV4CallOptions, ProviderV4 } from '@ai-sdk/provider';
import type { AiAccessSource, AiModel, AiSupport, ManagedAiSource } from '@lamarck/system/protocol';
import type { AiSourceStore } from './source-store';
import type { InvocationContext } from './invocations';
import { AiError } from './errors';
import { aiExecutable, CodexRpc, subscriptionEnv } from './runtime';
import { codexModel } from './codex';

export interface LoginStatus { status: 'pending' | 'ready' | 'cancelled' | 'failed'; url?: string; message?: string }
interface LoginAttempt { status: LoginStatus; cancel(): void; generation: number }
export class AiSubscriptions {
  private closed = false;
  private sessionLocks = new Map<string, Promise<void>>();
  private loginTasks = new Set<Promise<void>>();
  private attempts = new Map<string, LoginAttempt>();
  constructor(private store: AiSourceStore, private root: string) {}
  invalidate(id: string): void { this.attempts.get(id)?.cancel(); this.attempts.delete(id); }
  async remove(source: ManagedAiSource): Promise<void> {
    const id = source.id;
    this.invalidate(id);
    await this.sessionLocks.get(id);
    // The native Claude credential store belongs to this source/config directory.
    const directory = join(this.root, id);
    if (source.kind === 'subscription' && source.provider === 'anthropic') await this.command('anthropic', directory, ['auth', 'logout']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
  close(): void { this.closed = true; for (const id of this.attempts.keys()) this.invalidate(id); }
  async settled(): Promise<void> { await Promise.allSettled(this.loginTasks); await Promise.allSettled(this.sessionLocks.values()); }
  loginStatus(id: string): LoginStatus { return this.attempts.get(id)?.status ?? { status: 'cancelled' }; }
  cancelLogin(id: string): void { this.attempts.get(id)?.cancel(); }
  async login(source: ManagedAiSource): Promise<LoginStatus> {
    this.invalidate(source.id);
    const controller = new AbortController();
    const attempt: LoginAttempt = { status: { status: 'pending' }, generation: source.generation, cancel: () => { controller.abort(); attempt.status = { status: 'cancelled' }; } };
    this.attempts.set(source.id, attempt);
    const task = this.runLogin(source, attempt, controller.signal).catch(() => {
      if (!controller.signal.aborted) attempt.status = { status: 'failed', message: 'Login failed; retry from System' };
    }).finally(() => { this.loginTasks.delete(task); });
    this.loginTasks.add(task);
    return attempt.status;
  }
  private async runLogin(source: ManagedAiSource, attempt: LoginAttempt, signal: AbortSignal): Promise<void> {
    const session = await this.session(source, signal);
    const finish = () => { if (!signal.aborted && this.store.get(source.id)?.generation === source.generation) attempt.status = { status: 'ready' }; };
    try {
      if (source.provider === 'openai') {
        const rpc = new CodexRpc(session.directory);
        const abort = () => { void rpc.close(); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          await rpc.initialize();
          let settle!: (ok: boolean) => void;
          const completed = new Promise<boolean>(resolve => { settle = resolve; });
          const cancelled = () => settle(false);
          signal.addEventListener('abort', cancelled, { once: true });
          rpc.onEvent = (method, params) => { if (method === 'account/login/completed') settle(params.success === true); };
          const result = await rpc.request('account/login/start', { type: 'chatgpt' });
          attempt.status = { status: 'pending', url: result.authUrl };
          const timeout = setTimeout(() => settle(false), 5 * 60_000);
          try { if (!await completed) throw new Error('Login did not complete'); }
          finally { clearTimeout(timeout); signal.removeEventListener('abort', cancelled); }
          if (!signal.aborted && this.store.get(source.id)?.generation === source.generation) { await session.save(); finish(); }
        } finally { signal.removeEventListener('abort', abort); await rpc.close(); }
      } else {
        await this.command('anthropic', session.directory, ['auth', 'login', '--claudeai'], signal, url => { attempt.status = { status: 'pending', url }; });
        finish();
      }
    } finally { await session.dispose(); }
  }
  async describe(source: ManagedAiSource): Promise<{ status: AiAccessSource['status']; support: AiSupport[]; models: AiModel[] }> {
    // Discovery remains responsive while this source owns an interactive login.
    if (this.attempts.get(source.id)?.status.status === 'pending') return { status: 'login-required', support: [], models: [] };
    const session = await this.session(source);
    try {
      if (source.provider === 'openai') {
        const rpc = new CodexRpc(session.directory);
        try {
          await rpc.initialize();
          const account = await rpc.request('account/read', { refreshToken: false });
          if (account.account?.type !== 'chatgpt') return { status: 'login-required', support: [], models: [] };
          const result = await rpc.request('model/list', { includeHidden: false });
          const models = result.data.map((model: any) => ({ id: `openai:${model.model}`, name: model.displayName ?? model.model, provider: 'openai', type: 'language' as const }));
          await session.save();
          return { status: 'ready', models, support: models.map((model: AiModel) => languageSupport(model.id)) };
        } finally { await rpc.close(); }
      }
      const auth = JSON.parse(await this.command('anthropic', session.directory, ['auth', 'status', '--json']).catch(() => '{}'));
      if (!auth.loggedIn || auth.authMethod !== 'claude.ai') return { status: 'login-required', support: [], models: [] };
      // Initializing an empty streaming input permits supportedModels without
      // sending a user prompt or initiating inference.
      let closeInput!: () => void;
      const held = new Promise<void>(resolve => { closeInput = resolve; });
      const prompt = (async function* (): AsyncGenerator<SDKUserMessage> { await held; })();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const current = query({ prompt, options: { ...this.claudeOptions(session.directory, session.processes), abortController: controller } });
      try {
        const result = await current.supportedModels();
        const models = result.map(model => ({ id: `anthropic:${model.value}`, name: model.displayName, provider: 'anthropic', type: 'language' as const }));
        return { status: 'ready', models, support: models.map(model => languageSupport(model.id)) };
      } finally { clearTimeout(timer); closeInput(); current.close(); }
    } finally { await session.dispose(); }
  }
  async open(source: ManagedAiSource, options: LanguageModelV4CallOptions, context: InvocationContext): Promise<{ provider: ProviderV4; dispose(): Promise<void> }> {
    const session = await this.session(source, context.signal);
    if (source.provider === 'openai') {
      const rpc = new CodexRpc(session.directory);
      const abort = () => { void rpc.close(); };
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        context.signal.throwIfAborted();
        await rpc.initialize();
        const account = await rpc.request('account/read', { refreshToken: false });
        if (account.account?.type !== 'chatgpt') throw new AiError('login_required', 'Codex subscription login required');
        const provider: ProviderV4 = { specificationVersion: 'v4', languageModel: id => codexModel(id, rpc, context), embeddingModel: () => { throw new AiError('unsupported', 'Codex does not support embeddings'); }, imageModel: () => { throw new AiError('unsupported', 'Images unsupported'); } };
        return { provider, dispose: async () => { try { context.signal.removeEventListener('abort', abort); await rpc.close(); await session.save(); } finally { await session.dispose(); } } };
      } catch (error) { context.signal.removeEventListener('abort', abort); await rpc.close(); await session.dispose(); throw error; }
    }
    const abort = () => { for (const child of session.processes ?? []) void stopProcess(child); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      context.signal.throwIfAborted();
      const server = new McpServer({ name: 'lamarck', version: '1.0.0' }, { capabilities: { tools: {} } });
      if (options.toolChoice && !['auto', 'none'].includes(options.toolChoice.type)) throw new AiError('unsupported', 'Claude subscription does not support forced tool selection');
      const tools = options.toolChoice?.type === 'none' ? [] : options.tools ?? [];
      if (tools.some(tool => tool.type !== 'function')) throw new AiError('unsupported', 'Subscription only supports App function tools');
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({ name: tool.name, description: tool.type === 'function' ? tool.description : '', inputSchema: tool.type === 'function' ? tool.inputSchema : {} })) as any }));
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (!tools.some(tool => tool.name === request.params.name)) throw new Error('Unknown App tool');
        try {
          const value = await context.tool(request.params.name, request.params.arguments ?? {}, String(extra.requestId));
          return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] };
        } catch { return { isError: true, content: [{ type: 'text' as const, text: 'App tool failed' }] }; }
      });
      const provider = createClaudeCode({ defaultSettings: {
        ...this.claudeOptions(session.directory, session.processes), streamingInput: 'always', logger: false,
        mcpServers: { lamarck: { type: 'sdk', name: 'lamarck', instance: server } },
        canUseTool: async (name, input) => tools.some(tool => `mcp__lamarck__${tool.name}` === name)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Tool unavailable' },
      } });
      const scopedProvider: ProviderV4 = { ...provider, languageModel: id => normalizeClaudeModel(provider.languageModel(id), new Set(tools.map(tool => tool.name)), context.signal) };
      return { provider: scopedProvider, dispose: async () => { try { context.signal.removeEventListener('abort', abort); await server.close(); } finally { await session.dispose(); } } };
    } catch (error) { context.signal.removeEventListener('abort', abort); await session.dispose(); throw error; }
  }
  private claudeOptions(directory: string, processes?: Set<ChildProcess>) {
    return {
      cwd: directory, pathToClaudeCodeExecutable: aiExecutable('anthropic'),
      env: subscriptionEnv(directory), tools: [] as string[], strictMcpConfig: true,
      settingSources: [] as [], persistSession: false,
      spawnClaudeCodeProcess: (options: any) => {
        const child = spawn(options.command, options.args, { cwd: directory, env: subscriptionEnv(directory), stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
        processes?.add(child); child.once('exit', () => processes?.delete(child)); child.once('error', () => { if (!child.pid) processes?.delete(child); });
        return child;
      },
    };
  }
  private async acquire(id: string, signal?: AbortSignal): Promise<() => void> {
    const previous = this.sessionLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    this.sessionLocks.set(id, tail);
    void tail.then(() => { if (this.sessionLocks.get(id) === tail) this.sessionLocks.delete(id); });
    try {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        void previous.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
      });
      signal?.throwIfAborted();
      return release;
    } catch (error) { release(); throw error; }
  }
  private async session(source: ManagedAiSource, signal?: AbortSignal) {
    if (this.closed) throw new AiError('closed', 'Subscription service is shutting down');
    const release = await this.acquire(source.id, signal);
    try {
      if (this.closed) throw new AiError('closed', 'Subscription service is shutting down');
      const session = await this.openSession(source);
      return { ...session, dispose: async () => { try { await session.dispose(); } finally { release(); } } };
    } catch (error) { release(); throw error; }
  }
  private async openSession(source: ManagedAiSource) {
    if (source.kind !== 'subscription') throw new AiError('unsupported', 'Subscription source required');
    if (source.provider === 'anthropic') {
      const directory = join(this.root, source.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const processes = new Set<ChildProcess>();
      return { directory, processes, save: async () => {}, dispose: async () => { await Promise.all([...processes].map(stopProcess)); } };
    }
    const directory = await mkdtemp(join(tmpdir(), 'lamarck-ai-'));
    const ref = `ai-subscription:${source.id}`;
    const auth = await this.store.secrets.get(ref);
    if (auth) await writeFile(join(directory, 'auth.json'), auth, { mode: 0o600 });
    await writeFile(join(directory, 'config.toml'), 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n', { mode: 0o600 });
    return {
      directory, processes: undefined,
      save: async () => {
        const auth = await readFile(join(directory, 'auth.json'), 'utf8').catch(() => undefined);
        if (auth) await this.store.saveSubscription(source.id, source.generation, auth);
      },
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  }
  private command(provider: string, directory: string, args: string[], signal?: AbortSignal, onUrl?: (url: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(aiExecutable(provider), args, { cwd: directory, env: subscriptionEnv(directory), stdio: ['pipe', 'pipe', 'pipe'], signal });
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), onUrl ? 5 * 60_000 : 15_000);
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 64 * 1024) { child.kill('SIGKILL'); return; }
        const url = output.match(/https:\/\/(?:claude\.ai|platform\.claude\.com)\/[^\s\x1b]+/);
        if (url) onUrl?.(url[0]);
      };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('error', () => { clearTimeout(timer); void stopProcess(child).then(() => reject(new AiError('runtime_unavailable', 'Subscription runtime unavailable'))); });
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new AiError('login_required', 'Subscription login required')); });
    });
  }
}
function languageSupport(model: string): AiSupport { return { model, streaming: true, structuredOutput: true, tools: true }; }

/** Native MCP names are internal; Apps observe their original Vercel tool names. */
function normalizeClaudeModel(model: LanguageModelV4, names: Set<string>, signal: AbortSignal): LanguageModelV4 {
  const normalize = <T>(part: T): T => {
    const value = part as any;
    if (typeof value.toolName !== 'string' || !value.toolName.startsWith('mcp__lamarck__')) return part;
    const toolName = value.toolName.slice('mcp__lamarck__'.length);
    if (!names.has(toolName)) throw new AiError('invalid_tool', 'Unexpected subscription tool');
    return { ...value, toolName, dynamic: false };
  };
  return {
    specificationVersion: 'v4', provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    async doGenerate(options) { signal.throwIfAborted(); const result = await model.doGenerate(options); signal.throwIfAborted(); return { ...result, warnings: result.warnings.filter(warning => warning.type !== 'unsupported' || warning.feature !== 'tools'), content: result.content.map(normalize) }; },
    async doStream(options) { signal.throwIfAborted(); const result = await model.doStream(options); signal.throwIfAborted(); return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(part, controller) { signal.throwIfAborted(); controller.enqueue(part.type === 'stream-start' ? { ...part, warnings: part.warnings.filter(warning => warning.type !== 'unsupported' || warning.feature !== 'tools') } : normalize(part)); } })) }; },
  };
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 1500);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
  });
}
