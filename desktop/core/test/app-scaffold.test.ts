import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as appLoader from "../src/app-loader";
import {
  APP_V1_SCAFFOLD_FILES,
  instantiateBlankApp,
} from "../src/app-scaffold";

const roots: string[] = [];
const canonicalScaffold = fileURLToPath(new URL("../scaffolds/app-v1", import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; appsDir: string; scaffoldDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lamarck-app-scaffold-"));
  roots.push(root);
  const appsDir = join(root, "apps");
  mkdirSync(appsDir);
  return { root, appsDir, scaffoldDir: canonicalScaffold };
}

function copyScaffold(root: string, name: string): string {
  const scaffoldDir = join(root, name);
  mkdirSync(scaffoldDir);
  for (const filename of APP_V1_SCAFFOLD_FILES) {
    writeFileSync(join(scaffoldDir, filename), readFileSync(join(canonicalScaffold, filename)));
  }
  return scaffoldDir;
}

async function initializeGit(appDir: string): Promise<void> {
  mkdirSync(join(appDir, ".git"));
  writeFileSync(join(appDir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

describe("blank App scaffold v1", () => {
  test("is exactly the six-file data-only scaffold", () => {
    expect(readdirSync(canonicalScaffold).sort()).toEqual([...APP_V1_SCAFFOLD_FILES].sort());
  });

  test("substitutes package identity and safely renders the prior minimal App", async () => {
    const { appsDir, scaffoldDir } = fixture();
    const name = `Daily \"Notes\" \\ </title><script>alert('x')</script> & More`;
    const result = await instantiateBlankApp({
      appsDir,
      scaffoldDir,
      id: "daily-notes",
      name,
      description: "A blank notes App.",
      async initializeGit(appDir) {
        expect(existsSync(join(appDir, "manifest.json"))).toBe(false);
        expect(readdirSync(appDir).sort()).toEqual([...APP_V1_SCAFFOLD_FILES].sort());
        await initializeGit(appDir);
      },
    });

    expect(result.manifest).toMatchObject({
      id: "daily-notes",
      name,
      description: "A blank notes App.",
    });
    expect(readdirSync(result.dir).sort()).toEqual([
      ".git",
      ...APP_V1_SCAFFOLD_FILES,
      "manifest.json",
    ].sort());

    const packageDocument = JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(result.dir, "package-lock.json"), "utf8"));
    expect(packageDocument.name).toBe("lamarck-app-daily-notes");
    expect(lock.name).toBe(packageDocument.name);
    expect(lock.packages[""].name).toBe(packageDocument.name);

    const appSource = readFileSync(join(result.dir, "index.tsx"), "utf8");
    const appNameLiteral = appSource.match(/^const appName = (.+);$/m)?.[1];
    expect(appNameLiteral).toBeDefined();
    expect(JSON.parse(appNameLiteral!)).toBe(name);
    expect(appSource).toContain("return <div>{appName}</div>;");
    expect(appSource).not.toContain("Your blank Lamarck App is ready to shape");

    const html = readFileSync(join(result.dir, "index.html"), "utf8");
    expect(html).toContain(
      "<title>Daily &quot;Notes&quot; \\ &lt;/title&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; More</title>",
    );
    expect(html).not.toContain("<script>alert('x')</script>");
  });

  test("copies only the fixed allowlist", async () => {
    const { root, appsDir } = fixture();
    const scaffoldDir = copyScaffold(root, "scaffold-with-extra-file");
    writeFileSync(join(scaffoldDir, "ambient-secret.txt"), "must not copy");

    const result = await instantiateBlankApp({
      appsDir,
      scaffoldDir,
      id: "safe-copy",
      name: "Safe Copy",
      description: "Tests allowlisted copying.",
      initializeGit,
    });
    expect(existsSync(join(result.dir, "ambient-secret.txt"))).toBe(false);
  });

  test("never replaces an existing App directory", async () => {
    const { appsDir, scaffoldDir } = fixture();
    mkdirSync(join(appsDir, "already-here"));
    writeFileSync(join(appsDir, "already-here", "mine.txt"), "preserve");

    await expect(instantiateBlankApp({
      appsDir,
      scaffoldDir,
      id: "already-here",
      name: "Already Here",
      description: "Must not replace.",
      initializeGit,
    })).rejects.toThrow();
    expect(readFileSync(join(appsDir, "already-here", "mine.txt"), "utf8")).toBe("preserve");
  });

  test("rolls back a newly owned target after required scaffold materialization fails", async () => {
    const { root, appsDir } = fixture();
    const scaffoldDir = copyScaffold(root, "incomplete-scaffold");
    rmSync(join(scaffoldDir, "main.tsx"));

    await expect(instantiateBlankApp({
      appsDir,
      scaffoldDir,
      id: "missing-required-file",
      name: "Missing Required File",
      description: "Must roll back.",
      initializeGit,
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(join(appsDir, "missing-required-file"))).toBe(false);
  });

  test("rolls back a newly owned target when completed App validation fails", async () => {
    const { appsDir, scaffoldDir } = fixture();
    vi.spyOn(appLoader, "loadApps").mockImplementationOnce(async () => {
      const appDir = join(appsDir, "invalid-after-write");
      expect(readdirSync(appDir).sort()).toEqual([
        ".git",
        ...APP_V1_SCAFFOLD_FILES,
        "manifest.json",
      ].sort());
      throw new Error("validation failed");
    });

    await expect(instantiateBlankApp({
      appsDir,
      scaffoldDir,
      id: "invalid-after-write",
      name: "Invalid After Write",
      description: "Must roll back.",
      initializeGit,
    })).rejects.toThrow("validation failed");
    expect(existsSync(join(appsDir, "invalid-after-write"))).toBe(false);
  });

  test("keeps external Git initialization best-effort", async () => {
    const { appsDir, scaffoldDir } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await instantiateBlankApp({
      appsDir,
      scaffoldDir,
      id: "git-unavailable",
      name: "Git Unavailable",
      description: "Creation must still succeed.",
      async initializeGit() {
        throw new Error("git executable not found");
      },
    });

    expect(warning).toHaveBeenCalledOnce();
    expect(existsSync(join(result.dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(result.dir, ".git"))).toBe(false);
  });

  test("rolls back when a required scaffold token is malformed", async () => {
    const { root, appsDir } = fixture();
    const scaffoldDir = copyScaffold(root, "bad-token-scaffold");
    writeFileSync(join(scaffoldDir, "index.tsx"), "export default function App() {}\n");

    await expect(instantiateBlankApp({
      appsDir,
      scaffoldDir,
      id: "bad-token",
      name: "Bad Token",
      description: "Must roll back.",
      initializeGit,
    })).rejects.toThrow("must contain exactly 1");
    expect(existsSync(join(appsDir, "bad-token"))).toBe(false);
  });
});
