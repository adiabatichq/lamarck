# macOS AX Watcher Design

Status: v0 design locked for snapshot/profiler implementation.

## Scope

The macOS AX watcher is a local, device-scoped connector. It captures the user's active desktop context through macOS Accessibility APIs without changing the connector runtime or the D0 write contract.

V0 requires Accessibility only. It does not request Input Monitoring, Screen Recording, screenshot capture, OCR, or deep traversal of every background window.

## Capture Model

The collector samples at roughly one-second cadence:

- frontmost/focused app and window
- focused accessibility element
- bounded rich text from the focused/frontmost AX tree
- all visible window metadata across displays
- mouse location and hovered visible-window hint
- system HID idle time and screen-lock state

Visible AX text is captured locally by default, with a hard exclusion for OS-declared secure fields. Persistence is controlled by app, website/category, and domain privacy policy actions rather than a connector-wide capture mode.

Frontmost selection uses the first onscreen layer-0 CGWindow owner as the primary source, with `NSWorkspace.frontmostApplication` as fallback. Visible window inventory is always enabled for the connector; it is part of the desktop attention model, not a user-facing capture toggle. In the Codex-spawned helper path, `NSWorkspace` can remain pinned to Codex even while the actual top window is Chrome, Terminal, Telegram, or another app. Snapshots include `frontmostSource` diagnostics with the chosen source, chosen window, workspace app, and whether the sources matched.

## Research Capture Baseline

This phase is raw-first. The snapshot artifact should preserve as much AX-observed source material as practical:

- normalized app/window/focus/text facts
- raw frontmost AX tree
- supported AX attribute names and parameterized attribute names
- value types, children counts, bounds, roles, identifiers
- visible window inventory and display metadata
- idle seconds, screen lock, permission state, mouse position

The helper still keeps safety bounds on traversal depth, node count, child count, and string length so one app cannot make capture unbounded. It also applies a bounded AX messaging timeout and a per-snapshot AX budget. If a target app is slow or unresponsive, the snapshot should degrade to partial metadata and include diagnostics rather than blocking the sampler.

Minimum hard protections:

- never read values from elements where role or subrole is `AXSecureTextField`

Redaction, explicit privacy-category policy, app-specific filtering, and storage retention are later aggregate/storage-manager decisions, not part of raw snapshot collection.

## Privacy Policy Direction

Production aggregation should treat "exclude" as a policy action, not as one meaning. The default action for sensitive privacy categories is metadata-only:

- Lamarck/self app: metadata-only by default, so internal product activity, frontmost state, and presence remain visible without indexing the app's rich text.
- Finder: metadata-only by default, so file-navigation attention is visible without indexing filenames/tree text as rich context.
- System Settings: metadata-only by default through app policy, so settings/security/password panes remain visible as activity without indexing their rich UI text.
- Private browsing/incognito windows: metadata-only by default; keep the browser attention envelope but do not index page text or query/title content unless the user explicitly chooses `rich`.
- Secret-management sites: metadata-only by default through domain policy; keep app/window/frontmost evidence but do not write AX text/value content. Native password-manager apps should be handled by app policy, not by website category inference.

`disabled` is reserved for explicit user opt-out or surfaces where even attributed metadata is unwanted. OS-declared secure fields remain a lower-level hard protection: their text/value is never read into raw snapshots.

The policy surface follows a Littlebird-style shape:

- app rules by bundle id
- website/category rules
- three actions: `rich`, `metadata_only`, `disabled`

Built-in website/category evidence lives under `privacy-lists/` as connector-owned policy data, not runtime state. The runtime loads these lists once at connector startup, keeps them in memory, and performs suffix lookup against observed domains. User overrides live in Source config; the built-in lists should remain source-controlled, documented, and easy to refresh/audit.

For privacy decisions, an observed domain is runtime-only policy evidence, not always-safe persisted metadata. It must be a surface domain: `AXURL`/`AXDocument` from the focused window or focused element, or an explicit `http(s)` URL in the window title as a fallback. Domains found inside AX text, terminal output, chats, documents, or arbitrary title text are mentions, not current-surface evidence, and must not drive category or domain policy. This avoids corrupting activity truth when one app discusses another website.

Metadata is the attention envelope: app identity, bundle id, frontmost/window evidence, display/bounds, category when retained by policy, mouse/hover hint, presence, timestamps, and the policy decision itself. Rich context is the human-readable content inside that envelope: AX text/value/selected text/visible text, document body, terminal viewport, DM composer text, and other UI strings that explain the work itself.

URLs and domains sit across the boundary. They may be used to decide policy, but `metadata_only` events must not persist domain, matched domain, full URL, path, query, or title. They should persist category and policy reason only. `rich` events may keep surface domain evidence. `disabled` samples should not persist attributed context at all. DM typing text is rich context, not metadata.

