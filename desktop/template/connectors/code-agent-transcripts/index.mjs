import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collapseHome,
  compactObject,
  isObject,
  sessionForInteraction,
  stringFrom,
} from "./common.mjs";
import {
  contentPayload,
  conversationKey,
  interactionKey,
  shortHash,
  writeBatch,
} from "./d0.mjs";
import { readJsonLines } from "./jsonl.mjs";
import { codexAdapter } from "./providers/codex.mjs";
import { claudeAdapter } from "./providers/claude.mjs";

export { collapseHome } from "./common.mjs";

const DEFAULTS = {
  "include-codex": true,
  "include-claude": true,
  "include-reasoning": false,
  "codex-root": "~/.codex/sessions",
  "claude-root": "~/.claude/projects",
  "lookback-days": 30,
};

const INTERNAL = {
  stateVersion: 1,
  watchIntervalMs: 30_000,
  eventBatchSize: 100,
  watchWarningKey: "code-agent-transcripts-watch",
  fileWarningKey: "code-agent-transcripts-files",
  maxWarningFailures: 10,
  maxOperationalRetries: 3,
  codexDiscoveryDays: 90,
};

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const PROVIDER_ADAPTERS = {
  codex: codexAdapter,
  claude: claudeAdapter,
};

export default {
  async run(context) {
    await runWatch(context);
  },
};

export async function runWatch(context, deps = {}) {
  const waitImpl = deps.waitImpl ?? waitForNextRun;
  let syncFailureCount = 0;
  const criticalFileFailureCounts = new Map();
  while (!isAborted(context.signal)) {
    let terminalError;
    try {
      const result = await syncOnce(context, deps.syncOnceDeps);
      syncFailureCount = 0;
      const exhaustedFile = updateCriticalFileFailureCounts(
        criticalFileFailureCounts,
        result.criticalFileFailures,
      );
      if (exhaustedFile) {
        terminalError = new Error(
          `Code agent root transcript ${exhaustedFile.sourceFile} failed after ${INTERNAL.maxOperationalRetries} retries: ${exhaustedFile.error}`,
        );
      } else {
        await clearWarningSafely(context, INTERNAL.watchWarningKey);
      }
    } catch (err) {
      if (isAborted(context.signal)) return;
      syncFailureCount += 1;
      if (syncFailureCount > INTERNAL.maxOperationalRetries) {
        terminalError = new Error(
          `Code agent transcript sync failed after ${INTERNAL.maxOperationalRetries} retries: ${errorMessage(err)}`,
        );
      } else {
        await setWarningSafely(context, {
          key: INTERNAL.watchWarningKey,
          message: `Code agent transcript sync failed and will be retried up to ${INTERNAL.maxOperationalRetries} times.`,
          details: {
            error: errorMessage(err),
            failureCount: syncFailureCount,
            retriesRemaining: INTERNAL.maxOperationalRetries - syncFailureCount + 1,
          },
        });
      }
    }
    if (terminalError) {
      await clearWarningSafely(context, INTERNAL.watchWarningKey);
      await clearWarningSafely(context, INTERNAL.fileWarningKey);
      throw terminalError;
    }
    if (!isAborted(context.signal)) {
      await waitImpl(INTERNAL.watchIntervalMs, context.signal);
    }
  }
}

