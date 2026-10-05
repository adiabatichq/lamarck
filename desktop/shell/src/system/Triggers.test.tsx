import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { draftSettings, targetInFilter, TriggerView, type TriggerDraft } from './Triggers';
import type { TriggerDetail, TriggerTarget } from '../lib/api';
const draft: TriggerDraft = { name: 'Inbox', target: 'app:notes:job:inbox', enabled: true, kind: 'event', sql: 'SELECT id FROM events WHERE type=?', params: '["mail.received"]', cron: '0 9 * * *', timezone: 'Asia/Taipei' };
const target: TriggerTarget = { id: draft.target, name: 'Notes / inbox', kind: 'app-job', inputs: ['event', 'schedule'], available: false, reason: 'Capsule unavailable' };
const detail: TriggerDetail = { id: 't', revision: 2, name: draft.name, target: draft.target, kind: 'event', enabled: true, available: false, unavailableReason: target.reason, error: 'Target refused', nextRunAt: null, lastRun: null, settings: draftSettings(draft), runs: [{ id: 'r', triggerId: 't', revision: 1, name: 'Old settings', target: draft.target, status: 'interrupted', createdAt: 1, startedAt: 1, endedAt: 2, error: 'Host interrupted; external effects may have occurred', input: { kind: 'event', eventId: 'original-d0', type: 'mail.received' } }] };
const actions = { onSelect: vi.fn(), onDraft: vi.fn(), onSave: vi.fn(), onPreview: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(), onCancelDelete: vi.fn(), onConfirmDelete: vi.fn(), onCancelRun: vi.fn() };
test('Console presents conditions, availability, errors, immutable run revisions and original input identities', () => {
  const html = renderToStaticMarkup(<TriggerView records={[detail]} targets={[target]} detail={detail} selected="t" draft={draft} preview={{ kind: 'event', truncated: false, events: [] }} error={null} busy={false} deleting={false} {...actions} />);
  for (const text of ['Read-only SQL', 'Capsule unavailable', 'Target refused', 'Execution history', 'interrupted', 'original-d0', 'revision 1', 'Historical sample', 'No matching events.', 'Save settings']) expect(html).toContain(text);
  expect(actions.onSave).not.toHaveBeenCalled(); expect(actions.onPreview).not.toHaveBeenCalled();
});
test('schedule draft and shared API configuration contain only editable settings', () => {
  const config = draftSettings({ ...draft, kind: 'schedule' }); expect(config.condition).toEqual({ kind: 'schedule', cron: draft.cron, timezone: draft.timezone }); expect(Object.keys(config).sort()).toEqual(['condition', 'enabled', 'name', 'target']);
  expect(() => draftSettings({ ...draft, params: 'invalid JSON' })).toThrow();
  expect(targetInFilter(draft.target, { appId: 'notes' })).toBe(true); expect(targetInFilter('app:notes-extra:job:inbox', { appId: 'notes' })).toBe(false); expect(targetInFilter('source:s:run', { sourceId: 's' })).toBe(true);
});
test('deletion explicitly describes pending and running work treatment', () => {
  const html = renderToStaticMarkup(<TriggerView records={[detail]} targets={[target]} detail={detail} selected="t" draft={draft} preview={null} error={null} busy={false} deleting {...actions} />);
  expect(html).toContain('cancel queued runs'); expect(html).toContain('Running work can finish'); expect(html).toContain('history is retained');
});
