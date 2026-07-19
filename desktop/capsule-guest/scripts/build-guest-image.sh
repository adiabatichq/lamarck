#!/bin/sh

set -eu

guest="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
repo="$(CDPATH= cd -- "$guest/../.." && pwd)"
work="$repo/.lamarck/build/capsule-guest"
release="$work/release"
key="${LAMARCK_GUEST_SIGNING_KEY:-}"
version="${LAMARCK_GUEST_IMAGE_VERSION:-0.1.0}"
download_cache_requested="${LAMARCK_GUEST_BUILDROOT_DOWNLOAD_CACHE:-}"
case "$download_cache_requested" in
	"") ;;
	"1") ;;
	*)
		echo "LAMARCK_GUEST_BUILDROOT_DOWNLOAD_CACHE must be unset or exactly 1" >&2
		exit 64
		;;
esac
[ -n "$key" ] || { echo "LAMARCK_GUEST_SIGNING_KEY must name an Ed25519 private PEM key" >&2; exit 64; }
if [ -e "$release" ] || [ -L "$release" ]; then
	echo "Guest release already exists at $release; refusing to overwrite signed output" >&2
	exit 73
fi
mkdir -p "$work"
build_staging="$(mktemp -d "$work/build-staging.XXXXXX")"
release_staging=""
cleanup() {
	case "$build_staging" in
		"$work"/build-staging.*) rm -rf -- "$build_staging" ;;
		*) echo "refusing to clean unexpected Build staging path" >&2 ;;
	esac
	if [ -n "$release_staging" ]; then
		case "$release_staging" in
			"$work"/release-staging.*) rm -rf -- "$release_staging" ;;
			*) echo "refusing to clean unexpected release staging path" >&2 ;;
		esac
	fi
}
trap cleanup EXIT HUP INT TERM

node "$guest/scripts/validate-signing-key.mjs" "$key" "$repo"
snapshot="$build_staging/source-snapshot"
prebuilt="$build_staging/prebuilt"
build_export="$build_staging/export"
node "$guest/scripts/prepare-build-snapshot.mjs" create "$repo" "$snapshot"
mkdir -m 0700 "$prebuilt" "$build_export"
snapshot_guest="$snapshot/desktop/capsule-guest"
builder_iid_file="$build_staging/builder-image-id"
download_cache=""
if [ "$download_cache_requested" = "1" ]; then
	download_cache="$(node \
		"$snapshot_guest/scripts/validate-buildroot-download-cache.mjs" "$repo")"
	[ -n "$download_cache" ] || {
		echo "Buildroot download cache validator returned an empty path" >&2
		exit 70
	}
fi

docker build --platform linux/arm64 \
	--iidfile "$builder_iid_file" \
	-f "$snapshot/desktop/capsule-guest/buildroot/Dockerfile" \
	"$snapshot/desktop/capsule-guest/buildroot"
builder_image_id="$(node "$snapshot_guest/scripts/docker-image-id.mjs" "$builder_iid_file")"
docker run --rm --platform linux/arm64 \
	--network bridge \
	-v "$snapshot:/snapshot:ro" \
	-v "$prebuilt:/prebuilt" \
	-e LAMARCK_BUILD_SNAPSHOT=/snapshot \
	-e LAMARCK_JS_BUILD_EXPORT=/prebuilt \
	"$builder_image_id" \
	/bin/sh /snapshot/desktop/capsule-guest/scripts/build-js-inside.sh
node "$snapshot_guest/scripts/prepare-build-snapshot.mjs" verify "$snapshot"
set -- docker run --rm --platform linux/arm64
if [ -n "$download_cache" ]; then
	set -- "$@" \
		--mount "type=bind,source=$download_cache,target=/buildroot-download-cache" \
		-e LAMARCK_BUILDROOT_DOWNLOAD_CACHE=/buildroot-download-cache
fi
set -- "$@" \
	-v "$snapshot:/src:ro" \
	-v "$prebuilt:/prebuilt:ro" \
	-v "$build_export:/export" \
	-e SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" \
	-e JOBS="${JOBS:-}" \
	-e LAMARCK_BUILD_EXPORT=/export \
	-e LAMARCK_PREBUILT_ROOT=/prebuilt \
	"$builder_image_id" \
	/src/desktop/capsule-guest/scripts/build-buildroot-inside.sh
"$@"
node "$snapshot_guest/scripts/prepare-build-snapshot.mjs" verify "$snapshot"

release_staging="$(mktemp -d "$work/release-staging.XXXXXX")"
node "$snapshot_guest/scripts/generate-compliance.mjs" \
	"$build_export/output/legal-info" \
	"$build_export/src/buildroot-2026.05.tar.xz" \
	"$snapshot" \
	"$release_staging/compliance" \
	"$version" \
	"$builder_image_id"
node "$snapshot_guest/scripts/sign-guest-image.mjs" \
	"$build_export/image-input" \
	"$release_staging/compliance" \
	"$release_staging/release" \
	"$key" \
	"$version" \
	"$repo"
node "$snapshot_guest/scripts/test-guest-image-boot.mjs" "$release_staging/release"
node "$snapshot_guest/scripts/publish-guest-release.mjs" \
	"$release_staging/release" \
	"$release" \
	"$build_staging/rename-excl"
node "$snapshot_guest/scripts/verify-guest-release.mjs" "$release"
