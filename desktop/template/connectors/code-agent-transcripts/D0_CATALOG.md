# Code Agent Transcripts D0 Catalog

This connector writes two current D0 event types. The catalog is connector-owned; these are product-data events, not `system:*` events from the system D0 catalog.

## Shared identity and ordering

- `provider` is `codex` or `claude-code`.
- `conversationKey` is `<provider>:<source transcript path>`. It is the grouping key for one provider transcript file.
- `interactionId` is connector-generated from provider, provider session id, and the provider turn/prompt id. Human messages and their agent turn share it. Steering may produce multiple human messages for one interaction.
- Provider-native ids remain under `raw.ids`.
- Reconstruct the normalized conversation by grouping on `conversationKey`, ordering interactions by their earliest human `startedAt`, ordering human messages inside an interaction by `startedAt`, and placing the agent turn's projected `content` after those human messages. Use raw `sourceLineIndex` anchors when exact provider order is required.

All text and raw records are redacted before hashing, byte measurement, inline storage, or blob storage. Limits are UTF-8 bytes, not JavaScript character counts.

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

`content` is fully inline through `max-inline-bytes` (default 8192). Above the limit, `text` is a UTF-8-safe preview, `truncated` is true, and `contentRef` resolves the complete redacted text.

Human raw is one provider record. It stays inline through the same limit. Above it, `records` is omitted, `format` becomes `<provider>-jsonl`, and `raw.contentRef` resolves JSONL text containing `{ sourceLineIndex, record }` wrappers.

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
      "format": "codex-jsonl",
      "recordCount": 42,
      "firstSourceLineIndex": 2,
      "lastSourceLineIndex": 205,
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
        "variant": "redacted-text",
        "mediaType": "text/plain; charset=utf-8",
        "encoding": "gzip"
      }
    }
  }
}
```

`status` is `completed`, `interrupted`, or `failed`. `content` is the provider's final-answer projection and is absent when no final answer exists. It follows the same 8192-byte content rule as human messages.

Agent raw is always written through `guard.writeTextBlob`, even for a very short turn. D0 contains only its anchors, size/hash, provider ids, and `contentRef`. The resolved text is newline-delimited JSON; each line is `{ "sourceLineIndex": number, "record": object }`.

### Selected raw boundary

Codex agent raw includes:

- `task_started`, `task_complete`, and `turn_aborted` lifecycle records;
- assistant `response_item` messages;
- function/custom/web-search calls and their outputs;
- inter-agent message records;
- reasoning records only when `include-reasoning=true`.

Claude Code agent raw includes:

- assistant records;
- user-shaped tool-result records;
- thinking/reasoning content only when `include-reasoning=true`.

The connector excludes repeated UI mirrors, token-count telemetry, world/turn context, compaction records, title records, and other provider scaffolding. When Claude reasoning is disabled, reasoning parts are removed from otherwise selected assistant records before the raw record is stored.

Claude Code human records are recognized across transcript versions whether or not `origin.kind=human` is present. User-shaped tool results, task notifications, sidechains, metadata records, and compact-summary scaffolding are not emitted as human messages.

## Incremental closure

Open agent interactions are not emitted. Connector state stores only source byte/line anchors and provider interaction ids, not accumulated raw records. When a provider lifecycle closes the interaction, the connector re-reads that bounded source range once, selects/redacts the raw records, writes the raw blob, emits the agent turn, and removes the open anchor. If cancellation occurs before that work finishes, the sync aborts without committing an advanced cursor so the same closure is retried. This keeps temporary connector state bounded even when one agent turn runs for hours.

Codex closes on `task_complete` or `turn_aborted`. Claude Code closes on a text-bearing assistant record with `stop_reason=end_turn`, on a text-bearing `stop_sequence` failure, or as interrupted when a human prompt with a different prompt id begins. A steering message that retains the active prompt id emits another human event in the same interaction without closing or reopening the agent turn.
