import { createHash } from "node:crypto";
import { compactObject, isObject, timestampFromRecord } from "./common.mjs";
import { redactString, redactValue } from "./redaction.mjs";

const FULL_BLOB_TEXT = Symbol("fullBlobText");
const FULL_BLOB_MEDIA_TYPE = Symbol("fullBlobMediaType");
export const MAX_INLINE_BYTES = 8192;

export function buildHumanMessageEvent(input) {
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
      content: contentPayload(input.text),
      raw: rawPayload({
        provider: input.provider,
        records: [wrapper],
        ids: input.ids,
        forceBlob: false,
      }),
    },
  };
}

export function contentPayload(text) {
  const redacted = redactString(typeof text === "string" ? text : "");
  const fullBytes = Buffer.byteLength(redacted);
  const truncated = fullBytes > MAX_INLINE_BYTES;
  const payload = {
    text: truncated ? utf8Prefix(redacted, MAX_INLINE_BYTES) : redacted,
    chars: redacted.length,
    bytes: fullBytes,
    hash: `sha256:${sha256(redacted)}`,
    truncated,
  };
  if (truncated) attachFullBlobText(payload, redacted);
  return payload;
}

export function rawPayload(input) {
  const text = input.records.map((record) => JSON.stringify(record)).join("\n") + (input.records.length ? "\n" : "");
  const bytes = Buffer.byteLength(text);
  const inline = !input.forceBlob && bytes <= MAX_INLINE_BYTES;
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

export function attachFullBlobText(payload, text, mediaType = "text/plain; charset=utf-8") {
  Object.defineProperty(payload, FULL_BLOB_TEXT, {
    value: text,
    enumerable: false,
  });
  Object.defineProperty(payload, FULL_BLOB_MEDIA_TYPE, {
    value: mediaType,
    enumerable: false,
  });
}

export async function writeBatch(guard, events, eventBatchSize) {
  for (let start = 0; start < events.length; start += eventBatchSize) {
    const batch = events.slice(start, start + eventBatchSize);
    await materializeBlobs(guard, batch);
    if (typeof guard.writeEvents === "function") {
      await guard.writeEvents(batch);
    } else {
      for (const event of batch) await guard.writeEvent(event);
    }
  }
}

export function logicalProvider(provider) {
  return provider === "claude" ? "claude-code" : provider;
}

export function conversationKey(provider, session) {
  return `${provider}:${session.sourceFile ?? session.fileKey ?? session.id ?? "unknown"}`;
}

export function interactionKey(provider, session, providerInteractionId) {
  return `${provider}:${session.id ?? shortHash(session.fileKey)}:${providerInteractionId}`;
}

export function fallbackRecordId(session, ctx) {
  const sessionKey = session.id ?? session.fileKey ?? "unknown";
  return `line-${ctx.lineIndex}-${shortHash(`${sessionKey}\0${ctx.rawLine}`)}`;
}

export function shortHash(value) {
  return sha256(value).slice(0, 16);
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function materializeBlobs(guard, events) {
  const pendingByContent = new Map();
  for (const event of events) {
    const payload = isObject(event.payload) ? event.payload : {};
    for (const target of [payload.content, payload.raw]) {
      if (!isObject(target) || target.contentRef) continue;
      const text = target[FULL_BLOB_TEXT];
      if (typeof text !== "string") continue;
      if (typeof guard.writeTextBlob !== "function") {
        throw new Error("code-agent-transcripts requires guard.writeTextBlob for oversized content and agent raw trajectories");
      }
      const mediaType = target[FULL_BLOB_MEDIA_TYPE] ?? "text/plain; charset=utf-8";
      const contentKey = `${mediaType}\0${text}`;
      let pending = pendingByContent.get(contentKey);
      if (!pending) {
        pending = guard.writeTextBlob({
          text,
          variant: "redacted-text",
          mediaType,
        });
        pendingByContent.set(contentKey, pending);
      }
      const result = await pending;
      if (!isObject(result?.ref)) throw new Error("writeTextBlob returned no contentRef");
      target.contentRef = result.ref;
    }
  }
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
