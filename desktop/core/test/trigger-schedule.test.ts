import { expect, test } from 'vitest';
import { upcomingTimes, nextScheduledTime } from '../src/triggers/schedule';
import { nextCronRunAt } from '../src/connectors/schedule';
const iso = (cron: string, zone: string, after: string, n = 3) => upcomingTimes(cron, zone, Date.parse(after), n).map(t => new Date(t).toISOString());
test('five fields, steps, ranges, lists and timezone calculations share one parser', () => {
  expect(iso('0,30 9-10 * * *', 'Asia/Taipei', '2026-10-02T00:00:00Z')).toEqual(['2026-10-02T01:00:00.000Z', '2026-10-02T01:30:00.000Z', '2026-10-02T02:00:00.000Z']);
  expect(nextScheduledTime('*/5 * * * *', 'UTC', Date.parse('2026-10-02T00:05:00Z'))).toBe(Date.parse('2026-10-02T00:10:00Z'));
});
test('DST follows the cron library: gap shifts forward and a daily fold runs once', () => {
  expect(iso('30 2 * * *', 'America/New_York', '2026-03-07T12:00:00Z', 2)).toEqual(['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z']);
  expect(iso('30 1 * * *', 'America/New_York', '2026-11-01T00:00:00Z')).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z']);
});
test('half-hour DST and quarter-hour offsets are represented exactly', () => {
  expect(iso('45 1 * * *', 'Australia/Lord_Howe', '2026-04-04T12:00:00Z', 2)).toEqual(['2026-04-04T14:45:00.000Z', '2026-04-05T15:15:00.000Z']);
  expect(iso('0 9 * * *', 'Asia/Kathmandu', '2026-10-02T00:00:00Z', 1)).toEqual(['2026-10-02T03:15:00.000Z']);
});
test('native cron matches either restricted DOM or DOW; names, Sunday and leap days work', () => {
  expect(iso('0 9 2 * FRI', 'UTC', '2026-10-03T00:00:00Z', 1)).toEqual(['2026-10-09T09:00:00.000Z']);
  expect(iso('0 0 * * 7', 'UTC', '2026-10-02T00:00:00Z', 1)).toEqual(iso('0 0 * * 0', 'UTC', '2026-10-02T00:00:00Z', 1));
  expect(iso('0 0 29 2 *', 'UTC', '2026-10-02T00:00:00Z', 2)).toEqual(['2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z']);
});
test('Source schedules share standard cron semantics and retain their local timezone', () => {
  expect(nextCronRunAt('0 9 2 * FRI', new Date(2026, 9, 3).getTime())).toBe(new Date(2026, 9, 9, 9).getTime());
});
test.each([
  ['Japan', 'Asia/Tokyo'],
  ['CET', 'Europe/Brussels'],
  ['PRC', 'Asia/Shanghai'],
  ['ROC', 'Asia/Taipei'],
  ['PST', 'America/Los_Angeles'],
])('runtime-recognized timezone alias %s shares its named zone schedule', (alias, zone) => {
  expect(iso('0 9 * * *', alias, '2026-10-02T00:00:00Z')).toEqual(iso('0 9 * * *', zone, '2026-10-02T00:00:00Z'));
});
test.each(['* * * *', '60 * * * *', '*/0 * * * *', '* * 31 2 *', 'H * * * *', '2-1 * * * *', '* * * * * *'])('rejects invalid or unsupported cron %s', cron => { expect(() => nextScheduledTime(cron, 'UTC', Date.now())).toThrow(); });
test.each(['Mars/Olympus', '+08:00', '-08:00', '+0800', 'GMT+8', ''])('rejects invalid or non-named timezone %s', zone => { expect(() => nextScheduledTime('* * * * *', zone, Date.now())).toThrow(); });
