import { createHash } from "node:crypto";

export const NPM_INSTALL_INPUT_POLICY = "capsule-npm-install-v1" as const;
export const MAX_INSTALL_PACKAGE_JSON_BYTES = 1024 * 1024;
export const MAX_INSTALL_PACKAGE_LOCK_BYTES = 64 * 1024 * 1024;
export const MAX_INSTALL_NPMRC_BYTES = 1024 * 1024;

const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
]);

export interface NpmInstallInput {
  readonly packageJson: Uint8Array;
  readonly packageLock: Uint8Array;
  readonly npmrc?: Uint8Array;
  readonly hasBindingGyp: boolean;
  readonly hasShrinkwrap: boolean;
}

export interface EvaluatedNpmInstallInput {
  readonly digest: `sha256:${string}`;
  readonly warmEligible: boolean;
  readonly reason?: string;
}

/**
 * Produces the Host/Guest shared, pre-network fingerprint for one npm install.
 * The digest is useful even when reuse is conservatively disabled: a cold
 * Build still verifies that Host and Guest evaluated the exact same bytes.
 */
export function evaluateNpmInstallInput(input: NpmInstallInput): EvaluatedNpmInstallInput {
  assertBytes("package.json", input.packageJson, MAX_INSTALL_PACKAGE_JSON_BYTES);
  assertBytes("package-lock.json", input.packageLock, MAX_INSTALL_PACKAGE_LOCK_BYTES);
  if (input.npmrc !== undefined) {
    assertBytes(".npmrc", input.npmrc, MAX_INSTALL_NPMRC_BYTES, true);
  }
  const hash = createHash("sha256");
  hash.update(`${NPM_INSTALL_INPUT_POLICY}\0`, "ascii");
  updateFramed(hash, "package.json", input.packageJson);
  updateFramed(hash, "package-lock.json", input.packageLock);
  updateFramed(
    hash,
    ".npmrc",
    input.npmrc === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), input.npmrc]),
  );
  updateFramed(hash, "binding.gyp", Buffer.from([input.hasBindingGyp ? 1 : 0]));
  updateFramed(hash, "npm-shrinkwrap.json", Buffer.from([input.hasShrinkwrap ? 1 : 0]));
  const digest = `sha256:${hash.digest("hex")}` as const;

  const reason = warmIneligibilityReason(input);
  return Object.freeze({
    digest,
    warmEligible: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
  });
}

function warmIneligibilityReason(input: NpmInstallInput): string | undefined {
  if (input.hasShrinkwrap) return "npm-shrinkwrap.json requires a cold install";
  if (input.hasBindingGyp) return "binding.gyp may trigger an implicit source-dependent install";
  const packageJson = parseJsonObject(input.packageJson);
  if (!packageJson) return "package.json is not a plain JSON object";
  const packageLock = parseJsonObject(input.packageLock);
  if (!packageLock) return "package-lock.json is not a plain JSON object";
  if (packageJson.workspaces !== undefined) {
    return "npm workspaces are conservatively cold-built";
  }
  const scripts = packageJson.scripts;
  if (isPlainObject(scripts)) {
    for (const name of INSTALL_LIFECYCLE_SCRIPTS) {
      if (Object.prototype.hasOwnProperty.call(scripts, name)) {
        return `npm lifecycle script ${name} requires a cold install`;
      }
    }
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = packageJson[field];
    if (!isPlainObject(dependencies)) continue;
    for (const specification of Object.values(dependencies)) {
      if (
        typeof specification === "string"
        && /^(?:file:|link:|workspace:)/i.test(specification)
      ) {
        return "local and workspace dependencies are conservatively cold-built";
      }
    }
  }
  const packages = packageLock.packages;
  if (!isPlainObject(packages)) return "package-lock.json has no packages object";
  for (const value of Object.values(packages)) {
    if (!isPlainObject(value)) continue;
    if (value.link === true) return "linked lockfile packages are conservatively cold-built";
    if (typeof value.resolved === "string" && /^(?:file:|link:)/i.test(value.resolved)) {
      return "local lockfile packages are conservatively cold-built";
    }
  }
  return undefined;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function updateFramed(
  hash: ReturnType<typeof createHash>,
  label: string,
  bytes: Uint8Array,
): void {
  const header = Buffer.allocUnsafe(8);
  header.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(label, "ascii");
  hash.update("\0", "ascii");
  hash.update(header);
  hash.update(bytes);
}

function assertBytes(
  label: string,
  bytes: Uint8Array,
  maximum: number,
  allowEmpty = false,
): void {
  if (
    !(bytes instanceof Uint8Array)
    || (!allowEmpty && bytes.byteLength < 1)
    || bytes.byteLength > maximum
  ) {
    throw new Error(`${label} is outside the install-input byte bound`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
