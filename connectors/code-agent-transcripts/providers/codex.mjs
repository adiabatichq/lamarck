import {
  collapseHome,
  compactObject,
  extractContentParts,
  isObject,
  sessionForInteraction,
  stringFrom,
  timestampFromRecord,
} from "../common.mjs";
import {
  attachFullBlobText,
  buildHumanMessageEvent,
  fallbackRecordId,
  sha256,
} from "../d0.mjs";
import { redactValue } from "../redaction.mjs";

const TURN_BUNDLE_FORMAT = "codex-turn-bundle-v1";

export const codexAdapter = {
  logicalProvider: "codex",
  transcriptScope(session) {
    if (!stringFrom(session?.canonicalSessionId) && !stringFrom(session?.id)) return undefined;
    return isCodexNonRootSession(session) ? "optional" : "root";
  },
  shouldSkipTranscript() {
    return false;
  },
  updateSession: updateCodexSessionContext,
  scanRecord: scanCodexRecord,
  selectAgentRecord(record, closed, config) {
    return selectedCodexRecord(
      record,
      closed.providerInteractionId,
      config["include-reasoning"],
    );
  },
  projectAgentRecord: projectCodexRecord,
  agentRawIds(session, providerInteractionId) {
    return compactObject({
      sessionId: session.id,
      turnId: providerInteractionId,
    });
  },
  buildAgentRaw(input) {
    return codexTurnBundleRawPayload({
      session: input.session,
      closed: input.closed,
      rootRecords: input.records,
      ids: input.ids,
    });
  },
};

function scanCodexRecord(record, ctx, scan, session) {
  const payload = isObject(record.payload) ? record.payload : {};
  if (record.type !== "event_msg") return;

  if (payload.type === "task_started" && typeof payload.turn_id === "string") {
    const turnId = payload.turn_id;
    const replayed = isCodexReplayedTurn(session, turnId);
    scan.openInteractions[turnId] = {
      providerInteractionId: turnId,
      startOffset: ctx.recordStartOffset,
      startLineIndex: ctx.lineIndex,
      startedAt: replayed
        ? codexTurnStartedAt(payload, record)
        : timestampFromRecord(record),
      sessionId: sessionIdForTurn(session, turnId),
      replayed: replayed || undefined,
    };
    scan.activeInteractionId = turnId;
    return;
  }

  if (payload.type === "user_message") {
    if (isCodexNonRootSession(session)) return;
    const open = scan.activeInteractionId
      ? scan.openInteractions[scan.activeInteractionId]
      : undefined;
    const interactionSession = sessionForInteraction(session, open);
    const rawId = stringFrom(payload.client_id) ?? fallbackRecordId(interactionSession, ctx);
    const providerInteractionId = scan.activeInteractionId ?? rawId;
    scan.events.push(buildHumanMessageEvent({
      provider: "codex",
      providerInteractionId,
      rawId,
      text: typeof payload.message === "string" ? payload.message : "",
      record,
      startedAt: open?.replayed === true ? open.startedAt : undefined,
      lineIndex: ctx.lineIndex,
      session: interactionSession,
      ids: compactObject({
        sessionId: interactionSession.id,
        turnId: scan.activeInteractionId,
        clientId: stringFrom(payload.client_id),
      }),
    }));
    return;
  }

  if ((payload.type === "task_complete" || payload.type === "turn_aborted") && typeof payload.turn_id === "string") {
    const turnId = payload.turn_id;
    const existingOpen = scan.openInteractions[turnId];
    const replayed = existingOpen?.replayed === true || isCodexReplayedTurn(session, turnId);
    const startedAt = replayed
      ? timestampValue(payload.started_at)
        ?? existingOpen?.startedAt
        ?? codexIdTimestamp(turnId)
        ?? timestampFromRecord(record)
      : existingOpen?.startedAt ?? timestampFromRecord(record);
    const endedAt = replayed
      ? codexTurnEndedAt(payload, record, startedAt)
      : timestampFromRecord(record);
    const open = existingOpen ?? {
      providerInteractionId: turnId,
      startOffset: ctx.recordStartOffset,
      startLineIndex: ctx.lineIndex,
      sessionId: sessionIdForTurn(session, turnId),
    };
    scan.closedInteractions.push({
      ...open,
      startedAt,
      replayed: replayed || undefined,
      agentStartedAt: replayed
        ? codexReplayedAgentStartedAt(payload, startedAt, endedAt)
        : undefined,
      endOffset: ctx.recordEndOffset,
      endLineIndex: ctx.lineIndex,
      endedAt,
      model: session.model,
      status: payload.type === "turn_aborted"
        ? "interrupted"
        : payload.error === undefined || payload.error === null
          ? "completed"
          : "failed",
    });
    delete scan.openInteractions[turnId];
    if (scan.activeInteractionId === turnId) scan.activeInteractionId = undefined;
  }
}

