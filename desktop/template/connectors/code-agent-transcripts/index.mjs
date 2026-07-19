import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS = {
  "include-codex": true,
  "include-claude": true,
  "include-reasoning": false,
  "codex-root": "~/.codex/sessions",
  "claude-root": "~/.claude/projects",
  "lookback-days": 30,
  "max-inline-bytes": 8192,
};

const INTERNAL = {
  stateVersion: 1,
  watchIntervalMs: 30_000,
  eventBatchSize: 100,
};

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const FULL_BLOB_TEXT = Symbol("fullBlobText");

export default {
  async run(context) {
    await syncOnce(context);
    while (!context.signal.aborted) {
      await waitForNextRun(INTERNAL.watchIntervalMs, context.signal);
      if (!context.signal.aborted) await syncOnce(context);
    }
  },
};

export async function syncOnce(context, deps = {}) {
  const config = normalizeConfig(context.config);
  const previous = normalizeState(await context.state.get());
  const next = {
    version: INTERNAL.stateVersion,
    files: { ...previous.files },
  };
  const nowMs = readNowMs(deps.now);

  for (const source of transcriptSources(config)) {
    if (isAborted(context.signal)) break;
    const files = await listTranscriptFiles(source.root, {
      provider: source.provider,
      nowMs,
      lookbackDays: config["lookback-days"],
      knownPaths: knownTranscriptPaths(next.files, source.provider),
      readdirImpl: deps.readdirImpl,
      statImpl: deps.statImpl,
    });

    for (const file of files) {
      if (isAborted(context.signal)) break;
      const key = stateKey(source.provider, file.path);
      const cursor = normalizeFileCursor(next.files[key]);
      if (isFileCursorCurrent(cursor, file)) continue;

      const result = await syncTranscriptFile({
        provider: source.provider,
        root: source.root,
        file,
        cursor,
        config,
        signal: context.signal,
        readLinesImpl: deps.readLinesImpl,
      });
      await writeBatch(context.guard, result.events);
      next.files[key] = result.cursor;
      await context.state.set(next);
    }
  }

  await context.state.set(next);
}

export async function syncTranscriptFile(opts) {
  const resetCursor = opts.file.size < opts.cursor.size || opts.cursor.byteOffset > opts.file.size;
  const startOffset = resetCursor ? 0 : opts.cursor.byteOffset;
  const startLineCount = startOffset > 0 ? opts.cursor.lineCount : 0;
  const savedSession = startOffset > 0 ? opts.cursor.session : {};
  const session = {
    id: stringFrom(savedSession?.id),
    cwd: stringFrom(savedSession?.cwd),
    projectPath: stringFrom(savedSession?.projectPath),
    model: stringFrom(savedSession?.model),
    title: stringFrom(savedSession?.title),
    titleKind: stringFrom(savedSession?.titleKind),
    sourceFile: collapseHome(opts.file.path),
    sourceRoot: collapseHome(opts.root),
    fileKey: fileKey(opts.provider, opts.file.path),
  };
  const scan = {
    activeInteractionId: resetCursor ? undefined : stringFrom(opts.cursor.activeInteractionId),
    openInteractions: resetCursor ? {} : normalizeOpenInteractions(opts.cursor.openInteractions),
    closedInteractions: [],
    events: [],
  };
  let lineIndex = startLineCount;
  let byteOffset = startOffset;

  for await (const item of readJsonLines(opts.file.path, {
    startOffset,
    readLinesImpl: opts.readLinesImpl,
  })) {
    throwIfAborted(opts.signal);
    if (!item.complete) break;
    const nextLineIndex = lineIndex + 1;
    let record;
    try {
      record = JSON.parse(item.line);
    } catch {
      lineIndex = nextLineIndex;
      byteOffset = item.nextOffset ?? byteOffset;
      continue;
    }

    lineIndex = nextLineIndex;
    updateSessionContext(session, opts.provider, record);
    const recordContext = {
      recordStartOffset: item.startOffset ?? byteOffset,
      recordEndOffset: item.nextOffset ?? opts.file.size,
      lineIndex,
    };
    if (opts.provider === "codex") {
      scanCodexRecord(record, recordContext, scan, session, opts.config);
    } else if (opts.provider === "claude") {
      scanClaudeRecord(record, recordContext, scan, session, opts.config);
    }
    byteOffset = item.nextOffset ?? opts.file.size;
  }

  for (const closed of scan.closedInteractions) {
    throwIfAborted(opts.signal);
    scan.events.push(await buildAgentTurnEvent({
      provider: opts.provider,
      path: opts.file.path,
      session,
      closed,
      config: opts.config,
      signal: opts.signal,
      readLinesImpl: opts.readLinesImpl,
    }));
  }
  throwIfAborted(opts.signal);

  return {
    events: scan.events,
    cursor: {
      lineCount: lineIndex,
      byteOffset,
      path: collapseHome(opts.file.path),
      size: opts.file.size,
      mtimeMs: opts.file.mtimeMs,
      lastSyncedAt: Date.now(),
      session: compactObject({
        id: session.id,
        cwd: session.cwd,
        projectPath: session.projectPath,
        model: session.model,
        title: session.title,
        titleKind: session.titleKind,
      }),
      openInteractions: scan.openInteractions,
      activeInteractionId: scan.activeInteractionId,
    },
  };
}

