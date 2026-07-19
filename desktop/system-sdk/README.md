# `@lamarck/system`

The canonical TypeScript/JavaScript client for Lamarck Personal System Apps.

App code imports the same package in browser UI and Node workloads:

```ts
import { system } from "@lamarck/system";
```

The package supplies the client and protocol contract. At runtime, Lamarck binds it to the App Capsule's Host-mediated System channel; importing this package does not grant ambient Host, network, filesystem, or cross-App authority.

`@lamarck/system` follows System protocol V1 and declares that compatibility in its package metadata. Apps should declare an explicit compatible version in `package.json` and commit the generated npm lockfile.

## Release

Publishing a GitHub Release whose tag is `system-sdk-v<version>` publishes the exact tarball produced by `scripts/pack-system-sdk.mjs`. The release gate verifies the SDK, reproducible tarball contents, clean consumer installation, and registry bytes without depending on Core, Shell, or bundled App lockfiles. It accepts an existing immutable version only when the registry integrity and tarball URL match the locally verified artifact.

After publication succeeds, a separate downstream job reads the official version, tarball URL, and SHA-512 integrity from the npm registry. It updates the first-party starter App lockfiles and opens an independent pull request for review. Starter locks therefore record published registry bytes instead of predicting an unpublished tarball; incompatible version-range changes remain an explicit manual decision. Repository-wide CI runs only when a GitHub Release is published while the public repository is being assembled module by module.

Publishing uses npm trusted publishing from the protected GitHub `npm-publish` environment and does not store an npm token. npm requires a package to exist before a trusted publisher can be configured, so the first release is a one-time bootstrap: an npm scope owner publishes that same verified tarball interactively with 2FA, configures the trusted publisher for this repository, workflow, and environment, and then removes any bootstrap credential. The GitHub Release workflow is idempotent for that bootstrap version: it accepts an existing version only when the registry integrity and tarball URL exactly match the locally verified artifact.
