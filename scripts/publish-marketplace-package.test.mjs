import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createCandidateArchive,
  discoverOfficialPackages,
  publishMarketplaceCandidate,
  requestGitHubOidcToken,
} from "./publish-marketplace-package.mjs";

const execFileAsync = promisify(execFile);

test("discovers every immediate App and Connector without reading manifests", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(join(root, "apps", "z-app"), { recursive: true });
  await mkdir(join(root, "apps", "a-app", "nested"), { recursive: true });
  await mkdir(join(root, "connectors", "one"), { recursive: true });
  await writeFile(join(root, "apps", "README.md"), "not a package directory\n");

  assert.deepEqual(await discoverOfficialPackages(root), [
    { kind: "app", directory: "apps/a-app", package: "a-app" },
    { kind: "app", directory: "apps/z-app", package: "z-app" },
    { kind: "connector", directory: "connectors/one", package: "one" },
  ]);
});

test("treats a missing Official App collection as empty", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(join(root, "connectors", "one"), { recursive: true });
  assert.deepEqual(await discoverOfficialPackages(root), [
    { kind: "connector", directory: "connectors/one", package: "one" },
  ]);
});

test("creates an opaque bounded archive with only common logical-tree exclusions", async (t) => {
  const root = await temporaryRoot(t);
  const source = join(root, "package");
  await mkdir(join(source, ".git"), { recursive: true });
  await mkdir(join(source, "nested", "node_modules"), { recursive: true });
  await mkdir(join(source, ".lamarck"), { recursive: true });
  await writeFile(join(source, "manifest.json"), "{}\n");
  await writeFile(join(source, ".git", "config"), "ignored\n");
  await writeFile(join(source, "nested", "node_modules", "dep"), "ignored\n");
  await writeFile(join(source, ".lamarck", "state"), "ignored\n");
  const candidatePath = join(root, "candidate.tar.gz");

  const size = await createCandidateArchive({ packageDirectory: source, candidatePath });
  assert.equal(size, (await readFile(candidatePath)).byteLength);
  const { stdout } = await execFileAsync("tar", ["-tzf", candidatePath]);
  assert.match(stdout, /\.\/manifest\.json/);
  assert.doesNotMatch(stdout, /\.git|node_modules/);
  // The blind publisher does not apply App-only tree policy. Backend excludes
  // this path for Apps while preserving existing Connector tree semantics.
  assert.match(stdout, /\.\/\.lamarck\/state/);
});

test("requests a GitHub OIDC token for the exact configured audience", async () => {
  let actualUrl;
  let actualAuthorization;
  const token = await requestGitHubOidcToken({
    audience: "https://api.lamarck.ai/marketplace/uploads",
    requestUrl: "https://token.actions.githubusercontent.com/request?job=1",
    requestToken: "request-token",
    fetchImpl: async (url, init) => {
      actualUrl = new URL(url);
      actualAuthorization = init.headers.Authorization;
      return Response.json({ value: "github-oidc-jwt" });
    },
  });
  assert.equal(token, "github-oidc-jwt");
  assert.equal(actualUrl.searchParams.get("audience"), "https://api.lamarck.ai/marketplace/uploads");
  assert.equal(actualAuthorization, "Bearer request-token");
});

test("uses the common upload resource and sends no authority to the presigned PUT", async (t) => {
  const root = await temporaryRoot(t);
  const candidatePath = join(root, "candidate.tar.gz");
  const candidate = Buffer.from("opaque candidate bytes");
  await writeFile(candidatePath, candidate);
  const requests = [];
  const uploadId = `upl_${"a".repeat(24)}`;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.hostname === "private-upload.example") return new Response(null, { status: 200 });
    if (url.pathname === "/marketplace/uploads" && init.method === "POST") {
      return Response.json({
        uploadId,
        status: "awaiting_upload",
        uploadUrl: "https://private-upload.example/exact-key?signature=1",
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": "application/gzip" },
        uploadExpiresAt: "2026-08-04T01:00:00Z",
        statusExpiresAt: "2026-08-05T01:00:00Z",
      }, { status: 201 });
    }
    if (url.pathname.endsWith("/complete")) {
      return Response.json({ uploadId, status: "queued" }, { status: 202 });
    }
    return Response.json({
      uploadId,
      status: "published",
      packageId: "lamarck.notes",
      releaseId: "rel_1",
    });
  };

  const result = await publishMarketplaceCandidate({
    apiOrigin: "https://api.lamarck.ai",
    token: "github-oidc-jwt",
    kind: "app",
    namespace: "lamarck",
    candidatePath,
    candidateBytes: candidate.byteLength,
    sourceRepository: "adiabatichq/lamarck",
    sourceCommit: "1".repeat(40),
    fetchImpl,
    pollIntervalMs: 0,
  });

  assert.equal(result.packageId, "lamarck.notes");
  const create = requests.find(({ url }) => url.pathname === "/marketplace/uploads");
  assert.deepEqual(JSON.parse(create.init.body), {
    kind: "app",
    namespace: "lamarck",
    candidateBytes: candidate.byteLength,
    sourceRepository: "adiabatichq/lamarck",
    sourceCommit: "1".repeat(40),
  });
  for (const request of requests.filter(({ url }) => url.hostname === "api.lamarck.ai")) {
    assert.equal(request.init.headers.Authorization, "Bearer github-oidc-jwt");
  }
  const put = requests.find(({ url }) => url.hostname === "private-upload.example");
  assert.equal(put.init.method, "PUT");
  assert.equal(put.init.headers.Authorization, undefined);
  assert.deepEqual(Buffer.from(put.init.body), candidate);
});

test("reports deterministic Backend validation failures", async (t) => {
  const root = await temporaryRoot(t);
  const candidatePath = join(root, "candidate.tar.gz");
  await writeFile(candidatePath, "x");
  const uploadId = `upl_${"b".repeat(24)}`;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "upload.example") return new Response(null, { status: 200 });
    if (url.pathname === "/marketplace/uploads") {
      return Response.json({
        uploadId,
        status: "awaiting_upload",
        uploadUrl: "https://upload.example/candidate",
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": "application/gzip" },
      }, { status: 201 });
    }
    return Response.json({
      uploadId,
      status: "failed",
      error: { code: "manifest_namespace_mismatch", message: "wrong namespace" },
    }, { status: 202 });
  };

  await assert.rejects(publishMarketplaceCandidate({
    apiOrigin: "https://api.lamarck.ai",
    token: "token",
    kind: "app",
    namespace: "lamarck",
    candidatePath,
    candidateBytes: 1,
    sourceRepository: "adiabatichq/lamarck",
    sourceCommit: "2".repeat(40),
    fetchImpl,
    pollIntervalMs: 0,
  }), /manifest_namespace_mismatch: wrong namespace/);
});

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "lamarck-marketplace-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