function scanCodexRecord(record, ctx, scan, session, config) {
  const payload = isObject(record.payload) ? record.payload : {};
  if (record.type !== "event_msg") return;

  if (payload.type === "task_started" && typeof payload.turn_id === "string") {
    const turnId = payload.turn_id;
    scan.openInteractions[turnId] = {
      providerInteractionId: turnId,
      startOffset: ctx.recordStartOffset,
      startLineIndex: ctx.lineIndex,
      startedAt: timestampFromRecord(record),
    };
    scan.activeInteractionId = turnId;
    return;
  }

  if (payload.type === "user_message") {
    const rawId = stringFrom(payload.client_id) ?? `line-${ctx.lineIndex}`;
    const providerInteractionId = scan.activeInteractionId ?? rawId;
    scan.events.push(buildHumanMessageEvent({
      provider: "codex",
      providerInteractionId,
      rawId,
      text: typeof payload.message === "string" ? payload.message : "",
      record,
      lineIndex: ctx.lineIndex,
      session,
      config,
      ids: compactObject({
        sessionId: session.id,
        turnId: scan.activeInteractionId,
        clientId: stringFrom(payload.client_id),
      }),
    }));
    return;
  }

  if ((payload.type === "task_complete" || payload.type === "turn_aborted") && typeof payload.turn_id === "string") {
    const turnId = payload.turn_id;
    const open = scan.openInteractions[turnId] ?? {
      providerInteractionId: turnId,
      startOffset: ctx.recordStartOffset,
      startLineIndex: ctx.lineIndex,
      startedAt: timestampFromRecord(record),
    };
    scan.closedInteractions.push({
      ...open,
      endOffset: ctx.recordEndOffset,
      endLineIndex: ctx.lineIndex,
      endedAt: timestampFromRecord(record),
      status: payload.type === "task_complete" ? "completed" : "interrupted",
    });
    delete scan.openInteractions[turnId];
    if (scan.activeInteractionId === turnId) scan.activeInteractionId = undefined;
  }
}

function scanClaudeRecord(record, ctx, scan, session, config) {
  if (isClaudeHumanRecord(record)) {
    const rawId = stringFrom(record.uuid) ?? `line-${ctx.lineIndex}`;
    const providerInteractionId = stringFrom(record.promptId) ?? rawId;
    const activeIsSteeredInteraction = scan.activeInteractionId === providerInteractionId
      && Boolean(scan.openInteractions[providerInteractionId]);

    if (!activeIsSteeredInteraction && scan.activeInteractionId && scan.openInteractions[scan.activeInteractionId]) {
      const open = scan.openInteractions[scan.activeInteractionId];
      scan.closedInteractions.push({
        ...open,
        endOffset: ctx.recordStartOffset,
        endLineIndex: Math.max(open.startLineIndex, ctx.lineIndex - 1),
        endedAt: timestampFromRecord(record),
        status: "interrupted",
      });
      delete scan.openInteractions[scan.activeInteractionId];
    }

    if (!activeIsSteeredInteraction) {
      scan.openInteractions[providerInteractionId] = {
        providerInteractionId,
        startOffset: ctx.recordStartOffset,
        startLineIndex: ctx.lineIndex,
        startedAt: timestampFromRecord(record),
      };
    }
    scan.activeInteractionId = providerInteractionId;
    scan.events.push(buildHumanMessageEvent({
      provider: "claude-code",
      providerInteractionId,
      rawId,
      text: extractContentParts(record.message?.content).text.join("\n\n"),
      record,
      lineIndex: ctx.lineIndex,
      session,
      config,
      ids: compactObject({
        sessionId: session.id,
        promptId: stringFrom(record.promptId),
        messageId: stringFrom(record.uuid),
      }),
    }));
    return;
  }

  if (record.type !== "assistant" || !scan.activeInteractionId) return;
  const message = isObject(record.message) ? record.message : {};
  const finalText = extractContentParts(message.content).text.join("\n\n");
  const completed = message.stop_reason === "end_turn" && Boolean(finalText);
  const failed = message.stop_reason === "stop_sequence" && Boolean(finalText);
  if (!completed && !failed) return;

  const open = scan.openInteractions[scan.activeInteractionId];
  if (!open) return;
  scan.closedInteractions.push({
    ...open,
    endOffset: ctx.recordEndOffset,
    endLineIndex: ctx.lineIndex,
    endedAt: timestampFromRecord(record),
    status: completed ? "completed" : "failed",
  });
  delete scan.openInteractions[scan.activeInteractionId];
  scan.activeInteractionId = undefined;
}

