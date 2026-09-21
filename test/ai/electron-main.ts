import { app, BrowserWindow, ipcMain } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiTurns } from '../../desktop/core/src/ai/turns';
import { GuardEngine } from '../../desktop/core/src/guard-service/engine';
import { ContentBlobStore } from '../../desktop/core/src/blob-store';
import { decodeAi } from '@lamarck/system/protocol';
import { AiService, type AiAdapter } from '../../desktop/core/src/ai/service';
import { SYSTEM_SCHEMA_V1 } from '../../desktop/core/src/db';
import { CredentialStore } from '../../desktop/core/src/credentials/credential-store';
import { SqliteEncryptedSecretStore } from '../../desktop/core/src/credentials/secret-store';
import { handleAiRequest } from '../../desktop/core/src/ai/routes';
import { SystemBroker } from '../../desktop/shell/electron/capsule/system-broker';
import { serve } from '../../desktop/core/src/node-server';
app.on('window-all-closed', () => {});
async function main() {
const root = await mkdtemp(join(tmpdir(), 'lamarck-ai-electron-'));
app.setPath('userData', join(root, 'electron'));
await app.whenReady();
const db = new DatabaseSync(':memory:'); db.exec(SYSTEM_SCHEMA_V1);
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as any;
const finishReason = { unified: 'stop', raw: 'stop' } as const;
let outstanding = 0;
let retryAttempts = 0, retryInvocation: string | undefined;
let retryErrorSent = false, retryPulling = false, cancelledDuringPull = false;
let retryPollEntered!: () => void;
const retryPoll = new Promise<void>(resolve => { retryPollEntered = resolve; });
const adapter: AiAdapter = {
  async describe(source) { return { models: [{ id: 'openai:fixture', name: 'Fixture', provider: 'openai', type: 'language' }], view: { ...source, status: 'ready', discovery: 'known', support: [{ model: 'openai:fixture', streaming: true, structuredOutput: true, tools: true }] } }; },
  async open(source, options, context) {
    const model = { specificationVersion: 'v4' as const, provider: 'fixture', modelId: 'fixture', supportedUrls: {},
      async doGenerate(options: any) {
        if (JSON.stringify(options.prompt).includes('abort-me')) await new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
        const content: any[] = [];
        if (options.tools?.length) {
          const value = await context.tool('lookup', { value: 'input' }, 'call');
          content.push({ type: 'tool-call', toolCallId: 'call', toolName: 'lookup', input: '{"value":"input"}', providerExecuted: true }, { type: 'tool-result', toolCallId: 'call', toolName: 'lookup', result: value });
        }
        content.push({ type: 'text', text: options.responseFormat?.type === 'json' ? '{"answer":42}' : 'hello' }); return { content, usage, finishReason, warnings: [] };
      },
      async doStream() {
        if (JSON.stringify(options.prompt).includes('retry-stream') && ++retryAttempts === 1) {
          retryInvocation = context.id;
          return { stream: new ReadableStream<any>({ start(c) {
            for (const part of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'retry prefix ' }, { type: 'error', error: new Error('fixture retry') }]) c.enqueue(part);
          } }) };
        }
        return { stream: new ReadableStream<any>({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'hel' }, { type: 'text-delta', id: 'text', delta: 'lo' }, { type: 'text-end', id: 'text' }, { type: 'finish', usage, finishReason }]) c.enqueue(p); c.close(); } }) };
      },
    };
    return { provider: { specificationVersion: 'v4', languageModel: () => model, embeddingModel() { throw new Error('Unsupported'); }, imageModel() { throw new Error('Unsupported'); } }, dispose: async () => {} };
  },
};
const guard = new GuardEngine({ workspacePath: root });
const principal = { source: 'app:browser-fixture:ui', producerRef: `producer:v1:sha256:${'3'.repeat(64)}`, tableGrants: [] };
const service = new AiService(db, new CredentialStore(db), new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(1)), root, adapter, new AiTurns(root, () => ({ publishAiTurn: input => guard.publishAiTurn(principal, input) })));
const next = service.invocations.next.bind(service.invocations);
service.invocations.next = async (...args) => {
  const held = args[1] === retryInvocation && retryErrorSent;
  if (held) { retryPulling = true; retryPollEntered(); }
  try {
    const result = await next(...args);
    if (args[1] === retryInvocation && result.events.some(event => event.type === 'part' && (decodeAi(event.value) as any).type === 'error')) retryErrorSent = true;
    return result;
  } finally { if (held) retryPulling = false; }
};
const cancel = service.invocations.cancel.bind(service.invocations);
service.invocations.cancel = (caller, id) => { if (id === retryInvocation) cancelledDuringPull ||= retryPulling; cancel(caller, id); };
const source = await service.sources.save({ provider: 'openai', kind: 'subscription', name: 'Fixture' });
const caller = { kind: 'app', appId: 'browser-fixture', channelId: 'browser', workload: 'ui', authorization: {} } as any;
const signal = new AbortController();
let loginState = 'pending', loginStarts = 0, loginCancels = 0;
const server = await serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.headers.get('authorization') === 'Bearer console-fixture') {
    // Exercise the full Console sign-in lifecycle without a real account.
    const path = new URL(request.url).pathname;
    if (path === '/fixture/login-state') {
      loginState = (await request.json()).status;
      return Response.json({ ok: true }, { headers: cors });
    }
    const loginAction = path.match(/^\/api\/ai\/sources\/[^/]+\/(login|login-status|cancel-login)$/)?.[1];
    if (loginAction) {
      if (loginAction === 'login') {
        loginStarts++; loginState = 'pending';
        return Response.json({ status: 'pending' }, { headers: cors });
      }
      if (loginAction === 'cancel-login') { loginCancels++; loginState = 'cancelled'; }
      return Response.json({ status: loginState, ...(loginState === 'pending' ? { url: 'https://example.invalid/subscription-login' } : {}) }, { headers: cors });
    }
    try { return Response.json((await handleAiRequest(service, request, { context: { kind: 'host' }, signal: new AbortController().signal, release() {} } as any)).body, { headers: cors }); }
    catch (error) { return Response.json({ error: String(error) }, { status: 400, headers: cors }); }
  }
  if (request.headers.get('x-lamarck-app-capability') !== 'fixture') return new Response('', { status: 401 });
  outstanding++; let released = false, retained = false;
  const admission = { context: caller, signal: signal.signal, release() { if (!released) { released = true; outstanding--; } } };
  try {
    if (new URL(request.url).pathname === '/api/query') {
      const body = await request.json(); if (body.sql === 'retry-poll') await retryPoll;
      return Response.json({ rows: body.sql === 'capture-count' ? [{ count: guard.query(principal, 'SELECT id FROM events WHERE type = ?', ['ai.turn']).length }] : [{ appId: caller.appId }] });
    }
    const result = await handleAiRequest(service, request, admission); retained = !!result.retained; return Response.json(result.body);
  } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  finally { if (!retained) admission.release(); }
} });
const broker = new SystemBroker({ coreBaseUrl: async () => `http://127.0.0.1:${server.port}`, revokeCapability: async () => { signal.abort(); } });
const window = new BrowserWindow({ show: false, webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
broker.bindSender(window.webContents.id, { capability: 'fixture', channelId: 'browser' });
ipcMain.handle('app-system:invoke', (event, request) => broker.invokeSerialized(event.sender.id, request));
let code = 0;
try {
  console.log('Checking sandboxed App renderer');
  await window.loadFile(join(import.meta.dirname, 'index.html'));
  const result = await window.webContents.executeJavaScript(`window.exercise(${JSON.stringify(source.id)})`);
  if (result !== 'passed') throw new Error('Renderer did not complete');
  // Destroying the real sandboxed renderer must cancel its pending generation.
  await window.webContents.executeJavaScript(`window.pending(${JSON.stringify(source.id)})`);
  for (let i = 0; i < 100 && !service.invocations.size; i++) await new Promise(r => setTimeout(r, 10));
  if (!service.invocations.size) throw new Error('Pending invocation did not start');
  broker.cancelAi(window.webContents.id); window.destroy();
  const consoleWindow = new BrowserWindow({ show: false, width: 1000, height: 640, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  consoleWindow.webContents.on('console-message', event => { if (event.level === 'error') console.error('Console renderer:', event.message); });
  let popupAttempts = 0;
  consoleWindow.webContents.setWindowOpenHandler(() => { popupAttempts++; return { action: 'deny' }; });
  try {
    console.log('Checking Console controls');
    await consoleWindow.loadFile(join(import.meta.dirname, 'index.html'));
    await consoleWindow.webContents.executeJavaScript(`window.showConsole(${JSON.stringify(`http://127.0.0.1:${server.port}`)})`);
    const result = await consoleWindow.webContents.executeJavaScript('window.exerciseConsole().catch(error => { throw new Error(error.stack); })');
    if (result !== 'passed' || service.sources.list().find(source => source.name === 'Console fixture')?.allow.mode !== 'apps' || loginStarts !== 4 || loginCancels !== 1) throw new Error('Console source management or sign-in lifecycle failed');
    if (popupAttempts) throw new Error('Console login attempted to open a blocked Shell window');
    await writeFile(join(import.meta.dirname, 'console.png'), (await consoleWindow.webContents.capturePage()).toPNG());
    consoleWindow.setSize(480, 420);
    await consoleWindow.webContents.executeJavaScript('window.exerciseConsoleLayout()');
    await writeFile(join(import.meta.dirname, 'console-small.png'), (await consoleWindow.webContents.capturePage()).toPNG());
    console.log('AI_CONSOLE_SMOKE_PASS: page/dialog scrolling, create, secret custody, App policy, subscription save-and-sign-in, external link failure/retry, completion, cancellation, login failure/retry, keyboard dismissal');
  } catch (error) {
    await writeFile(join(import.meta.dirname, 'console-failure.png'), (await consoleWindow.webContents.capturePage()).toPNG());
    throw error;
  } finally { consoleWindow.destroy(); }
  await service.close(); await broker.settledCaptures();
  const events = guard.query(principal, 'SELECT * FROM events WHERE type = ?', ['ai.turn']).map((row: any) => ({ ...row, payload: JSON.parse(row.payload) }));
  if (events.length !== 8 || events.filter(event => event.payload.status === 'completed').length !== 6 || events.filter(event => event.payload.status === 'interrupted').length !== 2) throw new Error(`Incorrect Electron captures: ${JSON.stringify(events)}`);
  if (retryAttempts !== 2 || !cancelledDuringPull || retryPulling) throw new Error('Retry did not cancel and settle the outstanding Chromium pull');
  for (const event of events) {
    const raw = new ContentBlobStore(root).resolve(event.payload.raw.contentRef);
    if (raw.status !== 'resolved' || JSON.parse(raw.text).records.at(-1).status !== event.payload.status || event.source !== principal.source || event.producer_ref !== principal.producerRef) throw new Error('Electron capture attribution/raw resolution failed');
    if (event.payload.input?.text.includes('retry-stream')) {
      const records = JSON.parse(raw.text).records;
      const starts = records.filter((r: any) => r.kind === 'model-start');
      if (event.payload.content.text !== 'hello' || starts.length !== 2 || new Set(starts.map((r: any) => r.invocationId)).size !== 2 || starts.some((r: any) => r.model !== 'openai:fixture' || r.accessSource !== source.id) || !raw.text.includes('retry prefix ') || records.filter((r: any) => r.kind === 'terminal').length !== 1) throw new Error('Electron retry capture lost attempt content/attribution');
    }
  }
  console.log('AI_ELECTRON_CAPTURE_PASS: eight persisted events, retry cancellation during an outstanding pull, post-generation validation and resolved raw blobs in sandboxed Chromium');
  if (outstanding !== 0) throw new Error('Authorization admission leaked');
  console.log('AI_ELECTRON_SMOKE_PASS: isolated renderer, generation, streaming, callback, nested System call, abort and disconnect');
} catch (error) { console.error(error); code = 1; }
finally { if (!window.isDestroyed()) window.destroy(); broker.unbindAll(); await service.close(); await broker.settledCaptures(); await server.stop(); db.close(); guard.close(); await rm(root, { recursive: true, force: true }); app.exit(code); }

}
void main().catch(error => { console.error(error); app.exit(1); });