Every D0 context span/window privacy summary should carry the action, policy version, redaction reason, retained category when safe, and redaction flags. Full matched-rule trails are optional debug/audit metadata for a future policy inspection UI, not a v0 persistence requirement. D2 must not infer that absent text means absent activity.

## Helper Packaging

Production should ship a precompiled `bin/ax-helper` inside the connector package. End-user machines must not need Xcode or Command Line Tools just to run the connector. The Swift source should stay in `helper/ax-helper.swift` for auditability, development, and reproducible rebuilds, but source execution is a development fallback only.

Rebuild the production helper with `desktop/template/connectors/macos-ax/build-helper.sh`. The script builds arm64 and x86_64 slices, combines them into a universal Mach-O at `bin/ax-helper`, and applies an ad-hoc code signature. Distribution signing/notarization can replace that signature at app packaging time.

Connector package hashing covers regular files recursively and skips only `.git` and `node_modules`, so `bin/ax-helper` is covered by the same `contentHash` trust gate as `index.mjs`. If the helper binary is modified, the connector package hash changes and the package should no longer match the official catalog hash.

Because macOS TCC attribution is effectively at the host app/process-tree level, the connector trust gate is also guarding system-level screen/context access. Modified or untrusted connector packages must not be allowed to inherit the desktop app's Accessibility permission.

## Aggregate Direction

D0 should not receive one event per raw sample. The target D0 shape is a bounded attention envelope:

```text
1s snapshots
  -> redaction
  -> in-event content dedup
  -> 30s desktop.context event
```

The 30s window is not a semantic task boundary. It is a fixed durability, replay, and query envelope. Once opened, the envelope keeps its absolute 30s boundary; late samples can close the prior window but do not stretch it. D2 can later merge these envelopes into task episodes.

The packer waits for a right-side boundary sample before writing a context envelope. With the default 1s sampler and 30s window, the fatal no-sample deadline is 30s plus a 10s grace. If no boundary sample arrives before that deadline, the connector run raises a fatal error so the shell can show the Source as needing attention.

The aggregate should keep events self-contained in v0:

- text is deduped inside the event by normalized text hash
- contents are addressed by event-local IDs (`c1`, `c2`, ...)
- attentionSpans/observations reference event-local content IDs, not global blobs
- the same text may still be repeated across adjacent D0 events
- cross-event content-addressed dedup is left to the future storage manager/blob store

This avoids making a D0 event depend on a previous event for replay.

The v0 aggregate shape is:

- `attentionSpans`: contiguous attention surfaces. App/window/focus/surface/privacy changes can create a new attention span.
- `observations`: RLE-compressed visible-state segments inside an attention span. Text/viewport changes create a new observation, not a new attention span.
- `contents`: event-local visible text records for `rich` observations only.

Payload-internal time ranges use event-local offsets (`fromMs`/`toMs`). Absolute time belongs to the D0 event envelope (`startedAt`/`endedAt`), not nested spans or observations.

When a foreground window can be joined to the event-local visible window inventory, the attention span stores `foregroundWindowRef` and omits duplicate window metadata. If no reliable join is available, the span keeps a minimal `window` fallback with title/role/subrole.

`metadata_only` observations do not carry content refs. Their attention spans also omit surface domain/URL and keep only the policy category/reason.

`disabled` samples create privacy-hidden attention spans and minimal observations so consumers can distinguish an intentional privacy gap from missing data or a bug. Disabled spans keep timing and `privacy.action = "disabled"`, but omit app, window, focus, surface, display refs, window refs, and content refs.

The context envelope presence summary uses mutually exclusive buckets that should sum to the envelope duration: `activeMs`, `idleMs`, `afkMs`, `lockedMs`, `missingMs`, and `unattributedMs`.

Bounded sample gaps inside a closed context envelope are represented as `capture.state = "missing"` and `capture.reason = "sample_gap"` spans/observations and contribute to `presence.missingMs`. The connector only writes missing intervals that are bounded by the fixed envelope and a later real sample. Tail gaps from connector stop, sleep, or shutdown are not recovered for `desktop.context`.

Foreground resolution fallback is also collapsed to `capture.state = "missing"` and `capture.reason = "unattributed"` instead of storing AX-specific provenance in D0. CGWindow foreground evidence is trusted even when `NSWorkspace` disagrees; `NSWorkspace` fallback is treated as unreliable for attributed app/window/focus/text/layout context and contributes to `presence.unattributedMs`.

Full visible text remains inline while it is small enough for D0. Content records above 8192 chars are written through `guard.writeTextBlob` and keep only `hash`, `chars`, a 4096-char `preview`, and the returned `contentRef` inline.

## Attention Span Direction

Attention span count should not explode when visible text changes every second. V0 separates the two concepts:

