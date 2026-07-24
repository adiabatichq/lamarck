#!/bin/sh

set -eu

repo=/src
prebuilt="${LAMARCK_PREBUILT_ROOT:-/prebuilt}"
work=/work
version=2026.05
archive="buildroot-$version.tar.xz"
url="https://buildroot.org/downloads/$archive"
expected=9d2f3af10fcac763a61ff6e41894a033f9ecf9267ba13dd0912eedcd3be2b22a
source="$work/src/buildroot-$version"
external="$repo/desktop/capsule-guest/buildroot"
buildroot_hash_patch="$external/buildroot-patches/0001-download-force-hashes-reject-missing-hash-files.patch"
download_cache="${LAMARCK_BUILDROOT_DOWNLOAD_CACHE:-}"
case "$download_cache" in
	"") download_root="$work/dl" ;;
	"/buildroot-download-cache")
		[ -d "$download_cache" ] && [ ! -L "$download_cache" ] || {
			echo "fixed Buildroot download cache mount is unavailable" >&2
			exit 73
		}
		download_root="$download_cache"
		;;
	*)
		echo "unexpected Buildroot download cache mount path" >&2
		exit 64
		;;
esac
cache_publish_temp=""
cleanup_cache_publish_temp() {
	if [ -n "$cache_publish_temp" ]; then
		case "$cache_publish_temp" in
			"$download_cache"/.buildroot-2026.05.tar.xz.*)
				rm -f -- "$cache_publish_temp"
				;;
			*) echo "refusing to clean unexpected Buildroot cache staging path" >&2 ;;
		esac
	fi
}
if [ -n "$download_cache" ]; then
	trap cleanup_cache_publish_temp EXIT HUP INT TERM
fi

node "$repo/desktop/capsule-guest/scripts/prepare-build-snapshot.mjs" verify "$repo"
node "$repo/desktop/capsule-guest/scripts/verify-js-builder-output.mjs" \
	"$prebuilt" "$repo"

mkdir -p "$work/src" "$download_root" "$work/output"
archive_path="$work/src/$archive"
cache_archive=""
if [ -n "$download_cache" ]; then
	cache_archive="$download_cache/$archive"
fi
if [ -n "$cache_archive" ] && { [ -e "$cache_archive" ] || [ -L "$cache_archive" ]; }; then
	[ -f "$cache_archive" ] && [ ! -L "$cache_archive" ] || {
		echo "cached Buildroot source is not a regular file" >&2
		exit 65
	}
	cp -- "$cache_archive" "$archive_path.partial"
	if ! printf '%s  %s\n' "$expected" "$archive_path.partial" | sha256sum -c -; then
		rm -f -- "$archive_path.partial"
		echo "cached Buildroot source failed its pinned SHA-256" >&2
		exit 65
	fi
	mv "$archive_path.partial" "$archive_path"
else
	wget -O "$archive_path.partial" "$url"
	mv "$archive_path.partial" "$archive_path"
fi
printf '%s  %s\n' "$expected" "$archive_path" | sha256sum -c -
if [ -n "$cache_archive" ] && [ ! -e "$cache_archive" ] && [ ! -L "$cache_archive" ]; then
	cache_publish_temp="$(mktemp "$download_cache/.buildroot-2026.05.tar.xz.XXXXXX")"
	cp -- "$archive_path" "$cache_publish_temp"
	printf '%s  %s\n' "$expected" "$cache_publish_temp" | sha256sum -c -
	if ! ln -- "$cache_publish_temp" "$cache_archive" 2>/dev/null; then
		[ -f "$cache_archive" ] && [ ! -L "$cache_archive" ] || {
			echo "concurrent Buildroot source cache publication created an invalid entry" >&2
			exit 65
		}
		printf '%s  %s\n' "$expected" "$cache_archive" | sha256sum -c -
	fi
	rm -f -- "$cache_publish_temp"
	cache_publish_temp=""
fi
if [ ! -f "$source/Makefile" ]; then
	rm -rf "$source"
	tar -C "$work/src" -xf "$archive_path"
