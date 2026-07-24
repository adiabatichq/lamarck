import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HostArtifactStore } from "./artifact-store";
import { CapsuleStorageBudget } from "./storage-budget";

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

function storageBudget(root: string): CapsuleStorageBudget {
  return new CapsuleStorageBudget({
    roots: [root],
    aggregateBytes: 1_024,
    perAppBytes: 1_024,
    filesystemReserveBytes: 0,
    dependencies: { availableBytes: async () => 1_000_000 },
  });
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

  test("pins an unactivated prepared artifact until its retention is released", async () => {
    const { store } = fixture();
    const bytes = Buffer.from("prepared but not activated");
    const expected = identity(bytes);
    const artifact = await store.receive(
      OWNER,
      expected.digest,
      expected.bytes,
      Readable.from([bytes]),
    );
    const retention = store.retain(artifact);
    const secondRetention = store.retain(artifact);

    await expect(store.pruneUnreferenced()).resolves.toBe(0);
    await expect(readFile(artifact.path)).resolves.toEqual(bytes);

    retention.release();
    retention.release();
    await expect(store.pruneUnreferenced()).resolves.toBe(0);
    await expect(readFile(artifact.path)).resolves.toEqual(bytes);

    secondRetention.release();
    await expect(store.pruneUnreferenced()).resolves.toBe(bytes.byteLength);
    await expect(readFile(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("honors a retention acquired after pruning took its initial pin snapshot", async () => {
    const { store } = fixture();
    const activeBytes = Buffer.from("active artifact");
    const activeIdentity = identity(activeBytes);
    const activeArtifact = await store.receive(
      OWNER,
      activeIdentity.digest,
      activeIdentity.bytes,
      Readable.from([activeBytes]),
    );
    await store.activate(OWNER, activeArtifact, {
      packageDigest: `sha256:${"1".repeat(64)}`,
      imageDigest: `sha256:${"2".repeat(64)}`,
    });
    const candidateBytes = Buffer.from("late retained candidate");
    const candidateIdentity = identity(candidateBytes);
    const candidate = await store.receive(
      OWNER,
      candidateIdentity.digest,
      candidateIdentity.bytes,
      Readable.from([candidateBytes]),
    );
    let releaseActiveScan!: () => void;
    const activeScanGate = new Promise<void>((resolve) => {
      releaseActiveScan = resolve;
    });
    let activeScanStarted!: () => void;
    const activeScan = new Promise<void>((resolve) => {
      activeScanStarted = resolve;
    });
    const readActive = store.active.bind(store);
    vi.spyOn(store, "active").mockImplementation(async (appKey) => {
      activeScanStarted();
      await activeScanGate;
      return await readActive(appKey);
    });

    const pruning = store.pruneUnreferenced();
    await activeScan;
    const retention = store.retain(candidate);
    releaseActiveScan();

    await expect(pruning).resolves.toBe(0);
    await expect(readFile(candidate.path)).resolves.toEqual(candidateBytes);
    retention.release();
  });

  test("never reports a pin after pruning has admitted deletion", async () => {
    const root = join(
      tmpdir(),
      `lamarck-artifact-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    roots.push(root);
    const budget = storageBudget(root);
    const store = new HostArtifactStore(root, { storageBudget: budget });
    const bytes = Buffer.from("candidate racing deletion");
    const expected = identity(bytes);
    const artifact = await store.receive(
      OWNER,
      expected.digest,
      expected.bytes,
      Readable.from([bytes]),
    );
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let removalStarted!: () => void;
    const removing = new Promise<void>((resolve) => {
      removalStarted = resolve;
    });
    const remove = budget.remove.bind(budget);
    vi.spyOn(budget, "remove").mockImplementation(async (path, options) => {
      removalStarted();
      await removalGate;
      return await remove(path, options);
    });

    const pruning = store.pruneUnreferenced();
    await removing;
    expect(() => store.retain(artifact)).toThrow("currently being pruned");
    releaseRemoval();

    await expect(pruning).resolves.toBe(bytes.byteLength);
    expect(() => store.retain(artifact)).toThrow("CAS entry is missing");
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

  test("accepts concurrent identical exports while storing one CAS object and claiming both owners", async () => {
    const root = join(
      tmpdir(),
      `lamarck-artifact-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    roots.push(root);
    const budget = storageBudget(root);
    const store = new HostArtifactStore(root, { storageBudget: budget });
    const bytes = Buffer.from("same verified export from two Builds");
    const expected = identity(bytes);
    const secondOwner = "b".repeat(64);
    let releaseSources!: () => void;
    const sourceGate = new Promise<void>((resolve) => {
      releaseSources = resolve;
    });
    let sourcesReady = 0;
    let bothSourcesReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothSourcesReady = resolve;
    });
    const source = async function* () {
      sourcesReady += 1;
      if (sourcesReady === 2) bothSourcesReady();
      await sourceGate;
      yield bytes;
    };

    const first = store.receive(OWNER, expected.digest, expected.bytes, source());
    const second = store.receive(secondOwner, expected.digest, expected.bytes, source());
    await ready;
    releaseSources();
    await expect(Promise.all([first, second])).resolves.toMatchObject([expected, expected]);

    const hex = expected.digest.slice("sha256:".length);
    const entries = await readdir(join(root, "cas", "sha256", hex.slice(0, 2)));
    expect(entries).toEqual([hex]);
    expect(await budget.snapshot()).toMatchObject({
      usedBytes: expected.bytes,
      reservedBytes: 0,
      reservations: 0,
      ownerUsedBytes: {
        [OWNER]: expected.bytes,
        [secondOwner]: expected.bytes,
      },
    });
  });

  test("retains the winner reservation and quarantines publication when temporary cleanup fails", async () => {
    const root = join(
      tmpdir(),
      `lamarck-artifact-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    roots.push(root);
    const budget = storageBudget(root);
    const store = new HostArtifactStore(root, {
      storageBudget: budget,
      artifactWriter: {
        removeTemporary: async () => {
          throw new Error("injected winner unlink failure");
        },
      },
    });
    const bytes = Buffer.from("winner cleanup must remain reserved");
    const expected = identity(bytes);

    await expect(store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes])))
      .rejects.toThrow("injected winner unlink failure");
    expect(await budget.snapshot()).toMatchObject({
      usedBytes: 0,
      reservedBytes: expected.bytes,
      reservations: 1,
      ownerUsedBytes: {},
      ownerReservedBytes: { [OWNER]: expected.bytes },
    });
    await expect(store.find(expected.digest, expected.bytes)).rejects.toThrow("quarantined");
  });

  test("retains a loser reservation and never claims its owner when temporary cleanup fails", async () => {
    const root = join(
      tmpdir(),
      `lamarck-artifact-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    roots.push(root);
    const budget = storageBudget(root);
    let removals = 0;
    const store = new HostArtifactStore(root, {
      storageBudget: budget,
      artifactWriter: {
        removeTemporary: async (path) => {
          removals += 1;
          if (removals === 2) throw new Error("injected loser unlink failure");
          await rm(path, { force: true });
        },
      },
    });
    const bytes = Buffer.from("loser cleanup must remain reserved");
    const expected = identity(bytes);
    const secondOwner = "b".repeat(64);

    await store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes]));
    await expect(store.receive(secondOwner, expected.digest, expected.bytes, Readable.from([bytes])))
      .rejects.toThrow("injected loser unlink failure");
    expect(await budget.snapshot()).toMatchObject({
      usedBytes: expected.bytes,
      reservedBytes: expected.bytes,
      reservations: 1,
      ownerUsedBytes: { [OWNER]: expected.bytes },
      ownerReservedBytes: { [secondOwner]: expected.bytes },
    });
  });

  test("keeps same-digest losers behind winner durability and fails them cleanly on ambiguity", async () => {
    const root = join(
      tmpdir(),
      `lamarck-artifact-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    roots.push(root);
    const budget = storageBudget(root);
    let winnerPublished!: () => void;
    const published = new Promise<void>((resolve) => {
      winnerPublished = resolve;
    });
    let failWinner!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      failWinner = resolve;
    });
    const store = new HostArtifactStore(root, {
      storageBudget: budget,
      artifactWriter: {
        afterPublication: async (isWinner) => {
          if (!isWinner) return;
          winnerPublished();
          await failureGate;
          throw new Error("injected winner accounting boundary failure");
        },
      },
    });
    const bytes = Buffer.from("same digest publication boundary");
    const expected = identity(bytes);
    const secondOwner = "b".repeat(64);

    const winner = store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes]));
    await published;
    const loser = store.receive(secondOwner, expected.digest, expected.bytes, Readable.from([bytes]));
    failWinner();
    const results = await Promise.allSettled([winner, loser]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(await budget.snapshot()).toMatchObject({
      usedBytes: 0,
      reservedBytes: expected.bytes,
      reservations: 1,
      ownerUsedBytes: {},
      ownerReservedBytes: { [OWNER]: expected.bytes },
    });
    const hex = expected.digest.slice("sha256:".length);
    expect(await readdir(join(root, "cas", "sha256", hex.slice(0, 2)))).toEqual([hex]);
  });

  test("does not expose a hard-link winner to reads before durability and accounting", async () => {
    let winnerPublished!: () => void;
    const published = new Promise<void>((resolve) => {
      winnerPublished = resolve;
    });
    let releaseWinner!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const { store } = fixture({
      artifactWriter: {
        afterPublication: async (isWinner) => {
          if (!isWinner) return;
          winnerPublished();
          await publicationGate;
        },
      },
    });
    const bytes = Buffer.from("reads wait for committed publication");
    const expected = identity(bytes);
    const receive = store.receive(OWNER, expected.digest, expected.bytes, Readable.from([bytes]));
    await published;
    let readSettled = false;
    const read = store.find(expected.digest, expected.bytes).finally(() => {
      readSettled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readSettled).toBe(false);
    releaseWinner();
    await expect(receive).resolves.toMatchObject(expected);
    await expect(read).resolves.toMatchObject(expected);
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
