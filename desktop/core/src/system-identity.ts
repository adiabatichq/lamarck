export interface SystemIdentity {
  readonly version: string;
  readonly commit: string;
  readonly platform: string;
}

export interface SystemReleaseIdentity {
  version: string;
  commit: string;
}

export interface SystemRuntimeIdentity {
  platform: string;
  arch: string;
}

declare const __LAMARCK_PRODUCT_VERSION__: string | undefined;
declare const __LAMARCK_REPOSITORY_COMMIT__: string | undefined;

const FULL_GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PLATFORM_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SYSTEM_PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._-]*-[a-z0-9][a-z0-9._-]*$/;

export function systemIdentityFromBuild(): SystemIdentity {
  if (typeof __LAMARCK_PRODUCT_VERSION__ !== "string") {
    throw new Error("Lamarck product version was not embedded in the Core build");
  }
  if (typeof __LAMARCK_REPOSITORY_COMMIT__ !== "string") {
    throw new Error("Lamarck repository commit was not embedded in the Core build");
  }
  return createSystemIdentity({
    version: __LAMARCK_PRODUCT_VERSION__,
    commit: __LAMARCK_REPOSITORY_COMMIT__,
  });
}

export function createSystemIdentity(
  release: SystemReleaseIdentity,
  runtime: SystemRuntimeIdentity = {
    platform: process.platform,
    arch: process.arch,
  },
): SystemIdentity {
  const releaseObject = requireExactObject(release, ["version", "commit"], "System release identity");
  const runtimeObject = requireExactObject(runtime, ["platform", "arch"], "System runtime identity");
  const platform = requirePlatformComponent(runtimeObject.platform, "System runtime platform");
  const arch = requirePlatformComponent(runtimeObject.arch, "System runtime architecture");

  return validateSystemIdentity({
    version: releaseObject.version,
    commit: releaseObject.commit,
    platform: `${platform}-${arch}`,
  });
}

export function validateSystemIdentity(value: unknown): SystemIdentity {
  const object = requireExactObject(
    value,
    ["version", "commit", "platform"],
    "System identity",
  );
  const version = requireNonEmptyString(object.version, "System identity version");
  if (version === "unknown") {
    throw new Error("System identity version must not be unknown");
  }
  const commit = validateFullGitCommit(object.commit, "System identity commit");
  const platform = requireNonEmptyString(object.platform, "System identity platform");
  if (platform === "unknown" || !SYSTEM_PLATFORM_PATTERN.test(platform)) {
    throw new Error("System identity platform must be an OS-architecture value");
  }

  return { version, commit, platform };
}

export const parseSystemIdentity = validateSystemIdentity;

export function validateFullGitCommit(value: unknown, label = "Git commit"): string {
  if (typeof value !== "string" || !FULL_GIT_COMMIT_PATTERN.test(value)) {
    throw new Error(`${label} must be a full 40- or 64-character lowercase Git commit`);
  }
  return value;
}

function requirePlatformComponent(value: unknown, label: string): string {
  const component = requireNonEmptyString(value, label);
  if (component === "unknown" || !PLATFORM_COMPONENT_PATTERN.test(component)) {
    throw new Error(`${label} is malformed`);
  }
  return component;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an object`);
  }

  const expected = new Set(expectedKeys);
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expected.has(key)) {
      throw new Error(`${label} contains unknown field ${String(key)}`);
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
  return value as Record<string, unknown>;
}
