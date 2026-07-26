#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  BUILD_SNAPSHOT_DIRECTORIES,
  BUILD_SNAPSHOT_FILES,
  BUILD_SNAPSHOT_MANIFEST,
  validateBuildSnapshot,
} from "./build-snapshot.mjs";
import { validateJavaScriptBuilderOutput } from "./js-builder-inventory.mjs";

const [
  legalValue,
  buildrootArchiveValue,
  repoValue,
  outputValue,
  imageVersion = "0.1.0",
  builderImageId,
] =
  process.argv.slice(2);
if (!legalValue || !buildrootArchiveValue || !repoValue || !outputValue || !builderImageId) {
  throw new Error(
    "usage: generate-compliance.mjs <buildroot-legal-info> <buildroot-archive> <repo-root> <output> [image-version] <builder-image-id>",
  );
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(imageVersion)) {
  throw new Error("invalid image version");
}
if (!/^sha256:[a-f0-9]{64}$/.test(builderImageId)) {
  throw new Error("builder image ID must be one immutable sha256 Docker image ID");
}

const legalRoot = await requireDirectory(legalValue, "Buildroot legal-info");
const repoRoot = await requireDirectory(repoValue, "repository");
const buildrootArchive = await requireRegularFile(buildrootArchiveValue, "Buildroot source archive");
const outputRoot = resolve(outputValue);
const sourceDateEpoch = parseSourceDateEpoch(process.env.SOURCE_DATE_EPOCH ?? "0");
await mkdir(outputRoot, { recursive: false, mode: 0o755 });
const snapshot = await validateBuildSnapshot(repoRoot);

const legalInfoFiles = await verifyBuildrootLegalInfo(legalRoot);
const manifestSource = await readFile(join(legalRoot, "manifest.csv"), "utf8");
const manifestPackages = parseBuildrootManifest(manifestSource);
if (manifestPackages.length === 0) throw new Error("Buildroot target manifest contains no packages");

const licensesSource = join(legalRoot, "licenses");
const sourcesSource = join(legalRoot, "sources");
await requireNonemptyTree(licensesSource, "Buildroot target licenses");
await requireNonemptyTree(sourcesSource, "Buildroot target sources");
const packages = [];
for (const component of manifestPackages) {
  if (!component.licenseFiles) {
    throw new Error(`Buildroot target ${component.name} has no retained license files`);
  }
  if (!component.sourceArchive || component.sourceArchive === "not saved") {
    throw new Error(`Buildroot target ${component.name} has no retained source archive`);
  }
  const sourceName = safeFileName(component.sourceArchive, `${component.name} source archive`);
  const sourceDirectory = safeFileName(
    `${component.name}-${buildrootSanitize(component.version)}`,
    `${component.name} source directory`,
  );
  const sourceArchivePath = `${sourceDirectory}/${sourceName}`;
  await requireRegularFile(
    join(sourcesSource, sourceDirectory, sourceName),
    `${component.name} source archive`,
  );
  if (!legalInfoFiles.has(`sources/${sourceArchivePath}`)) {
    throw new Error(`${component.name} source archive is not covered by legal-info.sha256`);
  }
  packages.push({ ...component, sourceArchivePath });
}

const buildrootMetadata = join(outputRoot, "buildroot");
const licensesOutput = join(outputRoot, "licenses");
const sourceOutput = join(outputRoot, "corresponding-source");
await mkdir(buildrootMetadata, { mode: 0o755 });
await copySelectedFiles(legalRoot, buildrootMetadata, [
  "README",
  "buildroot.config",
  "legal-info.sha256",
  "manifest.csv",
]);
await copyTree(licensesSource, licensesOutput);
await mkdir(sourceOutput, { mode: 0o755 });
await copyTree(sourcesSource, join(sourceOutput, "target-packages"));
await copyRegularFile(
  buildrootArchive,
  join(sourceOutput, "buildroot", basename(buildrootArchive)),
);
await copyRegularFile(
  join(repoRoot, BUILD_SNAPSHOT_MANIFEST),
  join(outputRoot, BUILD_SNAPSHOT_MANIFEST),
);

