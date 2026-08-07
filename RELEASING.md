# Releasing Lamarck

Guest images and Desktop packages have independent release cadences. A Guest
release never triggers a Desktop release automatically: merging the generated
Guest pin pull request only selects the Guest consumed by future Desktop
packages.

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
the Alpha Desktop package job reads. Their external source of truth and sync
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
6. It downloads the runtime and source archive through the public domain and
   verifies the pinned inventory, every file digest, and both signed manifests.
7. It opens a pull request that changes only
   `desktop/capsule-guest/release-pin.json`.
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
```

`files.json` is written last on the first publication. Uploads are retry-safe:
byte-identical objects are kept, while conflicting bytes under an existing
immutable path fail the workflow.

Desktop packaging fetches only the signed runtime files by default. The Guest
release workflow additionally fetches and verifies the source archive through
the public domain. The source archive is never staged into the App or consumed
by Desktop updates.

## Alpha Desktop workflow

Alpha Desktop releases are high-frequency and manually dispatched:

1. Ensure `main` contains the intended Guest pin.
2. Run **Alpha Desktop** from `main`. Optionally provide a full version such as
   `0.1.0-alpha.12`; otherwise the packager generates a UTC-stamped version.
3. The macOS arm64 job downloads and verifies the pinned Guest runtime without
   the optional source archive, builds the VM helper, stages native resources,
   packages the ad-hoc-signed App, and runs the packaged node-pty smoke.
4. Exactly the ZIP, its SHA-256 sidecar, and the release JSON are copied to the
   non-hidden `release-handoff/alpha/` directory and transferred through a
   three-day GitHub Actions artifact.
5. After `r2-releases` environment approval, a separate Linux job performs the
   R2 upload, verifies the ZIP through the public domain, and writes
   `latest.json` last.

Desktop R2 objects:

```text
desktop/macos/arm64/alpha/<version>/Lamarck-Alpha-<version>-macos-arm64.zip
desktop/macos/arm64/alpha/<version>/SHA256SUMS
desktop/macos/arm64/alpha/latest.json
```

Version directories are immutable. `latest.json` is the only mutable Desktop
object and is sent with `Cache-Control: no-cache`. A failed run can be retried
with the same version: matching immutable objects are retained and publication
continues. A hash or size conflict always fails closed.

`latest.json` also carries the signed Guest source archive metadata used by the
website's `/open-source/` page. That archive is presented as optional developer
and license-compliance material, never as a second Desktop download.

## Transition-period update behavior

Alpha packages are ad-hoc signed and are not notarized. The current channel is
therefore intended for explicit tester distribution, not broad public install.
The Desktop may check `latest.json` and download an update, but a production
quality self-replacing updater needs its own signed update manifest, atomic
replacement helper, rollback path, and permission fallback. Electron's
Squirrel-based updater becomes the normal path after Developer ID signing and
notarization are available.
