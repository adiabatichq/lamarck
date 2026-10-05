import { CronExpressionParser } from 'cron-parser';

/** Delegate cron matching and DST to the library; retain minute-granularity input. */
export function parseCron(cron: string, after: number, timezone?: string) {
  if (!Number.isSafeInteger(after) || cron.trim().split(/\s+/).length !== 5) throw new Error('Cron requires five fields: minute hour day month weekday');
  if (/\bH\b/.test(cron)) throw new Error('Randomized H expressions are not standard cron');
  return CronExpressionParser.parse(cron, { currentDate: new Date(after), tz: timezone });
}