fi
patch --batch --forward --fuzz=0 --strip=1 --directory="$source" \
	< "$buildroot_hash_patch"

export BR2_DL_DIR="$download_root"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
# The isolated builder runs as root against container-private /work. Outputs are
# exported only after the complete image and legal-info targets succeed.
export FORCE_UNSAFE_CONFIGURE=1
export LAMARCK_PREBUILT_ROOT="$prebuilt"
make -C "$source" O="$work/output" \
	BR2_EXTERNAL="$external" \
	lamarck_capsule_arm64_defconfig
node "$repo/desktop/capsule-guest/scripts/verify-buildroot-hash-policy.mjs" \
	"$source" "$work/output" "$external"
make -C "$source" O="$work/output" \
	BR2_EXTERNAL="$external" \
	"-j${JOBS:-$(nproc)}"
make -C "$source" O="$work/output" \
	BR2_EXTERNAL="$external" \
	legal-info

test -s "$work/output/images/Image"
test -s "$work/output/images/rootfs.ext4"
test -s "$work/output/legal-info/manifest.csv"
test -s "$work/output/legal-info/legal-info.sha256"
kernel_config="$work/output/build/linux-6.18.39/.config"
test -s "$kernel_config"
# runc implements cgroup-v2 device rules with a cgroup BPF program.  Missing
# any of these turns the apparent deny-all device policy into a launch failure
# (or, on a regressed adapter, an unenforced policy), so image publication must
# prove the exact kernel prerequisites rather than trusting a fragment merge.
for symbol in CONFIG_BPF CONFIG_BPF_SYSCALL CONFIG_CGROUP_BPF \
	CONFIG_CGROUPS CONFIG_MEMCG CONFIG_CGROUP_PIDS CONFIG_CFS_BANDWIDTH \
	CONFIG_NAMESPACES CONFIG_USER_NS CONFIG_NET_NS CONFIG_SECCOMP \
	CONFIG_SECCOMP_FILTER CONFIG_OVERLAY_FS CONFIG_EROFS_FS \
	CONFIG_VSOCKETS CONFIG_VIRTIO_VSOCKETS; do
	grep -qx "$symbol=y" "$kernel_config" || {
		echo "required Capsule Guest kernel feature is missing: $symbol" >&2
		exit 1
	}
done
mkdir -p "$work/image-input"
cp "$work/output/images/Image" "$work/image-input/Image"
cp "$work/output/images/rootfs.ext4" "$work/image-input/rootfs.ext4"
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' \
	| LC_ALL=C sort > "$work/image-input/builder-packages.tsv"

if [ -n "${LAMARCK_BUILD_EXPORT:-}" ]; then
	export_root="$LAMARCK_BUILD_EXPORT"
	[ -d "$export_root" ] || { echo "Build export root is unavailable" >&2; exit 73; }
	[ -z "$(find "$export_root" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
		echo "Build export root is not empty" >&2
		exit 73
	}
	mkdir -p "$export_root/output/legal-info" "$export_root/src" \
		"$export_root/image-input" "$export_root/prebuilt-verification"
	cp -R --no-preserve=mode,ownership,timestamps \
		"$work/output/legal-info/." "$export_root/output/legal-info/"
	cp --no-preserve=mode,ownership,timestamps \
		"$work/src/$archive" "$export_root/src/$archive"
	cp --sparse=always --no-preserve=mode,ownership,timestamps \
		"$work/image-input/Image" "$work/image-input/rootfs.ext4" \
		"$work/image-input/builder-packages.tsv" "$export_root/image-input/"
	cp --no-preserve=mode,ownership,timestamps \
		"$prebuilt/js-builder-environment.json" \
		"$repo/build-input-manifest.json" "$export_root/image-input/"
	cp -R --no-preserve=mode,ownership,timestamps \
		"$prebuilt/." "$export_root/prebuilt-verification/"
fi
node "$repo/desktop/capsule-guest/scripts/verify-js-builder-output.mjs" \
	"$prebuilt" "$repo"
