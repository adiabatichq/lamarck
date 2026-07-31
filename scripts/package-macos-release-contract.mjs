import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const MACOS_RELEASE_APP_NAME = "Lamarck.app";
export const MACOS_RELEASE_BUNDLE_ID = "ai.lamarck.desktop";
export const MACOS_DEVICE_IDENTITY_REVIEW_ACKNOWLEDGEMENTS = Object.freeze([
  "LAMARCK_DEVICE_IDENTITY_APPLE_POLICY_REVIEW",
  "LAMARCK_DEVICE_IDENTITY_APPLE_DTS_REVIEW",
  "LAMARCK_DEVICE_IDENTITY_APPLE_LEGAL_REVIEW",
]);
export const MACOS_ELECTRON_ARTIFACT = Object.freeze({
  version: "42.6.1",
  architecture: "arm64",
  archiveName: "electron-v42.6.1-darwin-arm64.zip",
  sha256: "52d96caea8edf9fab6f8c2c2ec77357f907146a60a1a1360f9b9079ab0df57b8",
  url: "https://github.com/electron/electron/releases/download/v42.6.1/electron-v42.6.1-darwin-arm64.zip",
  npmResolved: "https://registry.npmjs.org/electron/-/electron-42.6.1.tgz",
  npmIntegrity: "sha512-HR9yiOyl+kZpSAugjOpBNvKpoh1wNpTK4wl6geD9W9Xmo6L6IgEzVB/JKlbEUDdXYeqRaaEhTUSSfyQ/g9iXvQ==",
});

const DEVELOPER_ID_PREFIX = "Developer ID Application:";
const CERTIFICATE_SHA1_PATTERN = /^[A-Fa-f0-9]{40}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{1,126}[A-Za-z0-9])?$/;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3}$/;
const SAFE_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

export const MACOS_RELEASE_ENTITLEMENTS = Object.freeze({
  none: Object.freeze([]),
  electronJit: Object.freeze(["com.apple.security.cs.allow-jit"]),
  electronPlugin: Object.freeze([
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]),
  capsuleVmHost: Object.freeze(["com.apple.security.virtualization"]),
});

/**
 * Load the non-secret release contract from environment variables.
 *
 * Notary credentials themselves stay in the macOS keychain. The environment
 * carries only the name of the notarytool keychain profile, so this process
 * never needs an Apple password or private API-key bytes.
 */
export function loadMacOsReleaseConfig({
  root,
  packageVersion,
  env = process.env,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("production macOS release packaging requires macOS");
  }
  if (!root || !isAbsolute(root)) throw new Error("release repository root must be absolute");

  const codesignIdentity = distributionIdentity(env.LAMARCK_CODESIGN_IDENTITY);
  const notaryProfileName = notaryProfile(env.LAMARCK_NOTARY_PROFILE);
  requireAppleDeviceIdentityReviews(env);
  const version = releaseVersion(env.LAMARCK_RELEASE_VERSION ?? packageVersion);
  const bundleIdentifier = bundleIdentifierValue(
    env.LAMARCK_BUNDLE_ID ?? MACOS_RELEASE_BUNDLE_ID,
  );
  if (architecture === "x64") {
    throw new Error("alpha macOS release is arm64-only; no signed x64 Guest image exists");
  }
  if (architecture !== "arm64") {
    throw new Error(`unsupported macOS release architecture ${architecture}`);
  }
  const expectedGuestArchitecture = "arm64";

  const guestReleaseRoot = absoluteResolvedPath(
    root,
    env.LAMARCK_GUEST_RELEASE_ROOT
      ?? ".lamarck/build/capsule-guest/release",
    "LAMARCK_GUEST_RELEASE_ROOT",
  );
  const electronArchiveSource = env.LAMARCK_ELECTRON_ARCHIVE === undefined
    ? undefined
    : absoluteResolvedPath(root, env.LAMARCK_ELECTRON_ARCHIVE, "LAMARCK_ELECTRON_ARCHIVE");
  const outputRoot = absoluteResolvedPath(
    root,
    env.LAMARCK_MACOS_RELEASE_OUTPUT
      ?? ".lamarck/release/macos",
    "LAMARCK_MACOS_RELEASE_OUTPUT",
  );
  if (outputRoot === root || guestReleaseRoot === outputRoot || electronArchiveSource === outputRoot) {
    throw new Error("macOS release output must be a dedicated path");
  }

  return Object.freeze({
    root,
    codesignIdentity,
    notaryProfile: notaryProfileName,
    version,
    bundleIdentifier,
    expectedGuestArchitecture,
    guestReleaseRoot,
    electronArtifact: MACOS_ELECTRON_ARTIFACT,
    electronArchiveSource,
    outputRoot,
    appName: MACOS_RELEASE_APP_NAME,
    finalAppPath: resolve(outputRoot, MACOS_RELEASE_APP_NAME),
    finalArchivePath: resolve(
      outputRoot,
      `Lamarck-${version}-macos-${expectedGuestArchitecture}.zip`,
    ),
  });
}