function updateCodexSessionContext(session, record) {
  if (!isObject(record)) return;
  const payload = isObject(record.payload) ? record.payload : undefined;
  if (record.type === "session_meta" && payload) {
    const metadataSessionId = stringFrom(payload.id) ?? stringFrom(payload.session_id);
    if (metadataSessionId) session.id = metadataSessionId;
    if (typeof payload.cwd === "string") session.cwd = collapseHome(payload.cwd);
    if (typeof payload.model === "string") session.model = payload.model;
    if (session.canonicalMetadataSeen !== true) {
      session.canonicalMetadataSeen = true;
      session.canonicalSessionId = metadataSessionId;
      session.canonicalStartedAt = codexIdTimestamp(metadataSessionId)
        ?? timestampValue(payload.timestamp);
      if (typeof payload.thread_source === "string") {
        session.threadSource = payload.thread_source;
      }
      session.isSubagent = payload.thread_source === "subagent"
        || payload.thread_source === "memory_consolidation"
        || hasCodexNonRootSource(payload.source);
    }
  }
  if (record.type === "turn_context" && payload) {
    if (typeof payload.cwd === "string") session.cwd = collapseHome(payload.cwd);
    if (typeof payload.model === "string") session.model = payload.model;
  }
}

function isCodexNonRootSession(session) {
  return session?.isSubagent === true
    || session?.threadSource === "subagent"
    || session?.threadSource === "memory_consolidation";
}

function sessionIdForTurn(session, turnId) {
  const canonicalSessionId = stringFrom(session?.canonicalSessionId);
  const canonicalStartedAt = session?.canonicalStartedAt;
  const turnStartedAt = codexIdTimestamp(turnId);
  if (canonicalSessionId
    && Number.isFinite(canonicalStartedAt)
    && Number.isFinite(turnStartedAt)
    && turnStartedAt >= canonicalStartedAt) {
    return canonicalSessionId;
  }
  return stringFrom(session?.id) ?? canonicalSessionId;
}

function isCodexReplayedTurn(session, turnId) {
  const canonicalStartedAt = session?.canonicalStartedAt;
  const turnStartedAt = codexIdTimestamp(turnId);
  return Number.isFinite(canonicalStartedAt)
    && Number.isFinite(turnStartedAt)
    && turnStartedAt < canonicalStartedAt;
}

function codexTurnStartedAt(payload, record) {
  return timestampValue(payload?.started_at)
    ?? codexIdTimestamp(payload?.turn_id)
    ?? timestampFromRecord(record);
}

function codexTurnEndedAt(payload, record, startedAt) {
  const completedAt = timestampValue(payload?.completed_at);
  if (Number.isFinite(completedAt)) return completedAt;
  const durationMs = payload?.duration_ms;
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    return startedAt + durationMs;
  }
  return timestampFromRecord(record);
}

function codexReplayedAgentStartedAt(payload, startedAt, endedAt) {
  const timeToFirstTokenMs = payload?.time_to_first_token_ms;
  if (typeof timeToFirstTokenMs === "number"
    && Number.isFinite(timeToFirstTokenMs)
    && timeToFirstTokenMs >= 0) {
    const firstAgentAt = startedAt + timeToFirstTokenMs;
    if (firstAgentAt <= endedAt) return firstAgentAt;
  }
  return startedAt;
}

