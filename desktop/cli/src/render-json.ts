import type { CliErrorValue } from "./operations.js";
export function renderJsonSuccess(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
export function renderJsonError(error: CliErrorValue): string { return `${JSON.stringify({ error }, null, 2)}\n`; }