export function requireAppleDeviceIdentityReviews(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("Apple device identity review acknowledgements are required");
  }
  for (const name of MACOS_DEVICE_IDENTITY_REVIEW_ACKNOWLEDGEMENTS) {
    if (env[name] !== "1") {
      throw new Error(`${name}=1 is required for production macOS device identity distribution`);
    }
  }
}

/** A stable, secret-free plan used by --dry-run and contract tests. */
export function createMacOsReleasePlan(config) {
  return Object.freeze([
    Object.freeze({ id: "verify-credentials", action: "verify-installed-developer-id-identity" }),
    Object.freeze({ id: "verify-input", action: "validate-signed-guest-release", path: config.guestReleaseRoot }),
    Object.freeze({ id: "build-shell", action: "sealed-pinned-shell-production-build" }),
    Object.freeze({
      id: "electron-input",
      action: "materialize-lock-bound-electron-artifact",
      version: config.electronArtifact.version,
      architecture: config.electronArtifact.architecture,
      sha256: config.electronArtifact.sha256,
    }),
    Object.freeze({
      id: "build-helper",
      action: "build-and-distribution-sign-vz-helper",
      identity: config.codesignIdentity,
    }),
    Object.freeze({ id: "stage-native", action: "stage-exact-native-resources" }),
    Object.freeze({ id: "assemble-app", action: "assemble-electron-app", appName: config.appName }),
    Object.freeze({ id: "sign-app", action: "electron-osx-sign-inside-out-hardened-runtime" }),
    Object.freeze({ id: "verify-signature", action: "codesign-deep-strict" }),
    Object.freeze({
      id: "notarize",
      action: "notarytool-submit-wait",
      keychainProfile: config.notaryProfile,
    }),
    Object.freeze({ id: "staple", action: "stapler-staple-and-validate" }),
    Object.freeze({ id: "gatekeeper", action: "spctl-assess-execute" }),
    Object.freeze({ id: "postflight", action: "verify-exact-native-tree-and-signatures" }),
    Object.freeze({ id: "publish", action: "exclusive-atomic-publish-app-and-stapled-zip" }),
  ]);
}

/** Resolve a configured name or SHA-1 against macOS's valid signing identities. */
export function resolveInstalledDeveloperIdIdentity(configuredValue, securityOutput) {
  const configured = distributionIdentity(configuredValue);
  if (typeof securityOutput !== "string" || securityOutput.length > 4 * 1024 * 1024) {
    throw new Error("security identity output is invalid");
  }
  const identities = [...securityOutput.matchAll(
    /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"\s*$/gm,
  )].map((match) => ({
    hash: match[1].toUpperCase(),
    name: match[2],
    teamId: developerTeamId(match[2]),
  }));
  const match = CERTIFICATE_SHA1_PATTERN.test(configured)
    ? identities.find((identity) => identity.hash === configured.toUpperCase())
    : identities.find((identity) => identity.name === configured);
  if (!match || !match.name.startsWith(DEVELOPER_ID_PREFIX) || !match.teamId) {
    throw new Error("LAMARCK_CODESIGN_IDENTITY is not an installed valid Developer ID Application identity");
  }
  return Object.freeze(match);
}

export function validateLockedElectronPackage(packageLock) {
  if (typeof packageLock !== "object" || packageLock === null || Array.isArray(packageLock)) {
    throw new Error("package-lock.json must be an object");
  }
  const entry = packageLock.packages?.["node_modules/electron"];
  if (
    packageLock.lockfileVersion !== 3
    || typeof entry !== "object"
    || entry === null
    || entry.version !== MACOS_ELECTRON_ARTIFACT.version
    || entry.resolved !== MACOS_ELECTRON_ARTIFACT.npmResolved
    || entry.integrity !== MACOS_ELECTRON_ARTIFACT.npmIntegrity
  ) {
    throw new Error("package-lock Electron dependency does not match the pinned macOS artifact");
  }
  return MACOS_ELECTRON_ARTIFACT;
}

export function assertExactCodeSignatureIdentity(details, expectedIdentity, label = "signed code") {
  if (typeof details !== "string" || details.length > 4 * 1024 * 1024) {
    throw new Error(`${label} signature details are invalid`);
  }
  if (
    !expectedIdentity
    || !CERTIFICATE_SHA1_PATTERN.test(expectedIdentity.hash)
    || typeof expectedIdentity.name !== "string"
    || typeof expectedIdentity.teamId !== "string"
  ) throw new Error("expected signing identity is invalid");
  const authorities = [...details.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]);
  const teamIdentifiers = [...details.matchAll(/^TeamIdentifier=(.+)$/gm)].map((match) => match[1]);
  if (authorities[0] !== expectedIdentity.name) {
    throw new Error(`${label} was not signed by the resolved Developer ID certificate authority`);
  }
  if (teamIdentifiers.length !== 1 || teamIdentifiers[0] !== expectedIdentity.teamId) {
    throw new Error(`${label} Team ID does not match the resolved Developer ID certificate`);
  }
}

