#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maximumCandidateBytes = 64 * 1024 * 1024;
const defaultPollIntervalMs = 2_000;
const defaultPollTimeoutMs = 10 * 60_000;
const terminalStatuses = new Set(["published", "failed"]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "discover") {
    const packages = await discoverOfficialPackages(repositoryRoot);
    const matrix = JSON.stringify({ include: packages });
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`, "utf8");
    } else {
      process.stdout.write(`${matrix}\n`);
    }
  } else if (command === "publish") {
    const kind = process.argv[3];
    const packageDirectory = process.argv[4];
    if ((kind !== "app" && kind !== "connector") || !packageDirectory) {
      throw new Error(
        "Usage: node scripts/publish-marketplace-package.mjs publish <app|connector> <package-directory>",
      );
    }
    const resolvedPackageDirectory = resolve(repositoryRoot, packageDirectory);
    await assertPackageDirectory(repositoryRoot, resolvedPackageDirectory, kind);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "lamarck-marketplace-candidate-"));
    try {
      const candidatePath = join(temporaryDirectory, "candidate.tar.gz");
      const candidateBytes = await createCandidateArchive({
        packageDirectory: resolvedPackageDirectory,
        candidatePath,
      });
      const getToken = createGitHubOidcTokenProvider({
        audience: requireEnvironment("MARKETPLACE_OIDC_AUDIENCE"),
      });
      const result = await publishMarketplaceCandidate({
        apiOrigin: requireEnvironment("MARKETPLACE_API_ORIGIN"),
        getToken,
        kind,
        namespace: "lamarck",
        candidatePath,
        candidateBytes,
        sourceRepository: requireEnvironment("GITHUB_REPOSITORY"),
        sourceCommit: requireEnvironment("GITHUB_SHA"),
        ...(process.env.MARKETPLACE_CHANGELOG?.trim()
          ? { changelog: process.env.MARKETPLACE_CHANGELOG.trim() }
          : {}),
      });
      process.stdout.write(
        `Published ${kind} candidate ${packageDirectory} as ${result.packageId} ${result.releaseId}\n`,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  } else {
    throw new Error(
      "Usage: node scripts/publish-marketplace-package.mjs <discover|publish>",
    );
  }
}

/** Discover immediate package directories only; manifests and contents stay opaque to CI. */
export async function discoverOfficialPackages(root) {
  const discovered = [];
  for (const [collection, kind] of [["apps", "app"], ["connectors", "connector"]]) {
    const collectionPath = join(root, collection);
    let entries;
    try {
      entries = await readdir(collectionPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      discovered.push({
        kind,
        directory: `${collection}/${entry.name}`,
        package: entry.name,
      });
    }
  }
  if (discovered.length === 0) throw new Error("No official Marketplace packages found");
  return discovered;
}

/**
 * Produce an ordinary transport archive. This is intentionally not the
 * canonical Marketplace encoder and does not calculate logical identity.
 */
export async function createCandidateArchive({ packageDirectory, candidatePath }) {
  await execFileAsync("tar", [
    "-czf",
    candidatePath,
    "--exclude=.git",
    "--exclude=*/.git",
    "--exclude=node_modules",
    "--exclude=*/node_modules",
    "-C",
    packageDirectory,
    ".",
  ]);
  const candidate = await stat(candidatePath);
  if (!candidate.isFile() || candidate.size < 1 || candidate.size > maximumCandidateBytes) {
    throw new Error(
      `Marketplace candidate must be from 1 through ${maximumCandidateBytes} bytes`,
    );
  }
  return candidate.size;
}

export async function requestGitHubOidcToken({
  audience,
  requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  fetchImpl = fetch,
}) {
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub Actions OIDC request environment is unavailable");
  }
  const url = new URL(requestUrl);
  if (url.protocol !== "https:") throw new Error("GitHub Actions OIDC request URL must use HTTPS");
  url.searchParams.set("audience", audience);
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
  });
  const body = await readJsonResponse(response, "GitHub Actions OIDC token request");
  if (!response.ok || !isRecord(body) || typeof body.value !== "string" || body.value.length < 1) {
    throw new Error(`GitHub Actions OIDC token request failed with HTTP ${response.status}`);
  }
  return body.value;
}

export function createGitHubOidcTokenProvider({
  audience,
  requestOidcToken = requestGitHubOidcToken,
  now = Date.now,
}) {
  let cachedToken;
  return async function getToken() {
    if (!cachedToken || oidcTokenExpiresSoon(cachedToken, now())) {
      cachedToken = await requestOidcToken({ audience });
    }
    return cachedToken;
  };
}

export async function publishMarketplaceCandidate({
  apiOrigin,
  getToken,
  kind,
  namespace,
  candidatePath,
  candidateBytes,
  sourceRepository,
  sourceCommit,
  changelog,
  fetchImpl = fetch,
  pollIntervalMs = defaultPollIntervalMs,
  pollTimeoutMs = defaultPollTimeoutMs,
}) {
  const origin = validateApiOrigin(apiOrigin);
  if (kind !== "app" && kind !== "connector") throw new Error("Invalid Marketplace kind");
  if (namespace !== "lamarck") throw new Error("Official publisher namespace must be lamarck");
  if (!Number.isSafeInteger(candidateBytes) || candidateBytes < 1 || candidateBytes > maximumCandidateBytes) {
    throw new Error("Marketplace candidate size is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Source commit must be a full Git SHA");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) {
    throw new Error("Source repository is invalid");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 30_000) {
    throw new Error("Marketplace poll interval is invalid");
  }
  if (!Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs < 1 || pollTimeoutMs > 30 * 60_000) {
    throw new Error("Marketplace poll timeout is invalid");
  }
  if (typeof getToken !== "function") throw new Error("Marketplace OIDC token provider is required");

  const create = await apiJson(fetchImpl, new URL("/marketplace/uploads", origin), await getToken(), {
    method: "POST",
    body: JSON.stringify({
      kind,
      namespace,
      candidateBytes,
      sourceRepository,
      sourceCommit,
      ...(changelog ? { changelog } : {}),
    }),
  });
  if (
    create.response.status !== 201
    || !isRecord(create.body)
    || typeof create.body.uploadId !== "string"
    || create.body.status !== "awaiting_upload"
    || create.body.uploadMethod !== "PUT"
    || typeof create.body.uploadUrl !== "string"
    || !isRecord(create.body.uploadHeaders)
    || create.body.uploadHeaders["content-type"] !== "application/gzip"
  ) {
    throw apiFailure("create upload", create.response, create.body);
  }
  const uploadId = create.body.uploadId;
  if (!/^upl_[A-Za-z0-9_-]{24}$/.test(uploadId)) {
    throw new Error("Marketplace create upload returned an invalid upload ID");
  }
  const uploadUrl = new URL(create.body.uploadUrl);
  if (uploadUrl.protocol !== "https:") {
    throw new Error("Marketplace presigned upload URL must use HTTPS");
  }

  const candidate = await readFile(candidatePath);
  if (candidate.byteLength !== candidateBytes) {
    throw new Error("Marketplace candidate changed after size validation");
  }
  const put = await fetchImpl(uploadUrl, {
    method: "PUT",
    redirect: "error",
    headers: { "content-type": "application/gzip" },
    body: candidate,
  });
  if (!put.ok) throw new Error(`Marketplace candidate upload failed with HTTP ${put.status}`);

  const complete = await apiJson(
    fetchImpl,
    new URL(`/marketplace/uploads/${encodeURIComponent(uploadId)}/complete`, origin),
    await getToken(),
    { method: "POST" },
  );
  if (complete.response.status !== 202 || !isUploadStatus(complete.body, uploadId)) {
    throw apiFailure("complete upload", complete.response, complete.body);
  }
  if (terminalStatuses.has(complete.body.status)) return requirePublished(complete.body);

  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    if (pollIntervalMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
    const status = await apiJson(
      fetchImpl,
      new URL(`/marketplace/uploads/${encodeURIComponent(uploadId)}`, origin),
      await getToken(),
      { method: "GET" },
    );
    if (status.response.status !== 200 || !isUploadStatus(status.body, uploadId)) {
      throw apiFailure("read upload", status.response, status.body);
    }
    if (terminalStatuses.has(status.body.status)) return requirePublished(status.body);
  }
  throw new Error(`Marketplace upload ${uploadId} did not finish before the timeout`);
}

async function assertPackageDirectory(root, packageDirectory, kind) {
  const collection = kind === "app" ? "apps" : "connectors";
  const expectedParent = join(root, collection);
  if (dirname(packageDirectory) !== expectedParent || basename(packageDirectory).startsWith(".")) {
    throw new Error(`Marketplace package must be an immediate ${collection}/ directory`);
  }
}

function validateApiOrigin(value) {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:"
    || origin.username !== ""
    || origin.password !== ""
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== ""
  ) {
    throw new Error("Marketplace API origin must be an HTTPS origin without a path");
  }
  return origin;
}

async function apiJson(fetchImpl, url, token, init) {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  return { response, body: await readJsonResponse(response, `Marketplace API ${url.pathname}`) };
}

async function readJsonResponse(response, context) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context} returned non-JSON HTTP ${response.status}`);
  }
}

function isUploadStatus(value, uploadId) {
  return isRecord(value)
    && value.uploadId === uploadId
    && typeof value.status === "string"
    && ["awaiting_upload", "queued", "validating", "published", "failed"].includes(value.status);
}

function requirePublished(value) {
  if (value.status === "failed") {
    const details = isRecord(value.error)
      ? `${String(value.error.code)}: ${String(value.error.message)}`
      : "unknown validation error";
    throw new Error(`Marketplace validation failed: ${details}`);
  }
  if (
    value.status !== "published"
    || typeof value.packageId !== "string"
    || typeof value.releaseId !== "string"
  ) {
    throw new Error("Marketplace upload reached an invalid terminal state");
  }
  return value;
}

function apiFailure(operation, response, body) {
  const message = isRecord(body) && typeof body.message === "string"
    ? `: ${body.message}`
    : "";
  return new Error(`Marketplace ${operation} failed with HTTP ${response.status}${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oidcTokenExpiresSoon(token, nowMs) {
  try {
    const payload = token.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return !Number.isSafeInteger(claims.exp) || claims.exp * 1000 - nowMs < 60_000;
  } catch {
    return true;
  }
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