function buildHumanMessageEvent(input) {
  const conversationKeyValue = conversationKey(input.provider, input.session);
  const interactionId = interactionKey(input.provider, input.session, input.providerInteractionId);
  const wrapper = {
    sourceLineIndex: input.lineIndex,
    record: redactValue(input.record),
  };
  return {
    type: "code_agent.human_message",
    externalId: `human:${input.provider}:${shortHash(conversationKeyValue)}:${input.rawId}`,
    startedAt: timestampFromRecord(input.record),
    payload: {
      provider: input.provider,
      conversationKey: conversationKeyValue,
      interactionId,
      content: contentPayload(input.text, input.config),
      raw: rawPayload({
        provider: input.provider,
        records: [wrapper],
        ids: input.ids,
        maxInlineBytes: input.config["max-inline-bytes"],
        forceBlob: false,
      }),
    },
  };
}

async function buildAgentTurnEvent(input) {
  const records = [];
  let lineIndex = input.closed.startLineIndex - 1;
  let finalText;
  let firstAgentAt;
  let lifecycleStartedAt;

  for await (const item of readJsonLines(input.path, {
    startOffset: input.closed.startOffset,
    endOffset: input.closed.endOffset,
    readLinesImpl: input.readLinesImpl,
  })) {
    throwIfAborted(input.signal);
    if (!item.complete) break;
    lineIndex += 1;
    let record;
    try {
      record = JSON.parse(item.line);
    } catch {
      continue;
    }

    const selected = input.provider === "codex"
      ? selectedCodexRecord(record, input.closed.providerInteractionId, input.config["include-reasoning"])
      : selectedClaudeRecord(record, input.config["include-reasoning"]);
    if (!selected) continue;

    const timestamp = timestampFromRecord(record);
    if (input.provider === "codex" && record.type === "event_msg" && record.payload?.type === "task_started") {
      lifecycleStartedAt = timestamp;
    } else {
      firstAgentAt ??= timestamp;
    }
    records.push({ sourceLineIndex: lineIndex, record: selected });

    if (input.provider === "codex") {
      const payload = isObject(record.payload) ? record.payload : {};
      if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer") {
        finalText = extractContentParts(payload.content).text.join("\n\n") || finalText;
      }
      if (record.type === "event_msg" && payload.type === "task_complete" && !finalText) {
        finalText = stringFrom(payload.last_agent_message) ?? finalText;
      }
    } else if (record.type === "assistant" && ["end_turn", "stop_sequence"].includes(record.message?.stop_reason)) {
      finalText = extractContentParts(record.message?.content).text.join("\n\n") || finalText;
    }
  }
  throwIfAborted(input.signal);

  const providerName = logicalProvider(input.provider);
  const conversationKeyValue = conversationKey(providerName, input.session);
  const providerInteractionId = input.closed.providerInteractionId;
  const ids = input.provider === "codex"
    ? compactObject({ sessionId: input.session.id, turnId: providerInteractionId })
    : compactObject({ sessionId: input.session.id, promptId: providerInteractionId });

  return compactObject({
    type: "code_agent.agent_turn",
    externalId: `agent:${providerName}:${shortHash(conversationKeyValue)}:${providerInteractionId}`,
    startedAt: firstAgentAt ?? lifecycleStartedAt ?? input.closed.startedAt,
    endedAt: input.closed.endedAt,
    payload: compactObject({
      provider: providerName,
      conversationKey: conversationKeyValue,
      interactionId: interactionKey(providerName, input.session, providerInteractionId),
      status: input.closed.status,
      content: finalText ? contentPayload(finalText, input.config) : undefined,
      raw: rawPayload({
        provider: providerName,
        records,
        ids,
        maxInlineBytes: input.config["max-inline-bytes"],
        forceBlob: true,
      }),
    }),
  });
}