export function assertExactMachOArchitecture(source, expectedArchitecture, label = "Mach-O code") {
  if (typeof source !== "string") throw new Error(`${label} architecture output is invalid`);
  const architectures = source.trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== expectedArchitecture) {
    throw new Error(`${label} must contain exactly the ${expectedArchitecture} architecture`);
  }
}

export function assertExactBooleanEntitlements(value, expectedKeys, label = "signed code") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} entitlements are not a dictionary`);
  }
  if (!Array.isArray(expectedKeys) || new Set(expectedKeys).size !== expectedKeys.length) {
    throw new Error("expected entitlement keys must be a unique array");
  }
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} entitlements have missing or unexpected keys`);
  }
  for (const key of actual) {
    if (value[key] !== true) throw new Error(`${label} entitlement ${key} is not true`);
  }
}

/**
 * Return the least-privilege entitlement set for each signed code object.
 * `@electron/osx-sign` still owns the inside-out traversal and signing order;
 * this policy prevents its broad general-purpose defaults from silently
 * granting device access that Lamarck does not use.
 */
export function macOsReleaseEntitlementsForPath(filePath, { appPath, capsuleHelper }) {
  for (const [label, value] of Object.entries({ filePath, appPath, capsuleHelper })) {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error(`${label} must be an absolute release path`);
    }
  }
  const resolvedApp = resolve(appPath);
  const resolvedFile = resolve(filePath);
  const resolvedHelper = resolve(capsuleHelper);
  const appRelativePath = relative(resolvedApp, resolvedFile);
  if (
    resolvedFile !== resolvedApp
    && (appRelativePath === ".." || appRelativePath.startsWith(`..${sep}`) || isAbsolute(appRelativePath))
  ) {
    throw new Error("signed code path escaped Lamarck.app");
  }

  if (resolvedFile === resolvedHelper) return MACOS_RELEASE_ENTITLEMENTS.capsuleVmHost;
  if (
    resolvedFile === resolvedApp
    || resolvedFile === join(resolvedApp, "Contents", "MacOS", "Electron")
  ) return MACOS_RELEASE_ENTITLEMENTS.electronJit;
  const pathComponents = appRelativePath.split(sep);
  if (pathComponents.includes("Electron Helper (Plugin).app")) {
    return MACOS_RELEASE_ENTITLEMENTS.electronPlugin;
  }
  if (
    pathComponents.includes("Electron Helper.app")
    || pathComponents.includes("Electron Helper (GPU).app")
    || pathComponents.includes("Electron Helper (Renderer).app")
  ) return MACOS_RELEASE_ENTITLEMENTS.electronJit;
  return MACOS_RELEASE_ENTITLEMENTS.none;
}

export function distributionIdentity(value) {
  const identity = boundedSingleLine(value, "LAMARCK_CODESIGN_IDENTITY");
  if (identity === "-" || /^(?:ad[ -]?hoc|adhoc)$/i.test(identity)) {
    throw new Error("LAMARCK_CODESIGN_IDENTITY must not use ad-hoc signing");
  }
  if (!identity.startsWith(DEVELOPER_ID_PREFIX) && !CERTIFICATE_SHA1_PATTERN.test(identity)) {
    throw new Error(
      "LAMARCK_CODESIGN_IDENTITY must be a Developer ID Application identity or certificate SHA-1",
    );
  }
  return identity;
}

export function notaryProfile(value) {
  const profile = boundedSingleLine(value, "LAMARCK_NOTARY_PROFILE");
  if (!SAFE_PROFILE_PATTERN.test(profile)) {
    throw new Error("LAMARCK_NOTARY_PROFILE contains unsupported characters");
  }
  return profile;
}

export function releaseVersion(value) {
  const version = boundedSingleLine(value, "LAMARCK_RELEASE_VERSION");
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("LAMARCK_RELEASE_VERSION must contain 2-4 numeric components");
  }
  return version;
}

export function bundleIdentifierValue(value) {
  const bundleIdentifier = boundedSingleLine(value, "LAMARCK_BUNDLE_ID");
  if (!BUNDLE_ID_PATTERN.test(bundleIdentifier) || !bundleIdentifier.includes(".")) {
    throw new Error("LAMARCK_BUNDLE_ID is not a valid reverse-DNS bundle identifier");
  }
  return bundleIdentifier;
}

function absoluteResolvedPath(root, value, label) {
  const raw = boundedSingleLine(value, label);
  const path = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!isAbsolute(path)) throw new Error(`${label} must resolve to an absolute path`);
  return path;
}

function boundedSingleLine(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new Error(`${label} is required`);
  }
  if (value !== value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a bounded single-line value`);
  }
  return value;
}

function developerTeamId(identityName) {
  return /\(([A-Z0-9]{10})\)$/.exec(identityName)?.[1];
}
