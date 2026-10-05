# `@lamarck/cli`

The public command-line interface for a running Lamarck Desktop system.

```sh
npm install -g @lamarck/cli
lamarck app list
```

The CLI discovers Lamarck Desktop automatically. It does not accept a Core URL,
Core token, gateway token, Workspace selector, or managed socket path.

Use `lamarck --help` for the complete local command surface.

## Triggers

Host CLI and Console share validation, storage, scheduling, and execution history.
First discover a declared App job or supported concrete poll Source:

```sh
lamarck trigger targets --json
lamarck trigger create --name Inbox --target app:notes:job:inbox \
  --sql 'SELECT id FROM events WHERE type = ?' --params '["telegram.message.received"]'
lamarck trigger create --name Daily --target 'source:<source-id>:run' \
  --cron '0 9 * * *' --timezone Asia/Taipei
lamarck trigger preview --sql 'SELECT id FROM events WHERE type = ?' \
  --params '["telegram.message.received"]' --limit 5 --json
lamarck trigger preview --cron '0 9 * * *' --timezone Asia/Taipei --json
lamarck trigger create --config '{"name":"Inbox","target":"app:notes:job:inbox","condition":{"kind":"event","sql":"SELECT id FROM events"}}'
lamarck trigger create --file trigger-settings.json
lamarck trigger list --json
lamarck trigger inspect <trigger-id> --json
lamarck trigger update <trigger-id> --name 'Renamed' --revision 1
lamarck trigger enable <trigger-id>
lamarck trigger disable <trigger-id>
lamarck trigger runs <trigger-id> --limit 50 --json
lamarck trigger cancel <run-id>
lamarck trigger delete <trigger-id> --yes
```

Replace placeholder IDs with discovered values. Configuration files are optional,
local UTF-8 JSON capped at 16 KiB; `--config` accepts the same settings directly.
Create defaults to disabled (`--enabled` opts in). Update accepts editable fields
and an optional revision fence. Enable/disable/delete also accept `--revision`.
Noninteractive deletion requires `--yes`, following existing CLI conventions.
`--json` returns domain data; errors use the usual stderr envelope and exit code.

Event previews are bounded historical samples and schedule previews show upcoming
times (1–20 results); neither executes a target or advances consumption. History
is bounded to 1–500 results and remains inspectable by ID after configuration
deletion. Creation, enablement, and condition/target edits start future evaluation
from now. Pending runs retain saved settings; disabling pauses them, deletion
cancels them, and running work can finish. Failures/interruption are recorded
without automatic retry. Manual run/retry/replay commands are not advertised.

Only Host CLI can manage Triggers; managed App/Connector CLI has no such authority.
Runtime subscriptions remain separate temporary listeners. App `system.jobInput()`
and execution policies are preview contracts in this pre-1.0 release; protocol
and manifest versions remain v1. Connector event-input targets are not offered.

## Filenames

Workspace filenames follow the local filesystem, so macOS and Linux names such
as `myKB/why?.md` remain accessible through the public file commands. Quote paths
to pass punctuation literally: `lamarck file cat -- 'myKB/why?.md'`.

`lamarck file ls -R myKB` lists these entries without dropping them. Paths with
control characters or backslashes are displayed as JSON string literals. For
programmatic enumeration, `lamarck file ls -0R myKB` returns exact raw paths with
NUL separators and terminators. Shell expansion, traversal outside Workspace
Files, and access through filesystem links remain unsupported.

File commands execute in the running Desktop Core. These filename behaviors
require Lamarck Desktop Alpha 0.1.0-alpha.202609171438 or later; upgrading the
npm CLI alone does not update an already installed Desktop runtime.

## Query errors

`lamarck query` accepts one read-only relational query. Policy rejections return
`QUERY_REJECTED`; invalid SQL, including missing tables or columns, returns
`QUERY_INVALID` with the specific reason. Unexpected failures remain
`CLI_INTERNAL`. Failed commands exit non-zero and write their message to stderr;
with `--json`, stderr contains `{ "error": { "code": "...", "message": "..." } }`.

## Managed Capsule delivery and capabilities

Desktop packages `lamarck-managed.mjs` from the same CLI source and pins its bytes
in `managed-cli.json`, covered by Desktop signing. At workload startup the Host
sends this bounded artifact on the existing ticket-authenticated CLI DATA stream.
The Guest verifies its SHA-256, creates an executable in the private bridge
folder, and binds it read-only at `/usr/bin/lamarck`. The Runtime root contains
only a mountpoint. Missing, truncated, substituted or mismatched artifacts fail
startup; there is no image-embedded fallback or npm download. The npm package's
default `lamarck` binary remains the Host entry point.

CLI protocol V1 capabilities advertise operation names independently of the
client's catalog. Order, additions and omissions do not invalidate the handshake.
Each command checks advertised support and reports `CLI_UNSUPPORTED_COMMAND` if
absent; incompatible protocol values report `CLI_HOST_INCOMPATIBLE`. Names must
remain valid, bounded and unique. Host request validation and authorization are
still authoritative. Advertised support is not an authorization grant.

The Guest imports only `@lamarck/cli/transport`: bounded frames, envelopes,
upload metadata and response attribution. It forwards ordinary operations
without their business schemas. Workspace sync, `app.save` snapshots and
`app.refresh` materialization remain in the trusted Guest bridge. These local
semantics and changes to framing, upload kinds or OCI policy still require a
Guest release; ordinary Host business-command additions do not.
