import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const guest = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const board = resolve(guest, "buildroot/board/lamarck/arm64");

describe("read-only Guest boot contract", () => {
  test("builds the state mountpoint into rootfs and never creates it during early boot", async () => {
    const postBuild = await readFile(resolve(board, "post-build.sh"), "utf8");
    const init = await readFile(
      resolve(board, "rootfs-overlay/etc/init.d/S00lamarck-state"),
      "utf8",
    );
    expect(postBuild).toContain('install -d -m 0700 "$target/var/lib/lamarck"');
    expect(init).toContain("[ -d /var/lib/lamarck ] && [ ! -L /var/lib/lamarck ]");
    expect(init.split("\n").map((line) => line.trim())).not.toContain("mkdir -p /var/lib/lamarck");
    expect(init.indexOf("[ -d /var/lib/lamarck ]")).toBeLessThan(
      init.indexOf("mount -t ext4"),
    );
    expect(init).toContain("mkfs.ext4 -F -m 0 -E nodiscard");
    expect(init).toContain("rw,nodev,nosuid,noatime,nodiscard");
    expect(init).not.toMatch(/\bfstrim\b/);
  });

  test("mounts the single Host D1 share read-only before workloads start", async () => {
    const kernel = await readFile(resolve(board, "kernel.fragment"), "utf8");
    const postBuild = await readFile(resolve(board, "post-build.sh"), "utf8");
    const init = await readFile(
      resolve(board, "rootfs-overlay/etc/init.d/S01lamarck-files"),
      "utf8",
    );
    expect(kernel).toContain("CONFIG_FUSE_FS=y");
    expect(kernel).toContain("CONFIG_VIRTIO_FS=y");
    expect(postBuild).toContain('"$root/mnt/lamarck-files"');
    expect(postBuild).toContain('mkdir -p "$target/mnt/lamarck-files"');
    expect(init).toContain("mount -t virtiofs -o ro,nosuid,nodev,noexec");
    expect(init).toContain("tag=lamarck-files");
    expect(init).toContain("$3 == \"virtiofs\"");
  });

  test("keeps the native toolchain Build-only and proves npm-ci node-gyp at boot", async () => {
    const defconfig = await readFile(
      resolve(guest, "buildroot/configs/lamarck_capsule_arm64_defconfig"),
      "utf8",
    );
    const postBuild = await readFile(resolve(board, "post-build.sh"), "utf8");
    const service = await readFile(
      resolve(board, "rootfs-overlay/usr/libexec/lamarck-guest-service"),
      "utf8",
    );
    const fixture = resolve(board, "rootfs-overlay/usr/share/lamarck/native-addon-smoke");
    expect(defconfig).toContain("BR2_PACKAGE_MAKE=y");
    expect(defconfig).toContain("BR2_PACKAGE_PYTHON3=y");
    expect(defconfig).toContain("BR2_PACKAGE_PKGCONF=y");
    expect(postBuild).toContain('toolchain="$root/opt/lamarck/toolchain"');
    expect(postBuild).toContain('file "$cc1" | grep -q \'ELF 64-bit LSB executable, ARM aarch64\'');
    expect(postBuild).toContain("patchelf --set-rpath /opt/lamarck/toolchain/lib");
    expect(postBuild).toContain("install_build_compiler_wrapper");
    expect(postBuild).toContain(".br_real --sysroot=/opt/lamarck/toolchain/%s/sysroot");
    expect(postBuild).toContain('rm -rf "$runtime_root/usr/lib/python"*');
    expect(postBuild).not.toContain('cp -a "$target/usr/bin" "$root/usr/bin"');
    expect(postBuild).toContain('[ "$(readlink "$applet")" = ../../bin/busybox ] || continue');
    expect(postBuild).toContain("for required_applet in env printf; do");
    expect(postBuild).not.toContain('ln -sf /bin/env "$root/usr/bin/env"');
    expect(postBuild).toContain('rm -f -- "$root/usr/bin/$name"');
    expect(postBuild).toContain('cmp "$target/bin/busybox" "$root/bin/busybox"');
    expect(postBuild).toContain('[ ! -L "$build_root/usr/bin/$program" ]');
    expect(service).toContain('mount --rbind /dev "$native_build_root/dev"');
    expect(service).toContain('mount -t proc -o nosuid,noexec,nodev proc "$native_build_root/proc"');
    expect(service).toContain('cleanup_native_smoke || native_cleanup_status=$?');
    expect(service).toContain("/usr/local/bin/npm ci --offline");
    expect(service).toContain("lamarck_native_smoke.node");
    expect(await readFile(resolve(fixture, "binding.gyp"), "utf8")).toContain(
      '"target_name": "lamarck_native_smoke"',
    );
    expect(await readFile(resolve(fixture, "addon.cc"), "utf8")).toContain(
      "NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)",
    );
  });

  test("materializes read-only OCI file-mount destinations before sealing both roots", async () => {
    const postBuild = await readFile(resolve(board, "post-build.sh"), "utf8");
    expect(postBuild).toContain(': > "$root/etc/resolv.conf"');
    expect(postBuild).toContain(': > "$root/etc/hosts"');
    expect(postBuild).toContain('"$root/run/app" "$root/run/lamarck"');
    expect(postBuild).toContain('"$root/mnt/lamarck-files"');
    expect(postBuild.indexOf(': > "$root/etc/resolv.conf"')).toBeLessThan(
      postBuild.indexOf('runtime_root="$target/opt/lamarck/rootfs/node24"'),
    );
  });
});
