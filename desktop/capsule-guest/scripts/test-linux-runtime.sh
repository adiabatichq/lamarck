#!/bin/sh

set -eu

guest="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
repo="$(CDPATH= cd -- "$guest/../.." && pwd)"
image=lamarck-capsule-linux-test:20260624
require_erofs="${LAMARCK_REQUIRE_EROFS:-0}"
case "$require_erofs" in
	0|1) ;;
	*) echo "LAMARCK_REQUIRE_EROFS must be 0 or 1" >&2; exit 64 ;;
esac
context="$(mktemp -d "${TMPDIR:-/tmp}/lamarck-linux-e2e.XXXXXX")"

cleanup() {
	rm -rf "$context"
}
trap cleanup EXIT HUP INT TERM

# Bundle the production policy and LinuxRuncDriver from the current tree. The
# privileged image never carries a handwritten OCI config or a test runc
# adapter, so this gate fails if the shipped boundary cannot launch itself.
"$repo/node_modules/.bin/esbuild" \
	"$guest/test-linux/driver-harness.ts" \
	--bundle \
	--platform=node \
	--target=node24 \
	--format=esm \
	--outfile="$context/driver-harness.mjs"
"$repo/node_modules/.bin/esbuild" \
	"$guest/test-linux/build-driver-harness.ts" \
	--bundle \
	--platform=node \
	--target=node24 \
	--format=esm \
	--outfile="$context/build-driver-harness.mjs"
"$repo/node_modules/.bin/esbuild" \
	"$guest/test-linux/warm-mount-harness.ts" \
	--bundle \
	--platform=node \
	--target=node24 \
	--format=esm \
	--outfile="$context/warm-mount-harness.mjs"
"$repo/node_modules/.bin/esbuild" \
	"$guest/src/offline-npm.ts" \
	--bundle \
	--platform=node \
	--target=node24 \
	--format=esm \
	--outfile="$context/offline-npm.mjs"
"$repo/node_modules/.bin/esbuild" \
	"$repo/desktop/core/src/index.ts" \
	--bundle \
	--platform=node \
	--target=node24 \
	--format=esm \
	--external:node:sqlite \
	--outfile="$context/core.mjs"
"$repo/node_modules/.bin/esbuild" \
	"$repo/desktop/core/src/guard-service/entry.ts" \
	--bundle \
	--platform=node \
	--target=node24 \
	--format=cjs \
	--external:node:sqlite \
	--outfile="$context/guard-service.cjs"
cp "$guest/test-linux/Dockerfile" "$context/Dockerfile"
cp "$guest/test-linux/run.sh" "$context/run.sh"
cp "$guest/test-linux/run-build.sh" "$context/run-build.sh"
cp "$guest/test-linux/runtime-probe.c" "$context/runtime-probe.c"
cp "$guest/test-linux/build-policy-probe.c" "$context/build-policy-probe.c"

docker build --progress plain --platform linux/arm64 -t "$image" "$context"
docker run --rm --platform linux/arm64 --privileged \
	-e "LAMARCK_REQUIRE_EROFS=$require_erofs" \
	"$image"
