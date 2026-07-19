#!/usr/bin/env node

import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUILD_SNAPSHOT_DIRECTORIES,
  BUILD_SNAPSHOT_FILES,
  createBuildSnapshot,
  validateBuildSnapshot,
} from "./build-snapshot.mjs";
import { readValidatedGuestSigningKey } from "./signing-key.mjs";

const root = await mkdtemp(join(tmpdir(), "lamarck-build-inputs-"));
try {
  const repository = join(root, "repository");
  await createRepositoryFixture(repository);

  const snapshot = join(root, "snapshot");
  const created = await createBuildSnapshot(repository, snapshot);
  const verified = await validateBuildSnapshot(snapshot);
  assert.equal(verified.manifestDigest, created.manifestDigest);

  await assert.rejects(
    createBuildSnapshot(repository, join(root, "content-race"), {
      afterCopy: async () => {
        await writeFile(join(repository, "package.json"), "changed during snapshot\n");
      },
    }),
    /membership or content changed/,
  );
  await writeFile(join(repository, "package.json"), "package.json\n");

  await assert.rejects(
    createBuildSnapshot(repository, join(root, "membership-race"), {
      afterCopy: async () => {
        await writeFile(
          join(repository, "desktop/capsule-guest/src/appeared.ts"),
          "export {};\n",
        );
      },
    }),
    /membership or content changed/,
  );

  const linkedRepository = join(root, "hard-linked-repository");
  await createRepositoryFixture(linkedRepository);
  const outsideInput = join(root, "outside-input.json");
  await writeFile(outsideInput, "outside build input\n");
  await rm(join(linkedRepository, "package.json"));
  await link(outsideInput, join(linkedRepository, "package.json"));
  await assert.rejects(
    createBuildSnapshot(linkedRepository, join(root, "hard-linked-snapshot")),
    /not a nonempty regular file/,
  );

  const symlinkRepository = join(root, "symlink-repository");
  await createRepositoryFixture(symlinkRepository);
  await rm(join(symlinkRepository, "package.json"));
  await symlink(outsideInput, join(symlinkRepository, "package.json"));
  await assert.rejects(
    createBuildSnapshot(symlinkRepository, join(root, "symlink-snapshot")),
    /not a nonempty regular file|symbolic link/,
  );

  const key = join(root, "guest-signing.pem");
  await writeFile(key, "private-key-fixture\n", { mode: 0o600 });
  await chmod(key, 0o600);
  assert.equal((await readValidatedGuestSigningKey(key, { repositoryRoot: repository })).path, key);

  const permissive = join(root, "permissive.pem");
  await writeFile(permissive, "fixture\n", { mode: 0o644 });
  await chmod(permissive, 0o644);
  await assert.rejects(
    readValidatedGuestSigningKey(permissive, { repositoryRoot: repository }),
    /exactly 0600/,
  );

  const linked = join(root, "linked.pem");
  await link(key, linked);
  await assert.rejects(
    readValidatedGuestSigningKey(key, { repositoryRoot: repository }),
    /exactly one hard link/,
  );
  await rm(linked);

  const symbolic = join(root, "symbolic.pem");
  await symlink(key, symbolic);
  await assert.rejects(
    readValidatedGuestSigningKey(symbolic, { repositoryRoot: repository }),
    /non-symlink/,
  );

  const repositoryKey = join(repository, "private.pem");
  await writeFile(repositoryKey, "fixture\n", { mode: 0o600 });
  await chmod(repositoryKey, 0o600);
  await assert.rejects(
    readValidatedGuestSigningKey(repositoryKey, { repositoryRoot: repository }),
    /outside.*repository/,
  );

  process.stdout.write("sealed build snapshot and signing-key custody tests passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createRepositoryFixture(repository) {
  for (const path of BUILD_SNAPSHOT_FILES) {
    const destination = join(repository, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${path}\n`);
  }
  for (const path of BUILD_SNAPSHOT_DIRECTORIES) {
    const destination = join(repository, path, "fixture.txt");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${path}\n`);
  }
}
