import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { HostArtifactStore } from "./artifact-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const OWNER = "a".repeat(64);

function fixture(options: ConstructorParameters<typeof HostArtifactStore>[1] = {}): {
  root: string;
  store: HostArtifactStore;
} {
  const root = join(tmpdir(), `lamarck-artifact-${process.pid}-${Math.random().toString(16).slice(2)}`);
  roots.push(root);
  return { root, store: new HostArtifactStore(root, options) };
}

function identity(bytes: Buffer) {
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
    bytes: bytes.byteLength,
  };
}

describe("HostArtifactStore", () => {
  test("verifies Guest bytes, seals CAS, and atomically activates an App", async () => {
    const { root, store } = fixture();
    const bytes = Buffer.from("sealed erofs fixture");
    const expected = identity(bytes);

    const artifact = await store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes]));
    expect(await readFile(artifact.path)).toEqual(bytes);
    const provenance = {
      packageDigest: `sha256:${"1".repeat(64)}`,
      imageDigest: `sha256:${"2".repeat(64)}`,
    };
    await store.activate("a".repeat(64), artifact, provenance);
    expect(await store.active("a".repeat(64))).toMatchObject({
      artifact: expected,
      ...provenance,
    });
    const activation = JSON.parse(await readFile(join(root, "active", `${"a".repeat(64)}.json`), "utf8"));
    expect(activation).toEqual({ version: 1, ...expected, ...provenance });
    await store.deactivate("a".repeat(64));
    expect(await store.active("a".repeat(64))).toBeUndefined();
    await expect(store.deactivate("a".repeat(64))).resolves.toBeUndefined();
  });

  test("rejects truncated and digest-mismatched Guest exports without publishing", async () => {
    const { store } = fixture();
    const bytes = Buffer.from("correct");
    const expected = identity(bytes);
    await expect(store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes.subarray(0, 2)])))
      .rejects.toThrow("ended at");
    await expect(store.receive(OWNER, expected.digest, expected.bytes, Readable.from([Buffer.alloc(bytes.length)])))
      .rejects.toThrow("digest mismatch");
    expect(await store.find(expected.digest, expected.bytes)).toBeUndefined();
  });

  test("persists exact V2 install and dependency provenance while still reading V1 pointers", async () => {
    const { root, store } = fixture();
    const bytes = Buffer.from("warm artifact");
    const expected = identity(bytes);
    const artifact = await store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes]));
    const provenance = {
      packageDigest: `sha256:${"1".repeat(64)}`,
      imageDigest: `sha256:${"2".repeat(64)}`,
      installDigest: `sha256:${"3".repeat(64)}`,
      dependencyDigest: `sha256:${"4".repeat(64)}`,
    };
    await store.activate(OWNER, artifact, provenance);
    expect(await store.active(OWNER)).toMatchObject({ artifact: expected, ...provenance });
    expect(JSON.parse(await readFile(join(root, "active", `${OWNER}.json`), "utf8")))
      .toEqual({ version: 2, ...expected, ...provenance });

    await expect(store.activate(OWNER, artifact, {
      packageDigest: provenance.packageDigest,
      imageDigest: provenance.imageDigest,
      installDigest: provenance.installDigest,
    })).rejects.toThrow(/appear together/);
  });

  test("fails closed when a sealed CAS object is tampered", async () => {
    const { store } = fixture();
    const bytes = Buffer.from("artifact");
    const expected = identity(bytes);
    const artifact = await store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes]));
    await chmod(artifact.path, 0o600);
    await writeFile(artifact.path, Buffer.from("tampered"));
    await expect(store.require(expected.digest)).rejects.toThrow(/invalid|verification/);
  });

  test("does not follow a forged activation symlink", async () => {
    const { root, store } = fixture();
    const bytes = Buffer.from("artifact");
    const expected = identity(bytes);
    await store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes]));
    await mkdir(join(root, "active"), { recursive: true, mode: 0o700 });
    const target = join(root, "forged.json");
    await writeFile(target, `${JSON.stringify({
      version: 1,
      ...expected,
      packageDigest: `sha256:${"1".repeat(64)}`,
      imageDigest: `sha256:${"2".repeat(64)}`,
    })}\n`, { mode: 0o600 });
    await symlink(target, join(root, "active", `${"b".repeat(64)}.json`));
    await expect(store.active("b".repeat(64))).rejects.toThrow("activation pointer is invalid");
  });

  test("restores the previous activation when a post-rename durability step fails", async () => {
    let failAfterRename = false;
    const { store } = fixture({
      afterActivationPointerRename: async () => {
        if (failAfterRename) throw new Error("injected post-rename failure");
      },
    });
    const firstBytes = Buffer.from("first artifact");
    const secondBytes = Buffer.from("second artifact");
    const firstIdentity = identity(firstBytes);
    const first = await store.receive(
      OWNER,
      firstIdentity.digest,
      firstIdentity.bytes,
      Readable.from([firstBytes]),
    );
    const secondIdentity = identity(secondBytes);
    const second = await store.receive(
      OWNER,
      secondIdentity.digest,
      secondIdentity.bytes,
      Readable.from([secondBytes]),
    );
    const firstProvenance = {
      packageDigest: `sha256:${"1".repeat(64)}`,
      imageDigest: `sha256:${"2".repeat(64)}`,
      installDigest: `sha256:${"5".repeat(64)}`,
      dependencyDigest: `sha256:${"6".repeat(64)}`,
    };
    await store.activate(OWNER, first, firstProvenance);

    failAfterRename = true;
    await expect(store.activate(OWNER, second, {
      packageDigest: `sha256:${"3".repeat(64)}`,
      imageDigest: `sha256:${"4".repeat(64)}`,
      installDigest: `sha256:${"7".repeat(64)}`,
      dependencyDigest: `sha256:${"8".repeat(64)}`,
    })).rejects.toThrow("injected post-rename failure");
    expect(await store.active(OWNER)).toMatchObject({ artifact: identity(firstBytes), ...firstProvenance });
  });
});
