#!/bin/sh

set -eu

root=/work
build_rootfs=/opt/lamarck/rootfs/build-node24
scratch="$root/build-scratch.ext4"
artifact="$root/build-artifact.erofs"
artifact_mount="$root/build-artifact-root"
build_handle=EEEEEEEEEEEEEEEEEEEEEE
build_key="b-$(printf '%s' "$build_handle" | sha256sum | cut -c1-32)"
build_root="/var/lib/lamarck/builds/$build_key"
build_cgroup="/sys/fs/cgroup/lamarck/builds/$build_key"
netns_path="/run/lamarck/netns/$build_key"
runc_root=/run/lamarck/build-runc-integration
mapped_uid=101000
mapped_gid=201000
mounted_scratch=0
mounted_network_namespace=0
named_network_namespace=0
mounted_artifact=0

remove_cgroup_tree() {
	path="$1"
	[ -d "$path" ] || return 0
	for child in "$path"/*; do
		[ -d "$child" ] || continue
		remove_cgroup_tree "$child"
	done
	rmdir "$path" 2>/dev/null || true
}

cleanup() {
	runc_path=/usr/sbin/runc
	"$runc_path" --root "$runc_root" kill "$build_key" KILL >/dev/null 2>&1 || true
	"$runc_path" --root "$runc_root" delete --force "$build_key" >/dev/null 2>&1 || true
	[ "$mounted_artifact" -eq 0 ] || umount "$artifact_mount" >/dev/null 2>&1 || true
	[ "$mounted_network_namespace" -eq 0 ] || umount "$netns_path" >/dev/null 2>&1 || true
	[ "$named_network_namespace" -eq 0 ] || ip netns del "$build_key" >/dev/null 2>&1 || true
	[ "$mounted_scratch" -eq 0 ] || umount "$build_root" >/dev/null 2>&1 || true
	remove_cgroup_tree "$build_cgroup"
	rm -rf "$build_rootfs" "$artifact_mount"
	rm -f "$scratch" "$artifact"
}
trap cleanup EXIT HUP INT TERM

test "$(id -u)" -eq 0
test "$(node --version)" = v24.10.0
test -x /usr/sbin/runc
test -f /sys/fs/cgroup/cgroup.controllers

enable_controllers() {
	path="$1"
	controllers="$(cat "$path/cgroup.controllers")"
	[ -z "$controllers" ] || printf '%s\n' "$controllers" \
		| sed -e 's/^/+/' -e 's/ / +/g' > "$path/cgroup.subtree_control"
}

# The outer runtime gate established the delegated /lamarck hierarchy. Build
# cgroups use a separate parent so workload and Build admission never alias.
mkdir -p /sys/fs/cgroup/lamarck/builds
enable_controllers /sys/fs/cgroup/lamarck/builds

# A production Build joins one pre-created, loopback-only namespace. It has no
# veth, default route, inherited host namespace, or raw-network fallback.
mkdir -p /run/netns /run/lamarck/netns
ip netns add "$build_key"
named_network_namespace=1
ip -n "$build_key" link set lo up
test -z "$(ip -n "$build_key" -o link show up | sed -n '/: lo:/d;p')"
test -z "$(ip -n "$build_key" route show default)"
: > "$netns_path"
mount --bind "/run/netns/$build_key" "$netns_path"
mounted_network_namespace=1

# Mirror the production reduced Node root without relying on the full Guest
# image build. The OCI plan still selects the fixed production path and makes
# the resulting root read-only for every Build.
rm -rf "$build_rootfs"
mkdir -p "$build_rootfs/usr" "$build_rootfs/etc" "$build_rootfs/opt" \
	"$build_rootfs/proc" "$build_rootfs/dev/pts" "$build_rootfs/dev/shm" \
	"$build_rootfs/workspace" "$build_rootfs/dependencies" \
	"$build_rootfs/home/build" "$build_rootfs/tmp" "$build_rootfs/usr/libexec"
for name in bin sbin lib lib64; do
	[ ! -e "/$name" ] || cp -a "/$name" "$build_rootfs/$name"
done
for name in bin sbin lib lib64 local; do
	[ ! -e "/usr/$name" ] || cp -a "/usr/$name" "$build_rootfs/usr/$name"
done
for name in passwd group nsswitch.conf protocols services; do
	[ ! -e "/etc/$name" ] || cp -a "/etc/$name" "$build_rootfs/etc/$name"
done
: > "$build_rootfs/etc/resolv.conf"
: > "$build_rootfs/etc/hosts"
install -m 0755 /usr/local/libexec/lamarck-offline-npm.mjs \
	"$build_rootfs/usr/libexec/lamarck-offline-npm.production"
install -m 0755 /usr/local/libexec/lamarck-offline-npm.mjs \
	"$build_rootfs/usr/libexec/lamarck-offline-npm"
install -m 0755 /usr/local/libexec/lamarck-build-policy-probe \
	"$build_rootfs/usr/libexec/lamarck-build-policy-probe"

# The 512 MiB test volume is deliberately below the production 2 GiB ceiling,
# but exercises the same ext4 loop mount and proves writes cannot escape it.
rm -rf "$build_root"
truncate -s 536870912 "$scratch"
mkfs.ext4 -q -F -m 0 -L LBUILDTEST "$scratch"
mkdir -p "$build_root"
mount -o loop,rw,nodev,nosuid,noatime "$scratch" "$build_root"
mounted_scratch=1
mkdir -p "$build_root/workspace" "$build_root/dependencies/tarballs" "$build_root/home"
printf '{"version":1,"entries":[]}\n' > "$build_root/dependencies/manifest.json"
chown -R "$mapped_uid:$mapped_gid" "$build_root"
chmod 0755 "$build_root/workspace" "$build_root/dependencies" \
	"$build_root/dependencies/tarballs" "$build_root/home"
test "$(findmnt -n -o FSTYPE --target "$build_root")" = ext4
scratch_device="$(findmnt -n -o SOURCE --target "$build_root")"
test "$(blockdev --getsize64 "$scratch_device")" -eq 536870912

mkdir -p "$runc_root" /run/lamarck/bundles /run/lamarck/tmp
node /usr/local/libexec/lamarck-build-driver-integration.mjs

# Seal the successful recovery tree exactly as an immutable Build artifact and
# verify its bytes even on Docker Desktop kernels that omit CONFIG_EROFS_FS.
mkdir -p "$build_root/workspace/node_modules/warm-fixture"
printf 'sealed-dependency\n' > \
	"$build_root/workspace/node_modules/warm-fixture/index.txt"
mkfs.erofs --all-root -T 0 "$artifact" "$build_root/workspace" >/dev/null
fsck.erofs "$artifact" >/dev/null
mkdir -p "$artifact_mount"
if mount -t erofs -o loop,ro,nosuid,nodev "$artifact" "$artifact_mount" 2>/dev/null; then
	mounted_artifact=1
	test "$(cat "$artifact_mount/build-policy-success.txt")" = policy-ok
	if printf 'mutate\n' > "$artifact_mount/should-fail" 2>/dev/null; then
		echo "sealed Build artifact accepted a write" >&2
		exit 1
	fi
	warm_mount_source="$artifact_mount/node_modules"
	warm_mount_backend=erofs-readonly-bind
	artifact_backend=erofs
else
	[ "${LAMARCK_REQUIRE_EROFS:-0}" != 1 ] || {
		echo "kernel EROFS support is required for this release gate" >&2
		exit 1
	}
	artifact_backend=verified-erofs-bytes
	# Docker Desktop commonly omits CONFIG_EROFS_FS. The production EROFS
	# bytes remain fsck-verified above; exercise the exact bind/remount/detach
	# implementation against the same dependency tree on ext4 instead.
	warm_mount_source="$build_root/workspace/node_modules"
	warm_mount_backend=ext4-readonly-bind
fi
mkdir -p "$build_root/warm-candidate"
node /usr/local/libexec/lamarck-warm-mount-integration.mjs \
	"$warm_mount_source" \
	"$build_root/warm-candidate/node_modules"
test ! -e "$build_root/warm-candidate/node_modules"

# Resource creator cleanup is explicit and proven before returning control to
# the outer Guest gate. The runner already proved creator/container quiescence.
umount "$netns_path"
mounted_network_namespace=0
ip netns del "$build_key"
named_network_namespace=0
rm -f "$netns_path"
umount "$build_root"
mounted_scratch=0
rm -rf "$build_root"
rm -f "$scratch"
remove_cgroup_tree "$build_cgroup"
test ! -e "$netns_path"
test ! -d "$build_cgroup"
test ! -e "$build_root"
test ! -e "/run/lamarck/bundles/$build_key"
if runc --root "$runc_root" state "$build_key" >/dev/null 2>&1; then
	echo "retired Build retained runc state" >&2
	exit 1
fi
printf 'production Build runc + bounded ext4/%s + authoritative cleanup passed\n' \
	"$artifact_backend"
printf 'dependency-stable warm mount backend: %s\n' "$warm_mount_backend"