// Corresponding source must be the same explicit set that crossed the sealed
// build boundary. Keeping a second hand-maintained list silently omits inputs
// when a workspace or shared configuration is added to the snapshot.
const projectFiles = [...BUILD_SNAPSHOT_FILES, ...BUILD_SNAPSHOT_DIRECTORIES];
for (const projectPath of projectFiles) {
  const source = resolveInside(repoRoot, projectPath);
  const destination = join(sourceOutput, "lamarck-project", projectPath);
  const details = await lstat(source);
  if (details.isSymbolicLink()) throw new Error(`project source ${projectPath} is a symbolic link`);
  if (details.isDirectory()) await copyTree(source, destination);
  else if (details.isFile()) await copyRegularFile(source, destination);
  else throw new Error(`project source ${projectPath} is not a regular file or directory`);
}

const packageRecords = await Promise.all(packages.map(async (component) => {
  const sourcePath = `corresponding-source/target-packages/${component.sourceArchivePath}`;
  const sourceFile = join(outputRoot, sourcePath);
  return {
    ...component,
    sourcePath,
    sourceSha256: `sha256:${await sha256File(sourceFile)}`,
  };
}));

const sbomSeed = JSON.stringify(packageRecords.map((component) => [
  component.name,
  component.version,
  component.license,
  component.sourceSha256,
]));
const namespaceDigest = createHash("sha256").update(sbomSeed).digest("hex");
const created = new Date(sourceDateEpoch * 1_000).toISOString().replace(".000Z", "Z");
const spdxPackages = packageRecords.map((component) => ({
  SPDXID: spdxId(component.name, component.version),
  name: component.name,
  versionInfo: component.version,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: "NOASSERTION",
  licenseDeclared: "NOASSERTION",
  licenseComments: `Buildroot declared license: ${component.license}`,
  copyrightText: "NOASSERTION",
  sourceInfo: [
    `Buildroot source archive: ${component.sourceArchive}`,
    `Buildroot source site: ${component.sourceSite || "not declared"}`,
    `Retained source: ${component.sourcePath}`,
  ].join("; "),
}));
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `Lamarck-Capsule-Guest-${imageVersion}-arm64`,
  documentNamespace: `https://lamarck.invalid/spdx/capsule-guest/${namespaceDigest}`,
  creationInfo: {
    created,
    creators: ["Tool: lamarck-generate-compliance-1"],
  },
  packages: spdxPackages,
  relationships: spdxPackages.map((component) => ({
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: component.SPDXID,
  })),
};
await writeJson(join(outputRoot, "sbom.spdx.json"), sbom);

const notices = [
  "Lamarck Capsule Guest — Third-Party Notices",
  "",
  "This index is generated from Buildroot legal-info for target packages included in the Guest image.",
  "The complete retained license texts are in licenses/.",
  "Exact corresponding source is available as described in corresponding-source-offer.json.",
  "",
  ...packageRecords.flatMap((component) => [
    `${component.name} ${component.version}`,
    `Declared license: ${component.license}`,
    `License files: ${component.licenseFiles}`,
    `Source: ${component.sourcePath}`,
    `Upstream site: ${component.sourceSite || "not declared"}`,
    "",
  ]),
].join("\n");
await writeExclusive(join(outputRoot, "THIRD_PARTY_NOTICES.txt"), `${notices}\n`);

const retainedSourceFiles = await listRegularFiles(sourceOutput);
const sourceOffer = {
  schemaVersion: 1,
  subject: {
    name: "Lamarck Capsule Guest",
    imageVersion,
    architecture: "arm64",
  },
  fulfillment: {
    kind: "prepared-corresponding-source",
    root: "corresponding-source",
    statement:
      "The exact source archives, applied Buildroot patches, Buildroot source, configuration, and Lamarck build sources are prepared at the paths listed below. Release signing packages them as a separately downloadable archive.",
  },
  buildroot: {
    version: "2026.05",
    targetManifest: "buildroot/manifest.csv",
    configuration: "buildroot/buildroot.config",
    legalReport: "buildroot/README",
  },
  components: packageRecords.map((component) => ({
    name: component.name,
    version: component.version,
    declaredLicense: component.license,
    sourcePath: component.sourcePath,
    sourceSha256: component.sourceSha256,
  })),
  files: await Promise.all(retainedSourceFiles.map(async (path) => ({
    path: `corresponding-source/${path}`,
    sha256: `sha256:${await sha256File(join(sourceOutput, path))}`,
  }))),
};
await writeJson(join(outputRoot, "corresponding-source-offer.json"), sourceOffer);