function selectedCodexRecord(record, turnId, includeReasoning) {
  const payload = isObject(record.payload) ? record.payload : {};
  if (record.type === "event_msg") {
    if (!["task_started", "task_complete", "turn_aborted"].includes(payload.type)) return undefined;
    if (typeof payload.turn_id === "string" && payload.turn_id !== turnId) return undefined;
    return redactValue(record);
  }
  if (record.type !== "response_item") return undefined;
  const recordTurnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
  if (typeof recordTurnId === "string" && recordTurnId !== turnId) return undefined;
  if (payload.type === "message" && payload.role === "assistant") return redactValue(record);
  if (["function_call", "custom_tool_call", "web_search_call", "function_call_output", "custom_tool_call_output", "agent_message"].includes(payload.type)) {
    return redactValue(record);
  }
  if (payload.type === "reasoning" && includeReasoning) return redactValue(record);
  return undefined;
}

function selectedClaudeRecord(record, includeReasoning) {
  if (record.type === "assistant") {
    const selected = redactValue(record);
    const message = isObject(selected.message) ? selected.message : undefined;
    if (!message || !Array.isArray(message.content) || includeReasoning) return selected;
    message.content = message.content.filter((part) => !isReasoningPart(part));
    if (!message.content.length) return undefined;
    return selected;
  }
  if (record.type === "user" && extractContentParts(record.message?.content).toolResults.length) {
    return redactValue(record);
  }
  return undefined;
}

