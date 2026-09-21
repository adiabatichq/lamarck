import { generateText, Output, registerTelemetry, type Telemetry } from 'ai';
import { z } from 'zod';
import { createSystem } from '@lamarck/system';
import { encodeAi, type SystemInvoke } from '@lamarck/system/protocol';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * Probe the official generation boundary using an existing Lamarck model handle.
 * Only the Host reply is a fixture. No generation wrapper or patched ai package
 * participates. The validator gate demonstrates ordering without sleep/timers.
 */
export async function probeTurnTelemetry(validation: 'accept' | 'reject') {
  const events: Array<{ type: string; callId: string }> = [];
  const gate = deferred();
  const validating = deferred();
  const transport: string[] = [];
  let generationSettled = false;
  let appOnEndCalls = 0;
  const telemetry: Telemetry = {
    onStart(event) { events.push({ type: 'onStart', callId: event.callId }); },
    onEnd(event) { events.push({ type: 'onEnd', callId: event.callId }); },
    onError(event) {
      if (!event || typeof event !== 'object' || !('callId' in event) || typeof event.callId !== 'string') {
        throw new Error('Expected a correlated generation error');
      }
      events.push({ type: 'onError', callId: event.callId });
    },
  };
  registerTelemetry(telemetry);
  const invoke = (async (operation: string) => {
    if (operation === 'ai.capture') return { ok: true };
    transport.push(operation);
    if (operation === 'ai.start') return { invocationId: 'ai_fixture' };
    if (operation === 'ai.cancel') return { ok: true };
    if (operation === 'ai.next') return { events: [{ sequence: 0, type: 'complete', value: encodeAi({
      content: [{ type: 'text', text: '{"answer":42}' }],
      usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
      finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
      providerMetadata: { lamarck: { invocationId: 'ai_fixture' } },
    }) }] };
    throw new Error(`Unexpected fixture operation: ${operation}`);
  }) as SystemInvoke;
  const system = createSystem(invoke);
  const result = generateText({
    model: system.ai.languageModel({ model: 'openai:fixture', accessSource: 'fixture' }),
    prompt: 'Return an answer.',
    maxRetries: 0,
    onEnd() { appOnEndCalls++; },
    output: Output.object({ schema: z.object({ answer: z.number() }).superRefine(async (_, context) => {
      validating.resolve();
      await gate.promise;
      if (validation === 'reject') context.addIssue({ code: 'custom', message: 'Fixture validation rejects the output.' });
    }) }),
  }).then(
    value => { generationSettled = true; return { status: 'resolved' as const, output: value.output }; },
    error => { generationSettled = true; return { status: 'rejected' as const, error: error.name as string }; },
  );
  try {
    // If upstream moves validation before onEnd, this gate still releases and
    // the characterization assertion fails; no hanging regression test.
    await Promise.race([validating.promise, result]);
    const beforeValidation = {
      telemetry: events.map(event => event.type),
      transport: [...transport],
      generationSettled,
      appOnEndCalls,
    };
    gate.resolve();
    const outcome = await result;
    return {
      validation,
      beforeValidation,
      outcome,
      afterValidation: {
        telemetry: events.map(event => event.type),
        transport: [...transport],
        generationSettled,
        appOnEndCalls,
      },
      distinctCallIds: new Set(events.map(event => event.callId)).size,
    };
  } finally {
    gate.resolve();
    // registerTelemetry has no unregister API. This short-lived fixture turns
    // off its collector without altering any existing App integrations.
    delete telemetry.onStart;
    delete telemetry.onEnd;
    delete telemetry.onError;
  }
}

export async function runTurnTelemetryProbe() {
  const accepted = await probeTurnTelemetry('accept');
  const rejected = await probeTurnTelemetry('reject');
  for (const observation of [accepted, rejected]) {
    if (JSON.stringify(observation.beforeValidation.telemetry) !== '["onStart","onEnd"]'
      || observation.beforeValidation.generationSettled
      || observation.distinctCallIds !== 1
      || observation.beforeValidation.appOnEndCalls !== 1) {
      throw new Error(`Pinned telemetry ordering changed: ${JSON.stringify(observation)}`);
    }
  }
  if (accepted.outcome.status !== 'resolved'
    || JSON.stringify(accepted.afterValidation.telemetry) !== '["onStart","onEnd"]'
    || rejected.outcome.status !== 'rejected'
    || rejected.outcome.error !== 'AI_NoObjectGeneratedError'
    || JSON.stringify(rejected.afterValidation.telemetry) !== '["onStart","onEnd","onError"]') {
    throw new Error('Pinned generation settlement behavior changed');
  }
  return { accepted, rejected };
}
