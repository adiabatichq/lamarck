import type { AppInfo } from "./api";

const APP_ACCENTS = [
  "#d45f3a",
  "#2f64d6",
  "#23866f",
  "#a66a22",
  "#7652bd",
  "#bf4f79",
  "#397c9d",
  "#657231",
] as const;

export function isUiApp(app: AppInfo): boolean {
  return Boolean(app.runtime.ui);
}

export function appAccent(appId: string): string {
  let hash = 0;
  for (const char of appId) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return APP_ACCENTS[Math.abs(hash) % APP_ACCENTS.length];
}

export function appInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s_\-/]+/)
    .filter(Boolean);
  if (words.length === 0) return "A";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

export function appWorkloads(app: AppInfo): string[] {
  const workloads: string[] = [];
  if (app.runtime.ui) workloads.push("UI");
  const serviceCount = Object.keys(app.runtime.services ?? {}).length;
  const jobCount = Object.keys(app.runtime.jobs ?? {}).length;
  if (serviceCount > 0) workloads.push(`${serviceCount} service${serviceCount === 1 ? "" : "s"}`);
  if (jobCount > 0) workloads.push(`${jobCount} job${jobCount === 1 ? "" : "s"}`);
  return workloads;
}
