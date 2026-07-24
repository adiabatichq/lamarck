#!/bin/sh

set -eu

root=/work
source_root="$root/source"
artifact="$root/artifact.erofs"
scratch="$root/scratch.ext4"
runtime_mount=/var/lib/lamarck/runtime
rootfs=/opt/lamarck/rootfs/node24
runc_root=/run/lamarck/runc-driver-integration
app_handle=AAAAAAAAAAAAAAAAAAAAAA
app_b_handle=DDDDDDDDDDDDDDDDDDDDDD
oneshot_handle=BBBBBBBBBBBBBBBBBBBBBB
long_running_handle=CCCCCCCCCCCCCCCCCCCCCC
isolation_a_handle=EEEEEEEEEEEEEEEEEEEEEE
isolation_b_handle=FFFFFFFFFFFFFFFFFFFFFF
system_rpc_handle=GGGGGGGGGGGGGGGGGGGGGG
artifact_hex=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
app_key="a-$(printf '%s' "$app_handle" | sha256sum | cut -c1-32)"
app_b_key="a-$(printf '%s' "$app_b_handle" | sha256sum | cut -c1-32)"
oneshot_key="w-$(printf '%s' "$oneshot_handle" | sha256sum | cut -c1-32)"
long_running_key="w-$(printf '%s' "$long_running_handle" | sha256sum | cut -c1-32)"
isolation_a_key="w-$(printf '%s' "$isolation_a_handle" | sha256sum | cut -c1-32)"
isolation_b_key="w-$(printf '%s' "$isolation_b_handle" | sha256sum | cut -c1-32)"
system_rpc_key="w-$(printf '%s' "$system_rpc_handle" | sha256sum | cut -c1-32)"
artifact_root="/var/lib/lamarck/artifacts/sha256/$artifact_hex/root"
runtime_root="$runtime_mount/$app_key"
runtime_root_b="$runtime_mount/$app_b_key"
merged="$runtime_root/merged"
merged_b="$runtime_root_b/merged"
network_namespace="/run/lamarck/netns/$app_key"
network_namespace_b="/run/lamarck/netns/$app_b_key"
workload_cgroup_parent="/sys/fs/cgroup/lamarck/apps/$app_key/workloads"
workload_cgroup_parent_b="/sys/fs/cgroup/lamarck/apps/$app_b_key/workloads"
mounted_lower=0
mounted_scratch=0
mounted_overlay=0
mounted_overlay_b=0
mounted_network_namespace=0
mounted_network_namespace_b=0
named_network_namespace=0
named_network_namespace_b=0