const builderPackagesPath = join(dirname(dirname(legalRoot)), "image-input", "builder-packages.tsv");
const imageInputRoot = join(dirname(dirname(legalRoot)), "image-input");
const prebuiltRoot = join(dirname(dirname(legalRoot)), "prebuilt-verification");
let builderPackages = "";
try {
  builderPackages = await readFile(builderPackagesPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (!builderPackages.trim()) {
  throw new Error("builder-packages.tsv is required for the pinned builder inventory");
}
const javascriptInventoryPath = join(imageInputRoot, "js-builder-environment.json");
const verifiedJavaScript = await validateJavaScriptBuilderOutput(prebuiltRoot, repoRoot);
const javascriptInventory = verifiedJavaScript.inventory;
if (await sha256File(javascriptInventoryPath) !== await sha256File(verifiedJavaScript.inventoryPath)) {
  throw new Error("exported JavaScript builder inventories do not match");
}
await copyRegularFile(
  javascriptInventoryPath,
  join(outputRoot, "js-builder-environment.json"),
);
await writeJson(join(outputRoot, "builder-environment.json"), {
  schemaVersion: 1,
  builderImageId,
  baseImage:
    "debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df",
  aptSnapshot: "20260624T000000Z",
  aptSnapshotTransport: "http-with-debian-signed-release-metadata",
  buildrootVersion: "2026.05",
  sourceSnapshotManifestDigest: snapshot.manifestDigest,
  packageLockSha256: javascriptInventory.packageLockSha256,
  javascript: javascriptInventory,
  packages: builderPackages.trimEnd().split("\n").map((line) => {
    const [name, version, architecture, extra] = line.split("\t");
    if (!name || !version || !architecture || extra !== undefined) {
      throw new Error("builder package inventory is malformed");
    }
    return { name, version, architecture };
  }),
});

const complianceFiles = await listRegularFiles(outputRoot);
await writeJson(join(outputRoot, "compliance-index.json"), {
  schemaVersion: 1,
  imageVersion,
  architecture: "arm64",
  files: await Promise.all(complianceFiles.map(async (path) => ({
    path,
    sha256: `sha256:${await sha256File(join(outputRoot, path))}`,
  }))),
});
await normalizeTreeTimes(outputRoot, sourceDateEpoch);

function parseBuildrootManifest(source) {
  const rows = parseCsv(source);
  const expected = [
    "PACKAGE",
    "VERSION",
    "LICENSE",
    "LICENSE FILES",
    "SOURCE ARCHIVE",
    "SOURCE SITE",
    "DEPENDENCIES WITH LICENSES",
  ];
  if (JSON.stringify(rows[0]) !== JSON.stringify(expected)) {
    throw new Error("Buildroot target manifest has an unexpected header");
  }
  const seen = new Set();
  return rows.slice(1).map((row, index) => {
    if (row.length !== expected.length) throw new Error(`manifest row ${index + 2} is malformed`);
    const [name, version, license, licenseFiles, sourceArchive, sourceSite, dependencies] = row;
    if (!name || !version || !license) throw new Error(`manifest row ${index + 2} is incomplete`);
    const identity = `${name}\0${version}`;
    if (seen.has(identity)) throw new Error(`duplicate target package ${name} ${version}`);
    seen.add(identity);
    return { name, version, license, licenseFiles, sourceArchive, sourceSite, dependencies };
  }).sort((left, right) => left.name.localeCompare(right.name, "en") || left.version.localeCompare(right.version, "en"));
}

function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

async function verifyBuildrootLegalInfo(root) {
  const checksumSource = await readFile(join(root, "legal-info.sha256"), "utf8");
  const listed = new Set();
  for (const line of checksumSource.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error("Buildroot legal-info checksum manifest is malformed");
    const path = safeRelativePath(match[2], "legal-info checksum path");
    if (listed.has(path)) throw new Error(`duplicate legal-info checksum path ${path}`);
    listed.add(path);
    if (await sha256File(join(root, path)) !== match[1]) {
      throw new Error(`Buildroot legal-info checksum mismatch for ${path}`);
    }
  }
  for (const required of ["README", "buildroot.config", "manifest.csv"]) {
    if (!listed.has(required)) throw new Error(`Buildroot legal-info does not cover ${required}`);
  }
  const actual = await listRegularFiles(await requireDirectory(root, "Buildroot legal-info"));
  for (const path of actual) {
    if (path !== "legal-info.sha256" && !listed.has(path)) {
      throw new Error(`Buildroot legal-info does not cover ${path}`);
    }
  }
  if (actual.length !== listed.size + 1 || !actual.includes("legal-info.sha256")) {
    throw new Error("Buildroot legal-info checksum manifest does not exactly cover its tree");
  }
  return listed;
}

function buildrootSanitize(value) {
  // Match Buildroot's `sanitize` make macro: `strip` first collapses runs of
  // whitespace, then spaces, colons, and slashes become underscores. The
  // manifest retains DL_VERSION while the legal-info directory uses this
  // sanitized VERSION.
  return value.trim().replace(/\s+/g, " ").replace(/[ :/]/g, "_");
}

function spdxId(name, version) {
  const readable = `${name}-${version}`.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 80);
  const digest = createHash("sha256").update(`${name}\0${version}`).digest("hex").slice(0, 12);
  return `SPDXRef-Package-${readable}-${digest}`;
}

async function copySelectedFiles(sourceRoot, destinationRoot, paths) {
  for (const path of paths) {
    await copyRegularFile(join(sourceRoot, path), join(destinationRoot, path));
  }
}

async function copyTree(source, destination) {
  const sourceRoot = await requireDirectory(source, "source tree");
  await mkdir(destination, { recursive: false, mode: 0o755 });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true }).then((items) =>
    items.sort((left, right) => left.name.localeCompare(right.name, "en")))) {
    const sourcePath = join(sourceRoot, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`source tree contains symbolic link ${sourcePath}`);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) await copyRegularFile(sourcePath, destinationPath);
    else throw new Error(`source tree contains unsupported entry ${sourcePath}`);
  }
}

