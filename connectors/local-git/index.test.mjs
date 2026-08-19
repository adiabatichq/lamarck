import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import connector, { discoverConfiguredRepos, normalizeConfig } from "./index.mjs";

test("normalizes nested repository discovery as an opt-in root setting", () => {
  const root = join(tmpdir(), "local-git-root");

  assert.deepEqual(normalizeConfig({ localGit: { roots: [root] } }).roots, [
    { path: root, includeNestedRepos: false },
  ]);
  assert.deepEqual(normalizeConfig({
    localGit: { roots: [{ path: root, includeNestedRepos: true }] },
  }).roots, [
    { path: root, includeNestedRepos: true },
  ]);
});

test("discovers repositories inside another repository only when enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-git-nested-"));
  const parent = join(root, "parent");
  const nested = join(parent, "packages", "nested");

  try {
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["-C", parent, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", nested, "init"], { stdio: "ignore" });

    const directOnly = await discoverConfiguredRepos({
      localGit: { roots: [{ path: root }] },
    });
    assert.deepEqual(directOnly.map((repo) => repo.path), [parent]);

    const withNested = await discoverConfiguredRepos({
      localGit: { roots: [{ path: root, includeNestedRepos: true }] },
    });
    assert.deepEqual(withNested.map((repo) => repo.path), [nested, parent].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup lists every discovered repository in a scrollable section", async () => {
  const controller = new AbortController();
  try {
    const panel = await connector.configUi({
      panelId: "setup",
      configStore: {},
      signal: controller.signal,
    });
    const html = await fetch(panel.url).then((response) => response.text());

    assert.match(html, /<h2>Repositories<\/h2>/);
    assert.match(html, /Include nested repos/);
    assert.match(html, /class="repositoryList"/);
    assert.match(html, /overflow-y: auto/);
    assert.doesNotMatch(html, /<h2>Preview<\/h2>/);
    assert.doesNotMatch(html, /slice\(0, 12\)/);
  } finally {
    controller.abort();
  }
});
