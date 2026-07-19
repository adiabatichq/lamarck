import canonicalAppPackage from "../../template/apps/hello-world/package.json" with { type: "json" };
import canonicalAppPackageLock from "../../template/apps/hello-world/package-lock.json" with { type: "json" };

interface CanonicalAppPackageLock {
  readonly name: string;
  readonly version: string;
  readonly lockfileVersion: number;
  readonly requires: boolean;
  readonly packages: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const LOCK = canonicalAppPackageLock as CanonicalAppPackageLock;

export function createAppPackageJson(appId: string): string {
  return `${JSON.stringify({
    ...canonicalAppPackage,
    name: `lamarck-app-${appId}`,
  }, null, 2)}\n`;
}

/**
 * Render the checked-in, fully resolved App dependency graph for a new App.
 * This intentionally performs no package-manager or network resolution.
 */
export function createAppPackageLock(appId: string): string {
  const packageName = `lamarck-app-${appId}`;
  const root = LOCK.packages[""];
  if (!root) throw new Error("Canonical App package lock has no root package");

  return `${JSON.stringify({
    ...LOCK,
    name: packageName,
    packages: {
      ...LOCK.packages,
      "": {
        ...root,
        name: packageName,
      },
    },
  }, null, 2)}\n`;
}