function isClaudeHumanRecord(record) {
  if (record.type !== "user" || record.isSidechain === true || record.isMeta === true) return false;
  if (record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return false;
  if (record.origin?.kind && record.origin.kind !== "human") return false;
  return extractContentParts(record.message?.content).toolResults.length === 0;
}

function isReasoningPart(part) {
  return isObject(part) && (part.type === "thinking" || part.type === "reasoning");
}

function contentPayload(text, config) {
  const redacted = redactString(typeof text === "string" ? text : "");
  const fullBytes = Buffer.byteLength(redacted);
  const maxInlineBytes = Math.max(0, config["max-inline-bytes"]);
  const truncated = fullBytes > maxInlineBytes;
  const payload = {
    text: truncated ? utf8Prefix(redacted, maxInlineBytes) : redacted,
    chars: redacted.length,
    bytes: fullBytes,
    hash: `sha256:${sha256(redacted)}`,
    truncated,
  };
  if (truncated) attachFullBlobText(payload, redacted);
  return payload;
}

function rawPayload(input) {
  const text = input.records.map((record) => JSON.stringify(record)).join("\n") + (input.records.length ? "\n" : "");
  const bytes = Buffer.byteLength(text);
  const inline = !input.forceBlob && bytes <= input.maxInlineBytes;
  const payload = compactObject({
    format: `${input.provider}-${inline ? "records" : "jsonl"}`,
    recordCount: input.records.length,
    firstSourceLineIndex: input.records[0]?.sourceLineIndex,
    lastSourceLineIndex: input.records.at(-1)?.sourceLineIndex,
    bytes,
    hash: `sha256:${sha256(text)}`,
    ids: input.ids,
    records: inline ? input.records : undefined,
  });
  if (!inline) attachFullBlobText(payload, text);
  return payload;
}

function attachFullBlobText(payload, text) {
  Object.defineProperty(payload, FULL_BLOB_TEXT, {
    value: text,
    enumerable: false,
  });
}

async function writeBatch(guard, events) {
  for (let start = 0; start < events.length; start += INTERNAL.eventBatchSize) {
    const batch = events.slice(start, start + INTERNAL.eventBatchSize);
    await materializeBlobs(guard, batch);
    if (typeof guard.writeEvents === "function") {
      await guard.writeEvents(batch);
    } else {
      for (const event of batch) await guard.writeEvent(event);
    }
  }
}

async function materializeBlobs(guard, events) {
  const pendingByText = new Map();
  for (const event of events) {
    const payload = isObject(event.payload) ? event.payload : {};
    for (const target of [payload.content, payload.raw]) {
      if (!isObject(target) || target.contentRef) continue;
      const text = target[FULL_BLOB_TEXT];
      if (typeof text !== "string") continue;
      if (typeof guard.writeTextBlob !== "function") {
        throw new Error("code-agent-transcripts requires guard.writeTextBlob for oversized content and agent raw trajectories");
      }
      let pending = pendingByText.get(text);
      if (!pending) {
        pending = guard.writeTextBlob({
          text,
          variant: "redacted-text",
          mediaType: "text/plain; charset=utf-8",
        });
        pendingByText.set(text, pending);
      }
      const result = await pending;
      if (!isObject(result?.ref)) throw new Error("writeTextBlob returned no contentRef");
      target.contentRef = result.ref;
    }
  }
}

function extractContentParts(content) {
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

function updateSessionContext(session, provider, record) {
  if (!isObject(record)) return;
  const payload = isObject(record.payload) ? record.payload : undefined;
  if (provider === "codex") {
    if (record.type === "session_meta" && payload) {
      if (typeof payload.id === "string") session.id = payload.id;
      if (typeof payload.cwd === "string") session.cwd = collapseHome(payload.cwd);
      if (typeof payload.model === "string") session.model = payload.model;
    }
    if (record.type === "turn_context" && payload) {
      if (typeof payload.cwd === "string") session.cwd = collapseHome(payload.cwd);
      if (typeof payload.model === "string") session.model = payload.model;
    }
    return;
  }

  if (typeof record.sessionId === "string") session.id = record.sessionId;
  if (typeof record.cwd === "string") session.cwd = collapseHome(record.cwd);
  if (typeof record.projectPath === "string") session.projectPath = collapseHome(record.projectPath);
  if (record.type === "ai-title" && typeof record.aiTitle === "string") {
    session.title = record.aiTitle;
    session.titleKind = "ai";
  }
  if (record.type === "custom-title" && typeof record.customTitle === "string") {
    session.title = record.customTitle;
    session.titleKind = "custom";
  }
  if (typeof record.message?.model === "string") session.model = record.message.model;
}

async function listTranscriptFiles(root, opts) {
  const statImpl = opts.statImpl ?? stat;
  const readdirImpl = opts.readdirImpl ?? readdir;
  const byPath = new Map();
  let rootStat;
  try {
    rootStat = await statImpl(root);
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
  if (!rootStat.isDirectory()) return [];

  const cutoff = opts.lookbackDays <= 0 ? 0 : opts.nowMs - opts.lookbackDays * 24 * 60 * 60 * 1000;
  for (const path of opts.knownPaths ?? []) {
    if (!isPathInside(root, path) || !path.endsWith(".jsonl")) continue;
    try {
      const info = await statImpl(path);
      if (info.isFile()) byPath.set(path, { path, size: info.size, mtimeMs: info.mtimeMs });
    } catch (err) {
      if (!isNotFoundError(err) && !isPermissionError(err)) throw err;
    }
  }
  for (const dir of transcriptSearchDirs(root, opts)) await walk(dir);
  return Array.from(byPath.values())
    .filter((file) => file.mtimeMs >= cutoff)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));

  async function walk(dir) {
    let entries;
    try {
      entries = await readdirImpl(dir, { withFileTypes: true });
    } catch (err) {
      if (isNotFoundError(err) || isPermissionError(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = await statImpl(path);
        byPath.set(path, { path, size: info.size, mtimeMs: info.mtimeMs });
      } catch (err) {
        if (!isNotFoundError(err) && !isPermissionError(err)) throw err;
      }
    }
  }
}

function transcriptSearchDirs(root, opts) {
  if (opts.provider !== "codex" || opts.lookbackDays <= 0) return [root];
  const dayMs = 24 * 60 * 60 * 1000;
  const start = startOfUtcDay(opts.nowMs - opts.lookbackDays * dayMs - dayMs);
  const end = startOfUtcDay(opts.nowMs + dayMs);
  const dirs = [];
  for (let value = start; value <= end; value += dayMs) {
    const date = new Date(value);
    dirs.push(join(root, String(date.getUTCFullYear()), pad2(date.getUTCMonth() + 1), pad2(date.getUTCDate())));
  }
  return dirs;
}

async function* readJsonLines(path, opts = {}) {
  const startOffset = opts.startOffset ?? 0;
  if (opts.readLinesImpl) {
    let offset = startOffset;
    for await (const value of opts.readLinesImpl(path, startOffset)) {
      if (opts.endOffset !== undefined && offset >= opts.endOffset) break;
      if (typeof value !== "string" || !value.trim()) continue;
      const nextOffset = offset + Buffer.byteLength(value) + 1;
      yield { line: value, complete: true, startOffset: offset, nextOffset };
      offset = nextOffset;
    }
    return;
  }

  if (opts.endOffset !== undefined && opts.endOffset <= startOffset) return;
  const stream = createReadStream(path, compactObject({
    start: startOffset,
    end: opts.endOffset !== undefined ? opts.endOffset - 1 : undefined,
  }));
  let buffer = Buffer.alloc(0);
  let bufferOffset = startOffset;
  for await (const chunk of stream) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let consumed = 0;
    let newlineIndex = buffer.indexOf(10, consumed);
    while (newlineIndex !== -1) {
      const rawLine = stripTrailingCarriageReturn(buffer.subarray(consumed, newlineIndex));
      const lineStartOffset = bufferOffset + consumed;
      const nextOffset = bufferOffset + newlineIndex + 1;
      const line = rawLine.toString("utf8");
      if (line.trim()) yield { line, complete: true, startOffset: lineStartOffset, nextOffset };
      consumed = newlineIndex + 1;
      newlineIndex = buffer.indexOf(10, consumed);
    }
    if (consumed > 0) {
      buffer = buffer.subarray(consumed);
      bufferOffset += consumed;
    }
  }
  if (buffer.length) {
    const line = stripTrailingCarriageReturn(buffer).toString("utf8");
    if (line.trim()) {
      yield {
        line,
        complete: opts.endOffset !== undefined,
        startOffset: bufferOffset,
        nextOffset: bufferOffset + buffer.length,
      };
    }
  }
}

function normalizeConfig(input) {
  const value = isObject(input) ? input : {};
  const legacyInlineLimit = value["max-content-chars"];
  return {
    "include-codex": typeof value["include-codex"] === "boolean" ? value["include-codex"] : DEFAULTS["include-codex"],
    "include-claude": typeof value["include-claude"] === "boolean" ? value["include-claude"] : DEFAULTS["include-claude"],
    "include-reasoning": typeof value["include-reasoning"] === "boolean" ? value["include-reasoning"] : DEFAULTS["include-reasoning"],
    "codex-root": readString(value["codex-root"], DEFAULTS["codex-root"]),
    "claude-root": readString(value["claude-root"], DEFAULTS["claude-root"]),
    "lookback-days": integerInRange(value["lookback-days"], 0, 3650, DEFAULTS["lookback-days"]),
    "max-inline-bytes": integerInRange(value["max-inline-bytes"] ?? legacyInlineLimit, 0, 100_000, DEFAULTS["max-inline-bytes"]),
  };
}

function normalizeState(value) {
  if (!isObject(value) || value.version !== INTERNAL.stateVersion) {
    return { version: INTERNAL.stateVersion, files: {} };
  }
  return {
    version: INTERNAL.stateVersion,
    files: isObject(value.files) ? value.files : {},
  };
}

function normalizeFileCursor(value) {
  if (!isObject(value)) {
    return { lineCount: 0, byteOffset: 0, size: 0, mtimeMs: 0, session: {}, openInteractions: {} };
  }
  return {
    lineCount: integerInRange(value.lineCount, 0, Number.MAX_SAFE_INTEGER, 0),
    byteOffset: integerInRange(value.byteOffset, 0, Number.MAX_SAFE_INTEGER, 0),
    path: stringFrom(value.path),
    size: integerInRange(value.size, 0, Number.MAX_SAFE_INTEGER, 0),
    mtimeMs: typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs) ? value.mtimeMs : 0,
    session: isObject(value.session) ? value.session : {},
    openInteractions: normalizeOpenInteractions(value.openInteractions),
    activeInteractionId: stringFrom(value.activeInteractionId),
  };
}