cleanup() {
	for container in "$system_rpc_key" "$isolation_b_key" "$isolation_a_key" "$long_running_key" "$oneshot_key"; do
		runc --root "$runc_root" kill "$container" KILL >/dev/null 2>&1 || true
		runc --root "$runc_root" delete --force "$container" >/dev/null 2>&1 || true
	done
	[ "$mounted_overlay_b" -eq 0 ] || umount "$merged_b" >/dev/null 2>&1 || true
	[ "$mounted_overlay" -eq 0 ] || umount "$merged" >/dev/null 2>&1 || true
	[ "$mounted_lower" -eq 0 ] || umount "$artifact_root" >/dev/null 2>&1 || true
	[ "$mounted_scratch" -eq 0 ] || umount "$runtime_mount" >/dev/null 2>&1 || true
	[ "$mounted_network_namespace_b" -eq 0 ] || umount "$network_namespace_b" >/dev/null 2>&1 || true
	[ "$mounted_network_namespace" -eq 0 ] || umount "$network_namespace" >/dev/null 2>&1 || true
	[ "$named_network_namespace_b" -eq 0 ] || ip netns del "$app_b_key" >/dev/null 2>&1 || true
	[ "$named_network_namespace" -eq 0 ] || ip netns del "$app_key" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

test "$(id -u)" -eq 0
test "$(node --version)" = v24.18.0
test -x /usr/sbin/runc
test -f /sys/fs/cgroup/cgroup.controllers

# Docker places its init and this test process in the cgroup namespace root.
# Move all residents to a leaf before enabling delegation, mirroring the Guest
# supervisor hierarchy and satisfying cgroup v2's no-internal-process rule.
mkdir -p /sys/fs/cgroup/integration-init
while read -r pid; do
	printf '%s\n' "$pid" > /sys/fs/cgroup/integration-init/cgroup.procs 2>/dev/null || true
done < /sys/fs/cgroup/cgroup.procs

enable_controllers() {
	path="$1"
	controllers="$(cat "$path/cgroup.controllers")"
	[ -z "$controllers" ] || printf '%s\n' "$controllers" \
		| sed -e 's/^/+/' -e 's/ / +/g' > "$path/cgroup.subtree_control"
}

enable_controllers /sys/fs/cgroup
mkdir -p /sys/fs/cgroup/lamarck
enable_controllers /sys/fs/cgroup/lamarck
mkdir -p /sys/fs/cgroup/lamarck/apps
enable_controllers /sys/fs/cgroup/lamarck/apps
mkdir -p "/sys/fs/cgroup/lamarck/apps/$app_key"
enable_controllers "/sys/fs/cgroup/lamarck/apps/$app_key"
mkdir -p "$workload_cgroup_parent"
enable_controllers "$workload_cgroup_parent"
mkdir -p "/sys/fs/cgroup/lamarck/apps/$app_b_key"
enable_controllers "/sys/fs/cgroup/lamarck/apps/$app_b_key"
mkdir -p "$workload_cgroup_parent_b"
enable_controllers "$workload_cgroup_parent_b"

# The App joins one pinned, loopback-only network namespace. There is no veth,
# host namespace, or raw network fallback available to the workload.
mkdir -p /run/netns /run/lamarck/netns
ip netns add "$app_key"
named_network_namespace=1
ip -n "$app_key" link set lo up
# Some kernels create dormant tunnel devices in every new netns. They carry no
# route and no link; assert the security property (only loopback is up, and no
# default route) instead of assuming the namespace contains one device entry.
test -z "$(ip -n "$app_key" -o link show up | sed -n '/: lo:/d;p')"
test -z "$(ip -n "$app_key" route show default)"
: > "$network_namespace"
mount --bind "/run/netns/$app_key" "$network_namespace"
mounted_network_namespace=1

ip netns add "$app_b_key"
named_network_namespace_b=1
ip -n "$app_b_key" link set lo up
test -z "$(ip -n "$app_b_key" -o link show up | sed -n '/: lo:/d;p')"
test -z "$(ip -n "$app_b_key" route show default)"
: > "$network_namespace_b"
mount --bind "/run/netns/$app_b_key" "$network_namespace_b"
mounted_network_namespace_b=1

mkdir -p \
	"$source_root/node_modules/.vite" \
	"$artifact_root" \
	"$runtime_mount" \
	"$rootfs/bin" \
	"$rootfs/app" \
	"$rootfs/proc" \
	"$rootfs/dev/pts" \
	"$rootfs/dev/shm" \
	"$rootfs/dev/mqueue" \
	"$rootfs/home/app" \
	"$rootfs/run/app" \
	"$rootfs/run/lamarck" \
	"$rootfs/tmp" \
	"$rootfs/etc" \
	/opt/lamarck/config \
	/run/lamarck/bundles \
	/run/lamarck/tmp \
	"$runc_root"
printf 'base\n' > "$source_root/existing.txt"
printf 'seed\n' > "$source_root/node_modules/.vite/seed.txt"
find "$source_root" -type d -exec chmod 0777 {} +
find "$source_root" -type f -exec chmod 0666 {} +

mkfs.erofs --all-root -T 0 "$artifact" "$source_root" >/dev/null
if mount -t erofs -o loop,ro,nosuid,nodev "$artifact" "$artifact_root" 2>/dev/null; then
	lower_backend=erofs
else
	fsck.erofs "$artifact" >/dev/null
	[ "${LAMARCK_REQUIRE_EROFS:-0}" != 1 ] || {
		echo "kernel EROFS support is required for this release gate" >&2
		exit 1
	}
	# Docker Desktop currently omits CONFIG_EROFS_FS. The exact EROFS bytes
	# remain generated and checked; a read-only bind preserves the overlay/COW
	# portion of this portable developer gate.
	mount --bind "$source_root" "$artifact_root"
	mount -o remount,bind,ro,nosuid,nodev "$artifact_root"
	lower_backend=readonly-bind-fallback
fi
mounted_lower=1

truncate -s 268435456 "$scratch"
mkfs.ext4 -q -F -L LAMARCK_TEST "$scratch"
mount -o loop,nosuid,nodev "$scratch" "$runtime_mount"
mounted_scratch=1
mkdir -p "$runtime_root/upper" "$runtime_root/work" "$merged" \
	"$runtime_root/home" "$runtime_root/run"
mkdir -p "$runtime_root_b/upper" "$runtime_root_b/work" "$merged_b" \
	"$runtime_root_b/home" "$runtime_root_b/run"
mount -t overlay overlay \
	-o "lowerdir=$artifact_root,upperdir=$runtime_root/upper,workdir=$runtime_root/work,nosuid,nodev" \
	"$merged"
mounted_overlay=1
mount -t overlay overlay \
	-o "lowerdir=$artifact_root,upperdir=$runtime_root_b/upper,workdir=$runtime_root_b/work,nosuid,nodev" \
	"$merged_b"
mounted_overlay_b=1
chown 101000:201000 "$merged" "$runtime_root/home" "$runtime_root/run"
chown 301000:401000 "$merged_b" "$runtime_root_b/home" "$runtime_root_b/run"
chmod 0755 "$merged" "$runtime_root/home" "$runtime_root/run"
chmod 0755 "$merged_b" "$runtime_root_b/home" "$runtime_root_b/run"

install -m 0755 /usr/local/libexec/capsule-runtime-probe "$rootfs/bin/capsule-runtime-probe"
: > "$rootfs/etc/resolv.conf"
: > "$rootfs/etc/hosts"
: > /opt/lamarck/config/empty-resolv.conf
printf '127.0.0.1 localhost\n::1 localhost\n' > /opt/lamarck/config/loopback-hosts
chmod 0444 /opt/lamarck/config/empty-resolv.conf /opt/lamarck/config/loopback-hosts
chown -R 100000:200000 "$rootfs"
find "$rootfs" -type d -exec chmod 0755 {} +
chmod 0755 "$rootfs/bin/capsule-runtime-probe"

test "$(findmnt -n -o FSTYPE --target "$runtime_mount")" = ext4
test "$(findmnt -n -o FSTYPE --target "$merged")" = overlay
test "$(findmnt -n -o FSTYPE --target "$merged_b")" = overlay
if [ "$lower_backend" = erofs ]; then
	test "$(findmnt -n -o FSTYPE --target "$artifact_root")" = erofs
fi

node /usr/local/libexec/lamarck-linux-driver-integration.mjs

test "$(cat "$merged/existing.txt")" = "$(printf 'base\nappend')"
test "$(cat "$merged/renamed.txt")" = new
test "$(cat "$merged/node_modules/.vite/cache/result.txt")" = cache
test "$(cat "$artifact_root/existing.txt")" = base
printf 'production driver + uid/gid mapping + seccomp + %s/overlay + cgroup teardown passed\n' \
	"$lower_backend"

/usr/local/bin/lamarck-build-integration
