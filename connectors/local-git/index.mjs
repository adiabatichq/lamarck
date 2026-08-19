import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 24 * 60 * 60 * 1000;
const EVENT_BATCH_SIZE = 100;
const UNTIMED_REPORT_LIMIT = 20;
const RECENT_SHA_LIMIT = 2000;
const DISCOVERY_MAX_DEPTH = 10;
const DEFAULT_BACKFILL_DAYS = 30;
const MAX_BACKFILL_DAYS = 3650;
const GIT_LOG_FORMAT = "%H%x1f%aI%x1f%cI%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B";

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "dist",
  "build",
  "target",
  "vendor",
]);

const DEFAULT_CAPTURE = {
  commitMessage: "full",
  diffstat: "aggregate",
  codeDiff: false,
  emailInEvents: "raw_and_hash",
};

const COMMIT_MESSAGE_MODES = new Set(["none", "subject", "full"]);
const DIFFSTAT_MODES = new Set(["none", "aggregate", "files"]);
const EMAIL_MODES = new Set(["hash", "raw", "raw_and_hash"]);

export default {
  async run(context) {
    await syncOnce(context);

    while (!context.signal.aborted) {
      await waitForNextRun(SCAN_INTERVAL_MS, context.signal);
      if (!context.signal.aborted) {
        await syncOnce(context);
      }
    }
  },

  async configUi(context) {
    return startSetupPanel(context);
  },
};

export async function syncOnce(context, deps = {}) {
  const config = normalizeConfig(context.config);
  const identities = identityEmailSet(config);
  const identityFingerprint = identitySetFingerprint(identities);

  if (identities.size === 0) {
    await context.warnings?.set?.({
      key: "local-git-identities",
      message: "Local Git needs at least one identity email before it can classify commits.",
    });
    return;
  }
  await context.warnings?.clear?.("local-git-identities");

  const previous = normalizeState(await context.state.get());
  const next = {
    version: 1,
    repos: { ...previous.repos },
  };
  const nowMs = readNowMs(deps.now);
  const untimedShas = [];
  const repos = await discoverConfiguredRepos(config, {
    signal: context.signal,
    readdirImpl: deps.readdirImpl,
    statImpl: deps.statImpl,
    execFileImpl: deps.execFileImpl,
  });

  for (const repo of repos) {
    throwIfAborted(context.signal);
    const repoState = normalizeRepoState(next.repos[repo.scanKey]);
    const identityChanged = repoState.identityFingerprint !== identityFingerprint;
    const backfillDays = config.global.backfillDays;
    const backfillCutoffMs = Math.max(0, nowMs - backfillDays * DAY_MS);
    const backfillChanged = repoState.backfillDays !== backfillDays;
    const incrementalSinceMs = !identityChanged && !backfillChanged && repoState.lastScannedAt
      ? repoState.lastScannedAt - OVERLAP_MS
      : backfillCutoffMs;
    const since = new Date(Math.max(backfillCutoffMs, incrementalSinceMs)).toISOString();
    const recent = new Set(repoState.recentShas);
    const capture = captureForRepo(config, repo.path);
    const commits = await readGitLog(repo.path, { since, signal: context.signal, execFileImpl: deps.execFileImpl });
    const batch = [];

    for (const commit of commits) {
      throwIfAborted(context.signal);
      if (recent.has(commit.sha)) continue;
      // A commit whose time cannot be read is skipped, never stamped with the
      // current time: D0 is append-only and cannot express "unknown", so a
      // fabricated timestamp would be indistinguishable from a real one forever.
      const commitTimeMs = commitTimestampMs(commit);
      if (commitTimeMs === undefined) {
        untimedShas.push(`${repo.label ?? collapseHome(repo.path)}@${commit.sha.slice(0, 12)}`);
        continue;
      }
      if (commitTimeMs < backfillCutoffMs) continue;
      if (!isUserRelatedCommit(commit, identities)) continue;
      const event = await eventFromCommit({
        repo,
        commit,
        startedAt: commitTimeMs,
        capture,
        identities,
        guard: context.guard,
        signal: context.signal,
        execFileImpl: deps.execFileImpl,
      });
      batch.push(event);
      recent.add(commit.sha);
      trimRecentSet(recent);
      if (batch.length >= EVENT_BATCH_SIZE) {
        await context.guard.writeEvents(batch.splice(0, batch.length));
      }
    }

    if (batch.length) {
      await context.guard.writeEvents(batch);
    }

    throwIfAborted(context.signal);
    next.repos[repo.scanKey] = {
      path: collapseHome(repo.path),
      scanKey: repo.scanKey,
      normalizedOriginUrl: repo.normalizedOriginUrl,
      identityFingerprint,
      backfillDays,
      lastScannedAt: nowMs,
      recentShas: [...recent],
    };
    await context.state.set(next);
  }

  if (untimedShas.length) {
    await context.warnings?.set?.({
      key: "local-git-untimed-commits",
      message: `Skipped ${untimedShas.length} commit(s) with an unreadable commit time.`,
      details: { commits: untimedShas.slice(0, UNTIMED_REPORT_LIMIT) },
    });
  } else {
    await context.warnings?.clear?.("local-git-untimed-commits");
  }
}