function normalizeOpenInteractions(value) {
  if (!isObject(value)) return {};
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isObject(child)) continue;
    const providerInteractionId = stringFrom(child.providerInteractionId) ?? key;
    normalized[key] = {
      providerInteractionId,
      startOffset: integerInRange(child.startOffset, 0, Number.MAX_SAFE_INTEGER, 0),
      startLineIndex: integerInRange(child.startLineIndex, 1, Number.MAX_SAFE_INTEGER, 1),
      startedAt: typeof child.startedAt === "number" && Number.isFinite(child.startedAt) ? child.startedAt : Date.now(),
    };
  }
  return normalized;
}

function transcriptSources(config) {
  const sources = [];
  if (config["include-codex"]) sources.push({ provider: "codex", root: expandPath(config["codex-root"]) });
  if (config["include-claude"]) sources.push({ provider: "claude", root: expandPath(config["claude-root"]) });
  return sources;
}

function knownTranscriptPaths(files, provider) {
  const prefix = `${provider}:`;
  const paths = [];
  for (const [key, value] of Object.entries(files)) {
    if (!key.startsWith(prefix)) continue;
    const path = isObject(value) ? stringFrom(value.path) : undefined;
    paths.push(expandPath(path ?? key.slice(prefix.length)));
  }
  return paths;
}

