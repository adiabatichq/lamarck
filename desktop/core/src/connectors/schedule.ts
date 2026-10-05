import { parseCron } from '../cron';

const VALIDATION_BASE_MS = Date.UTC(2024, 0, 1);

export function validateConnectorSchedule(schedule: string): void {
  nextCronRunAt(schedule, VALIDATION_BASE_MS);
}

export function nextCronRunAt(schedule: string, fromMs: number): number {
  try { return parseCron(schedule, fromMs).next().getTime(); }
  catch (cause) { throw new Error(`Unsupported connector schedule: ${schedule}`, { cause }); }
}
