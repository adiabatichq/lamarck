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
