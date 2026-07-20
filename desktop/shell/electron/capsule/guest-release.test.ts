import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CAPSULE_GUEST_RELEASE_DESCRIPTOR_FILE,
  CapsuleGuestReleaseError,
  loadCapsuleGuestRelease,
  type CapsuleGuestReleaseDescriptor,
} from "./guest-release";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("Capsule Guest release descriptor", () => {
  test("loads an exact app-bundled descriptor into VM, handshake, and ABI expectations", async () => {
    const fixture = await createFixture();
    const loaded = await loadCapsuleGuestRelease({
      resourcesRoot: fixture.root,
      stateDirectory: `${fixture.root}/host-state`,
      hostArchitecture: "arm64",
    });

    expect(loaded.vmImage).toEqual({
      imageBundlePath: await realpath(fixture.bundle),
      stateDirectory: await realpath(`${fixture.root}/host-state`),
      expectedManifestDigest: DIGEST,
      manifestPublicKey: PUBLIC_KEY,
      cpuCount: 4,
      memorySizeBytes: 4 * 1024 * 1024 * 1024,
    });
    expect((await stat(loaded.vmImage.stateDirectory)).mode & 0o777).toBe(0o700);
    expect(loaded.handshake).toEqual({
      expectedImageDigest: DIGEST,
      expectedArchitecture: "arm64",
      expectedSupervisorVersion: "0.1.0",
      expectedFeatures: [
        "artifact-erofs-v1",
        "build-v1",
        "oci-policy-v1",
        "sdk-uds-v1",
        "tickets-v1",
        "warm-rebuild-v1",
      ],
    });
    expect(loaded.runtime).toEqual({
      runtimeAbi: "capsule-node-v1",
      architecture: "arm64",
      nodeVersion: "24.10.0",
      nodeModulesAbi: "137",
      libc: "glibc-2.43",
    });
    expect(Object.isFrozen(loaded.handshake.expectedFeatures)).toBe(true);
  });

  test("rejects unknown, missing, unsupported, noncanonical, and unsorted fields", async () => {
    const invalidDescriptors: Array<[string, (value: Record<string, unknown>) => void]> = [
      ["unknown field", (value) => { value.imageVersion = "0.1.0"; }],
      ["missing field", (value) => { delete value.runtimeAbi; }],
      ["wire version", (value) => { value.vmWireVersion = 2; }],
      ["manifest digest", (value) => { value.manifestDigest = `sha256:${"A".repeat(64)}`; }],
      ["public key alphabet", (value) => { value.pinnedEd25519PublicKey = PUBLIC_KEY.replace("=", "_"); }],
      ["public key size", (value) => { value.pinnedEd25519PublicKey = Buffer.alloc(31).toString("base64"); }],
      ["feature ordering", (value) => { value.features = ["build-v1", "artifact-erofs-v1"]; }],
      ["duplicate feature", (value) => { value.features = ["build-v1", "build-v1"]; }],
      ["missing required warm Build feature", (value) => {
        value.features = (value.features as string[]).filter((item) => item !== "warm-rebuild-v1");
      }],
      ["runtime ABI", (value) => { value.runtimeAbi = "node-any"; }],
      ["Node version", (value) => { value.nodeVersion = "v24.10.0"; }],
      ["memory alignment", (value) => { value.memorySizeBytes = 4 * 1024 * 1024 * 1024 + 1; }],
      ["unsafe bundle path", (value) => { value.bundleRelativePath = "../guest"; }],
      ["backslash bundle path", (value) => { value.bundleRelativePath = "images\\guest"; }],
    ];

    for (const [label, mutate] of invalidDescriptors) {
      const fixture = await createFixture();
      const descriptor = structuredClone(fixture.descriptor) as unknown as Record<string, unknown>;
      mutate(descriptor);
      await writeDescriptor(fixture.root, descriptor);
      await expect(loadCapsuleGuestRelease({
        resourcesRoot: fixture.root,
        stateDirectory: `${fixture.root}/state`,
        hostArchitecture: "arm64",
      }), label).rejects.toBeInstanceOf(CapsuleGuestReleaseError);
    }
  });

  test("rejects malformed JSON and nonregular or linked descriptors", async () => {
    const malformed = await createFixture();
    await writeFile(join(malformed.root, CAPSULE_GUEST_RELEASE_DESCRIPTOR_FILE), "{", "utf8");
    await expect(loadFixture(malformed.root)).rejects.toMatchObject({
      code: "INVALID_DESCRIPTOR_JSON",
    });

    const directoryDescriptor = await createRoot();
    await mkdir(join(directoryDescriptor, CAPSULE_GUEST_RELEASE_DESCRIPTOR_FILE));
    await expect(loadFixture(directoryDescriptor)).rejects.toMatchObject({
      code: "INVALID_DESCRIPTOR_FILE",
    });

    const linkedDescriptor = await createRoot();
    const external = join(linkedDescriptor, "external.json");
    await writeFile(external, JSON.stringify(validDescriptor()));
    await symlink(external, join(linkedDescriptor, CAPSULE_GUEST_RELEASE_DESCRIPTOR_FILE));
    await expect(loadFixture(linkedDescriptor)).rejects.toMatchObject({
      code: "INVALID_DESCRIPTOR_FILE",
    });
  });

  test("rejects linked or non-directory image bundle components", async () => {
    const linked = await createFixture();
    await rm(linked.bundle, { recursive: true });
    const target = join(linked.root, "real-bundle");
    await mkdir(target);
    await symlink(target, linked.bundle);
    await expect(loadFixture(linked.root)).rejects.toMatchObject({ code: "INVALID_IMAGE_BUNDLE" });

    const nonDirectory = await createFixture();
    await rm(nonDirectory.bundle, { recursive: true });
    await writeFile(nonDirectory.bundle, "not a directory");
    await expect(loadFixture(nonDirectory.root)).rejects.toMatchObject({ code: "INVALID_IMAGE_BUNDLE" });
  });

  test("binds the release to Host architecture and a Host-selected absolute state path", async () => {
    const fixture = await createFixture();
    await expect(loadCapsuleGuestRelease({
      resourcesRoot: fixture.root,
      stateDirectory: `${fixture.root}/state`,
      hostArchitecture: "x64",
    })).rejects.toMatchObject({ code: "INCOMPATIBLE_ARCHITECTURE" });
    await expect(loadCapsuleGuestRelease({
      resourcesRoot: fixture.root,
      stateDirectory: "relative-state",
      hostArchitecture: "arm64",
    })).rejects.toMatchObject({ code: "INVALID_DESCRIPTOR_FIELD" });

    const realState = join(fixture.root, "real-state");
    const linkedState = join(fixture.root, "linked-state");
    await mkdir(realState, { mode: 0o700 });
    await symlink(realState, linkedState);
    await expect(loadCapsuleGuestRelease({
      resourcesRoot: fixture.root,
      stateDirectory: linkedState,
      hostArchitecture: "arm64",
    })).rejects.toMatchObject({ code: "INVALID_STATE_DIRECTORY" });
  });

  test("rejects a resources root that is itself a symbolic link", async () => {
    const fixture = await createFixture();
    const parent = await createRoot();
    const linkedRoot = join(parent, "resources-link");
    await symlink(fixture.root, linkedRoot);
    await expect(loadCapsuleGuestRelease({
      resourcesRoot: linkedRoot,
      stateDirectory: `${parent}/state`,
      hostArchitecture: "arm64",
    })).rejects.toMatchObject({ code: "INVALID_RESOURCE_ROOT" });
  });
});

