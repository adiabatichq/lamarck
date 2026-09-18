# Releasing Lamarck

Guest images and Desktop packages have independent release cadences. A Guest
release never triggers a Desktop release automatically: merging the generated
Guest pin pull request only selects the Guest consumed by future Desktop
packages.

Desktop also ships the managed CLI executable and its digest descriptor. App
Capsules receive that artifact over their authenticated Host channel and mount
it read-only. The npm package continues to default to the Host entry point.
Ordinary CLI/Host business-command changes can ship with Desktop while retaining
the same Guest pin. See [CLI transport](desktop/cli/README.md) and
[Guest build stages](desktop/capsule-guest/BUILD-STAGES.md).

## Release infrastructure

Create one publicly readable Cloudflare R2 bucket and expose it through an
HTTPS custom domain. The first-party defaults are:

- bucket: `lamarck-desktop-releases-prod`
- public base URL: `https://releases.lamarck.ai`

Forks may override these defaults with the GitHub repository or environment
variables `R2_RELEASES_BUCKET` and `RELEASES_PUBLIC_BASE`.

The protected `r2-releases` GitHub environment requires these secrets:

| Secret | Consumer | Purpose |
|---|---|---|
| `R2_ACCOUNT_ID` | Guest and Desktop publish steps | Cloudflare account used to form the R2 S3 endpoint |
| `R2_RELEASES_ACCESS_KEY_ID` | Guest and Desktop publish steps | Access key for an Object Read & Write token scoped to the releases bucket |
| `R2_RELEASES_SECRET_ACCESS_KEY` | Guest and Desktop publish steps | Secret for the same scoped R2 token |
| `LAMARCK_GUEST_SIGNING_KEY_PEM` | Guest build only | Ed25519 private key in PEM form used to sign Guest manifests |

The Guest signing key must be backed up offline. It is materialized as a
temporary mode-0600 file outside the checkout; it is never uploaded to R2,
placed in an Actions artifact, or passed into a Docker build or container.

## Official Marketplace package publishing

Official Marketplace source packages live independently from Desktop
packaging under `apps/<package>/` and `connectors/<package>/`. Every published
manifest uses a scoped `lamarck.<name>` ID. Desktop does not bundle either
collection, and `desktop/core/scaffolds/app-v1/` is only the local blank-App
scaffold; it is not a Marketplace package.

The **Publish Official Marketplace Packages** workflow runs for protected
`main` changes to either collection and supports manual retry. It discovers
every immediate package directory and applies one identical matrix job:

1. Create an ordinary bounded `.tar.gz` transport archive, excluding only the
   common `.git` and `node_modules` logical-tree exclusions. Backend applies
   kind-specific policy such as the App-only `.lamarck` exclusion.
2. Request a private upload slot from Marketplace Backend.
3. Put the exact candidate bytes at the returned short-lived presigned URL.
4. Complete the upload and poll the owned upload resource until Backend
   reports `published` or a bounded validation error.

The workflow does not parse package manifests, calculate an authoritative
logical hash, choose a final object path, execute Connector content, or make a
publication decision. Backend alone validates and canonicalizes the candidate,
derives package identity and origin, assigns the release, publishes the public
content-addressed artifact, and advances the index. Retry is safe through the
upload resource and Backend content idempotency; a failed validation is not a
public release and may be retried after fixing the source.

Configure these non-secret variables on the protected
`marketplace-official` GitHub environment:

| Variable | Required value |
|---|---|
| `MARKETPLACE_API_ORIGIN` | `https://api.lamarck.ai` |
| `MARKETPLACE_OIDC_AUDIENCE` | `https://api.lamarck.ai/marketplace/uploads` |

Only the package-publish matrix job receives `contents: read` and
`id-token: write`. It requests a short-lived GitHub Actions OIDC token for the
exact configured audience. Marketplace Backend verifies that token directly,
including issuer, signature, repository, workflow/ref, audience, and time
claims, and maps it to the narrow Official publisher for the reserved
`lamarck` namespace. No AWS federation is involved.

Do not add R2 credentials, a long-lived Marketplace token, a Lamarck account
token, or an OSS publishing secret to this workflow. OSS CI receives only the
one-key presigned PUT. Private ingest cleanup and publication into
`lamarck-desktop-releases-prod` are Backend responsibilities.

For the initial coordinated release:

1. Land and verify Backend publication plus the focused App and Connector
   Desktop download/lifecycle smoke coverage.
2. Deploy Backend routes, OIDC allowlist, namespace authority, signing key,
   index, validation worker, and existing R2 configuration.
3. Set the two non-secret GitHub variables, then run the OSS workflow from
   protected `main` and wait for every matrix entry to publish.
4. Verify catalog, exact/latest signed resolution, and public immutable
   artifact reads before enabling the Web handoff.
5. Ship the signed Desktop build containing the matching artifact consumer,
   protocol registration, pinned API/release origins, and resolve trust root.

