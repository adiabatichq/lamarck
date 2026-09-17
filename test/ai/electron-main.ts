import { app, BrowserWindow, ipcMain } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        content.push({ type: 'text', text: 'hello' }); return { content, usage, finishReason, warnings: [] };
      },
      async doStream() { return { stream: new ReadableStream<any>({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'hel' }, { type: 'text-delta', id: 'text', delta: 'lo' }, { type: 'text-end', id: 'text' }, { type: 'finish', usage, finishReason }]) c.enqueue(p); c.close(); } }) }; },
    };
    return { provider: { specificationVersion: 'v4', languageModel: () => model, embeddingModel() { throw new Error('Unsupported'); }, imageModel() { throw new Error('Unsupported'); } }, dispose: async () => {} };
  },
};
const service = new AiService(db, new CredentialStore(db), new SqliteEncryptedSecretStore(db, new Uint8Array(32).fill(1)), root, adapter);
const source = await service.sources.save({ provider: 'openai', kind: 'subscription', name: 'Fixture' });
const caller = { kind: 'app', appId: 'browser-fixture', channelId: 'browser', workload: 'ui', authorization: {} } as any;
const signal = new AbortController();
const server = await serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.headers.get('authorization') === 'Bearer console-fixture') {
    // Exercise the Console login link without contacting a real account.
    if (new URL(request.url).pathname === `/api/ai/sources/${source.id}/login` || new URL(request.url).pathname === `/api/ai/sources/${source.id}/login-status`) {
      return Response.json({ status: 'pending', url: 'https://example.invalid/subscription-login' }, { headers: cors });
    }
    try { return Response.json((await handleAiRequest(service, request, { context: { kind: 'host' }, signal: new AbortController().signal, release() {} } as any)).body, { headers: cors }); }
    catch (error) { return Response.json({ error: String(error) }, { status: 400, headers: cors }); }
  }
  if (request.headers.get('x-lamarck-app-capability') !== 'fixture') return new Response('', { status: 401 });
  outstanding++; let released = false, retained = false;
  const admission = { context: caller, signal: signal.signal, release() { if (!released) { released = true; outstanding--; } } };
  try {
    if (new URL(request.url).pathname === '/api/query') return Response.json({ rows: [{ appId: caller.appId }] });
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
  const consoleWindow = new BrowserWindow({ show: false, width: 1120, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let popupAttempts = 0;
  consoleWindow.webContents.setWindowOpenHandler(() => { popupAttempts++; return { action: 'deny' }; });
  try {
    console.log('Checking Console controls');
    await consoleWindow.loadFile(join(import.meta.dirname, 'index.html'));
    await consoleWindow.webContents.executeJavaScript(`window.showConsole(${JSON.stringify(`http://127.0.0.1:${server.port}`)})`);
    const result = await consoleWindow.webContents.executeJavaScript('window.exerciseConsole()');
    if (result !== 'passed' || service.sources.list().find(source => source.name === 'Console fixture')?.allow.mode !== 'apps') throw new Error('Console source management failed');
    if (popupAttempts) throw new Error('Console login attempted to open a blocked Shell window');
    await writeFile(join(import.meta.dirname, 'console.png'), (await consoleWindow.webContents.capturePage()).toPNG());
    console.log('AI_CONSOLE_SMOKE_PASS: create, secret custody, empty allowlist, preserved policy, subscription login via openExternal');
  } finally { consoleWindow.destroy(); }
  await service.close();
  if (outstanding !== 0) throw new Error('Authorization admission leaked');
  console.log('AI_ELECTRON_SMOKE_PASS: isolated renderer, generation, streaming, callback, nested System call, abort and disconnect');
} catch (error) { console.error(error); code = 1; }
finally { if (!window.isDestroyed()) window.destroy(); broker.unbindAll(); await service.close(); await server.stop(); db.close(); await rm(root, { recursive: true, force: true }); app.exit(code); }

}
void main().catch(error => { console.error(error); app.exit(1); });