export async function syncOnce(context, deps = {}) {
  const config = normalizeConfig(context.config);
  const previous = normalizeState(await context.state.get());
  const next = {
    version: INTERNAL.stateVersion,
    files: { ...previous.files },
  };
  const nowMs = readNowMs(deps.now);
  const eventCutoffMs = lookbackCutoffMs(nowMs, config["lookback-days"]);
  let fileFailureCount = 0;
  const fileFailures = [];
  const criticalFileFailures = [];

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
      let failureScope = transcriptScopeFromCursor(source.provider, cursor);
      try {
        const resetCursor = shouldResetFileCursor(file, cursor);
        if (resetCursor) {
          failureScope = transcriptScopeFromCursor(
            source.provider,
            normalizeFileCursor(undefined),
          );
        }

        const result = await syncTranscriptFile({
          provider: source.provider,
          root: source.root,
          file,
          cursor,
          config,
          eventCutoffMs,
          signal: context.signal,
          readLinesImpl: deps.readLinesImpl,
          resetCursor,
          onTranscriptScope(scope) {
            failureScope = scope;
          },
        });
        failureScope = transcriptScopeFromCursor(source.provider, result.cursor);
        await writeBatch(context.guard, result.events, INTERNAL.eventBatchSize);
        next.files[key] = result.cursor;
      } catch (err) {
        throwIfAborted(context.signal);
        fileFailureCount += 1;
        const critical = failureScope === "root";
        const failure = {
          key,
          provider: source.provider,
          sourceFile: collapseHome(file.path),
          error: errorMessage(err),
          scope: critical ? "root" : "optional-or-unknown",
        };
        if (critical) criticalFileFailures.push(failure);
        if (fileFailures.length < INTERNAL.maxWarningFailures) {
          fileFailures.push(failure);
        }
        continue;
      }
      await context.state.set(next);
    }
  }

  await context.state.set(next);
  if (fileFailureCount > 0) {
    const fileLabel = `${fileFailureCount} code agent transcript file${fileFailureCount === 1 ? "" : "s"}`;
    await setWarningSafely(context, {
      key: INTERNAL.fileWarningKey,
      message: criticalFileFailures.length > 0
        ? `${fileLabel} could not be processed; confirmed root failures will be retried up to ${INTERNAL.maxOperationalRetries} times.`
        : `${fileLabel} could not be processed and will be retried.`,
      details: {
        failures: fileFailures,
        omitted: fileFailureCount - fileFailures.length,
      },
    });
  } else {
    await clearWarningSafely(context, INTERNAL.fileWarningKey);
  }
  return { criticalFileFailures };
}

export async function syncTranscriptFile(opts) {
  const adapter = providerAdapter(opts.provider);
  const resetCursor = opts.resetCursor ?? shouldResetFileCursor(opts.file, opts.cursor);
  const startOffset = resetCursor ? 0 : opts.cursor.byteOffset;
  const startLineCount = startOffset > 0 ? opts.cursor.lineCount : 0;
  const savedSession = startOffset > 0 ? opts.cursor.session : {};
  const session = createSessionContext(savedSession, opts.provider, opts.root, opts.file.path);
  const scan = {
    activeInteractionId: resetCursor ? undefined : stringFrom(opts.cursor.activeInteractionId),
    openInteractions: resetCursor ? {} : normalizeOpenInteractions(opts.cursor.openInteractions),
    closedInteractions: [],
    events: [],
  };
  let lineIndex = startLineCount;
  let byteOffset = startOffset;

  if (adapter.transcriptScope(session) === "optional") {
    opts.onTranscriptScope?.("optional");
    return transcriptFileResult(opts, session, {
      ...scan,
      activeInteractionId: undefined,
      openInteractions: {},
    }, lineIndex, opts.file.size);
  }

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
    adapter.updateSession(session, record);
    const transcriptScope = transcriptScopeFromSession(opts.provider, session);
    if (transcriptScope) opts.onTranscriptScope?.(transcriptScope);
    if (transcriptScope === "optional") {
      scan.activeInteractionId = undefined;
      scan.openInteractions = {};
      scan.closedInteractions = [];
      scan.events = [];
      byteOffset = opts.file.size;
      break;
    }
    const recordContext = {
      recordStartOffset: item.startOffset ?? byteOffset,
      recordEndOffset: item.nextOffset ?? opts.file.size,
      lineIndex,
      rawLine: item.line,
    };
    adapter.scanRecord(record, recordContext, scan, session, opts.config);
    byteOffset = item.nextOffset ?? opts.file.size;
  }

  for (const closed of scan.closedInteractions) {
    throwIfAborted(opts.signal);
    if (adapter.transcriptScope(session) === "optional") continue;
    if (!timestampWithinLookback(closed.endedAt, opts.eventCutoffMs)) continue;
    const interactionSession = sessionForInteraction(session, closed);
    scan.events.push(await buildAgentTurnEvent({
      adapter,
      path: opts.file.path,
      session: interactionSession,
      closed,
      config: opts.config,
      signal: opts.signal,
      readLinesImpl: opts.readLinesImpl,
    }));
  }
  throwIfAborted(opts.signal);
  scan.events = scan.events.filter((event) => eventWithinLookback(event, opts.eventCutoffMs));

  return transcriptFileResult(opts, session, scan, lineIndex, byteOffset);
}

function eventWithinLookback(event, cutoffMs) {
  const timestamp = event.type === "code_agent.agent_turn"
    ? event.endedAt
    : event.startedAt;
  return timestampWithinLookback(timestamp, cutoffMs);
}

function timestampWithinLookback(timestamp, cutoffMs) {
  return !(cutoffMs > 0)
    || (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= cutoffMs);
}