For any later artifact-format revision, ship a Desktop reader that recognizes
the revision before Backend begins emitting it. The blind OSS publisher does
not change merely because the canonical artifact contract changes.

## Marketplace Desktop cutover and rollback

Desktop resolves Marketplace identities through `https://api.lamarck.ai` by
default. `LAMARCK_API_ORIGIN` may point local development at another API, but a
signed artifact path is always resolved against the pinned
`https://releases.lamarck.ai` origin. Alpha and release builds must set both of
these non-secret build inputs:

| Variable | Value |
|---|---|
| `LAMARCK_MARKETPLACE_SIGNING_KEY_ID` | The active Backend resolve-signing key ID |
| `LAMARCK_MARKETPLACE_SIGNING_PUBLIC_KEY` | Canonical base64 for the matching raw 32-byte Ed25519 public key |

Provide both values as GitHub environment secrets under `r2-releases`, which
the Desktop Release build job reads. Their external source of truth and sync
mechanism are release-operations concerns outside this repository. Export them
directly for a local release build. Never place the Backend private key in
GitHub or the Desktop build environment.

The public key must be the exact counterpart of the private signing key in the
private production configuration. The private key never enters this repository
or Desktop CI. Packaging seals the public trust root into the App and fails if
either release input is absent or the staged resource differs. The macOS App
also registers the exact `lamarck` URL scheme in `Info.plist`; no web origin or
artifact URL is registered as protocol authority.

Use a coordinated cutover:

1. Configure and deploy the Backend signer, Official index, resolve routes, and
   immutable release storage mapping first.
2. Publish the Official packages and verify exact and latest signed resolution
   plus public artifact reads.
3. Build Desktop with the matching public trust root and verify cold-launch and
   warm-process handoffs from a Web App detail page and a Connector detail page.
4. Confirm tampered resolve fields and artifact bytes fail closed, App creation
   records only `createdFrom`, Connector exact-hash install/update works, and an
   update preserves existing Sources.
5. Enable the Web Marketplace handoff only after those checks pass.

If cutover must be reversed, disable the Web handoff and deploy the prior
Backend or Desktop build as appropriate. Published Marketplace artifacts are
immutable and can remain in R2; rollback does not delete or rewrite them and
there is no Marketplace `latest.json` object to repair. A Desktop build whose
trust root no longer matches the active Backend signer fails closed until a
matching build is shipped. Key generation, private-key placement, production
Backend configuration, release build variables, package publication, and the
Web enablement remain explicit manual deployment actions.

## Guest Release workflow

The build produces a pinned OS base, then builds current Guest JavaScript and
assembles the complete image before compliance generation, signing, and boot
smoke. The tag workflow restores the reviewed OS base and its exact builder
from the existing R2 bucket when native inputs match `os-base-pin.json`.
An initial release or changed native inputs builds a new base; missing or
tampered pinned artifacts fail the release. Reuse commands, retained source,
and pin custody are documented in
[Guest build stages](desktop/capsule-guest/BUILD-STAGES.md).

Guest releases are low-frequency and tag-driven:

1. Create and publish a GitHub Release whose protected tag is
   `guest-v<version>`, for example `guest-v0.2.0`.
2. Approve the `r2-releases` environment deployment.
3. The workflow builds natively on Linux arm64, signs the release, performs the
   production QEMU/runc boot smoke, and verifies the signed release contract.
4. It packages complete corresponding source as one separately downloadable
   archive. The runtime retains licenses, notices, SBOM, and a signed offer
   that binds the archive URL, size, and SHA-256.
5. It uploads every release file under a digest-addressed immutable R2 prefix.
   A newly built OS base and its exact Docker builder are also saved together
   under an immutable prefix and verified through the public domain.
6. It downloads the runtime and source archive through the public domain and
   verifies the pinned inventory, every file digest, and both signed manifests.
7. It opens a pull request limited to `desktop/capsule-guest/release-pin.json`
   and `desktop/capsule-guest/os-base-pin.json`. Review both: the latter binds
   the native input identity, base manifest, builder image ID, and archive bytes.
8. Review and merge that pull request when future Desktop releases should use
   the new Guest.

The committed pin is public release metadata, not a credential. It records the
Guest image version, full manifest digest, full inventory digest, and immutable
R2 prefix. Desktop CI does not receive the Guest private key.

Guest R2 objects:

```text
guest/macos/arm64/<manifest-digest-first-16>/<every release-tree file>
guest/macos/arm64/<manifest-digest-first-16>/Lamarck-Capsule-Guest-<version>-Open-Source.tar.gz
guest/macos/arm64/<manifest-digest-first-16>/files.json
guest/os-base/arm64/<full-base-manifest-digest>/<full-archive-digest>.tar.gz
```

`files.json` is written last on the first publication. Uploads are retry-safe:
byte-identical objects are kept, while conflicting bytes under an existing
immutable path fail the workflow.

