#!/bin/sh

set -eu

target="${1:?Buildroot target directory is required}"
external="${BR2_EXTERNAL_LAMARCK_PATH:?BR2_EXTERNAL_LAMARCK_PATH is required}"
guest="$(CDPATH= cd -- "$external/.." && pwd)"
repo="$(CDPATH= cd -- "$guest/../.." && pwd)"
prebuilt="${LAMARCK_PREBUILT_ROOT:?LAMARCK_PREBUILT_ROOT is required}"

# Virtualization.framework attaches the rootfs read-only. Materialize the
# state-disk mountpoint in the image; early boot must never try to create it.
install -d -m 0700 "$target/var/lib/lamarck"

for file in "$prebuilt/capsule-guest/dist/supervisor.js" \
	"$prebuilt/capsule-guest/dist/offline-npm.js" \
	"$prebuilt/capsule-guest/dist/release-runc-smoke.js" \
	"$prebuilt/capsule-guest/dist/lamarck.js"; do
	[ -f "$file" ] || { echo "missing prebuilt Guest input $file" >&2; exit 1; }
done

compiler="$(find "$HOST_DIR/bin" -maxdepth 1 \( -type f -o -type l \) -name 'aarch64*-gcc' | LC_ALL=C sort | head -n 1)"
[ -x "$compiler" ] || { echo "Buildroot target compiler was not found" >&2; exit 1; }
"$compiler" -O2 -pipe -std=c11 -Wall -Wextra -Werror \
	-o "$target/usr/libexec/lamarck-vsock-relay" "$guest/native/vsock-relay.c"
"$compiler" -O2 -pipe -std=c11 -Wall -Wextra -Werror \
	-o "$target/usr/libexec/lamarck-net-helper" "$guest/native/net-helper.c"

