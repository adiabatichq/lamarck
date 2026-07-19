export const GUEST_ROOT = "/var/lib/lamarck";
export const BLOB_ROOT = `${GUEST_ROOT}/blobs`;
export const ARTIFACT_MOUNT_ROOT = `${GUEST_ROOT}/artifacts/sha256`;
export const RUNTIME_ROOT = `${GUEST_ROOT}/runtime`;
export const BUILD_ROOT = `${GUEST_ROOT}/builds`;
export const BUNDLE_ROOT = "/run/lamarck/bundles";
export const NETNS_ROOT = "/run/lamarck/netns";
export const CGROUP_ROOT = "/sys/fs/cgroup/lamarck";
export const APP_ROOTFS = "/opt/lamarck/rootfs/node24";
export const BUILD_ROOTFS = "/opt/lamarck/rootfs/build-node24";
export const RUNC_PATH = "/usr/sbin/runc";
export const RUNC_ROOT = "/run/lamarck/runc";
export const NET_HELPER_PATH = "/usr/libexec/lamarck-net-helper";
export const VSOCK_RELAY_PATH = "/usr/libexec/lamarck-vsock-relay";
export const MKFS_EROFS_PATH = "/usr/sbin/mkfs.erofs";

export interface GuestFilesystemPaths {
  blobRoot: string;
  artifactMountRoot: string;
  runtimeRoot: string;
  buildRoot: string;
  cgroupRoot: string;
  netnsRoot: string;
  appRootfs: string;
  buildRootfs: string;
  netHelperPath: string;
  mkfsErofsPath: string;
}

export const DEFAULT_GUEST_PATHS: GuestFilesystemPaths = Object.freeze({
  blobRoot: BLOB_ROOT,
  artifactMountRoot: ARTIFACT_MOUNT_ROOT,
  runtimeRoot: RUNTIME_ROOT,
  buildRoot: BUILD_ROOT,
  cgroupRoot: CGROUP_ROOT,
  netnsRoot: NETNS_ROOT,
  appRootfs: APP_ROOTFS,
  buildRootfs: BUILD_ROOTFS,
  netHelperPath: NET_HELPER_PATH,
  mkfsErofsPath: MKFS_EROFS_PATH,
});
