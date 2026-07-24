import {
  collapseHome,
  compactObject,
  extractContentParts,
  isObject,
  stringFrom,
  timestampFromRecord,
} from "../common.mjs";
import {
  buildHumanMessageEvent,
  fallbackRecordId,
  rawPayload,
} from "../d0.mjs";
import { redactValue } from "../redaction.mjs";

export const claudeAdapter = {
  logicalProvider: "claude-code",
  transcriptScope() {
    return "root";
  },
  shouldSkipTranscript: isClaudeSubagentTranscriptPath,
  updateSession: updateClaudeSessionContext,
  scanRecord: scanClaudeRecord,
  selectAgentRecord(record, _closed, config) {
    return selectedClaudeRecord(record, config["include-reasoning"]);
  },
  projectAgentRecord: projectClaudeRecord,
  agentRawIds(session, providerInteractionId) {
    return compactObject({
      sessionId: session.id,
      promptId: providerInteractionId,
    });
  },
  buildAgentRaw(input) {
    return rawPayload({
      provider: "claude-code",
      records: input.records,
      ids: input.ids,
      maxInlineBytes: input.config["max-inline-bytes"],
      forceBlob: true,
    });
  },
};

function scanClaudeRecord(record, ctx, scan, session, config) {
  if (isClaudeHumanRecord(record)) {
    const rawId = stringFrom(record.uuid) ?? fallbackRecordId(session, ctx);
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
        model: session.model,
        status: "interrupted",
      });
      delete scan.openInteractions[scan.activeInteractionId];
    }

    if (!activeIsSteeredInteraction) {
      scan.openInteractions[providerInteractionId] = {
        providerInteractionId,
        sessionId: session.id,
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

  if (record.type !== "assistant" || record.isSidechain === true || !scan.activeInteractionId) return;
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
    model: session.model,
    status: completed ? "completed" : "failed",
  });
  delete scan.openInteractions[scan.activeInteractionId];
  scan.activeInteractionId = undefined;
}

function updateClaudeSessionContext(session, record) {
  if (!isObject(record)) return;
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

function selectedClaudeRecord(record, includeReasoning) {
  if (record.isSidechain === true) return undefined;
  if (record.type === "assistant") {
    const selected = redactValue(record);
    const message = isObject(selected.message) ? selected.message : undefined;
    if (!message || !Array.isArray(message.content) || includeReasoning) return selected;
    message.content = message.content.filter((part) => !isReasoningPart(part));
    if (!message.content.length) return undefined;
    return selected;
  }
  if (record.type === "user" && extractContentParts(record.message?.content).toolResults.length) {
    return redactClaudeToolResultRecord(record);
  }
  return undefined;
}

function projectClaudeRecord(record, projection) {
  projection.firstAgentAt ??= timestampFromRecord(record);
  if (record.type === "assistant" && ["end_turn", "stop_sequence"].includes(record.message?.stop_reason)) {
    projection.finalText = extractContentParts(record.message?.content).text.join("\n\n")
      || projection.finalText;
  }
}

function isClaudeSubagentTranscriptPath(path) {
  return String(path).split(/[\\/]/).includes("subagents");
}

function redactClaudeToolResultRecord(record) {
  const selected = redactValue(record);
  const content = selected.message?.content;
  if (!Array.isArray(content)) return selected;
  for (const part of content) {
    if (!isObject(part) || part.type !== "tool_result") continue;
    part.content = redactValue(part.content, "result");
  }
  return selected;
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