make_oci_root() {
	root="$1"
	rm -rf "$root"
	mkdir -p "$root" "$root/etc" "$root/usr/bin" "$root/opt" "$root/app" \
		"$root/home/app" "$root/home/build" "$root/run/app" "$root/run/lamarck" "$root/tmp" \
		"$root/proc" "$root/dev" "$root/sys" "$root/dependencies" "$root/workspace" \
		"$root/mnt/lamarck-files" "$root/mnt/lamarck-apps" \
		"$root/mnt/lamarck-apps-lower"
	for name in bin sbin lib lib64; do
		[ ! -e "$target/$name" ] || cp -a "$target/$name" "$root/$name"
	done
	for name in lib lib64; do
		[ ! -e "$target/usr/$name" ] || cp -a "$target/usr/$name" "$root/usr/$name"
	done
	cp -a "$target/usr/local" "$root/usr/local"
	for name in passwd group nsswitch.conf protocols services; do
		[ ! -e "$target/etc/$name" ] || cp -a "$target/etc/$name" "$root/etc/$name"
	done
	printf 'root:x:0:0:root:/root:/bin/sh\napp:x:1000:1000:App:/home/app:/bin/sh\nbuild:x:1000:1000:Build:/home/build:/bin/sh\n' > "$root/etc/passwd"
	printf 'root:x:0:\napp:x:1000:\nbuild:x:1000:\n' > "$root/etc/group"
	# runc cannot create a file bind-mount destination after it has made this
	# OCI root read-only.  Materialize both network-policy mountpoints before
	# sealing the Runtime and Build roots; the bound sources remain Host-owned.
	: > "$root/etc/resolv.conf"
	: > "$root/etc/hosts"
	# Preserve every enabled BusyBox /usr/bin applet without copying unrelated
	# Build-only programs from the full target tree.  Applet-name availability
	# is convenience, not a security boundary; OCI capabilities, seccomp,
	# namespaces, mounts, and the absent network remain authoritative.
	for applet in "$target"/usr/bin/*; do
		[ -L "$applet" ] || continue
		[ "$(readlink "$applet")" = ../../bin/busybox ] || continue
		cp -a "$applet" "$root/usr/bin/"
	done
	for required_applet in env printf; do
		[ -x "$root/usr/bin/$required_applet" ] || {
			echo "missing Runtime Capsule BusyBox applet /usr/bin/$required_applet" >&2
			exit 1
		}
	done
}

runtime_root="$target/opt/lamarck/rootfs/node24"
make_oci_root "$runtime_root"
install -D -m 0755 "$prebuilt/capsule-guest/dist/lamarck.js" \
	"$runtime_root/usr/bin/lamarck"
make_oci_root "$target/opt/lamarck/rootfs/build-node24"
# Python/pkgconf are target packages only because Buildroot does not produce a
# target-native compiler package.  Their libraries must not leak into the
# ordinary Runtime Capsule root merely because both roots share one source
# target tree during image construction.
rm -rf "$runtime_root/usr/lib/python"* "$runtime_root/usr/lib/libpython"* \
	"$runtime_root/usr/lib/libpkgconf"* "$runtime_root/usr/lib/pkgconfig/python"*

install_build_program() {
	root="$1"
	name="$2"
	[ -e "$target/usr/bin/$name" ] || [ -L "$target/usr/bin/$name" ] || {
		echo "missing Build Capsule program /usr/bin/$name" >&2
		exit 1
	}
	# Dereference the Buildroot applet/version symlink so the intentionally
	# selected binary remains self-contained in the reduced Build root.
	rm -f -- "$root/usr/bin/$name"
	cp -L -p "$target/usr/bin/$name" "$root/usr/bin/$name"
}

install_build_tool_wrapper() {
	root="$1"
	name="$2"
	program="$3"
	rm -f -- "$root/usr/bin/$name"
	printf '#!/bin/sh\nexec %s "$@"\n' "$program" > "$root/usr/bin/$name"
	chmod 0755 "$root/usr/bin/$name"
}

install_build_compiler_wrapper() {
	root="$1"
	name="$2"
	driver="$3"
	tuple="$4"
	rm -f -- "$root/usr/bin/$name"
	# Buildroot's cross wrapper correctly rejects Host paths such as
	# /usr/local/include.  Inside this target-native chroot those paths belong
	# to the sealed target Node runtime, so invoke the real driver with the
	# same explicit target sysroot instead of weakening the cross wrapper.
	printf '#!/bin/sh\nexec /opt/lamarck/toolchain/bin/%s.br_real --sysroot=/opt/lamarck/toolchain/%s/sysroot "$@"\n' \
		"$driver" "$tuple" > "$root/usr/bin/$name"
	chmod 0755 "$root/usr/bin/$name"
}

install_build_toolchain() {
	root="$1"
	tuple=aarch64-buildroot-linux-gnu
	toolchain="$root/opt/lamarck/toolchain"
	gcc_version_count="$(find "$HOST_DIR/lib/gcc/$tuple" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
	[ "$gcc_version_count" = 1 ] || {
		echo "expected exactly one Buildroot GCC version" >&2
		exit 1
	}
	gcc_version="$(find "$HOST_DIR/lib/gcc/$tuple" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')"
	cc1="$HOST_DIR/libexec/gcc/$tuple/$gcc_version/cc1"
	[ -x "$cc1" ] || { echo "Buildroot cc1 is unavailable" >&2; exit 1; }
	file "$cc1" | grep -q 'ELF 64-bit LSB executable, ARM aarch64' || {
		echo "Build Capsule compiler is not target-native arm64" >&2
		exit 1
	}

	rm -rf "$toolchain"
	mkdir -p "$toolchain/bin" "$toolchain/lib" "$toolchain/libexec"
	cp -a "$HOST_DIR/$tuple" "$toolchain/$tuple"
	mkdir -p "$toolchain/lib/gcc/$tuple" "$toolchain/libexec/gcc/$tuple"
	cp -a "$HOST_DIR/lib/gcc/$tuple/$gcc_version" "$toolchain/lib/gcc/$tuple/"
	cp -a "$HOST_DIR/libexec/gcc/$tuple/$gcc_version" "$toolchain/libexec/gcc/$tuple/"
	for library in libgmp.so libgmp.so.10 libgmp.so.10.5.0 \
		libmpc.so libmpc.so.3 libmpc.so.3.4.1 \
		libmpfr.so libmpfr.so.6 libmpfr.so.6.2.2 \
		libz.so libz.so.1 libz.so.1.3.2; do
		[ -e "$HOST_DIR/lib/$library" ] || [ -L "$HOST_DIR/lib/$library" ] || {
			echo "missing Buildroot compiler library $library" >&2
			exit 1
		}
		cp -a "$HOST_DIR/lib/$library" "$toolchain/lib/$library"
	done
	cp -a "$HOST_DIR/bin/toolchain-wrapper" "$toolchain/bin/toolchain-wrapper"
	for program in cc c++ cpp gcc g++; do
		cp -a "$HOST_DIR/bin/$tuple-$program" "$toolchain/bin/$tuple-$program"
		cp -a "$HOST_DIR/bin/$tuple-$program.br_real" "$toolchain/bin/$tuple-$program.br_real"
	done
	for program in gcc-ar gcc-nm gcc-ranlib; do
		cp -a "$HOST_DIR/bin/$tuple-$program" "$toolchain/bin/$tuple-$program"
	done
	# GCC host tools were linked while HOST_DIR was /work/output/host.  The
	# wrapper and compiler search paths are relocatable, but ELF RUNPATH is not;
	# rewrite every copied compiler-side ELF to the immutable Build-root path.
	for binary in $(find "$toolchain/bin" "$toolchain/lib" \
		"$toolchain/libexec" "$toolchain/$tuple/bin" -type f); do
		file "$binary" | grep -q 'ELF ' || continue
		runpath="$(patchelf --print-rpath "$binary" 2>/dev/null || true)"
		case "$runpath" in
			*"$HOST_DIR"*) patchelf --set-rpath /opt/lamarck/toolchain/lib "$binary" ;;
		esac
	done

	# The Buildroot wrapper derives its compiler and sysroot paths relative to
	# its own prefixed argv[0].  Small fixed-name scripts preserve that argv[0]
	# while presenting the ordinary compiler names expected by node-gyp.
	install_build_compiler_wrapper "$root" cc "$tuple-gcc" "$tuple"
	install_build_compiler_wrapper "$root" gcc "$tuple-gcc" "$tuple"
	install_build_compiler_wrapper "$root" c++ "$tuple-g++" "$tuple"
	install_build_compiler_wrapper "$root" g++ "$tuple-g++" "$tuple"
	install_build_compiler_wrapper "$root" cpp "$tuple-cpp" "$tuple"
	for program in ar as ld nm objcopy objdump ranlib readelf strip; do
		install_build_tool_wrapper "$root" "$program" \
			"/opt/lamarck/toolchain/$tuple/bin/$program"
	done
	for program in gcc-ar gcc-nm gcc-ranlib; do
		install_build_tool_wrapper "$root" "$program" \
			"/opt/lamarck/toolchain/bin/$tuple-$program"
	done
}

build_root="$target/opt/lamarck/rootfs/build-node24"
for program in make python3 pkgconf; do
	install_build_program "$build_root" "$program"
done
rm -f -- "$build_root/usr/bin/python" "$build_root/usr/bin/pkg-config"
ln -s python3 "$build_root/usr/bin/python"
ln -s pkgconf "$build_root/usr/bin/pkg-config"
install_build_toolchain "$build_root"
install -D -m 0755 "$prebuilt/capsule-guest/dist/offline-npm.js" \
	"$build_root/usr/libexec/lamarck-offline-npm"

# Projecting BusyBox applet links must not let a later Build-tool override
# write through one of those links and mutate the shared applet binary.
for root in "$runtime_root" "$build_root"; do
	[ -x "$root/bin/busybox" ] && [ ! -u "$root/bin/busybox" ] && [ ! -g "$root/bin/busybox" ] || {
		echo "invalid Capsule BusyBox authority at $root/bin/busybox" >&2
		exit 1
	}
	cmp "$target/bin/busybox" "$root/bin/busybox"
done
for program in make python3 pkgconf cc gcc c++ g++ cpp ar as ld nm objcopy objdump ranlib readelf strip \
	gcc-ar gcc-nm gcc-ranlib; do
	[ -f "$build_root/usr/bin/$program" ] && [ ! -L "$build_root/usr/bin/$program" ] \
		&& [ -x "$build_root/usr/bin/$program" ] || {
		echo "invalid Build Capsule program /usr/bin/$program" >&2
		exit 1
	}
done

install -D -m 0755 "$prebuilt/capsule-guest/dist/supervisor.js" \
	"$target/usr/libexec/lamarck-supervisor.js"
install -D -m 0755 "$prebuilt/capsule-guest/dist/offline-npm.js" \
	"$target/usr/libexec/lamarck-offline-npm"
install -D -m 0755 "$prebuilt/capsule-guest/dist/release-runc-smoke.js" \
	"$target/usr/libexec/lamarck-release-runc-smoke.js"
ln -sf /usr/bin/runc "$target/usr/sbin/runc"
ln -sf /usr/bin/mkfs.erofs "$target/usr/sbin/mkfs.erofs"

mkdir -p "$target/opt/lamarck/config"
mkdir -p "$target/mnt/lamarck-files"
mkdir -p "$target/mnt/lamarck-apps-lower"
: > "$target/opt/lamarck/config/empty-resolv.conf"
printf '127.0.0.1 localhost\n::1 localhost\n' > "$target/opt/lamarck/config/loopback-hosts"

chmod 0755 "$target/etc/init.d/S00lamarck-state" \
	"$target/etc/init.d/S01lamarck-files" \
	"$target/etc/init.d/S50lamarck-capsule" \
	"$target/usr/libexec/lamarck-guest-service" \
	"$target/usr/libexec/lamarck-supervisor.js" \
	"$target/usr/libexec/lamarck-offline-npm" \
	"$target/usr/libexec/lamarck-release-runc-smoke.js" \
	"$target/usr/libexec/lamarck-vsock-relay" \
	"$target/usr/libexec/lamarck-net-helper"
