# Guest build stages

The release builder has two build stages and one offline assembly step. All run
before release signing. There is no Guest runtime updater or startup installer.

## OS base

`scripts/build-buildroot-inside.sh` builds Linux, Node, runc, native helpers,
filesystem tools, the reduced Runtime root, and the Build root with its native
compiler and supporting libraries. It exports the kernel, an ext4 base image,
builder package inventory, Buildroot archive, and complete Buildroot legal-info.
The image has a fixed empty `/usr/bin/lamarck` mountpoint in the Runtime root;
it contains no managed CLI executable or Guest JavaScript programs.

`scripts/os-base.mjs` seals those files and their exact native source in
`os-base-manifest.json`. Its V1 identity includes:

- Every file, mode, length, and digest under `buildroot/` and `native/`, including
  new files, patches, overlays, Dockerfile, package hashes, and post-build hooks.
- The native build script, hash-policy verifier, and project license.
- The immutable Linux arm64 builder image ID, `SOURCE_DATE_EPOCH`, and `JOBS`.

Guest JavaScript, the CLI business catalog and executable, and the npm lockfile
do not affect this identity. Guest transport changes still require a new Guest
image but can reuse the OS base. Changes to any selected native input require a
new base, even if an operator expects identical native output.

The base pin is the SHA-256 of its manifest; the manifest binds the exact output
file set, modes, sizes, and SHA-256 values, including native source and licenses.
Reuse requires the caller to supply that pin independently of the artifact.
A digest proves integrity relative to a trusted pin, not who built the base.
Retain the pin from a trusted isolated build and carry it through release review;
do not derive a trusted pin from a downloaded or dirty directory. This internal
base contract does not replace the final Guest signatures or Desktop trust root.

On reuse, the builder validates the pin, current native identity, file inventory,
and retained source, copies the artifact into private staging, then verifies it
again. Missing files, added files, symlinks, hard-linked files, changed contents,
and stale identities fail explicitly. There is no fallback to rebuilding or
accepting a dirty directory when an explicitly selected base fails verification.

## Current Guest programs and assembly

The sealed current source snapshot builds only the supervisor (including the
Guest-local CLI bridge), offline-npm, and the release runc smoke executable.
Guest builds consume the CLI package's catalog-free `transport` subpath. A build
guard rejects imports of the CLI business barrel; the CLI executable and business
sources are absent from the sealed Guest source selection.

`scripts/assemble-guest-programs.mjs` verifies the pinned base and current
JavaScript output inventory. In a private copy of the base ext4 image, `debugfs`
installs only four fixed files: supervisor, offline-npm in the Guest and Build
roots, and release smoke. Those destinations must be absent in the base. The
assembler sets root ownership, executable modes and fixed times, reads back and
hashes every installed file, and runs `e2fsck` before and after assembly. It runs
in the same pinned builder with networking disabled and needs no filesystem
mount or privileged container.

The ordinary release flow then generates compliance metadata, signs the complete
kernel/rootfs release, runs the existing production QEMU/runc boot smoke, performs
the exclusive local release-directory handoff, and verifies runtime plus source.
Final release layouts, signatures, Host verification, and version identifiers
remain unchanged. The current compliance contract additionally requires the
pinned OS base manifest.

Compliance retains the reused base's exact native project source and Buildroot
archives alongside the current Guest project source and JavaScript inventory.
Both target and Host Buildroot manifests, licenses, and source archives are
included: Host compiler tools are copied into the shipped Build root, so their
source belongs in the offer too. The existing signed source archive and inventory
cover these files. No signing key is passed into a builder container.

## Local commands and artifact custody

Use the repository's Node/npm toolchain and a Linux arm64 Docker builder. From
the repository root, create an OS base without signing a Guest release:

```sh
npm run capsule-guest:os-base
```

The command reports the digest and the directory under
`.lamarck/build/capsule-guest/os-bases/<manifest-sha256>`. It refuses to overwrite
different output. Preserve the complete directory with modes intact; an ordinary
download cache is separate and cannot serve as this artifact.