function transcriptFileResult(opts, session, scan, lineIndex, byteOffset) {
  return {
    events: scan.events,
    cursor: {
      lineCount: lineIndex,
      byteOffset,
      path: collapseHome(opts.file.path),
      size: opts.file.size,
      mtimeMs: opts.file.mtimeMs,
      fileIdentity: opts.file.fileIdentity,
      lastSyncedAt: Date.now(),
      session: compactObject({
        id: session.id,
        canonicalSessionId: session.canonicalSessionId,
        canonicalStartedAt: session.canonicalStartedAt,
        canonicalMetadataSeen: session.canonicalMetadataSeen,
        cwd: session.cwd,
        projectPath: session.projectPath,
        model: session.model,
        title: session.title,
        titleKind: session.titleKind,
        threadSource: session.threadSource,
        isSubagent: session.isSubagent,
      }),
      openInteractions: scan.openInteractions,
      activeInteractionId: scan.activeInteractionId,
    },
  };
}

async function buildAgentTurnEvent(input) {
  const records = [];
  const projection = {};
  let lineIndex = input.closed.startLineIndex - 1;

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

    const selected = input.adapter.selectAgentRecord(
      record,
      input.closed,
      input.config,
    );
    if (!selected) continue;

    input.adapter.projectAgentRecord(record, projection);
    records.push({ sourceLineIndex: lineIndex, record: selected });
  }
  throwIfAborted(input.signal);

  const providerName = input.adapter.logicalProvider;
  const conversationKeyValue = conversationKey(providerName, input.session);
  const providerInteractionId = input.closed.providerInteractionId;
  const ids = input.adapter.agentRawIds(input.session, providerInteractionId);
  const raw = await input.adapter.buildAgentRaw({
    session: input.session,
    closed: input.closed,
    records,
    ids,
    config: input.config,
  });

  return compactObject({
    type: "code_agent.agent_turn",
    externalId: `agent:${providerName}:${shortHash(conversationKeyValue)}:${providerInteractionId}`,
    startedAt: projection.firstAgentAt ?? projection.lifecycleStartedAt ?? input.closed.startedAt,
    endedAt: input.closed.endedAt,
    payload: compactObject({
      provider: providerName,
      conversationKey: conversationKeyValue,
      interactionId: interactionKey(providerName, input.session, providerInteractionId),
      status: input.closed.status,
      content: projection.finalText
        ? contentPayload(projection.finalText)
        : undefined,
      raw,
    }),
  });
}

function createSessionContext(saved, provider, root, path) {
  return {
    id: stringFrom(saved?.id),
    canonicalSessionId: stringFrom(saved?.canonicalSessionId),
    canonicalStartedAt: typeof saved?.canonicalStartedAt === "number"
      && Number.isFinite(saved.canonicalStartedAt)
      ? saved.canonicalStartedAt
      : undefined,
    canonicalMetadataSeen: saved?.canonicalMetadataSeen === true ? true : undefined,
    cwd: stringFrom(saved?.cwd),
    projectPath: stringFrom(saved?.projectPath),
    model: stringFrom(saved?.model),
    title: stringFrom(saved?.title),
    titleKind: stringFrom(saved?.titleKind),
    threadSource: stringFrom(saved?.threadSource),
    isSubagent: saved?.isSubagent === true,
    sourceFile: collapseHome(path),
    sourceRoot: collapseHome(root),
    fileKey: fileKey(provider, path),
  };
}

function transcriptScopeFromCursor(provider, cursor) {
  const session = isObject(cursor?.session) ? cursor.session : {};
  return transcriptScopeFromSession(provider, session);
}

function transcriptScopeFromSession(provider, session) {
  return providerAdapter(provider).transcriptScope(session);
}

function shouldResetFileCursor(file, cursor) {
  return file.size < cursor.size
    || cursor.byteOffset > file.size
    || Boolean(file.fileIdentity && cursor.fileIdentity && file.fileIdentity !== cursor.fileIdentity);
}