export function normalizeConfig(input) {
  const source = isObject(input?.localGit) ? input.localGit : isObject(input) ? input : {};
  const global = isObject(source.global) ? source.global : {};
  return {
    version: 1,
    global: {
      backfillDays: integerInRange(global.backfillDays, 1, MAX_BACKFILL_DAYS, DEFAULT_BACKFILL_DAYS),
      capture: normalizeCapture(global.capture),
    },
    roots: normalizePathItems(source.roots),
    repositories: normalizeRepoOverrides(source.repositories),
    identities: normalizeIdentities(source.identities),
  };
}

export function normalizeState(input) {
  const source = isObject(input) ? input : {};
  const repos = {};
  if (isObject(source.repos)) {
    for (const [key, value] of Object.entries(source.repos)) {
      repos[key] = normalizeRepoState(value);
    }
  }
  return { version: 1, repos };
}

export async function discoverConfiguredRepos(config, deps = {}) {
  const normalized = normalizeConfig(config);
  const repos = new Map();

  for (const root of normalized.roots) {
    throwIfAborted(deps.signal);
    const rootPath = expandPath(root.path);
    const discovered = await discoverReposUnder(rootPath, {
      ...deps,
      includeNestedRepos: root.includeNestedRepos,
    });
    for (const repo of discovered) {
      repos.set(repo.path, repo);
    }
  }

  return [...repos.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function chooseCodeRoot(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const paths = platform === "darwin"
    ? await chooseCodeRootDarwin(deps)
    : platform === "win32"
      ? await chooseCodeRootWindows(deps)
      : await chooseCodeRootLinux(deps);
  return { paths: normalizeChosenPaths(paths) };
}

async function chooseCodeRootDarwin(deps) {
  const result = await execPicker(
    "osascript",
    ["-e", 'POSIX path of (choose folder with prompt "Choose a code root")'],
    deps,
    { cancelText: ["User canceled"] },
  );
  return pathsFromPickerStdout(result.stdout);
}

async function chooseCodeRootLinux(deps) {
  try {
    const result = await execPicker(
      "zenity",
      ["--file-selection", "--directory", "--title", "Choose a code root"],
      deps,
      { cancelText: ["No file selected", "cancel"] },
    );
    return pathsFromPickerStdout(result.stdout);
  } catch (err) {
    if (!isMissingCommand(err)) throw err;
  }

  try {
    const result = await execPicker(
      "kdialog",
      ["--title", "Choose a code root", "--getexistingdirectory", homedir()],
      deps,
      { cancelOnExitOne: true },
    );
    return pathsFromPickerStdout(result.stdout);
  } catch (err) {
    if (!isMissingCommand(err)) throw err;
  }

  throw new Error("No supported folder picker found. Install zenity or kdialog, or enter a path manually.");
}

async function chooseCodeRootWindows(deps) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Choose a code root'",
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "  Write-Output $dialog.SelectedPath",
    "}",
  ].join("; ");
  const result = await execPicker(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", script],
    deps,
    { cancelText: [] },
  );
  return pathsFromPickerStdout(result.stdout);
}

async function execPicker(command, args, deps = {}, opts = {}) {
  try {
    return await (deps.execFileImpl ?? execFileAsync)(command, args, {
      encoding: "utf8",
      signal: deps.signal,
    });
  } catch (err) {
    if (err && typeof err === "object" && err.name === "AbortError") {
      return { stdout: "", stderr: "" };
    }
    if (isPickerCancel(err, opts.cancelText ?? [])) {
      return { stdout: "", stderr: "" };
    }
    if (opts.cancelOnExitOne && isExitOne(err)) {
      return { stdout: "", stderr: "" };
    }
    throw err;
  }
}

function isPickerCancel(err, cancelText) {
  if (!err || typeof err !== "object") return false;
  if (!isExitOne(err) || cancelText.length === 0) return false;
  const text = `${err.message ?? ""}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`.toLowerCase();
  return cancelText.some((item) => text.includes(item.toLowerCase()));
}

function isExitOne(err) {
  const code = Number(err?.code);
  return code === 1 || code === -128;
}

function isMissingCommand(err) {
  return Boolean(err) && typeof err === "object" && err.code === "ENOENT";
}