- attention span: app/window/focused semantic area/privacy/surface
- observation: visible state and content ref inside that attention span

An attention span changes when app, focused window, focused semantic area, URL/domain, or privacy action/category materially changes. Text changes are recorded as observations under the current attention span rather than creating a new attention span for every keystroke or scroll.

Attention span keys are action-aware. `rich` attention spans include focused semantic area and rich surface evidence. `metadata_only` attention spans intentionally ignore focus/title churn after redaction, because that churn is usually sensitive UI detail with little replay value.

Observations include bounded secondary signals that do not affect attention span cutting:

- visible window count summary (`min`, `max`, `last`)
- mouse attention summary (`moved`, OS display IDs, OS window IDs)
- visible layout stacks, grouped per display

Raw mouse coordinates and keyboard keys are not persisted in v0 aggregate. Keyboard activity is represented by the separate `desktop.presence` timeline.

Visible layout uses event-local display/window refs:

- `displays`: physical/virtual screen snapshots.
- `windows`: visible app window snapshots, including app identity, optional title, display ref, bounds, and layer.
- `observations.visibleWindowStacks`: ordered per-display refs to windows that appear to have non-occluded visible area.

The stack order follows the collector's front-to-back order within each display. `layer` is retained as window metadata and for filtering, but it is not the stack order. The stack intentionally excludes covered layer-0 backlog windows where a front window fully occludes them. This keeps D0 closer to actual screen layout instead of "all windows that exist in the space."

Window snapshot identity includes geometry. If a window moves/resizes across displays, a new `wN` can be created; the underlying OS `windowId` lets consumers connect the snapshots when needed.

## Flush Direction

The target window is 30s. Future D0 writer should flush earlier when:

- privacy boundary changes
- screen locks/sleeps/shuts down
- payload becomes unusually large
- span/sample count becomes unusually high
- connector is stopping

Payload limits should initially be measured, not guessed. The profiler reports raw, normalized, redacted, and event-local-dedup estimates so the cap can be set from real p50/p95/p99 data.

If a payload threshold is exceeded, the first response should be to split/flush earlier. Dropping information is an emergency fallback only for pathological single snapshots.

## Presence Direction

Presence is a separate timeline from context. The default thresholds are:

- idle after 15s without HID input
- AFK after 60s without HID input
- screen locked immediately

- `desktop.context` records what was on screen and what had focus. It keeps the same presence summary for local query convenience, but disabled-only context windows do not include attributed app/window/focus/layout data.
- `desktop.presence` records active, idle, AFK, locked, sleep/wake state as `desktop.presence.segment.v0` state segments.

Presence segments flush when the state changes and when the connector stops. They are not tied to the 30s context envelope, so AFK does not create repeated 30s D0 events. When the screen is locked or the machine sleeps, the connector should stop writing repeated context and must not synthesize tail context without a right-side sample. Downstream queries join the presence timeline to the context timeline.

The connector also checkpoints the currently open presence segment in connector state when the context envelope flushes or a presence transition is emitted. On startup, an open cursor from a previous run is emitted once as a recovered `desktop.presence.segment.v0` with `endReason = "connector-restart"`, then the cursor is cleared. `desktop.context` is not recovered from state; losing the final unflushed context window on crash is acceptable for v0.

## Current Implementation Step

This package currently implements:

- Swift AX JSONL snapshot helper with AX messaging timeout and per-snapshot budget diagnostics
- JavaScript snapshot profiler
- `desktop.context.aggregate.v0` builder
- D0 `desktop.context` writer for the normal connector run path
- D0 `desktop.presence.segment.v0` writer for the normal connector run path
- connector-state recovery for the last open presence segment
- snapshot replay CLI via `--replay-snapshots`
- manifest config for user-facing capture choices
- connector-owned privacy config panel for app/category policy

Snapshot JSONL written with `--write-snapshots` is the primary local research artifact for this phase. It writes the helper's raw JSONL snapshots before JS redaction, filtering, dedup, or aggregation. It may contain visible text and window metadata.

Profiler JSONL written with `--write-profiles` is derived from snapshots and exists to estimate aggregate payload size. It preserves redacted event-local text contents unless `--stats-only` is set.

Aggregate JSONL written with `--write-aggregates` is a local preview artifact for the `desktop.context.aggregate.v0` shape. That JSONL line keeps a preview envelope for research/replay; it is not the exact D0 event envelope.

The normal connector run path now writes `desktop.context` envelope events and `desktop.presence` segment events through `guard.writeEvent`. The preview aggregate's `type`, `source`, `startedAt`, and `endedAt` fields are treated as local artifact envelope fields; the D0 writer maps them into the connector event envelope and keeps the formal aggregate under `payload`.

The next design step should use real D0 writes from coding, browser, terminal, and messaging sessions to validate payload size, query ergonomics, and privacy behavior.