Desktop packaging fetches only the signed runtime files by default. The Guest
release workflow additionally fetches and verifies the source archive through
the public domain. The source archive is never staged into the App or consumed
by Desktop updates.

## Signed Desktop releases

The **Desktop Release** workflow (`.github/workflows/desktop-release.yml`) replaces
Alpha Desktop. Dispatch it from protected `main` with a new three-component
version such as `0.1.0`. The version is embedded in both the application and its
System identity; the Git commit must match the clean checkout.

Doppler project `lamarck-releases`, config `prod`, syncs these additional secrets
to the GitHub `r2-releases` environment:

| Secret | Value |
|---|---|
| `LAMARCK_CODESIGN_P12_BASE64` | Base64 of the Developer ID Application certificate and private key export |
| `LAMARCK_CODESIGN_P12_PASSWORD` | Password protecting that P12 export |
| `APPLE_API_KEY_P8_BASE64` | Base64 of the App Store Connect Team API private key |
| `APPLE_API_KEY_ID` | Team API key ID |
| `APPLE_API_ISSUER_ID` | Team API issuer UUID |
| `APPLE_TEAM_ID` | Developer Program team ID matching the signing certificate |

An Apple ID password or app-specific password is not used. The existing
Marketplace public trust root and R2 secrets remain in the same environment.
Signing material is imported into a temporary macOS runner keychain. P12/P8
files are deleted after import; an always-run cleanup restores the search list
and deletes the keychain. Only the package step can use the installed signing
identity; R2 credentials are provided only to the publish step.

The existing device-identity distribution contract also requires these GitHub
**environment variables**, each set to `1` only after the corresponding review
has actually completed:

- `LAMARCK_DEVICE_IDENTITY_APPLE_POLICY_REVIEW`
- `LAMARCK_DEVICE_IDENTITY_APPLE_DTS_REVIEW`
- `LAMARCK_DEVICE_IDENTITY_APPLE_LEGAL_REVIEW`

These are project release acknowledgements, not Apple credentials. Creating a
Developer ID certificate does not satisfy them. The workflow checks them before
starting the build and preserves `requireAppleDeviceIdentityReviews` unchanged.

The workflow performs three jobs:

1. Linux arm64 creates a sealed source snapshot and builds the Shell inside the
   pinned Docker toolchain. A tar handoff preserves file modes and includes the
   exact source digest, version, commit, builder identity and output inventory.
2. macOS recreates the source snapshot and verifies the same-run handoff against
   it and the Linux job's builder identity. It fetches the signed Guest, builds
   native helpers, signs with Developer ID, submits to Apple notarization,
   staples the ticket, and runs signature/Gatekeeper/runtime checks. The final
   ZIP and release metadata are transferred as a three-day Actions artifact.
3. Linux uploads immutable release files to R2, downloads the public ZIP and
   verifies its SHA-256 and size, then atomically advances `latest.json`.
   Downgrading the stable pointer is rejected; publish fixes with a higher
   version. Retries reuse identical immutable files and reject byte conflicts.

```text
desktop/macos/arm64/stable/<version>/Lamarck-<version>-macos-arm64.zip
desktop/macos/arm64/stable/<version>/SHA256SUMS
desktop/macos/arm64/stable/latest.json
```

`latest.json` is the only mutable pointer (`Cache-Control: no-cache`). It
contains both website release metadata and Squirrel.Mac's `currentRelease` /
`releases[].updateTo` static feed, so both consumers select the same ZIP. It also
carries the Guest source archive link for license compliance; that source
archive is never consumed by the updater. The production updater origin is
fixed to `https://releases.lamarck.ai`; forks must explicitly change their
publisher and client together.

Only the production packager writes `desktopUpdateChannel: stable` into the
signed app package. The installed Mac arm64 app checks on launch and every six hours,
downloads the full ZIP with Electron's signed Squirrel.Mac updater, and shows
**Update & Restart** once ready. System also offers **Check for updates**.
Before installation the Host drains runtime operations and tears down App
viewers, terminals, Core, Guard and Capsule resources. Workspace files remain
outside the application bundle. A downloaded update can also install on the
next normal application launch. `package:patch` remains a developer artifact,
not a delta update format.

## First signed release cutover

Deploy the updated website/backend readers before publishing the first stable
release. They prefer stable and fall back to the existing Alpha channel only
when the stable pointer returns 404. An invalid stable document or server error
never falls back. No new Alpha workflow runs are available; old immutable Alpha
objects and local Alpha tooling remain for historical/testing use.

Existing Alpha installations use a different bundle identifier and ad-hoc
signing. Users must manually install the first signed `Lamarck.app` in
Applications. Subsequent signed versions can update in place. Verify the first
release's download, Gatekeeper launch and existing Workspace access, then ship
a higher test version and verify check → download → restart → new version.
Unit/contract tests do not replace this two-version signed Mac acceptance test.