function pathsFromPickerStdout(stdout) {
  return String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeChosenPaths(paths) {
  const seen = new Set();
  const output = [];
  for (const path of paths) {
    const value = stringFrom(path);
    if (!value) continue;
    const normalized = collapseHome(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

async function discoverReposUnder(rootPath, deps = {}) {
  const repos = [];
  const root = resolve(rootPath);
  if (!(await pathExists(root, deps.statImpl))) return repos;

  async function walk(dir, depth) {
    throwIfAborted(deps.signal);
    if (await hasGitMetadata(dir, deps.statImpl)) {
      repos.push(await repoInfo(dir, deps));
      if (!deps.includeNestedRepos) return;
    }
    if (depth >= DISCOVERY_MAX_DEPTH) return;

    let entries;
    try {
      entries = await (deps.readdirImpl ?? readdir)(dir, { withFileTypes: true });
    } catch (err) {
      if (isIgnorableFsError(err)) return;
      throw err;
    }

    for (const entry of entries) {
      throwIfAborted(deps.signal);
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return repos;
}

async function repoInfo(repoPath, deps = {}) {
  const path = resolve(repoPath);
  const originUrl = await readGitConfig(path, "remote.origin.url", deps).catch(() => undefined);
  const normalizedOriginUrl = normalizeRemoteUrl(originUrl);
  const keyMaterial = `worktree:${path}`;
  const scanKey = `sha256:${sha256Hex(keyMaterial)}`;
  const objectFormat = await readGitObjectFormat(path, deps);
  return {
    scanKey,
    path,
    label: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
    objectFormat,
    normalizedOriginUrl,
  };
}

async function readGitLog(repoPath, opts = {}) {
  const args = [
    "-C",
    repoPath,
    "log",
    "--all",
    "--reverse",
    "-z",
    `--format=${GIT_LOG_FORMAT}`,
  ];
  if (opts.since) args.push(`--since=${opts.since}`);
  const result = await execGit(args, opts);
  const commits = [];
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const parts = record.split("\x1f");
    if (parts.length < 7) continue;
    const [sha, authorTime, committerTime, authorName, authorEmail, committerName, committerEmail] = parts;
    commits.push({
      sha,
      authorTime,
      committerTime,
      authorName,
      authorEmail,
      committerName,
      committerEmail,
      message: parts.slice(7).join("\x1f").trimEnd(),
    });
  }
  return commits;
}

async function eventFromCommit(opts) {
  const { repo, commit, startedAt, capture, identities, guard, signal, execFileImpl } = opts;
  const authoredByUser = identities.has(normalizeEmail(commit.authorEmail));
  const committedByUser = identities.has(normalizeEmail(commit.committerEmail));
  const diffstat = await readDiffstat(repo.path, commit.sha, capture.diffstat, { signal, execFileImpl });
  const codeDiff = await readCodeDiff(repo.path, commit.sha, capture.codeDiff, { guard, signal, execFileImpl });

  return {
    type: "local_git.commit",
    externalId: `commit:${repo.objectFormat}:${commit.sha}`,
    startedAt,
    payload: compactObject({
      schema: "local_git.commit.v1",
      provider: "git",
      captureMethod: "git.log.all",
      repo: compactObject({
        path: collapseHome(repo.path),
        label: repo.label,
        normalizedOriginUrl: repo.normalizedOriginUrl,
      }),
      objectFormat: repo.objectFormat,
      commitSha: commit.sha,
      authoredAt: commit.authorTime,
      committedAt: commit.committerTime,
      author: identityPayload(commit.authorName, commit.authorEmail, capture.emailInEvents),
      committer: identityPayload(commit.committerName, commit.committerEmail, capture.emailInEvents),
      authoredByUser,
      committedByUser,
      message: messagePayload(commit.message, capture.commitMessage),
      diffstat,
      codeDiff,
    }),
  };
}

async function readDiffstat(repoPath, sha, mode, opts = {}) {
  if (mode === "none") return { mode: "none" };
  const result = await execGit([
    "-C",
    repoPath,
    "show",
    "--numstat",
    "--format=",
    "--no-ext-diff",
    sha,
  ], opts);
  const files = [];
  let additions = 0;
  let deletions = 0;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    const binary = rawAdditions === "-" || rawDeletions === "-";
    const fileAdditions = binary ? 0 : Number(rawAdditions);
    const fileDeletions = binary ? 0 : Number(rawDeletions);
    additions += Number.isFinite(fileAdditions) ? fileAdditions : 0;
    deletions += Number.isFinite(fileDeletions) ? fileDeletions : 0;
    files.push(compactObject({
      path: filePath,
      additions: Number.isFinite(fileAdditions) ? fileAdditions : 0,
      deletions: Number.isFinite(fileDeletions) ? fileDeletions : 0,
      binary: binary ? true : undefined,
    }));
  }
  if (mode === "files") {
    return { mode, filesChanged: files.length, additions, deletions, files };
  }
  return { mode, filesChanged: files.length, additions, deletions };
}

async function readCodeDiff(repoPath, sha, enabled, opts = {}) {
  if (!enabled) return { mode: "none" };
  const result = await execGit([
    "-C",
    repoPath,
    "show",
    "--format=",
    "--patch",
    "--no-ext-diff",
    sha,
  ], opts);
  const patch = result.stdout;
  const hash = `sha256:${sha256Hex(patch)}`;
  const base = {
    mode: "patch",
    sha256: hash,
    bytes: Buffer.byteLength(patch, "utf8"),
  };
  if (opts.guard?.writeTextBlob) {
    const blob = await opts.guard.writeTextBlob({
      text: patch,
      mediaType: "text/plain; charset=utf-8",
    });
    return { ...base, contentRef: blob.ref, compressedBytes: blob.compressedBytes };
  }
  return { ...base, unavailable: "writeTextBlob capability unavailable" };
}

function captureForRepo(config, repoPath) {
  const normalizedPath = resolve(repoPath);
  const override = config.repositories.find((repo) => resolve(expandPath(repo.path)) === normalizedPath);
  return override?.capture ?? config.global.capture;
}

function isUserRelatedCommit(commit, identities) {
  return identities.has(normalizeEmail(commit.authorEmail)) || identities.has(normalizeEmail(commit.committerEmail));
}

function commitTimestampMs(commit) {
  return timestampFromIso(commit.authorTime) ?? timestampFromIso(commit.committerTime);
}

function identityEmailSet(config) {
  return new Set(config.identities.map((identity) => normalizeEmail(identity.email)).filter(Boolean));
}

function identitySetFingerprint(identities) {
  const emails = [...identities].sort();
  return `sha256:${sha256Hex(emails.join("\n"))}`;
}

function identityPayload(name, email, mode) {
  const normalized = normalizeEmail(email);
  return compactObject({
    name: stringFrom(name),
    email: mode === "raw" || mode === "raw_and_hash" ? stringFrom(email) : undefined,
    emailHash: mode === "hash" || mode === "raw_and_hash" ? emailHash(normalized) : undefined,
  });
}

function messagePayload(message, mode) {
  if (mode === "none") return { mode };
  const normalized = (message ?? "").trimEnd();
  const subject = normalized.split(/\r?\n/, 1)[0] ?? "";
  if (mode === "subject") return { mode, subject };
  return { mode, subject, body: normalized };
}

function normalizeCapture(input) {
  const source = isObject(input) ? input : {};
  const commitMessage = COMMIT_MESSAGE_MODES.has(source.commitMessage) ? source.commitMessage : DEFAULT_CAPTURE.commitMessage;
  const diffstat = DIFFSTAT_MODES.has(source.diffstat) ? source.diffstat : DEFAULT_CAPTURE.diffstat;
  const emailInEvents = EMAIL_MODES.has(source.emailInEvents) ? source.emailInEvents : DEFAULT_CAPTURE.emailInEvents;
  return {
    commitMessage,
    diffstat,
    codeDiff: typeof source.codeDiff === "boolean" ? source.codeDiff : DEFAULT_CAPTURE.codeDiff,
    emailInEvents,
  };
}

function normalizePathItems(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const items = [];
  for (const item of input) {
    const path = typeof item === "string" ? item : stringFrom(item?.path);
    if (!path) continue;
    const normalized = collapseHome(expandPath(path));
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    items.push({
      path: normalized,
      includeNestedRepos: isObject(item) && item.includeNestedRepos === true,
    });
  }
  return items;
}

function normalizeRepoOverrides(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const items = [];
  for (const item of input) {
    if (!isObject(item)) continue;
    const path = stringFrom(item.path);
    if (!path) continue;
    const normalized = collapseHome(expandPath(path));
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    items.push({ path: normalized, capture: normalizeCapture(item.capture) });
  }
  return items;
}

function normalizeIdentities(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const identities = [];
  for (const item of input) {
    if (!isObject(item)) continue;
    const email = normalizeEmail(item.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    identities.push({
      email,
      label: stringFrom(item.label) ?? "",
    });
  }
  return identities;
}

function normalizeRepoState(input) {
  const source = isObject(input) ? input : {};
  const recentShas = Array.isArray(source.recentShas)
    ? source.recentShas.filter((sha) => typeof sha === "string").slice(-RECENT_SHA_LIMIT)
    : [];
  return {
    path: stringFrom(source.path),
    scanKey: stringFrom(source.scanKey) ?? stringFrom(source.repoKey),
    normalizedOriginUrl: stringFrom(source.normalizedOriginUrl),
    identityFingerprint: stringFrom(source.identityFingerprint),
    backfillDays: integerInRange(source.backfillDays, 1, MAX_BACKFILL_DAYS, undefined),
    lastScannedAt: Number.isFinite(source.lastScannedAt) ? source.lastScannedAt : undefined,
    recentShas,
  };
}

async function startSetupPanel(context) {
  if (context.panelId !== "setup") {
    throw new Error(`Unknown local-git config panel: ${context.panelId}`);
  }
  const token = randomBytes(24).toString("hex");
  const port = await startLoopbackFetchServer(
    (req) => handleSetupRequest(req, { token, configStore: context.configStore, signal: context.signal }),
    context.signal,
  );
  return {
    url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
  };
}

async function startLoopbackFetchServer(fetchHandler, signal) {
  if (signal.aborted) throw new Error("setup panel was aborted");
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error("request body is too large");
        chunks.push(chunk);
      }
      const method = incoming.method ?? "GET";
      const response = await fetchHandler(new Request(
        new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "127.0.0.1"}`),
        {
          method,
          headers: incoming.headers,
          body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
        },
      ));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: errorMessage(err) }));
    }
  });
  signal.addEventListener("abort", () => {
    server.closeAllConnections();
    server.close();
  }, { once: true });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("setup panel failed to bind a loopback port");
  return address.port;
}

async function handleSetupRequest(req, ctx) {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== ctx.token) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  try {
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(setupHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      return jsonResponse(await setupSnapshot(ctx));
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await req.json().catch(() => ({}));
      const next = normalizeConfig(body.localGit ?? body);
      await ctx.configStore.patch({ set: { localGit: next } });
      return jsonResponse({ config: next });
    }
    if (req.method === "POST" && url.pathname === "/api/choose-root") {
      return jsonResponse(await chooseCodeRoot({ signal: ctx.signal }));
    }
    if (req.method === "POST" && url.pathname === "/api/discover") {
      const body = await req.json().catch(() => ({}));
      const config = normalizeConfig(body.localGit ?? await currentConfig(ctx.configStore));
      return jsonResponse(await discoverySnapshot(config, ctx));
    }
    return jsonResponse({ error: "not_found" }, 404);
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, 500);
  }
}

async function setupSnapshot(ctx) {
  const config = await currentConfig(ctx.configStore);
  const discovery = await discoverySnapshot(config, ctx);
  return { config, ...discovery };
}

async function discoverySnapshot(config, ctx) {
  const repos = await discoverConfiguredRepos(config, { signal: ctx.signal }).catch(() => []);
  const suggestions = await identitySuggestions(config, repos).catch(() => []);
  return {
    discoveredRepos: repos.map((repo) => ({
      path: collapseHome(repo.path),
      label: repo.label,
      normalizedOriginUrl: repo.normalizedOriginUrl,
    })),
    identitySuggestions: suggestions,
  };
}

async function currentConfig(configStore) {
  return normalizeConfig(await configStore.get());
}

async function identitySuggestions(config, repos) {
  const existing = identityEmailSet(config);
  const suggestions = new Map();
  const globalEmail = normalizeEmail(await readGlobalGitConfig("user.email").catch(() => undefined));
  if (globalEmail && !existing.has(globalEmail)) {
    suggestions.set(globalEmail, { email: globalEmail, label: "global git config", source: "global_git_config" });
  }
  for (const repo of repos) {
    const email = normalizeEmail(await readGitConfig(repo.path, "user.email").catch(() => undefined));
    if (email && !existing.has(email) && !suggestions.has(email)) {
      suggestions.set(email, { email, label: `${repo.label} git config`, source: "repo_git_config" });
    }
  }
  return [...suggestions.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function setupHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local Git Setup</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --panel: #ffffff;
      --ink: #181a1f;
      --muted: #69707d;
      --line: #d9ddd3;
      --accent: #0f766e;
      --accent-ink: #ffffff;
      --warn: #8a4b06;
      --shadow: 0 10px 30px rgba(32, 38, 46, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    .shell {
      max-width: 1120px;
      margin: 0 auto;
      padding: 28px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: flex-start;
      margin-bottom: 18px;
    }
    .saveActions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    .saveStatus {
      min-width: 108px;
      max-width: 240px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
      text-align: right;
    }
    .saveStatus.success { color: var(--accent); }
    .saveStatus.error { color: var(--warn); }
    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .sub {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 16px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 16px;
      margin-bottom: 16px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    h3 {
      margin: 16px 0 10px;
      font-size: 13px;
      color: var(--ink);
    }
    h3:first-child { margin-top: 0; }
    .row {
      display: grid;
      grid-template-columns: 160px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      margin: 10px 0;
    }
    label {
      color: var(--muted);
      font-size: 13px;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      font: inherit;
      color: var(--ink);
      background: #fff;
    }
    input[type="checkbox"] { width: auto; }
    button {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 6px;
      padding: 9px 12px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--accent-ink);
    }
    button:disabled {
      opacity: .55;
      cursor: default;
    }
    .inline {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .rootControls {
      display: flex;
      gap: 12px;
      align-items: center;
      white-space: nowrap;
    }
    .rootActions {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      border-top: 1px solid var(--line);
      padding: 10px 0;
    }
    .item:first-child { border-top: 0; }
    .path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .muted {
      color: var(--muted);
      font-size: 12px;
    }
    .repositoryList {
      max-height: 360px;
      overflow-y: auto;
      overscroll-behavior: contain;
      border: 1px solid var(--line);
      border-radius: 6px;
      margin-top: 12px;
    }
    .repositoryList .path {
      padding: 8px 10px;
      border-top: 1px solid var(--line);
    }
    .repositoryList .path:first-child { border-top: 0; }
    .repoCapture {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 8px;
    }
    .status {
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
    }
    .empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 14px;
      font-size: 13px;
    }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; }
      .repoCapture { grid-template-columns: 1fr; }
      .rootActions { grid-template-columns: 1fr; }
    }
    @media (max-width: 600px) {
      header { flex-direction: column; }
      .saveActions { justify-content: flex-start; }
      .saveStatus {
        order: 2;
        min-width: 0;
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <h1>Local Git</h1>
        <div class="sub">Scan code roots for git repositories and record commits that match your configured identities.</div>
      </div>
      <div class="saveActions">
        <span id="saveStatus" class="saveStatus" role="status" aria-live="polite"></span>
        <button id="save" class="primary">Save</button>
      </div>
    </header>
    <div class="grid">
      <main>
        <section class="panel">
          <h2>Code Roots</h2>
          <div class="rootActions">
            <button id="addRoot">+ Add Root</button>
            <input id="rootInput" placeholder="~/Projects">
            <button id="addRootPath">Add Path</button>
          </div>
          <div class="muted" style="margin-top:8px">Roots are data sources. Enable nested repos when work inside submodules or embedded repositories should be included.</div>
          <div id="roots"></div>
        </section>

        <section class="panel">
          <h2>Privacy / Capture</h2>
          <h3>History</h3>
          <div class="row">
            <label for="backfillDays">Backfill days</label>
            <input id="backfillDays" type="number" min="1" max="3650" step="1">
          </div>
          <div class="muted">Only commits from this many days ago or newer can be written. Defaults to 30 days.</div>

          <h3>Global Capture</h3>
          <div class="row">
            <label for="commitMessage">Commit message</label>
            <select id="commitMessage">
              <option value="full">Full message</option>
              <option value="subject">Subject only</option>
              <option value="none">None</option>
            </select>
          </div>
          <div class="row">
            <label for="diffstat">Diffstat</label>
            <select id="diffstat">
              <option value="aggregate">Aggregate</option>
              <option value="files">Per-file</option>
              <option value="none">None</option>
            </select>
          </div>
          <div class="row">
            <label for="emailInEvents">Email in events</label>
            <select id="emailInEvents">
              <option value="raw_and_hash">Raw + hash</option>
              <option value="raw">Raw</option>
              <option value="hash">Hash only</option>
            </select>
          </div>
          <div class="row">
            <label for="codeDiff">Full code changes</label>
            <div class="inline"><input id="codeDiff" type="checkbox"><span class="muted">Stores patch diff content for matching commits.</span></div>
          </div>

          <h3>Repo Overrides</h3>
          <div class="inline">
            <select id="repoSelect"></select>
            <button id="addRepo">+ Add Repo</button>
          </div>
          <div class="muted" style="margin-top:8px">Repos not listed here use the global capture settings. The list is populated from currently discovered repos under code roots.</div>
          <div id="repos"></div>
        </section>
      </main>

      <aside>
        <section class="panel">
          <h2>Identities</h2>
          <div class="inline">
            <input id="identityEmail" placeholder="you@example.com">
            <input id="identityLabel" placeholder="label">
            <button id="addIdentity">+</button>
          </div>
          <div id="suggestions"></div>
          <div id="identities"></div>
        </section>

        <section class="panel">
          <h2>Repositories</h2>
          <button id="refresh">Refresh repositories</button>
          <div id="repositorySummary" class="muted" style="margin-top:12px"></div>
          <div id="repositoryList" class="repositoryList" role="list"></div>
        </section>
      </aside>
    </div>
    <div id="status" class="status"></div>
  </div>
  <script>
    const token = new URLSearchParams(location.search).get("token");
    let config = null;
    let discoveredRepos = [];
    let identitySuggestions = [];
    let saveResetTimer = null;

    const el = (id) => document.getElementById(id);
    const api = (path, opts = {}) => fetch(path + "?token=" + encodeURIComponent(token), {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) }
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "request failed");
      return data;
    });

    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function captureFromForm(prefix) {
      return {
        commitMessage: el(prefix + "commitMessage").value,
        diffstat: el(prefix + "diffstat").value,
        codeDiff: el(prefix + "codeDiff").checked,
        emailInEvents: el(prefix + "emailInEvents") ? el(prefix + "emailInEvents").value : config.global.capture.emailInEvents
      };
    }
    function setStatus(text) { el("status").textContent = text || ""; }
    function setSaveStatus(text, tone) {
      const node = el("saveStatus");
      node.textContent = text || "";
      node.className = "saveStatus" + (tone ? " " + tone : "");
    }
    function resetSaveFeedback() {
      const button = el("save");
      button.textContent = "Save";
      setSaveStatus("");
      saveResetTimer = null;
    }
    function addRootPath(path) {
      const value = String(path || "").trim();
      if (!value) return false;
      if (config.roots.some((root) => root.path === value)) return false;
      config.roots.push({ path: value, includeNestedRepos: false });
      return true;
    }
    function pruneRepoOverridesToVisible() {
      const visible = new Set(discoveredRepos.map((repo) => repo.path));
      const before = config.repositories.length;
      config.repositories = config.repositories.filter((repo) => visible.has(repo.path));
      return config.repositories.length !== before;
    }

    async function load() {
      setStatus("Loading...");
      const snapshot = await api("/api/snapshot");
      config = snapshot.config;
      discoveredRepos = snapshot.discoveredRepos || [];
      identitySuggestions = snapshot.identitySuggestions || [];
      render();
      setStatus("");
    }

    function render() {
      el("backfillDays").value = String(config.global.backfillDays);
      el("commitMessage").value = config.global.capture.commitMessage;
      el("diffstat").value = config.global.capture.diffstat;
      el("emailInEvents").value = config.global.capture.emailInEvents;
      el("codeDiff").checked = config.global.capture.codeDiff === true;
      renderRoots();
      renderRepoSelect();
      renderRepos();
      renderIdentities();
      renderRepositoryList();
    }

    async function refreshDiscovery(statusText, options = {}) {
      setStatus(statusText || "Refreshing repositories...");
      const data = await api("/api/discover", { method: "POST", body: JSON.stringify({ localGit: config }) });
      discoveredRepos = data.discoveredRepos || [];
      identitySuggestions = data.identitySuggestions || [];
      if (options.pruneRepoOverrides) pruneRepoOverridesToVisible();
      render();
      setStatus("");
    }

    function renderRoots() {
      const node = el("roots");
      node.innerHTML = "";
      if (!config.roots.length) {
        node.appendChild(empty("No code roots configured."));
        return;
      }
      config.roots.forEach((root, index) => {
        const item = document.createElement("div");
        item.className = "item";
        const left = document.createElement("div");
        const path = document.createElement("div");
        path.className = "path";
        path.textContent = root.path;
        left.appendChild(path);
        const controls = document.createElement("div");
        controls.className = "rootControls";
        const nested = repoCheckbox("Include nested repos", root.includeNestedRepos, async (value) => {
          root.includeNestedRepos = value;
          try {
            await refreshDiscovery(value ? "Scanning nested repositories..." : "Scanning code roots...");
          } catch (err) {
            setStatus(err.message || String(err));
          }
        });
        const button = document.createElement("button");
        button.textContent = "Remove";
        button.onclick = async () => {
          config.roots.splice(index, 1);
          render();
          try {
            await refreshDiscovery("Scanning remaining code roots...", { pruneRepoOverrides: true });
          } catch (err) {
            setStatus(err.message || String(err));
          }
        };
        controls.append(nested, button);
        item.append(left, controls);
        node.appendChild(item);
      });
    }

    function renderRepoSelect() {
      const select = el("repoSelect");
      select.innerHTML = "";
      const existing = new Set(config.repositories.map((repo) => repo.path));
      const options = discoveredRepos.filter((repo) => !existing.has(repo.path));
      if (!options.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No discovered repos available";
        select.appendChild(option);
        return;
      }
      options.forEach((repo) => {
        const option = document.createElement("option");
        option.value = repo.path;
        option.textContent = repo.path;
        select.appendChild(option);
      });
    }

    function renderRepos() {
      const node = el("repos");
      node.innerHTML = "";
      if (!config.repositories.length) {
        node.appendChild(empty("No repo overrides. All discovered repos use global capture."));
        return;
      }
      config.repositories.forEach((repo, index) => {
        const item = document.createElement("div");
        item.className = "item";
        const left = document.createElement("div");
        const path = document.createElement("div");
        path.className = "path";
        path.textContent = repo.path;
        left.appendChild(path);
        const controls = document.createElement("div");
        controls.className = "repoCapture";
        controls.append(
          repoSelect("Commit", repo.capture.commitMessage, ["full", "subject", "none"], (value) => repo.capture.commitMessage = value),
          repoSelect("Diffstat", repo.capture.diffstat, ["aggregate", "files", "none"], (value) => repo.capture.diffstat = value),
          repoCheckbox("Full code changes", repo.capture.codeDiff, (value) => repo.capture.codeDiff = value)
        );
        left.appendChild(controls);
        const button = document.createElement("button");
        button.textContent = "Remove";
        button.onclick = () => { config.repositories.splice(index, 1); render(); };
        item.append(left, button);
        node.appendChild(item);
      });
    }

    function renderIdentities() {
      const list = el("identities");
      list.innerHTML = "";
      if (!config.identities.length) list.appendChild(empty("Add at least one git email."));
      config.identities.forEach((identity, index) => {
        const item = document.createElement("div");
        item.className = "item";
        const left = document.createElement("div");
        const email = document.createElement("div");
        email.className = "path";
        email.textContent = identity.email;
        const label = document.createElement("div");
        label.className = "muted";
        label.textContent = identity.label || "identity";
        left.append(email, label);
        const button = document.createElement("button");
        button.textContent = "Remove";
        button.onclick = () => { config.identities.splice(index, 1); render(); };
        item.append(left, button);
        list.appendChild(item);
      });

      const suggestions = el("suggestions");
      suggestions.innerHTML = "";
      const existing = new Set(config.identities.map((identity) => identity.email.toLowerCase()));
      identitySuggestions.filter((item) => !existing.has(item.email.toLowerCase())).forEach((item) => {
        const row = document.createElement("div");
        row.className = "item";
        const left = document.createElement("div");
        const email = document.createElement("div");
        email.className = "path";
        email.textContent = item.email;
        const label = document.createElement("div");
        label.className = "muted";
        label.textContent = item.label;
        left.append(email, label);
        const button = document.createElement("button");
        button.textContent = "Add";
        button.onclick = () => {
          config.identities.push({ email: item.email, label: item.label });
          render();
        };
        row.append(left, button);
        suggestions.appendChild(row);
      });
    }

    function renderRepositoryList() {
      const summary = el("repositorySummary");
      const node = el("repositoryList");
      summary.innerHTML = "";
      node.innerHTML = "";
      const rootCount = config.roots.length;
      const repoCount = discoveredRepos.length;
      const identityCount = config.identities.length;
      summary.textContent = [
        rootCount + " code root" + (rootCount === 1 ? "" : "s"),
        repoCount + " discovered git repo" + (repoCount === 1 ? "" : "s"),
        identityCount + " identity email" + (identityCount === 1 ? "" : "s")
      ].join(" · ");
      if (!discoveredRepos.length) {
        node.appendChild(empty("No repositories discovered."));
        return;
      }
      discoveredRepos.forEach((repo) => {
        const div = document.createElement("div");
        div.className = "path";
        div.setAttribute("role", "listitem");
        div.textContent = repo.path;
        node.appendChild(div);
      });
    }

    function repoSelect(label, value, values, onChange) {
      const wrap = document.createElement("label");
      wrap.textContent = label;
      const select = document.createElement("select");
      values.forEach((item) => {
        const option = document.createElement("option");
        option.value = item;
        option.textContent = item;
        select.appendChild(option);
      });
      select.value = value;
      select.onchange = () => onChange(select.value);
      wrap.appendChild(select);
      return wrap;
    }

    function repoCheckbox(label, value, onChange) {
      const wrap = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value === true;
      input.onchange = () => onChange(input.checked);
      wrap.append(input, document.createTextNode(" " + label));
      return wrap;
    }

    function empty(text) {
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = text;
      return div;
    }

    el("addRoot").onclick = async () => {
      setStatus("Choosing code root...");
      try {
        const data = await api("/api/choose-root", { method: "POST", body: JSON.stringify({}) });
        const paths = data.paths || [];
        let changed = false;
        paths.forEach((path) => {
          if (addRootPath(path)) changed = true;
        });
        render();
        if (changed) await refreshDiscovery("Scanning selected root...");
        else setStatus("");
      } catch (err) {
        setStatus(err.message || String(err));
      }
    };
    el("addRootPath").onclick = async () => {
      const value = el("rootInput").value.trim();
      if (!value) return;
      const changed = addRootPath(value);
      el("rootInput").value = "";
      render();
      if (changed) {
        try {
          await refreshDiscovery("Scanning code roots...");
        } catch (err) {
          setStatus(err.message || String(err));
        }
      }
    };
    el("addRepo").onclick = () => {
      const value = el("repoSelect").value;
      if (!value) return;
      config.repositories.push({ path: value, capture: clone(config.global.capture) });
      render();
    };
    el("addIdentity").onclick = () => {
      const email = el("identityEmail").value.trim();
      if (!email) return;
      config.identities.push({ email, label: el("identityLabel").value.trim() });
      el("identityEmail").value = "";
      el("identityLabel").value = "";
      render();
    };
    el("refresh").onclick = async () => {
      try {
        await refreshDiscovery("Refreshing repositories...");
      } catch (err) {
        setStatus(err.message || String(err));
      }
    };
    el("save").onclick = async () => {
      const button = el("save");
      if (saveResetTimer !== null) {
        window.clearTimeout(saveResetTimer);
        saveResetTimer = null;
      }
      config.global.backfillDays = Number(el("backfillDays").value);
      config.global.capture = captureFromForm("");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "Saving…";
      setSaveStatus("Saving…");
      try {
        const data = await api("/api/config", {
          method: "POST",
          body: JSON.stringify({ localGit: config })
        });
        config = data.config;
        render();
        button.textContent = "Saved ✓";
        setSaveStatus("Settings saved.", "success");
        saveResetTimer = window.setTimeout(resetSaveFeedback, 1800);
      } catch (err) {
        button.textContent = "Retry";
        setSaveStatus("Save failed: " + (err.message || String(err)), "error");
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    };
    load().catch((err) => setStatus(err.message || String(err)));
  </script>
</body>
</html>`;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readGitConfig(repoPath, key, deps = {}) {
  const result = await execGit(["-C", repoPath, "config", "--get", key], deps);
  return result.stdout.trim() || undefined;
}

async function readGitObjectFormat(repoPath, deps = {}) {
  const result = await execGit(["-C", repoPath, "rev-parse", "--show-object-format=storage"], deps);
  const value = result.stdout.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`Git returned an invalid object format for ${repoPath}`);
  }
  return value;
}

async function readGlobalGitConfig(key) {
  const result = await execGit(["config", "--global", "--get", key]);
  return result.stdout.trim() || undefined;
}

async function execGit(args, opts = {}) {
  try {
    return await (opts.execFileImpl ?? execFileAsync)("git", args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      signal: opts.signal,
    });
  } catch (err) {
    throw err;
  }
}

async function hasGitMetadata(dir, statImpl = stat) {
  try {
    const info = await statImpl(join(dir, ".git"));
    return info.isDirectory() || info.isFile();
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

async function pathExists(path, statImpl = stat) {
  try {
    await statImpl(path);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function trimRecentSet(set) {
  while (set.size > RECENT_SHA_LIMIT) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

function waitForNextRun(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout;
    const done = () => {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function expandPath(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(path);
}

function collapseHome(path) {
  const home = homedir();
  const resolved = resolve(path);
  return resolved === home || resolved.startsWith(`${home}/`)
    ? `~${resolved.slice(home.length)}`
    : resolved;
}

function normalizeRemoteUrl(input) {
  const raw = stringFrom(input);
  if (!raw) return undefined;
  let value = raw.trim();
  if (!value.includes("://")) {
    const scpMatch = value.match(/^(?:[^@\s]+@)?([^:\s]+):(.+)$/);
    if (scpMatch) value = `ssh://${scpMatch[1]}/${scpMatch[2]}`;
  }
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol === "ssh:" || parsed.protocol === "git:" ? "https:" : parsed.protocol;
    const host = parsed.host.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/g, "").replace(/\.git$/i, "");
    if (!host || !pathname || pathname === "/") return undefined;
    return `${protocol}//${host}${pathname}`.toLowerCase();
  } catch {
    return value.replace(/\.git$/i, "").toLowerCase();
  }
}

function normalizeEmail(input) {
  return stringFrom(input)?.trim().toLowerCase() ?? "";
}

function emailHash(email) {
  return email ? `sha256:${sha256Hex(email)}` : undefined;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timestampFromIso(input) {
  const value = Date.parse(input);
  return Number.isFinite(value) ? value : undefined;
}

function readNowMs(now) {
  if (typeof now === "function") return Number(now());
  if (Number.isFinite(now)) return Number(now);
  return Date.now();
}

function integerInRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function compactObject(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function stringFrom(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAborted(signal) {
  return Boolean(signal?.aborted);
}

function throwIfAborted(signal) {
  if (!isAborted(signal)) return;
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  throw err;
}

function isNotFoundError(err) {
  return Boolean(err) && typeof err === "object" && err.code === "ENOENT";
}

function isIgnorableFsError(err) {
  return Boolean(err)
    && typeof err === "object"
    && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(err.code);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
