# Code Agent Transcripts D0 Catalog

This connector writes two current D0 event types. The catalog is connector-owned; these are product-data events, not `system:*` events from the system D0 catalog.

## Shared identity and ordering

- `provider` is `codex` or `claude-code`.
- `conversationKey` is `<provider>:<source transcript path>`. For Codex it always names the root transcript; Codex subagent and internal transcripts do not become normalized conversations.
- `interactionId` is connector-generated from provider, provider session id, and the provider turn/prompt id. For Codex, the first `session_meta` is latched as the canonical rollout identity; later metadata may describe copied fork history. Replayed parent turns retain their history session id, while native turns at or after the canonical rollout start use the canonical session id even when its repeated metadata appears later. Human messages and their agent turn share the resulting interaction id. Steering may produce multiple human messages for one interaction.
- Codex fork transcripts rewrite the envelope `timestamp` on copied records to the fork serialization time. For replayed parent turns, normalized event time therefore comes from the preserved lifecycle `started_at`, `completed_at`, duration, and time-to-first-token fields instead of the copied record envelope. Native turns continue to use their record timestamps for point, first-agent, and terminal activity precision.
- Provider-native ids remain under `raw.ids`.
- Reconstruct the normalized conversation by grouping on `conversationKey`, ordering interactions by their earliest human `startedAt`, ordering human messages inside an interaction by `startedAt`, and placing the agent turn's projected `content` after those human messages. Use raw `sourceLineIndex` anchors when exact provider order is required.

Codex non-root sessions with `thread_source=subagent`, `thread_source=memory_consolidation`, `source.subagent`, or `source.internal` do not emit `code_agent.human_message` or `code_agent.agent_turn` events and are not attached to root raw. Once the canonical metadata identifies a Codex transcript as non-root, the connector fast-forwards its cursor to EOF without parsing the ignored tail. Claude Code subagent transcripts are suppressed the same way: transcript files under a `subagents/` directory are skipped at discovery, and records marked `isSidechain: true` are never treated as human messages, never close interactions, and never enter raw, so a sidechain record embedded in a root transcript cannot end a root turn or populate D0 `content`. The connector guarantees capture of the root conversation only.

All text and raw records pass through best-effort redaction before hashing, byte measurement, inline storage, or blob storage. Redaction covers high-confidence token formats, credential-like object keys, and JSON object/array strings in known tool payload fields such as Codex `arguments`, `input`, `output`, and `result`, plus Claude Code `tool_result.content`. A structured tool field is inspected without reserializing it: if it contains a sensitive key or known token, or exceeds the inspection depth, the whole field becomes `[REDACTED_STRUCTURED_VALUE]`; otherwise its original bytes, number lexemes, whitespace, and key order remain unchanged. Generic hex and base64 strings are not classified as secrets, so commit SHAs and content hashes remain intact. Large encoded binary payloads are independently collapsed to `[REDACTED_PAYLOAD]` when represented as a data URL, Codex `image_generation_call.result`, or an explicit `{ type: "base64", data }` object. Parsing is size- and depth-bounded; arbitrary prose, novel encodings, and oversized encoded objects are not a security boundary and may still contain sensitive material. Limits are UTF-8 bytes, not JavaScript character counts.

## `code_agent.human_message`

A point event for one provider-authored human message. It has `startedAt` and no `endedAt`.

```json
{
  "type": "code_agent.human_message",
  "externalId": "human:<provider>:<conversation-hash>:<provider-message-id>",
  "startedAt": 1783750672061,
  "payload": {
    "provider": "codex",
    "conversationKey": "codex:~/.codex/sessions/.../rollout.jsonl",
    "interactionId": "codex:<session-id>:<turn-id>",
    "content": {
      "text": "message text or an 8192-byte-safe preview",
      "chars": 12,
      "bytes": 12,
      "hash": "sha256:<redacted-content-hash>",
      "truncated": false
    },
    "raw": {
      "format": "codex-records",
      "recordCount": 1,
      "firstSourceLineIndex": 10,
      "lastSourceLineIndex": 10,
      "bytes": 420,
      "hash": "sha256:<redacted-raw-hash>",
      "ids": {
        "sessionId": "<provider-session-id>",
        "turnId": "<codex-turn-id>",
        "clientId": "<codex-client-id>"
      },
      "records": [
        {
          "sourceLineIndex": 10,
          "record": {}
        }
      ]
    }
  }
}
```

