import { expect, test } from 'vitest';
import { probeTurnTelemetry } from './turn-telemetry-fixture';

// Historical SDK ordering characterization. Persisted content acceptance is
// separately exercised through the production capture path in paths.test.ts.
test.each(['accept', 'reject'] as const)('onEnd is before %s of async structured output validation', async validation => {
  const observed = await probeTurnTelemetry(validation);
  expect(observed.beforeValidation).toEqual({
    telemetry: ['onStart', 'onEnd'],
    transport: ['ai.start', 'ai.next', 'ai.cancel'],
    generationSettled: false,
    appOnEndCalls: 1,
  });
  expect(observed.distinctCallIds).toBe(1);
  expect(observed.afterValidation.generationSettled).toBe(true);
  expect(observed.afterValidation.appOnEndCalls).toBe(1);
  expect(observed.afterValidation.transport).toEqual(observed.beforeValidation.transport);
  expect(observed.afterValidation.telemetry).toEqual(validation === 'accept'
    ? ['onStart', 'onEnd'] : ['onStart', 'onEnd', 'onError']);
  expect(observed.outcome).toEqual(validation === 'accept'
    ? { status: 'resolved', output: { answer: 42 } }
    : { status: 'rejected', error: 'AI_NoObjectGeneratedError' });
});