function logicalProvider(provider) {
  return provider === "claude" ? "claude-code" : provider;
}

function conversationKey(provider, session) {
  return `${provider}:${session.sourceFile ?? session.fileKey ?? session.id ?? "unknown"}`;
}

function interactionKey(provider, session, providerInteractionId) {
  return `${provider}:${session.id ?? shortHash(session.fileKey)}:${providerInteractionId}`;
}

function fileKey(provider, path) {
  return `${provider}:${collapseHome(path)}`;
}

function stateKey(provider, path) {
  return fileKey(provider, path);
}

function isFileCursorCurrent(cursor, file) {
  return cursor.size === file.size && cursor.mtimeMs === file.mtimeMs && cursor.byteOffset >= file.size;
}

function timestampFromRecord(record) {
  const raw = record.timestamp ?? record.created_at ?? record.createdAt ?? record.message?.created_at ?? record.payload?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 10_000_000_000 ? raw : raw * 1000;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function redactValue(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  return value;
}

function redactString(value) {
  let output = value;
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{24,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    /\b(?:[A-Fa-f0-9]{40,}|[A-Za-z0-9+/=_-]{48,})\b/g,
  ];
  for (const pattern of patterns) output = output.replace(pattern, "[REDACTED_SECRET]");
  return output;
}

function utf8Prefix(value, maxBytes) {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    output += character;
    bytes += next;
  }
  return output;
}

function startOfUtcDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function stripTrailingCarriageReturn(buffer) {
  return buffer.length && buffer[buffer.length - 1] === 13 ? buffer.subarray(0, -1) : buffer;
}

function isPathInside(root, path) {
  const child = resolve(path);
  const parent = resolve(root);
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function expandPath(value) {
  const text = value.replace(/^~(?=$|\/|\\)/, homedir());
  return isAbsolute(text) ? resolve(text) : resolve(PACKAGE_DIR, text);
}

function collapseHome(value) {
  if (!value) return undefined;
  const home = resolve(homedir());
  const text = String(value);
  if (text === home) return "~";
  if (text.startsWith(`${home}/`)) return `~/${text.slice(home.length + 1)}`;
  return text;
}

function readNowMs(now) {
  if (typeof now === "function") return Number(now());
  if (Number.isFinite(now)) return Number(now);
  return Date.now();
}

function waitForNextRun(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let timeout;
    const done = () => {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolvePromise();
    };
    timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function integerInRange(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function readString(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringFrom(value) {
  return typeof value === "string" && value ? value : undefined;
}

function shortHash(value) {
  return sha256(value).slice(0, 16);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAborted(signal) {
  return signal?.aborted === true;
}

function throwIfAborted(signal) {
  if (!isAborted(signal)) return;
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  throw err;
}

function isNotFoundError(err) {
  return Boolean(err) && typeof err === "object" && err.code === "ENOENT";
}

function isPermissionError(err) {
  return Boolean(err) && typeof err === "object" && (err.code === "EACCES" || err.code === "EPERM");
}