For a later Guest-program release, use the reported path and independently
retained digest, plus the same epoch and job settings used for the base:

```sh
export LAMARCK_GUEST_OS_BASE=/absolute/path/to/verified-base
export LAMARCK_GUEST_OS_BASE_DIGEST=sha256:<full-manifest-digest>
export SOURCE_DATE_EPOCH=0
export JOBS=4
export LAMARCK_GUEST_SIGNING_KEY=/absolute/path/outside/repository/guest-private.pem
npm run capsule-guest:image
```

Both base variables must be supplied together. The builder image must resolve
to the same immutable image ID. If restoring the archived builder with Docker,
set `LAMARCK_GUEST_BUILDER_IMAGE_ID` to its reviewed full image ID; this skips
rebuilding the builder and still requires an explicitly pinned matching base.
With no base selected, the command builds and
retains a fresh OS base before assembling the current programs. A successful
full build leaves the existing signed release directory in place; choose a clean
build workspace for the next release instead of overwriting it.

The tag-driven GitHub workflow runs `scripts/guest-os-base-ci.mjs restore` before
the build. It reads the reviewed `desktop/capsule-guest/os-base-pin.json` from
the tagged checkout. If native inputs match, it downloads the pinned archive
from the existing R2 releases bucket, verifies its exact size and digest before
extraction, verifies the base, loads and checks the exact Linux arm64 builder,
then supplies all three variables to the existing build command. Saving the
builder is necessary because rebuilding identical Docker inputs on a new runner
does not guarantee the same image ID.

After the complete Guest passes signing, boot smoke, and Desktop Host checks,
the workflow saves a newly built base and its builder together in R2. It verifies
the archive through the public domain before proposing its pin alongside the
Guest release pin in the existing PR. Review and merge both pins before creating
the next Guest tag. A matching base is reused without uploading a replacement.
No pin exists before the first real build; no placeholder digest is checked in.

Only an absent initial pin or changed native inputs selects a fresh build. A
malformed pin, missing object, bad digest, mismatched base, or wrong builder
fails explicitly. To deliberately rebuild unchanged native inputs, remove the
base pin in a reviewed source change before tagging. The immutable archive
includes native source/license records and is retained alongside release objects;
it is not an Actions download cache or a runtime update channel.

The command reports native-build seconds, current JavaScript-build seconds, and
assembly milliseconds. Reuse skips Buildroot compilation, kernel, Node, runc,
native helpers, toolchain/root construction, and legal-info generation. It still
builds/verifies the builder image, hashes and stages the base, builds JavaScript,
assembles the image, generates current compliance metadata, signs, and boots it.
Measure a real release to quantify savings; small synthetic ext4 tests do not
predict full-image build or copy time.

## Initial and subsequent release order

The first rollout of this pre-release contract requires a newly built Guest with
the artifact receiver, catalog-free bridge, and fixed CLI mountpoint. Build,
sign, boot-test, and publish that Guest through the normal release process;
review its generated Guest pin before releasing Desktop with that pin and the
packaged managed CLI. Historical Guests and Desktops are not supported by this
updated contract. Existing checked-in release pins are deliberately not changed
by implementation work.

After this initial rollout:

- Ordinary business-command additions: ship matching Desktop Host and managed
  CLI; optionally publish the standalone npm CLI. Retain the Guest pin.
- Guest-local bridge, transport boundary, supervisor, or offline-npm changes:
  reuse a matching pinned OS base, produce and validate a new signed Guest, then
  update the Desktop Guest pin.
- OS/native, builder-image, epoch, or job-setting changes: produce a new OS base
  and a new signed Guest before updating the Desktop pin.

Operation advertisements express support, not authorization. The Guest forwards
ordinary commands without a business catalog; the Host still validates requests
and authorizes each attributed workload. New Guest-local behavior, upload kinds,
or framing require a deliberate Guest change. No schema/protocol identifiers,
migrations, legacy validators, or compatibility adapters are introduced by this
split.