async function copyRegularFile(source, destination) {
  const sourcePath = await requireRegularFile(source, "source file");
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(sourcePath, destination, constants.COPYFILE_FICLONE);
}

async function requireDirectory(value, label) {
  const path = resolve(value);
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return await realpath(path);
}

async function requireRegularFile(value, label) {
  const path = resolve(value);
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) {
    throw new Error(`${label} is not a nonempty regular file`);
  }
  return path;
}

async function requireNonemptyTree(path, label) {
  if ((await listRegularFiles(await requireDirectory(path, label))).length === 0) {
    throw new Error(`${label} contains no regular files`);
  }
}

async function listRegularFiles(root) {
  const result = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`tree contains symbolic link ${absolute}`);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) result.push(path);
      else throw new Error(`tree contains unsupported entry ${absolute}`);
    }
  };
  await visit(root);
  return result;
}

async function sha256File(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${path} is not a regular file`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${path} changed while hashing`);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function writeJson(path, value) {
  await writeExclusive(path, `${JSON.stringify(value)}\n`);
}

async function writeExclusive(path, value) {
  await writeFile(path, value, { encoding: "utf8", mode: 0o644, flag: "wx" });
}

async function normalizeTreeTimes(root, epoch) {
  const date = new Date(epoch * 1_000);
  const visit = async (path) => {
    const details = await lstat(path);
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
    }
    await utimes(path, date, date);
  };
  await visit(root);
}

function resolveInside(root, value) {
  const path = resolve(root, value);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`path escapes repository: ${value}`);
  return path;
}

function safeFileName(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== basename(value) ||
    value === "." ||
    value === ".." ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is not a safe file name`);
  }
  return value;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} is unsafe`);
  }
  const components = value.split("/");
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new Error(`${label} is unsafe`);
  }
  return value;
}

function parseSourceDateEpoch(value) {
  if (!/^(?:0|[1-9][0-9]{0,11})$/.test(value)) throw new Error("SOURCE_DATE_EPOCH is invalid");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > 253_402_300_799) {
    throw new Error("SOURCE_DATE_EPOCH is outside the supported range");
  }
  return result;
}
