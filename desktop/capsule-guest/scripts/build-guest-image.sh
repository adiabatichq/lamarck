#!/bin/sh

set -eu

guest="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
repo="$(CDPATH= cd -- "$guest/../.." && pwd)"
work="$repo/.lamarck/build/capsule-guest"
release="$work/release"
key="${LAMARCK_GUEST_SIGNING_KEY:-}"
version="${LAMARCK_GUEST_IMAGE_VERSION:-0.1.0}"
base_only=0
case "${1:-}" in
  "") [ "$#" = 0 ] || exit 64 ;;
  "--os-base-only") [ "$#" = 1 ] || exit 64; base_only=1 ;;
  *) echo "usage: build-guest-image.sh [--os-base-only]" >&2; exit 64 ;;
esac
os_base_requested="${LAMARCK_GUEST_OS_BASE:-}"
os_base_pin="${LAMARCK_GUEST_OS_BASE_DIGEST:-}"
epoch="${SOURCE_DATE_EPOCH:-0}"
jobs="${JOBS:-4}"
if { [ -n "$os_base_requested" ] && [ -z "$os_base_pin" ]; } || { [ -z "$os_base_requested" ] && [ -n "$os_base_pin" ]; }; then
  echo "LAMARCK_GUEST_OS_BASE and LAMARCK_GUEST_OS_BASE_DIGEST must be supplied together" >&2
  exit 64
fi
download_cache_requested="${LAMARCK_GUEST_BUILDROOT_DOWNLOAD_CACHE:-}"
case "$download_cache_requested" in
	"") ;;
	"1") ;;
	*)
		echo "LAMARCK_GUEST_BUILDROOT_DOWNLOAD_CACHE must be unset or exactly 1" >&2
		exit 64
		;;
esac
if [ "$base_only" = 0 ]; then
[ -n "$key" ] || { echo "LAMARCK_GUEST_SIGNING_KEY must name an Ed25519 private PEM key" >&2; exit 64; }
if [ -e "$release" ] || [ -L "$release" ]; then
	echo "Guest release already exists at $release; refusing to overwrite signed output" >&2
	exit 73
fi
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

if [ "$base_only" = 0 ]; then
  node "$guest/scripts/validate-signing-key.mjs" "$key" "$repo"
fi
snapshot="$build_staging/source-snapshot"
prebuilt="$build_staging/prebuilt"
os_base="$build_staging/os-base"
assembly_root="$build_staging/assembly"
build_export="$assembly_root/export"
node "$guest/scripts/prepare-build-snapshot.mjs" create "$repo" "$snapshot"
mkdir -m 0700 "$prebuilt" "$assembly_root"
snapshot_guest="$snapshot/desktop/capsule-guest"
builder_iid_file="$build_staging/builder-image-id"
host_uid="$(id -u)"
host_gid="$(id -g)"
case "$host_uid:$host_gid" in
	*[!0-9:]*|:*|*:)
		echo "Host UID and GID must be non-negative decimal integers" >&2
		exit 70
		;;
esac
download_cache=""
if [ "$download_cache_requested" = "1" ]; then
	download_cache="$(node \
		"$snapshot_guest/scripts/validate-buildroot-download-cache.mjs" "$repo")"
	[ -n "$download_cache" ] || {
		echo "Buildroot download cache validator returned an empty path" >&2
		exit 70
	}
fi

restored_builder="${LAMARCK_GUEST_BUILDER_IMAGE_ID:-}"
if [ -n "$restored_builder" ]; then
  [ -n "$os_base_requested" ] || { echo "A restored builder requires an explicitly pinned OS base" >&2; exit 64; }
  # The base identity below binds this image ID to the current native sources.
  docker image inspect --format '{{.Id}}' "$restored_builder" > "$builder_iid_file"
  [ "$(cat "$builder_iid_file")" = "$restored_builder" ] || exit 65
else
docker build --platform linux/arm64 \
	--iidfile "$builder_iid_file" \
	-f "$snapshot/desktop/capsule-guest/buildroot/Dockerfile" \
	"$snapshot/desktop/capsule-guest/buildroot"
fi
builder_image_id="$(node "$snapshot_guest/scripts/docker-image-id.mjs" "$builder_iid_file")"
reclaim_builder_outputs() {
	[ "$(uname -s)" = Linux ] || return 0
	docker run --rm --platform linux/arm64 \
		--network none \
		--read-only \
		--cap-drop ALL \
		--cap-add CHOWN \
		--cap-add DAC_READ_SEARCH \
		--security-opt no-new-privileges:true \
		--pids-limit 64 \
		--user 0:0 \
		-v "$prebuilt:/prebuilt" \
		-v "$os_base:/os-base" \
		-v "$assembly_root:/assembly" \
		--entrypoint /usr/bin/chown \
		"$builder_image_id" \
		-R "$host_uid:$host_gid" /prebuilt /os-base /assembly
}
# Validate the selected identity before compiling anything expensive.
node --input-type=module -e '
  const { describeOsBaseInputs } = await import(process.argv[1]);
  await describeOsBaseInputs(...process.argv.slice(2));
