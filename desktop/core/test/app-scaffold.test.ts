import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import canonicalAppPackageLock from "../../template/apps/hello-world/package-lock.json" with { type: "json" };
import { createAppPackageJson, createAppPackageLock } from "../src/app-scaffold";

interface PackageDocument {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

interface LockDocument {
  readonly name: string;
  readonly version: string;
  readonly lockfileVersion: number;
  readonly packages: Record<string, Record<string, unknown>>;
}

const SYSTEM_SDK_LOCK = (canonicalAppPackageLock as LockDocument)
  .packages["node_modules/@lamarck/system"];

describe("new App package lock", () => {
  test("renders package.json from the same canonical template", async () => {
    const canonical = JSON.parse(await readFile(
      fileURLToPath(new URL("../../template/apps/hello-world/package.json", import.meta.url)),
      "utf8",
    )) as PackageDocument;
    expect(JSON.parse(createAppPackageJson("notes"))).toEqual({
      ...canonical,
      name: "lamarck-app-notes",
    });
  });

  test("renders a deterministic closed lock without resolving packages at runtime", () => {
    const first = createAppPackageLock("notes");
    const second = createAppPackageLock("notes");
    const other = createAppPackageLock("calendar");
    expect(second).toBe(first);
    expect(other).not.toBe(first);

    const lock = JSON.parse(first) as LockDocument;
    expect(lock).toMatchObject({
      name: "lamarck-app-notes",
      version: "0.1.0",
      lockfileVersion: 3,
    });
    expect(lock.packages[""]?.name).toBe("lamarck-app-notes");
    expect(lock.packages["node_modules/@lamarck/system"]).toEqual(SYSTEM_SDK_LOCK);
  });

  test.each(["hello-world", "tools"])(
    "keeps the %s template and newly created Apps on the same canonical graph",
    async (appId) => {
      const appDir = fileURLToPath(new URL(`../../template/apps/${appId}/`, import.meta.url));
      const [packageBytes, lockBytes] = await Promise.all([
        readFile(`${appDir}package.json`, "utf8"),
        readFile(`${appDir}package-lock.json`, "utf8"),
      ]);
      const packageDocument = JSON.parse(packageBytes) as PackageDocument;
      const lock = JSON.parse(lockBytes) as LockDocument;
      const root = lock.packages[""]!;

      expect(lockBytes).toBe(createAppPackageLock(appId));
      expect(lock.name).toBe(packageDocument.name);
      expect(lock.version).toBe(packageDocument.version);
      expect(root.name).toBe(packageDocument.name);
      expect(root.version).toBe(packageDocument.version);
      expect(root.dependencies).toEqual(packageDocument.dependencies);
      expect(root.devDependencies).toEqual(packageDocument.devDependencies);
      expect(lock.packages["node_modules/@lamarck/system"]).toEqual(SYSTEM_SDK_LOCK);
      expect(await readdir(appDir)).not.toContain("lamarck-system.d.ts");
    },
  );
});