async function createFixture() {
  const root = await createRoot();
  const descriptor = validDescriptor();
  const bundle = join(root, descriptor.bundleRelativePath);
  await mkdir(bundle, { recursive: true });
  await writeDescriptor(root, descriptor);
  return { root, bundle, descriptor };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "capsule-guest-release-"));
  roots.push(root);
  return root;
}

async function writeDescriptor(root: string, value: unknown): Promise<void> {
  await writeFile(
    join(root, CAPSULE_GUEST_RELEASE_DESCRIPTOR_FILE),
    `${JSON.stringify(value)}\n`,
    { mode: 0o600 },
  );
}

async function loadFixture(resourcesRoot: string) {
  return await loadCapsuleGuestRelease({
    resourcesRoot,
    stateDirectory: `${resourcesRoot}/state`,
    hostArchitecture: "arm64",
  });
}

function validDescriptor(): CapsuleGuestReleaseDescriptor {
  return {
    schemaVersion: 1,
    vmWireVersion: 1,
    guestProtocolVersion: 1,
    architecture: "arm64",
    bundleRelativePath: "capsule-guest-arm64",
    manifestDigest: DIGEST,
    pinnedEd25519PublicKey: PUBLIC_KEY,
    supervisorVersion: "0.1.0",
    features: [
      "artifact-erofs-v1",
      "build-v1",
      "oci-policy-v1",
      "sdk-uds-v1",
      "tickets-v1",
      "warm-rebuild-v1",
    ],
    runtimeAbi: "capsule-node-v1",
    nodeVersion: "24.10.0",
    nodeModulesAbi: "137",
    libc: "glibc-2.43",
    cpuCount: 4,
    memorySizeBytes: 4 * 1024 * 1024 * 1024,
    stateFormatVersion: 1,
  };
}
