import { expect, test, vi } from 'vitest';
import { createSystem } from '../src/create-system';
import type { JobInvocation, SystemInvoke } from '../src/protocol';
test.each([{ kind: 'event', event: { id: 'd0', payload: { original: true } } }, { kind: 'schedule', scheduledAt: 1234 }])('proposed jobInput reads the bound typed input (%j) without selectors or management APIs', async input => {
  const value = { version: 1, triggerId: 't', runId: 'r', revision: 2, input } as JobInvocation;
  const invoke = vi.fn(async () => value); const system = createSystem(invoke as SystemInvoke);
  expect(await system.jobInput()).toEqual(value); expect(invoke).toHaveBeenCalledWith('job.input', {});
  expect(Object.keys(system)).not.toContain('triggers');
});