`content` is fully inline through the connector's fixed 8192-byte limit. Above the limit, `text` is a UTF-8-safe preview, `truncated` is true, and `contentRef` resolves the complete redacted text.

Human raw is one provider record. It stays inline through the same limit. Above it, `records` is omitted, `format` becomes `<provider>-jsonl`, and `raw.contentRef` resolves JSONL text containing `{ sourceLineIndex, record }` wrappers.

For a native Codex turn, human `startedAt` is the user-message record timestamp. A replayed fork turn no longer has the original per-record envelope timestamp, so its human messages use the preserved turn start. Multiple replayed steering messages can consequently share `startedAt`; `sourceLineIndex` retains their exact provider order.

## `code_agent.agent_turn`

A duration event for one completed, interrupted, or failed agent interaction. It has both `startedAt` and `endedAt`.

```json
{
  "type": "code_agent.agent_turn",
  "externalId": "agent:<provider>:<conversation-hash>:<provider-interaction-id>",
  "startedAt": 1783750672200,
  "endedAt": 1783750840000,
  "payload": {
    "provider": "codex",
    "conversationKey": "codex:~/.codex/sessions/.../rollout.jsonl",
    "interactionId": "codex:<session-id>:<turn-id>",
    "status": "completed",
    "content": {
      "text": "final answer projection",
      "chars": 23,
      "bytes": 23,
      "hash": "sha256:<redacted-content-hash>",
      "truncated": false
    },
    "raw": {
      "format": "codex-turn-bundle-v1",
      "recordCount": 20,
      "rootFirstSourceLineIndex": 2,
      "rootLastSourceLineIndex": 205,
      "bytes": 18342,
      "hash": "sha256:<redacted-raw-hash>",
      "ids": {
        "sessionId": "<provider-session-id>",
        "turnId": "<codex-turn-id>"
      },
      "contentRef": {
        "kind": "content-blob",
        "version": 1,
        "digest": "sha256:<digest>",
        "mediaType": "application/json",
        "encoding": "gzip"
      }
    }
  }
}
```

`status` is `completed`, `interrupted`, or `failed`. A Codex `task_complete` carrying a terminal `error` is `failed`; an error-free `task_complete` is `completed`, and `turn_aborted` is `interrupted`. Agent `startedAt` is the first selected agent activity for native records. For replayed Codex fork history, it is reconstructed from the preserved lifecycle start plus time-to-first-token when available, then falls back to the lifecycle start; copied envelope timestamps are never used as event time. If a Codex turn fails or aborts before producing agent activity, it also falls back to the root `task_started` timestamp instead of creating a zero-duration terminal event. Replayed Codex `endedAt` prefers the lifecycle `completed_at`, then start plus duration, before falling back to the terminal record timestamp; native turns retain the precise terminal record timestamp. For Codex, `content` is only the root agent's final-answer projection; non-root output never populates D0 `content`. It is absent when the root has no final answer. The same 8192-byte content rule as human messages applies.

Agent raw is always written through `guard.writeTextBlob`, even for a very short turn. D0 contains only fixed-size counts, the root source bounds, size/hash, provider ids, and one `contentRef`.

For Codex, `contentRef` resolves an `application/json` turn bundle:

```json
{
  "version": 1,
  "root": {
    "role": "main",
    "sessionId": "<root-session-id>",
    "turnId": "<root-turn-id>",
    "sourceFile": "~/.codex/sessions/.../root.jsonl",
    "recordCount": 20,
    "firstSourceLineIndex": 2,
    "lastSourceLineIndex": 205,
    "records": []
  },
  "childTrajectories": []
}
```

