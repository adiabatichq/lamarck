import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { recoverGuestEphemeralState } from "../src/boot-recovery";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("Guest boot crash recovery", () => {
  test("purges stale App, Build, and reconstructable blob state only after idle proof", async () => {
    const fixture = await recoveryFixture();
    await writeFile(join(fixture.runtimeRoot, "stale-app.scratch.ext4"), "stale");
    await mkdir(join(fixture.buildRoot, "stale-build"));
    await writeFile(join(fixture.buildRoot, "stale-build", "workspace"), "stale");
    await mkdir(join(fixture.blobRoot, "artifact"));
    await writeFile(join(fixture.blobRoot, "artifact", "stale"), "stale");

    await recoverGuestEphemeralState(fixture.options);
    expect(await readdir(fixture.runtimeRoot)).toEqual([]);
    expect(await readdir(fixture.buildRoot)).toEqual([]);
    expect(await readdir(fixture.blobRoot)).toEqual([]);

    // A second simulated crash/reboot is idempotent and reclaims new residue.
    await writeFile(join(fixture.runtimeRoot, "second-crash"), "stale");
    await recoverGuestEphemeralState(fixture.options);
    expect(await readdir(fixture.runtimeRoot)).toEqual([]);
  });

  test("refuses to purge when any nested disposable mount still exists", async () => {
    const fixture = await recoveryFixture();
    const sentinel = join(fixture.runtimeRoot, "keep-me");
    await writeFile(sentinel, "evidence");
    await writeFile(
      fixture.mountInfoPath,
      `36 29 0:32 / ${mountInfoEscape(join(fixture.runtimeRoot, "mounted app"))} rw - ext4 /dev/loop0 rw\n`,
    );

    await expect(recoverGuestEphemeralState(fixture.options)).rejects.toMatchObject({
      code: "CAPSULE_GUEST_CONTAINMENT_FAILED",
      fatalGuest: true,
    });
    expect(await readFile(sentinel, "utf8")).toBe("evidence");
  });

  test("refuses to purge when an old App or Build cgroup is populated", async () => {
    const fixture = await recoveryFixture();
    const sentinel = join(fixture.buildRoot, "keep-me");
    await writeFile(sentinel, "evidence");
    await writeFile(join(fixture.cgroupRoot, "builds", "cgroup.events"), "populated 1\nfrozen 0\n");
    await writeFile(join(fixture.cgroupRoot, "builds", "cgroup.procs"), "4242\n");

    await expect(recoverGuestEphemeralState(fixture.options)).rejects.toMatchObject({
      fatalGuest: true,
    });
    expect(await readFile(sentinel, "utf8")).toBe("evidence");
  });
});

async function recoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), "lamarck-boot-recovery-"));
  roots.push(root);
  const runtimeRoot = join(root, "state", "runtime");
  const buildRoot = join(root, "state", "builds");
  const blobRoot = join(root, "state", "blobs");
  const cgroupRoot = join(root, "cgroup", "lamarck");
  const mountInfoPath = join(root, "mountinfo");
  await Promise.all([
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(buildRoot, { recursive: true }),
    mkdir(blobRoot, { recursive: true }),
    mkdir(join(cgroupRoot, "apps"), { recursive: true }),
    mkdir(join(cgroupRoot, "builds"), { recursive: true }),
  ]);
  for (const scope of ["apps", "builds"]) {
    await writeFile(join(cgroupRoot, scope, "cgroup.events"), "populated 0\nfrozen 0\n");
    await writeFile(join(cgroupRoot, scope, "cgroup.procs"), "");
  }
  await writeFile(mountInfoPath, "");
  return {
    runtimeRoot,
    buildRoot,
    blobRoot,
    cgroupRoot,
    mountInfoPath,
    options: { runtimeRoot, buildRoot, blobRoot, cgroupRoot, mountInfoPath },
  };
}

function mountInfoEscape(value: string): string {
  return value.replace(/\\/g, "\\134").replace(/ /g, "\\040");
}
