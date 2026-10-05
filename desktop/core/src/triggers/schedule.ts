import { parseCron } from '../cron';

export function upcomingTimes(cron: string, timezone: string, after: number, count = 5): number[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Invalid schedule preview bounds');
  const zone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
  // Intl resolves named aliases and also supports offsets; this contract uses named zones.
  if (zone.startsWith('+') || zone.startsWith('-')) throw new Error('Schedule requires a named IANA timezone');
  return parseCron(cron, after, zone).take(count).map(date => date.getTime());
}
export function nextScheduledTime(cron: string, timezone: string, after: number): number { return upcomingTimes(cron, timezone, after, 1)[0]; }