`childTrajectories` is reserved and remains empty in v1. D0 `recordCount` describes only the root trajectory. Claude Code continues to resolve newline-delimited JSON where each line is `{ "sourceLineIndex": number, "record": object }`.

### Selected raw boundary

Codex root raw includes:

- `task_started`, `task_complete`, and `turn_aborted` lifecycle records;
- assistant `response_item` messages;
- tool-call and tool-output response items, including function, custom,
  web-search, tool-search, local-shell, and image-generation records;
- inter-agent message records;
- reasoning records only when `include-reasoning=true`.

Claude Code agent raw includes:

- assistant records;
- user-shaped tool-result records;
- thinking/reasoning content only when `include-reasoning=true`.

The connector excludes repeated UI mirrors, token-count telemetry, world/turn context, compaction records, title records, and other provider scaffolding. When reasoning is disabled, Codex reasoning records and Claude reasoning parts are excluded before raw is stored.

Claude Code human records are recognized across transcript versions whether or not `origin.kind=human` is present. User-shaped tool results, task notifications, sidechains, metadata records, and compact-summary scaffolding are not emitted as human messages.

Codex discovery enumerates at least the most recent 90 days of date-partitioned session directories so a newly resumed conversation can be found even when its rollout predates the normal backfill window. The user-facing `lookback-days` setting controls D0 event-time backfill and defaults to 30 days: human messages are eligible by `startedAt`, while closed agent turns are eligible by terminal `endedAt`, so a turn that begins before the cutoff but completes inside the window is retained. Transcript modification time is only a file-level prefilter. An initial scan may parse older records to reconstruct session and interaction context, but it does not emit out-of-window events. If `lookback-days` is configured above 90 days, the discovery horizon expands to match it, and `0` removes both event and discovery cutoffs. Previously known transcript paths continue to be checked directly. An untracked Codex rollout older than the discovery horizon is outside the capture guarantee even if it is resumed later.

## Incremental closure

Open agent interactions are not emitted. Connector state stores only source byte/line anchors and provider interaction and session ids—not accumulated raw records. When a root lifecycle closes, the connector immediately materializes its bounded raw range and writes the root event in the same sync. Subagent and internal lifecycles are ignored. If materialization or event writing fails, the file cursor is not advanced, so the root is retried on the next sync.

Transcript files are processed independently. While the connector signal remains active, any read, materialization, or write failure—including an operation-level `AbortError`—leaves that file eligible for retry, records a connector warning, and does not prevent later root files from being processed. After an initial sync-wide or confirmed-root failure, watch mode allows three retry attempts at the normal polling interval. If the third retry also fails, the connector clears its persisted retry warnings and then throws so the integration enters `error` and requires user attention; the terminal reason is carried by the integration error state, not by a stale "will be retried" warning. Confirmed child and not-yet-classifiable Codex files remain warning-only so an optional child cannot stop root capture. Only cancellation of the connector signal exits immediately without an error.

Transcript files are treated as append-only logs. The connector resumes at the stored byte offset, retains an incomplete trailing line for the next poll, and rereads only a closed interaction's bounded source range to materialize raw. An inode change, file shrink, or cursor beyond EOF resets that file on a best-effort basis.

Same-inode rewrites of already-consumed bytes are outside the connector contract: they are not fingerprinted, detected, or reconciled. D0 records the transcript history observed by the connector; it is not a mutable mirror of upstream files. Providers are therefore expected to append new JSONL records rather than revise previous ones.

Codex closes on `task_complete` or `turn_aborted`; a terminal `error` on `task_complete` marks the turn failed rather than completed. Claude Code closes on a text-bearing assistant record with `stop_reason=end_turn`, on a text-bearing `stop_sequence` failure, or as interrupted when a human prompt with a different prompt id begins. A steering message that retains the active prompt id emits another human event in the same interaction without closing or reopening the agent turn.