function codexIdTimestamp(value) {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return undefined;
  }
  const timestampHex = value.replaceAll("-", "").slice(0, 12);
  const timestamp = Number.parseInt(timestampHex, 16);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

function timestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function selectedCodexRecord(record, turnId, includeReasoning) {
  const payload = isObject(record.payload) ? record.payload : {};
  if (record.type === "event_msg") {
    if (!["task_started", "task_complete", "turn_aborted"].includes(payload.type)) return undefined;
    if (typeof payload.turn_id === "string" && payload.turn_id !== turnId) return undefined;
    return redactValue(record);
  }
  if (record.type === "inter_agent_communication") {
    const recordTurnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
    if (typeof recordTurnId === "string" && recordTurnId !== turnId) return undefined;
    return redactValue(record);
  }
  if (record.type !== "response_item") return undefined;
  const recordTurnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
  if (typeof recordTurnId === "string" && recordTurnId !== turnId) return undefined;
  if (payload.type === "message" && payload.role === "assistant") return redactValue(record);
  if (isSelectedCodexToolItemType(payload.type)) return redactValue(record);
  if (payload.type === "reasoning" && includeReasoning) return redactValue(record);
  return undefined;
}

function projectCodexRecord(record, projection) {
  const payload = isObject(record.payload) ? record.payload : {};
  const lifecycleType = record.type === "event_msg" ? payload.type : undefined;
  const timestamp = timestampFromRecord(record);
  if (lifecycleType === "task_started") {
    projection.lifecycleStartedAt = timestamp;
  } else if (lifecycleType !== "task_complete" && lifecycleType !== "turn_aborted") {
    projection.firstAgentAt ??= timestamp;
  }

  if (record.type === "response_item"
    && payload.type === "message"
    && payload.role === "assistant"
    && payload.phase === "final_answer") {
    projection.finalText = extractContentParts(payload.content).text.join("\n\n")
      || projection.finalText;
  }
  if (record.type === "event_msg" && payload.type === "task_complete" && !projection.finalText) {
    projection.finalText = stringFrom(payload.last_agent_message) ?? projection.finalText;
  }
}

async function codexTurnBundleRawPayload(input) {
  const root = trajectoryPayload({
    session: input.session,
    closed: input.closed,
    records: input.rootRecords,
  });
  const bundle = {
    version: 1,
    root,
    childTrajectories: [],
  };
  const text = JSON.stringify(bundle) + "\n";
  const bytes = Buffer.byteLength(text);
  const payload = {
    format: TURN_BUNDLE_FORMAT,
    recordCount: root.recordCount,
    rootFirstSourceLineIndex: root.firstSourceLineIndex,
    rootLastSourceLineIndex: root.lastSourceLineIndex,
    bytes,
    hash: `sha256:${sha256(text)}`,
    ids: input.ids,
  };
  attachFullBlobText(payload, text, "application/json");
  return payload;
}

function trajectoryPayload(input) {
  return compactObject({
    role: "main",
    sessionId: input.session.id,
    turnId: input.closed.providerInteractionId,
    sourceFile: input.session.sourceFile,
    model: input.closed.model,
    startedAt: input.closed.startedAt,
    endedAt: input.closed.endedAt,
    status: input.closed.status,
    recordCount: input.records.length,
    firstSourceLineIndex: input.records[0]?.sourceLineIndex,
    lastSourceLineIndex: input.records.at(-1)?.sourceLineIndex,
    records: input.records,
  });
}

function isSelectedCodexToolItemType(type) {
  return typeof type === "string"
    && (type.endsWith("_call")
      || type.endsWith("_call_output")
      || type === "tool_search_output"
      || type === "agent_message");
}

function hasCodexNonRootSource(source) {
  return isObject(source) && (source.subagent !== undefined || source.internal !== undefined);
}
