import { homedir } from "node:os";
import { resolve } from "node:path";

export function extractContentParts(content) {
  const out = { text: [], toolCalls: [], toolResults: [], reasoning: [] };
  if (typeof content === "string") {
    out.text.push(content);
    return out;
  }
  if (Array.isArray(content)) {
    for (const part of content) mergeContentPart(out, part);
    return out;
  }
  if (isObject(content)) mergeContentPart(out, content);
  return out;
}

export function timestampFromRecord(record) {
  const raw = record.timestamp ?? record.created_at ?? record.createdAt ?? record.message?.created_at ?? record.payload?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 10_000_000_000 ? raw : raw * 1000;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function sessionForInteraction(session, interaction) {
  const sessionId = stringFrom(interaction?.sessionId);
  return sessionId && sessionId !== session.id
    ? { ...session, id: sessionId }
    : session;
}

export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringFrom(value) {
  return typeof value === "string" && value ? value : undefined;
}

export function collapseHome(value, homeValue = resolve(homedir())) {
  if (!value) return undefined;
  const text = String(value);
  const home = String(homeValue).replace(/[\\/]+$/, "");
  const windowsStyle = isWindowsStylePath(home) || isWindowsStylePath(text);
  const normalizedHome = windowsStyle ? home.replace(/\\/g, "/") : home;
  const normalizedText = windowsStyle ? text.replace(/\\/g, "/") : text;
  const comparableHome = windowsStyle ? normalizedHome.toLowerCase() : normalizedHome;
  const comparableText = windowsStyle ? normalizedText.toLowerCase() : normalizedText;
  if (comparableText === comparableHome) return "~";
  if (comparableText.startsWith(`${comparableHome}/`)) {
    return `~/${normalizedText.slice(normalizedHome.length + 1)}`;
  }
  return text;
}

function mergeContentPart(out, part) {
  if (typeof part === "string") {
    out.text.push(part);
    return;
  }
  if (!isObject(part)) return;
  if (["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string") {
    out.text.push(part.text);
    return;
  }
  if (part.type === "tool_use" || part.type === "function_call") {
    out.toolCalls.push(part);
    return;
  }
  if (part.type === "tool_result" || part.type === "function_call_output") {
    out.toolResults.push(part);
    return;
  }
  if (part.type === "thinking" || part.type === "reasoning") {
    out.reasoning.push(part);
    return;
  }
  if (typeof part.text === "string") out.text.push(part.text);
}

function isWindowsStylePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
