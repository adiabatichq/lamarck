# `@lamarck/system`

The canonical TypeScript/JavaScript client for Lamarck Personal System Apps.

App code imports the same package in browser UI and Node workloads:

```ts
import { system } from "@lamarck/system";
```

The package supplies the client and protocol contract. At runtime, Lamarck binds it to the App Capsule's Host-mediated System channel; importing this package does not grant ambient Host, network, filesystem, or cross-App authority.

`@lamarck/system` follows System protocol V1 and declares that compatibility in its package metadata. Apps should declare an explicit compatible version in `package.json` and commit the generated npm lockfile.

The D1 surface is `system.vfs.command(command, options?)`, using explicit real paths under the Workspace `files/` authority, plus `system.vfs.open(path)` for brokered browser display. There are no document IDs, implicit `.md` suffixes, or legacy document compatibility methods. D2 mutations require an existing granted table with an explicit non-null primary key; primary-key values are immutable.

D1 filenames follow the local filesystem. On macOS and Linux, names containing `?`, `|`, `:`, backslashes, or Windows device names remain accessible; VFS does not impose Windows naming restrictions or an extra portable path-length limit. Paths must stay relative to `files/`, without empty, `.` or `..` segments or NUL. Reserved operational paths and link protections still apply. Quote literal paths in commands, for example `system.vfs.command("cat -- 'myKB/why?.md'")`; quoting does not enable shell expansion.

`ls` and `stat` display paths containing control characters or backslashes as JSON string literals. Use `ls -0` (or `ls -0R`) for exact, unescaped paths separated and terminated by NUL, including names containing newlines or tabs. Filenames are not silently omitted for lacking cross-platform portability.

## Release

Publishing a GitHub Release whose tag is `system-sdk-v<version>` publishes the exact tarball produced by `scripts/pack-system-sdk.mjs`. The release gate verifies the SDK, reproducible tarball contents, clean consumer installation, and registry bytes without depending on Core, Shell, or first-party App lockfiles. It accepts an existing immutable version only when the registry integrity and tarball URL match the locally verified artifact.

After publication succeeds, a separate downstream job reads the official version, tarball URL, and SHA-512 integrity from the npm registry. It updates the official App and local blank-App scaffold lockfiles and opens an independent pull request for review. Those consumer locks therefore record published registry bytes instead of predicting an unpublished tarball; incompatible version-range changes remain an explicit manual decision. Run `npm run verify` from the repository root for repository-wide source validation.

Publishing uses npm trusted publishing from the protected GitHub `npm-publish` environment and does not store an npm token. npm requires a package to exist before a trusted publisher can be configured, so the first release is a one-time bootstrap: an npm scope owner publishes that same verified tarball interactively with 2FA, configures the trusted publisher for this repository, workflow, and environment, and then removes any bootstrap credential. The GitHub Release workflow is idempotent for that bootstrap version: it accepts an existing version only when the registry integrity and tarball URL exactly match the locally verified artifact.
