# `@lamarck/cli`

The public command-line interface for a running Lamarck Desktop system.

```sh
npm install -g @lamarck/cli
lamarck app list
```

The CLI discovers Lamarck Desktop automatically. It does not accept a Core URL,
Core token, gateway token, Workspace selector, or managed socket path.

Use `lamarck --help` for the complete local command surface.

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
require a Desktop build containing the VFS fix from System SDK 0.1.3; upgrading
the npm CLI alone does not update an already installed Desktop runtime.

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
