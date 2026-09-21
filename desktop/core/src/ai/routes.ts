import { decodeAi, type AiSourceInput, type AiStart } from '@lamarck/system/protocol';
import type { AuthAdmission } from '../auth';
import { readJsonBody } from '../http-body';
import type { AiService } from './service';
import { AiError } from './errors';

export async function handleAiRequest(service: AiService, request: Request, admission: AuthAdmission): Promise<{ body: unknown; retained?: boolean }> {
  const path = new URL(request.url).pathname;
  const auth = admission.context;
  const body = request.method === 'POST' ? await readJsonBody<any>(request, 20 * 1024 * 1024) : {};
  if (path === '/api/ai/capture' && request.method === 'POST') {
    if (!service.turns) throw new AiError('capture_unavailable', 'AI content capture is unavailable');
    return { body: await service.turns.request(admission, body), retained: body.action === 'start' };
  }
  if (path === '/api/ai/options' && request.method === 'POST') return { body: await service.options(auth.kind === 'app' ? auth : undefined) };
  if (path.startsWith('/api/ai/invoke/') && request.method === 'POST') {
    if (auth.kind !== 'app') throw new AiError('unauthorized', 'App identity required');
    if (path === '/api/ai/invoke/start') {
      const started = service.start({ ...admission, signal: AbortSignal.any([admission.signal, request.signal]) }, body as AiStart);
      return { body: started, retained: true };
    }
    if (typeof body.invocationId !== 'string') throw new AiError('invalid_request', 'AI invocation id is required');
    if (path === '/api/ai/invoke/next') return { body: await service.invocations.next(auth, body.invocationId, body.sequence, request.signal) };
    if (path === '/api/ai/invoke/cancel') { service.invocations.cancel(auth, body.invocationId); return { body: { ok: true } }; }
    if (path === '/api/ai/invoke/tool-result') {
      if (typeof body.toolCallId !== 'string' || typeof body.failed !== 'boolean') throw new AiError('invalid_request', 'Invalid tool result');
      service.invocations.reply(auth, body.invocationId, body.toolCallId, decodeAi(body.value), body.failed);
      return { body: { ok: true } };
    }
  }
  if (auth.kind !== 'host') throw new AiError('unauthorized', 'Host management required');
  if (path === '/api/ai/sources' && request.method === 'GET') return { body: { sources: service.sources.list(), ...await service.options() } };
  if (path === '/api/ai/sources' && request.method === 'POST') {
    const { id, ...input } = body;
    if (id !== undefined && typeof id !== 'string') throw new AiError('invalid_request', 'Invalid source id');
    return { body: await service.sources.save(input as AiSourceInput, id) };
  }
  const match = path.match(/^\/api\/ai\/sources\/(access_[a-f0-9-]+)(?:\/(login|login-status|cancel-login))?$/);
  if (match) {
    const source = service.sources.get(match[1]);
    if (!source) throw new AiError('not_found', 'AI source not found');
    if (!match[2] && request.method === 'DELETE') {
      await service.sources.remove(source.id);
      await service.subscriptions.remove(source);
      return { body: { ok: true } };
    }
    if (source.kind !== 'subscription') throw new AiError('unsupported', 'Subscription source required');
    if (match[2] === 'login' && request.method === 'POST') {
      const refreshed = await service.sources.save({ name: source.name, kind: source.kind, provider: source.provider, config: source.config }, source.id);
      return { body: await service.subscriptions.login(refreshed) };
    }
    if (match[2] === 'login-status' && request.method === 'GET') {
      const status = service.subscriptions.loginStatus(source.id);
      if (status.status === 'ready') service.refreshSource(source.id);
      return { body: status };
    }
    if (match[2] === 'cancel-login' && request.method === 'POST') { service.subscriptions.cancelLogin(source.id); return { body: { ok: true } }; }
  }
  throw new AiError('not_found', 'Unknown AI operation');
}
