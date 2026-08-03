import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveCommittedAppRevision } from "../src/app-revision";

describe("committed App revision", () => {
  let workspace: string;
  let appDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-app-revision-"));
    appDir = join(workspace, "app-a");
    mkdirSync(appDir);
    git("init", "--quiet");
    git("config", "user.name", "Lamarck Test");
    git("config", "user.email", "lamarck-test@example.invalid");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("returns the full commit for an exact committed activation", async () => {
    const expectedCommit = commitApp();

    const actualCommit = await resolveCommittedAppRevision(appDir);

    expect(actualCommit).toBe(expectedCommit);
    expect(actualCommit).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  });

  test("fails when the App has no committed revision", async () => {
    await expect(resolveCommittedAppRevision(appDir)).rejects.toThrow(/committed revision/);
  });

  test("does not adopt a parent repository as the App revision", async () => {
    rmSync(join(appDir, ".git"), { recursive: true, force: true });
    execFileSync("git", ["-C", workspace, "init", "--quiet"]);
    execFileSync("git", ["-C", workspace, "config", "user.name", "Lamarck Test"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "lamarck-test@example.invalid",
    ]);
    writeFileSync(join(appDir, "manifest.json"), '{"id":"app-a"}\n');
    writeFileSync(join(appDir, "index.mjs"), "export default {};\n");
    execFileSync("git", ["-C", workspace, "add", "--all"]);
    execFileSync("git", [
      "-C",
      workspace,
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "Commit parent repository",
    ]);

    await expect(resolveCommittedAppRevision(appDir)).rejects.toThrow(
      "App activation must be the root of its Git repository",
    );
  });

  test("fails when a tracked activation file differs from the commit", async () => {
    commitApp();
    writeFileSync(join(appDir, "index.mjs"), "export default 'dirty';\n");

    await expect(resolveCommittedAppRevision(appDir)).rejects.toThrow(
      "App activation must exactly match a committed Git revision",
    );
  });

  test("fails when a relevant untracked activation file exists", async () => {
    commitApp();
    mkdirSync(join(appDir, "services"));
    writeFileSync(join(appDir, "services", "new-service.mjs"), "export default {};\n");

    await expect(resolveCommittedAppRevision(appDir)).rejects.toThrow(
      "App activation must exactly match a committed Git revision",
    );
  });

  test("fails when a relevant path is ignored by Git", async () => {
    commitApp("cache/\n");
    mkdirSync(join(appDir, "cache"));
    writeFileSync(join(appDir, "cache", "runtime.mjs"), "export default 'uncommitted';\n");

    await expect(resolveCommittedAppRevision(appDir)).rejects.toThrow(
      "App activation must exactly match a committed Git revision",
    );
  });

  test("allows changes only beneath Capsule-excluded roots", async () => {
    const expectedCommit = commitApp(".lamarck/\nnode_modules/\n");
    mkdirSync(join(appDir, ".lamarck"));
    writeFileSync(join(appDir, ".lamarck", "runtime-state.json"), "{}\n");
    mkdirSync(join(appDir, "node_modules", "example"), { recursive: true });
    writeFileSync(join(appDir, "node_modules", "example", "index.mjs"), "export {};\n");
    writeFileSync(join(appDir, ".git", "lamarck-runtime-state"), "not activation input\n");

    await expect(resolveCommittedAppRevision(appDir)).resolves.toBe(expectedCommit);
  });

  test("fails when manifest.json is not part of the committed activation", async () => {
    writeFileSync(join(appDir, "index.mjs"), "export default {};\n");
    git("add", "--all");
    git("commit", "--quiet", "--no-gpg-sign", "-m", "Commit App without manifest");

    await expect(resolveCommittedAppRevision(appDir)).rejects.toThrow(
      "App activation manifest.json must belong to the committed revision",
    );
  });

  function commitApp(gitignore = ""): string {
    writeFileSync(join(appDir, "manifest.json"), '{"id":"app-a"}\n');
    writeFileSync(join(appDir, "index.mjs"), "export default {};\n");
    if (gitignore) writeFileSync(join(appDir, ".gitignore"), gitignore);
    git("add", "--all");
    git("commit", "--quiet", "--no-gpg-sign", "-m", "Commit App activation");
    return git("rev-parse", "--verify", "HEAD^{commit}").trim();
  }

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", appDir, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  }
});