' "$snapshot_guest/scripts/os-base.mjs" "$snapshot" "$builder_image_id" "$epoch" "$jobs"
if [ -n "$os_base_requested" ]; then
  node "$snapshot_guest/scripts/os-base.mjs" stage \
    "$os_base_requested" "$os_base_pin" "$snapshot" "$builder_image_id" "$epoch" "$jobs" "$os_base"
  echo "Reusing verified OS base $os_base_pin; skipping Buildroot, kernel, Node, runc, native helpers, toolchain and legal-info builds"
else
  mkdir -m 0700 "$os_base"
  native_started="$(date +%s)"
  set -- docker run --rm --platform linux/arm64
  if [ -n "$download_cache" ]; then
    set -- "$@" \
      --mount "type=bind,source=$download_cache,target=/buildroot-download-cache" \
      -e LAMARCK_BUILDROOT_DOWNLOAD_CACHE=/buildroot-download-cache
  fi
  set -- "$@" \
    -v "$snapshot:/src:ro" \
    -v "$os_base:/export" \
    -e SOURCE_DATE_EPOCH="$epoch" \
    -e JOBS="$jobs" \
    -e LAMARCK_BUILD_EXPORT=/export \
    "$builder_image_id" \
    /src/desktop/capsule-guest/scripts/build-buildroot-inside.sh
  "$@"
  reclaim_builder_outputs
  node "$snapshot_guest/scripts/prepare-build-snapshot.mjs" verify "$snapshot"
  os_base_pin="$(node "$snapshot_guest/scripts/os-base.mjs" create "$os_base" "$snapshot" "$builder_image_id" "$epoch" "$jobs")"
  echo "OS/native build completed in $(($(date +%s) - native_started)) seconds; base $os_base_pin"
  base_destination="$work/os-bases/${os_base_pin#sha256:}"
  mkdir -p "$work/os-bases"
  if [ -e "$base_destination" ] || [ -L "$base_destination" ]; then
    node "$snapshot_guest/scripts/os-base.mjs" verify "$base_destination" "$os_base_pin" "$snapshot" "$builder_image_id" "$epoch" "$jobs"
  else
    node "$snapshot_guest/scripts/publish-guest-release.mjs" "$os_base" "$base_destination" "$build_staging/rename-base-excl"
    os_base="$base_destination"
  fi
  echo "Reusable OS base: $base_destination"
fi
if [ "$base_only" = 1 ]; then
  echo "OS base pin: $os_base_pin"
  exit 0
fi
js_started="$(date +%s)"
docker run --rm --platform linux/arm64 \
  --network bridge \
  -v "$snapshot:/snapshot:ro" \
  -v "$prebuilt:/prebuilt" \
  -e LAMARCK_BUILD_SNAPSHOT=/snapshot \
  -e LAMARCK_JS_BUILD_EXPORT=/prebuilt \
  "$builder_image_id" \
  /bin/sh /snapshot/desktop/capsule-guest/scripts/build-js-inside.sh
reclaim_builder_outputs
node "$snapshot_guest/scripts/prepare-build-snapshot.mjs" verify "$snapshot"
echo "Guest JavaScript build completed in $(($(date +%s) - js_started)) seconds"
docker run --rm --platform linux/arm64 \
  --network none \
  -v "$snapshot:/snapshot:ro" \
  -v "$prebuilt:/prebuilt:ro" \
  -v "$os_base:/base:ro" \
  -v "$assembly_root:/assembly" \
  "$builder_image_id" \
  node /snapshot/desktop/capsule-guest/scripts/assemble-guest-programs.mjs \
  /base "$os_base_pin" /prebuilt /snapshot /assembly/export "$builder_image_id" "$epoch" "$jobs"
reclaim_builder_outputs
node "$snapshot_guest/scripts/prepare-build-snapshot.mjs" verify "$snapshot"

release_staging="$(mktemp -d "$work/release-staging.XXXXXX")"
node "$snapshot_guest/scripts/generate-compliance.mjs" \
	"$build_export/output/legal-info" \
	"$build_export/src/buildroot-2026.05.tar.xz" \
	"$snapshot" \
	"$release_staging/compliance" \
	"$version" \
	"$builder_image_id" \
	"$os_base" "$os_base_pin" "$jobs"
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
node "$snapshot_guest/scripts/verify-guest-release.mjs" "$release" --require-source
