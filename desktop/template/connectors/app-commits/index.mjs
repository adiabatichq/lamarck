import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_WATCH_INTERVAL_MS = 5000;
// Fields are unit-separated (%x1f) and records NUL-separated (git log -z), so
// %B (the full raw commit message, which contains newlines) parses cleanly.
const GIT_LOG_FORMAT = "%H%x1f%ct%x1f%an%x1f%ae%x1f%B";

export default {
  async run(context) {
    assertWorkspaceHost(context.host);
    await syncOnce(context);

    while (!context.signal.aborted) {
      await waitForNextRun(DEFAULT_WATCH_INTERVAL_MS, context.signal);
      if (!context.signal.aborted) {
        await syncOnce(context);
      }
    }
  },
};

export async function syncOnce({ guard, state, host, signal }) {
  assertWorkspaceHost(host);

  const previous = await state.get();
  const base = isObject(previous) ? previous : {};
  const currentApps = { ...readAppCursors(previous) };

  for (const repo of await listAppRepos(host.workspacePath)) {
    if (signal.aborted) return;

    const lastSha = readLastSha(currentApps, repo.appId);
    const newestSha = await syncAppRepo({ guard, repo, lastSha, signal });
    if (newestSha && newestSha !== lastSha) {
      currentApps[repo.appId] = { lastSha: newestSha };
      await state.set({ ...base, apps: currentApps });
    }
  }
}

async function syncAppRepo({ guard, repo, lastSha, signal }) {
  const stdout = await readGitLog(repo.dir, lastSha, signal);
  let newestSha = lastSha;

  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const [sha, committedAt, authorName, authorEmail, message] = record.split("\x1f");
    if (!sha || sha === lastSha) continue;

    await guard.writeEvent({
      type: "app.commit",
      externalId: `${repo.appId}:${sha}`,
      startedAt: Number(committedAt) * 1000,
      payload: {
        appId: repo.appId,
        commitSha: sha,
        authorName,
        authorEmail,
        message: (message ?? "").trimEnd(),
      },
    });
    newestSha = sha;
  }

  return newestSha;
}

async function readGitLog(repoDir, lastSha, signal) {
  const range = lastSha ? `${lastSha}..HEAD` : "HEAD";
  return readGitLogRange(repoDir, range, signal, { fallbackToHead: Boolean(lastSha) });
}

async function readGitLogRange(repoDir, range, signal, opts = {}) {
  try {
    const result = await execFileAsync("git", [
      "-C",
      repoDir,
      "log",
      "-z",
      "--reverse",
      `--format=${GIT_LOG_FORMAT}`,
      range,
    ], { signal });
    return result.stdout;
  } catch (err) {
    if (err && typeof err === "object" && err.name === "AbortError") return "";
    const stderr = err && typeof err === "object" && typeof err.stderr === "string"
      ? err.stderr
      : "";
    if (stderr.includes("does not have any commits yet") || stderr.includes("ambiguous argument 'HEAD'")) {
      return "";
    }
    if (opts.fallbackToHead && isInvalidRevisionError(stderr)) {
      return readGitLogRange(repoDir, "HEAD", signal);
    }
    throw err;
  }
}

async function listAppRepos(workspacePath) {
  const appsDir = join(workspacePath, "apps");
  let entries;
  try {
    entries = await readdir(appsDir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }

  const repos = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const appId = entry.name;
    const dir = join(appsDir, appId);
    if (await hasGitMetadata(dir)) {
      repos.push({ appId, dir });
    }
  }
  return repos.sort((a, b) => a.appId.localeCompare(b.appId));
}

async function hasGitMetadata(appDir) {
  try {
    const info = await stat(join(appDir, ".git"));
    return info.isDirectory() || info.isFile();
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function readAppCursors(previous) {
  if (!isObject(previous) || !isObject(previous.apps)) return {};
  return previous.apps;
}

function readLastSha(apps, appId) {
  const cursor = apps[appId];
  return isObject(cursor) && typeof cursor.lastSha === "string"
    ? cursor.lastSha
    : undefined;
}

function assertWorkspaceHost(host) {
  if (!host || typeof host.workspacePath !== "string") {
    throw new Error("App Commits requires host.workspacePath");
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFoundError(err) {
  return Boolean(err) && typeof err === "object" && err.code === "ENOENT";
}

function isInvalidRevisionError(stderr) {
  return stderr.includes("Invalid revision range")
    || stderr.includes("unknown revision")
    || stderr.includes("bad revision")
    || stderr.includes("ambiguous argument");
}