async function listTranscriptFiles(root, opts) {
  const adapter = providerAdapter(opts.provider);
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

  const cutoff = lookbackCutoffMs(opts.nowMs, opts.lookbackDays);
  for (const path of opts.knownPaths ?? []) {
    if (!isPathInside(root, path) || !path.endsWith(".jsonl")) continue;
    if (adapter.shouldSkipTranscript(path)) continue;
    try {
      const info = await statImpl(path);
      if (info.isFile()) byPath.set(path, transcriptFileFromStat(path, info));
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
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
      if (isNotFoundError(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (adapter.shouldSkipTranscript(path)) continue;
        if (!entry.name.startsWith(".")) await walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = await statImpl(path);
        byPath.set(path, transcriptFileFromStat(path, info));
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
  }
}

function lookbackCutoffMs(nowMs, lookbackDays) {
  return lookbackDays <= 0 ? 0 : nowMs - lookbackDays * 24 * 60 * 60 * 1000;
}

function transcriptFileFromStat(path, info) {
  return compactObject({
    path,
    size: info.size,
    mtimeMs: info.mtimeMs,
    fileIdentity: fileIdentityFromStat(info),
  });
}

function fileIdentityFromStat(info) {
  const device = fileIdentityPart(info?.dev);
  const inode = fileIdentityPart(info?.ino);
  return device !== undefined && inode !== undefined ? `${device}:${inode}` : undefined;
}

function fileIdentityPart(value) {
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return undefined;
}

function transcriptSearchDirs(root, opts) {
  if (opts.provider !== "codex" || opts.lookbackDays <= 0) return [root];
  const dayMs = 24 * 60 * 60 * 1000;
  const discoveryDays = Math.max(opts.lookbackDays, INTERNAL.codexDiscoveryDays);
  const start = startOfUtcDay(opts.nowMs - discoveryDays * dayMs - dayMs);
  const end = startOfUtcDay(opts.nowMs + dayMs);
  const dirs = [];
  for (let value = start; value <= end; value += dayMs) {
    const date = new Date(value);
    dirs.push(join(root, String(date.getUTCFullYear()), pad2(date.getUTCMonth() + 1), pad2(date.getUTCDate())));
  }
  return dirs;
}

function normalizeConfig(input) {
  const value = isObject(input) ? input : {};
  return {
    "include-codex": typeof value["include-codex"] === "boolean" ? value["include-codex"] : DEFAULTS["include-codex"],
    "include-claude": typeof value["include-claude"] === "boolean" ? value["include-claude"] : DEFAULTS["include-claude"],
    "include-reasoning": typeof value["include-reasoning"] === "boolean" ? value["include-reasoning"] : DEFAULTS["include-reasoning"],
    "codex-root": readString(value["codex-root"], DEFAULTS["codex-root"]),
    "claude-root": readString(value["claude-root"], DEFAULTS["claude-root"]),
    "lookback-days": integerInRange(value["lookback-days"], 0, 3650, DEFAULTS["lookback-days"]),
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
    fileIdentity: stringFrom(value.fileIdentity),
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
      sessionId: stringFrom(child.sessionId),
    };
  }
  return normalized;
}

function providerAdapter(provider) {
  const adapter = PROVIDER_ADAPTERS[provider];
  if (!adapter) throw new Error(`Unsupported code agent transcript provider: ${provider}`);
  return adapter;
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

function fileKey(provider, path) {
  return `${provider}:${collapseHome(path)}`;
}

function stateKey(provider, path) {
  return fileKey(provider, path);
}

function isFileCursorCurrent(cursor, file) {
  const sameIdentity = !cursor.fileIdentity
    || !file.fileIdentity
    || cursor.fileIdentity === file.fileIdentity;
  return sameIdentity
    && cursor.size === file.size
    && cursor.mtimeMs === file.mtimeMs
    && cursor.byteOffset >= file.size;
}

function startOfUtcDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function pad2(value) {
  return String(value).padStart(2, "0");
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

function isAborted(signal) {
  return signal?.aborted === true;
}

function throwIfAborted(signal) {
  if (!isAborted(signal)) return;
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  throw err;
}

function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function updateCriticalFileFailureCounts(counts, failures) {
  const current = new Map(failures.map((failure) => [failure.key, failure]));
  for (const key of counts.keys()) {
    if (!current.has(key)) counts.delete(key);
  }

  let exhausted;
  for (const [key, failure] of current) {
    const failureCount = (counts.get(key) ?? 0) + 1;
    counts.set(key, failureCount);
    if (!exhausted && failureCount > INTERNAL.maxOperationalRetries) {
      exhausted = failure;
    }
  }
  return exhausted;
}

async function setWarningSafely(context, warning) {
  try {
    await context.warnings?.set?.(warning);
  } catch {
    // Warning persistence must not stop transcript capture.
  }
}

async function clearWarningSafely(context, key) {
  try {
    await context.warnings?.clear?.(key);
  } catch {
    // Warning persistence must not stop transcript capture.
  }
}

function isNotFoundError(err) {
  return Boolean(err) && typeof err === "object" && err.code === "ENOENT";
}
