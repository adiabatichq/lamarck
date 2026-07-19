const VALIDATION_BASE_MS = Date.UTC(2024, 0, 1);

export function validateConnectorSchedule(schedule: string): void {
  nextCronRunAt(schedule, VALIDATION_BASE_MS);
}

export function nextCronRunAt(schedule: string, fromMs: number): number {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Unsupported connector schedule: ${schedule}`);
  }

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const days = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const weekdays = parseCronField(fields[4], 0, 7);
  const normalizedWeekdays = new Set([...weekdays].map((day) => day === 7 ? 0 : day));

  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const maxMinutes = 366 * 24 * 60;
  for (let offset = 0; offset < maxMinutes; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    if (
      minutes.has(candidate.getMinutes())
      && hours.has(candidate.getHours())
      && days.has(candidate.getDate())
      && months.has(candidate.getMonth() + 1)
      && normalizedWeekdays.has(candidate.getDay())
    ) {
      return candidate.getTime();
    }
  }

  throw new Error(`Could not resolve next connector schedule time: ${schedule}`);
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    parseCronPart(part, min, max).forEach((value) => values.add(value));
  }
  if (values.size === 0) {
    throw new Error(`Invalid connector cron field: ${field}`);
  }
  return values;
}

function parseCronPart(part: string, min: number, max: number): number[] {
  const [rangePart, stepPart] = part.split("/");
  if (part.split("/").length > 2) {
    throw new Error(`Invalid connector cron part: ${part}`);
  }

  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Invalid connector cron step: ${part}`);
  }

  const [start, end] = parseCronRange(rangePart, min, max);
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    assertCronValue(value, min, max, part);
    values.push(value);
  }
  return values;
}

function parseCronRange(part: string, min: number, max: number): [number, number] {
  if (part === "*") return [min, max];
  if (part.includes("-")) {
    const [start, end] = part.split("-").map(Number);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new Error(`Invalid connector cron range: ${part}`);
    }
    assertCronValue(start, min, max, part);
    assertCronValue(end, min, max, part);
    return [start, end];
  }

  const value = Number(part);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid connector cron value: ${part}`);
  }
  assertCronValue(value, min, max, part);
  return [value, value];
}

function assertCronValue(value: number, min: number, max: number, field: string): void {
  if (value < min || value > max) {
    throw new Error(`Connector cron value out of range: ${field}`);
  }
}
