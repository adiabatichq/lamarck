import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const helperSourcePath = join(packageDir, "helper", "ax-helper.swift");
const helperBinaryPath = join(packageDir, "bin", "ax-helper");
const privacyListsDir = join(packageDir, "privacy-lists");
const swiftModuleCachePath = join(tmpdir(), "lamarck-swift-module-cache");

const DEFAULTS = {
  "idle-threshold-seconds": 15,
  "afk-threshold-seconds": 60,
};

const DEFAULT_PRIVACY_POLICY = {
  version: 1,
  apps: {
    "com.apple.finder": { action: "metadata_only" },
    "com.apple.systempreferences": { action: "metadata_only" },
    "ai.lamarck.desktop": { action: "metadata_only" },
  },
  domains: {},
  categories: {
    adult_content: { action: "metadata_only" },
    banking_finance: { action: "metadata_only" },
    gambling: { action: "metadata_only" },
    private_browsing: { action: "metadata_only" },
    secret_management: { action: "metadata_only" },
  },
};

const PRIVACY_ACTIONS = new Set(["rich", "metadata_only", "disabled"]);
const PRIVACY_ACTION_RANK = { rich: 0, metadata_only: 1, disabled: 2 };
const PRIVACY_POLICY_VERSION = "desktop-privacy-v1";

const PRIVACY_CATEGORIES = [
  { id: "adult_content", label: "Adult Content", description: "Adult websites and mature content" },
  { id: "banking_finance", label: "Banking & Finance", description: "Bank accounts, financial transactions, and investment platforms" },
  { id: "gambling", label: "Gambling", description: "Betting, casinos, and gambling platforms" },
  { id: "private_browsing", label: "Private Browsing", description: "Incognito and private browser windows" },
  { id: "social_media", label: "Social Media", description: "Social platforms and messaging services" },
  { id: "secret_management", label: "Credentials & Secrets", description: "Password vaults, credential management, and one-time secret sharing surfaces" },
];

const PRIVACY_CATEGORY_IDS = new Set(PRIVACY_CATEGORIES.map((item) => item.id));
const CATEGORY_DOMAIN_INDEX = loadPrivacyDomainIndex();

const INTERNAL_DEFAULTS = {
  intervalMs: 1000,
  profileWindowMs: 30_000,
  helperShutdownMs: 2_000,
  axTimeoutMs: 500,
  snapshotBudgetMs: 850,
  maxHelperStartFailures: 3,
};

const SAMPLE_GAP_WARNING_KEY = "macos-ax-sample-gap";

const INLINE_CONTENT_TEXT_CHARS = 8_192;
const BLOB_CONTENT_PREVIEW_CHARS = 4_096;

export default {
  async run(context) {
    await runDesktopContextConnector(context);
  },
  async configUi(context) {
    return startPrivacyControlsUi(context);
  },
  requirements: {
    "macos-accessibility": {
      label: "macOS Accessibility",
      description: "Allows the connector to read focused app, window, and accessibility context.",
      async check() {
        return checkAccessibility();
      },
      async request() {
        return requestAccessibility();
      },
    },
  },
};

export async function runDesktopContextConnector(context, deps = {}) {
  const maxHelperStartFailures = Math.max(
    1,
    Math.floor(readPositiveNumber(
      deps.maxHelperStartFailures,
      INTERNAL_DEFAULTS.maxHelperStartFailures,
    )),
  );
  let consecutiveHelperStartFailures = 0;
  let presenceRecoveryEndReason;

  while (!context.signal.aborted) {
    try {
      await runSnapshotProfiler(context, {
        ...deps,
        writeContextEvents: true,
        presenceRecoveryEndReason,
        async onFirstSnapshot(input) {
          consecutiveHelperStartFailures = 0;
          presenceRecoveryEndReason = undefined;
          await clearWarningSafely(context, SAMPLE_GAP_WARNING_KEY);
          await deps.onFirstSnapshot?.(input);
        },
      });
      return;
    } catch (err) {
      if (context.signal.aborted) return;
      if (!(err instanceof ContextWindowDeadlineError)) throw err;

      presenceRecoveryEndReason = "sample-gap";
      if (err.hadSamples) {
        consecutiveHelperStartFailures = 0;
        await setWarningSafely(context, {
          key: SAMPLE_GAP_WARNING_KEY,
          message: "macOS AX sampling stopped; the incomplete context window was skipped and the helper will restart.",
          details: {
            error: err.message,
            recovery: "helper-restart",
          },
        });
        await deps.onHelperRestart?.({ error: err, reason: "sample-gap" });
        continue;
      }

      consecutiveHelperStartFailures += 1;
      if (consecutiveHelperStartFailures >= maxHelperStartFailures) {
        await clearWarningSafely(context, SAMPLE_GAP_WARNING_KEY);
        const terminalError = new Error(
          `macOS AX helper failed to produce a first sample in ${maxHelperStartFailures} consecutive sessions.`,
        );
        terminalError.cause = err;
        throw terminalError;
      }

      await setWarningSafely(context, {
        key: SAMPLE_GAP_WARNING_KEY,
        message: "macOS AX helper produced no samples and will be restarted.",
        details: {
          error: err.message,
          failureCount: consecutiveHelperStartFailures,
          retriesRemaining: maxHelperStartFailures - consecutiveHelperStartFailures,
        },
      });
      await deps.onHelperRestart?.({ error: err, reason: "no-first-sample" });
    }
  }
}

export async function runSnapshotProfiler(context, deps = {}) {
  const config = normalizeConfig(context.config);
  const intervalMs = readPositiveNumber(deps.intervalMs, INTERNAL_DEFAULTS.intervalMs);
  const profileWindowMs = readPositiveNumber(deps.profileWindowMs, INTERNAL_DEFAULTS.profileWindowMs);
  const axTimeoutMs = readPositiveNumber(deps.axTimeoutMs, INTERNAL_DEFAULTS.axTimeoutMs);
  const snapshotBudgetMs = readPositiveNumber(deps.snapshotBudgetMs, INTERNAL_DEFAULTS.snapshotBudgetMs);
  const noSampleGraceMs = readPositiveNumber(deps.noSampleGraceMs, Math.max(10_000, intervalMs * 10));
  const profiler = new SnapshotProfiler({
    profileWindowMs,
    sampleIntervalMs: intervalMs,
    noSampleGraceMs,
    idleThresholdSeconds: config["idle-threshold-seconds"],
    afkThresholdSeconds: config["afk-threshold-seconds"],
    includeTextInProfile: deps.includeTextInProfiles === true,
  });
  if (deps.writeContextEvents === true) {
    await recoverOpenPresenceSegment(context, {
      ...deps,
      recoveryEndReason: deps.presenceRecoveryEndReason,
    });
  }
  const helper = spawnHelper([
    "--jsonl",
    "--interval-ms",
    String(intervalMs),
    "--capture-text",
    "true",
    "--ax-timeout-ms",
    String(Math.round(axTimeoutMs)),
    "--snapshot-budget-ms",
    String(Math.round(snapshotBudgetMs)),
  ], { signal: context.signal, spawnImpl: deps.spawnImpl });

  const onAbort = () => {
    helper.kill("SIGTERM");
    setTimeout(() => {
      if (!helper.killed) helper.kill("SIGKILL");
    }, INTERNAL_DEFAULTS.helperShutdownMs).unref?.();
  };

  if (context.signal.aborted) {
    onAbort();
    return;
  }
  context.signal.addEventListener("abort", onAbort, { once: true });

  let deadlineTimer;
  let failRun;
  let receivedSample = false;
  const helperStartedAt = Date.now();
  const startupDeadlineAt = helperStartedAt + profileWindowMs + noSampleGraceMs;
  const deadlineFailure = new Promise((_, reject) => {
    failRun = reject;
  });
  const clearDeadlineTimer = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };
  const scheduleDeadlineTimer = () => {
    clearDeadlineTimer();
    const deadlineAt = profiler.contextWindowDeadlineAt() ?? startupDeadlineAt;
    if (!deadlineAt) return;
    deadlineTimer = setTimeout(() => {
      if (context.signal.aborted) return;
      const err = profiler.contextWindowDeadlineError();
      helper.kill("SIGTERM");
      failRun?.(err);
    }, Math.max(0, deadlineAt - Date.now()));
  };

  try {
    scheduleDeadlineTimer();
    await Promise.race([consumeJsonLines(helper, async ({ line, value }) => {
      await deps.onSnapshot?.({ line, value });
      const rawBytes = Buffer.byteLength(line);
      const profiles = profiler.add(value, rawBytes, config);
      if (!receivedSample) {
        receivedSample = true;
        await deps.onFirstSnapshot?.({ line, value });
      }
      const presenceSegments = profiler.drainPresenceSegments();
      if (presenceSegments.length > 0) {
        await publishPresenceSegments(presenceSegments, context, deps);
        await checkpointPresenceOpen(profiler, context, deps);
      }
      for (const profile of profiles) {
        if (deps.writeContextEvents === true) {
          await publishContextEvent(profile, context, deps);
        }
        await publishProfile(profile, context, { log: deps.logProfiles === true });
        await checkpointPresenceOpen(profiler, context, deps);
        await deps.onProfile?.(profile);
      }
      scheduleDeadlineTimer();
    }), deadlineFailure]);

    const finalProfile = profiler.flush({ final: true, allowIncomplete: deps.writeContextEvents !== true });
    if (finalProfile) {
      if (deps.writeContextEvents === true) {
        await publishContextEvent(finalProfile, context, deps);
      }
      await publishProfile(finalProfile, context, { log: deps.logProfiles === true });
      await deps.onProfile?.(finalProfile);
    }
    await publishPresenceSegments(profiler.flushPresence({ final: true }), context, deps);
    await clearPresenceOpen(context, deps);
  } catch (err) {
    if (err instanceof ContextWindowDeadlineError && deps.writeContextEvents === true) {
      await checkpointPresenceOpen(profiler, context, deps);
    }
    throw err;
  } finally {
    clearDeadlineTimer();
    context.signal.removeEventListener("abort", onAbort);
  }
}

export function normalizeConfig(input) {
  const value = isObject(input) ? input : {};
  return {
    "idle-threshold-seconds": readPositiveNumber(
      value["idle-threshold-seconds"],
      DEFAULTS["idle-threshold-seconds"],
    ),
    "afk-threshold-seconds": readPositiveNumber(
      value["afk-threshold-seconds"],
      DEFAULTS["afk-threshold-seconds"],
    ),
    privacyPolicy: normalizePrivacyPolicy(value.privacyPolicy),
  };
}

function normalizePrivacyPolicy(input) {
  const source = isObject(input) ? input : {};
  const categories = normalizePrivacyCategoryRuleMap(source.categories, DEFAULT_PRIVACY_POLICY.categories);
  migrateLegacySecretCategory(categories, source.categories);
  return {
    version: 1,
    apps: normalizePrivacyRuleMap(source.apps, DEFAULT_PRIVACY_POLICY.apps),
    domains: normalizePrivacyDomainRuleMap(source.domains, DEFAULT_PRIVACY_POLICY.domains),
    categories,
  };
}

function migrateLegacySecretCategory(categories, sourceCategories) {
  delete categories.password_manager;
  delete categories.secret_sharing;
  if (!isObject(sourceCategories)) return;
  if (isObject(sourceCategories.secret_management) && PRIVACY_ACTIONS.has(sourceCategories.secret_management.action)) {
    categories.secret_management = { action: sourceCategories.secret_management.action };
    return;
  }
  const legacy = [sourceCategories.password_manager, sourceCategories.secret_sharing]
    .filter((rule) => isObject(rule) && PRIVACY_ACTIONS.has(rule.action));
  if (legacy.length === 0) return;
  const action = legacy
    .map((rule) => rule.action)
    .sort((a, b) => PRIVACY_ACTION_RANK[b] - PRIVACY_ACTION_RANK[a])[0];
  categories.secret_management = { action };
}

function normalizePrivacyRuleMap(input, fallback) {
  const source = isObject(input) ? input : {};
  const output = {};
  for (const [key, value] of Object.entries({ ...fallback, ...source })) {
    if (!isObject(value) || !PRIVACY_ACTIONS.has(value.action)) continue;
    output[key] = { action: value.action };
  }
  return output;
}

function normalizePrivacyCategoryRuleMap(input, fallback) {
  const source = isObject(input) ? input : {};
  const output = {};
  for (const [key, value] of Object.entries({ ...fallback, ...source })) {
    if (!PRIVACY_CATEGORY_IDS.has(key)) continue;
    if (!isObject(value) || !PRIVACY_ACTIONS.has(value.action)) continue;
    output[key] = { action: value.action };
  }
  return output;
}

function normalizePrivacyDomainRuleMap(input, fallback) {
  const source = isObject(input) ? input : {};
  const output = {};
  for (const [key, value] of Object.entries({ ...fallback, ...source })) {
    const domain = normalizeWebsiteDomain(key);
    if (!domain || !isObject(value) || !PRIVACY_ACTIONS.has(value.action)) continue;
    output[domain] = { action: value.action };
  }
  return output;
}

async function startPrivacyControlsUi(context) {
  if (context.panelId !== "privacy-controls") {
    throw new Error(`Unknown macos-ax config panel: ${context.panelId}`);
  }
  const token = randomBytes(24).toString("hex");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.searchParams.get("token") !== token) {
        sendText(res, 403, "Forbidden");
        return;
      }

      if (req.method === "GET" && url.pathname === "/panel") {
        sendHtml(res, privacyControlsHtml(token));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const rawConfig = await context.configStore.get();
        const config = normalizeConfig(rawConfig ?? context.config);
        sendJson(res, {
          apps: await listInstalledApps(),
          categories: PRIVACY_CATEGORIES,
          privacyPolicy: config.privacyPolicy,
          actions: [
            { value: "rich", label: "Rich" },
            { value: "metadata_only", label: "Metadata only" },
            { value: "disabled", label: "Disabled" },
          ],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/policy/apps") {
        const body = await readJsonBody(req);
        if (!isObject(body) || typeof body.bundleId !== "string" || !PRIVACY_ACTIONS.has(body.action)) {
          sendJson(res, { error: "Invalid app policy update" }, 400);
          return;
        }
        const rawConfig = await context.configStore.get();
        const policy = normalizePrivacyPolicy(isObject(rawConfig) ? rawConfig.privacyPolicy : undefined);
        policy.apps[body.bundleId] = { action: body.action };
        await context.configStore.patch({ set: { privacyPolicy: policy } });
        sendJson(res, { ok: true, privacyPolicy: policy });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/policy/categories") {
        const body = await readJsonBody(req);
        if (!isObject(body) || typeof body.category !== "string" || !PRIVACY_CATEGORIES.some((item) => item.id === body.category) || !PRIVACY_ACTIONS.has(body.action)) {
          sendJson(res, { error: "Invalid category policy update" }, 400);
          return;
        }
        const rawConfig = await context.configStore.get();
        const policy = normalizePrivacyPolicy(isObject(rawConfig) ? rawConfig.privacyPolicy : undefined);
        policy.categories[body.category] = { action: body.action };
        await context.configStore.patch({ set: { privacyPolicy: policy } });
        sendJson(res, { ok: true, privacyPolicy: policy });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/policy/websites") {
        const body = await readJsonBody(req);
        const domain = isObject(body) ? normalizeWebsiteDomain(body.domain) : undefined;
        if (!domain || !isObject(body) || !PRIVACY_ACTIONS.has(body.action)) {
          sendJson(res, { error: "Invalid website policy update" }, 400);
          return;
        }
        const rawConfig = await context.configStore.get();
        const policy = normalizePrivacyPolicy(isObject(rawConfig) ? rawConfig.privacyPolicy : undefined);
        policy.domains[domain] = { action: body.action };
        await context.configStore.patch({ set: { privacyPolicy: policy } });
        sendJson(res, { ok: true, domain, privacyPolicy: policy });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/policy/websites/remove") {
        const body = await readJsonBody(req);
        const domain = isObject(body) ? normalizeWebsiteDomain(body.domain) : undefined;
        if (!domain) {
          sendJson(res, { error: "Invalid website policy removal" }, 400);
          return;
        }
        const rawConfig = await context.configStore.get();
        const policy = normalizePrivacyPolicy(isObject(rawConfig) ? rawConfig.privacyPolicy : undefined);
        delete policy.domains[domain];
        await context.configStore.patch({ set: { privacyPolicy: policy } });
        sendJson(res, { ok: true, domain, privacyPolicy: policy });
        return;
      }

      sendText(res, 404, "Not found");
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const close = () => server.close();
  context.signal.addEventListener("abort", close, { once: true });
  const address = server.address();
  if (!isObject(address) || typeof address.port !== "number") {
    throw new Error("macos-ax config UI failed to bind a localhost port");
  }
  return { url: `http://127.0.0.1:${address.port}/panel?token=${token}` };
}

async function listInstalledApps() {
  const roots = [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    join(process.env.HOME ?? "", "Applications"),
  ].filter(Boolean);
  const apps = [];
  const seen = new Set();
  for (const root of roots) {
    await collectAppBundles(root, apps, seen, 0).catch(() => {});
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectAppBundles(dir, apps, seen, depth) {
  if (depth > 2) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(dir, entry.name);
    if (entry.name.endsWith(".app")) {
      const app = readAppBundle(fullPath);
      if (!seen.has(app.bundleId)) {
        seen.add(app.bundleId);
        apps.push(app);
      }
      continue;
    }
    if (depth < 1) {
      await collectAppBundles(fullPath, apps, seen, depth + 1).catch(() => {});
    }
  }
}

function readAppBundle(appPath) {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  const fallbackName = basename(appPath).replace(/\.app$/i, "");
  const bundleId = readPlistString(infoPlist, "CFBundleIdentifier") || `path:${appPath}`;
  const name = readPlistString(infoPlist, "CFBundleDisplayName")
    || readPlistString(infoPlist, "CFBundleName")
    || fallbackName;
  return { name, bundleId, path: appPath };
}

function readPlistString(plistPath, key) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath], {
    encoding: "utf8",
    timeout: 750,
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function privacyControlsHtml(token) {
  const tokenJson = JSON.stringify(token);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Privacy Controls</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #171513; color: #e8e1d8; }
    header { position: sticky; top: 0; z-index: 1; padding: 14px 18px; background: #1f1b18; border-bottom: 1px solid #3b342e; }
    h1 { margin: 0; font-size: 15px; font-weight: 600; }
    .sub { margin-top: 4px; color: #a79d91; font-size: 12px; }
    main { padding: 14px 18px 22px; }
    section { margin-bottom: 18px; }
    h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #d8d0c6; }
    .toolbar, .website-form { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    input { flex: 1 1 auto; min-width: 0; padding: 8px 10px; color: #e8e1d8; background: #24201c; border: 1px solid #4b4239; border-radius: 4px; }
    button { padding: 7px 10px; color: #e8e1d8; background: #2d2924; border: 1px solid #554a40; border-radius: 4px; cursor: pointer; }
    button:hover { background: #39332d; }
    button.icon { width: 28px; height: 28px; padding: 0; color: #a79d91; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 8px 6px; border-bottom: 1px solid #332d28; text-align: left; }
    th { color: #a79d91; font-weight: 500; }
    select { min-width: 150px; padding: 6px 8px; color: #e8e1d8; background: #24201c; border: 1px solid #4b4239; border-radius: 4px; }
    details { border: 1px solid #332d28; border-radius: 6px; margin-bottom: 8px; background: #1d1a17; }
    summary { padding: 8px 10px; cursor: pointer; color: #d8d0c6; font-size: 12px; }
    .domain-list { padding: 0 10px 8px; }
    .domain-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-top: 1px solid #2c2722; }
    .domain-name { color: #cfc6bb; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
    .empty { color: #7f756b; font-size: 12px; padding: 6px 0; }
    .bundle { color: #8d8378; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .description { color: #8d8378; font-size: 11px; }
    .status { color: #a79d91; font-size: 12px; }
    .error { color: #ef8d80; }
  </style>
</head>
<body>
  <header>
    <h1>Privacy Controls</h1>
    <div class="sub">App-level capture policy for macOS desktop context.</div>
  </header>
  <main>
    <section>
      <h2>Categories</h2>
      <table>
        <thead><tr><th>Category</th><th>Description</th><th>Capture</th></tr></thead>
        <tbody id="categories"></tbody>
      </table>
    </section>
    <section>
      <h2>Websites</h2>
      <form id="website-form" class="website-form">
        <input id="website-domain" placeholder="Add domain or URL" autocomplete="off" />
        <select id="website-action"></select>
        <button type="submit">Add</button>
      </form>
      <div id="website-groups"></div>
    </section>
    <section>
      <h2>Apps</h2>
      <div class="toolbar">
        <input id="filter" placeholder="Filter apps" autocomplete="off" />
        <span id="status" class="status">Loading...</span>
      </div>
      <table>
        <thead><tr><th>App</th><th>Bundle</th><th>Capture</th></tr></thead>
        <tbody id="apps"></tbody>
      </table>
    </section>
  </main>
  <script>
    const token = ${tokenJson};
    let state = { apps: [], categories: [], privacyPolicy: { apps: {}, categories: {}, domains: {} }, actions: [] };
    const appsEl = document.getElementById("apps");
    const categoriesEl = document.getElementById("categories");
    const websiteFormEl = document.getElementById("website-form");
    const websiteDomainEl = document.getElementById("website-domain");
    const websiteActionEl = document.getElementById("website-action");
    const websiteGroupsEl = document.getElementById("website-groups");
    const statusEl = document.getElementById("status");
    const filterEl = document.getElementById("filter");

    async function api(path, options) {
      const res = await fetch(path + "?token=" + encodeURIComponent(token), options);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      return json;
    }

    function currentAction(bundleId) {
      return state.privacyPolicy.apps?.[bundleId]?.action || "rich";
    }

    function currentCategoryAction(category) {
      return state.privacyPolicy.categories?.[category]?.action || "rich";
    }

    function render() {
      renderWebsiteActionSelect();
      renderCategories();
      renderWebsites();
      renderApps();
    }

    function renderCategories() {
      categoriesEl.textContent = "";
      for (const category of state.categories) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = category.label;
        const description = document.createElement("td");
        description.className = "description";
        description.textContent = category.description;
        const action = document.createElement("td");
        const select = actionSelect(currentCategoryAction(category.id));
        select.addEventListener("change", async () => {
          statusEl.textContent = "Saving...";
          statusEl.className = "status";
          try {
            const result = await api("/api/policy/categories", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ category: category.id, action: select.value })
            });
            state.privacyPolicy = result.privacyPolicy;
            statusEl.textContent = "Saved";
          } catch (err) {
            statusEl.textContent = err.message;
            statusEl.className = "status error";
          }
        });
        action.appendChild(select);
        tr.append(name, description, action);
        categoriesEl.appendChild(tr);
      }
    }

    function renderWebsiteActionSelect() {
      if (websiteActionEl.options.length === state.actions.length) return;
      websiteActionEl.textContent = "";
      for (const option of state.actions) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        websiteActionEl.appendChild(item);
      }
      websiteActionEl.value = "metadata_only";
    }

    function renderWebsites() {
      websiteGroupsEl.textContent = "";
      const domains = Object.entries(state.privacyPolicy.domains || {})
        .filter(([, rule]) => rule && state.actions.some((action) => action.value === rule.action))
        .sort(([a], [b]) => a.localeCompare(b));

      for (const action of state.actions) {
        const rows = domains.filter(([, rule]) => rule.action === action.value);
        const details = document.createElement("details");
        details.open = rows.length > 0;
        const summary = document.createElement("summary");
        summary.textContent = action.label + " (" + rows.length + ")";
        const list = document.createElement("div");
        list.className = "domain-list";

        if (rows.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "No website overrides";
          list.appendChild(empty);
        }

        for (const [domain] of rows) {
          const row = document.createElement("div");
          row.className = "domain-row";
          const name = document.createElement("span");
          name.className = "domain-name";
          name.textContent = domain;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "icon";
          remove.textContent = "x";
          remove.setAttribute("aria-label", "Remove " + domain);
          remove.addEventListener("click", async () => {
            statusEl.textContent = "Saving...";
            statusEl.className = "status";
            try {
              const result = await api("/api/policy/websites/remove", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ domain })
              });
              state.privacyPolicy = result.privacyPolicy;
              render();
              statusEl.textContent = "Saved";
            } catch (err) {
              statusEl.textContent = err.message;
              statusEl.className = "status error";
            }
          });
          row.append(name, remove);
          list.appendChild(row);
        }

        details.append(summary, list);
        websiteGroupsEl.appendChild(details);
      }
    }

    function renderApps() {
      const query = filterEl.value.trim().toLowerCase();
      const apps = state.apps.filter((app) =>
        !query || app.name.toLowerCase().includes(query) || app.bundleId.toLowerCase().includes(query)
      );
      appsEl.textContent = "";
      for (const app of apps) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = app.name;
        const bundle = document.createElement("td");
        bundle.className = "bundle";
        bundle.textContent = app.bundleId;
        const action = document.createElement("td");
        const select = actionSelect(currentAction(app.bundleId));
        select.addEventListener("change", async () => {
          statusEl.textContent = "Saving...";
          statusEl.className = "status";
          try {
            const result = await api("/api/policy/apps", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ bundleId: app.bundleId, action: select.value })
            });
            state.privacyPolicy = result.privacyPolicy;
            statusEl.textContent = "Saved";
          } catch (err) {
            statusEl.textContent = err.message;
            statusEl.className = "status error";
          }
        });
        action.appendChild(select);
        tr.append(name, bundle, action);
        appsEl.appendChild(tr);
      }
      statusEl.textContent = apps.length + " apps";
      statusEl.className = "status";
    }

    function actionSelect(value) {
      const select = document.createElement("select");
      for (const option of state.actions) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        select.appendChild(item);
      }
      select.value = value;
      return select;
    }

    async function load() {
      try {
        state = await api("/api/state");
        render();
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.className = "status error";
      }
    }

    filterEl.addEventListener("input", render);
    websiteFormEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      statusEl.textContent = "Saving...";
      statusEl.className = "status";
      try {
        const result = await api("/api/policy/websites", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ domain: websiteDomainEl.value, action: websiteActionEl.value })
        });
        state.privacyPolicy = result.privacyPolicy;
        websiteDomainEl.value = "";
        render();
        statusEl.textContent = "Saved";
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.className = "status error";
      }
    });
    load();
  </script>
</body>
</html>`;
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

export async function checkAccessibility() {
  const result = await runHelperJson(["--check-permission"]);
  if (result.ok && result.value?.trusted === true) {
    return { status: "satisfied", message: "Accessibility permission is granted." };
  }
  if (result.ok) {
    return { status: "missing", message: "Accessibility permission is required for macOS AX capture." };
  }
  return { status: "error", message: result.error };
}

export async function requestAccessibility() {
  const result = await runHelperJson(["--request-permission"]);
  if (result.ok && result.value?.trusted === true) {
    return { status: "satisfied", message: "Accessibility permission is granted." };
  }
  if (result.ok) {
    return {
      status: "pending",
      message: "macOS opened the Accessibility permission prompt. Grant access, then check again.",
    };
  }
  return { status: "error", message: result.error };
}

export async function collectProfileForCli(opts = {}) {
  const controller = new AbortController();
  const seconds = readPositiveNumber(opts.seconds, 30);
  const config = normalizeConfig({
    "idle-threshold-seconds": opts.idleThresholdSeconds ?? DEFAULTS["idle-threshold-seconds"],
    "afk-threshold-seconds": opts.afkThresholdSeconds ?? DEFAULTS["afk-threshold-seconds"],
  });
  const profiles = [];
  const writeProfilesPath = typeof opts.writeProfiles === "string" && opts.writeProfiles.trim()
    ? resolve(opts.writeProfiles)
    : undefined;
  const writeAggregatesPath = typeof opts.writeAggregates === "string" && opts.writeAggregates.trim()
    ? resolve(opts.writeAggregates)
    : undefined;
  const writeSnapshotsPath = typeof opts.writeSnapshots === "string" && opts.writeSnapshots.trim()
    ? resolve(opts.writeSnapshots)
    : undefined;
  const includeTextInProfiles = opts.includeTextInProfiles === true
    || (Boolean(writeProfilesPath) && opts.statsOnly !== true);
  const timeout = setTimeout(() => controller.abort(), seconds * 1000);
  try {
    await runSnapshotProfiler({
      config,
      signal: controller.signal,
      state: { async set() {} },
      warnings: noopWarnings(),
    }, {
      intervalMs: opts.intervalMs,
      profileWindowMs: opts.profileWindowMs,
      axTimeoutMs: opts.axTimeoutMs,
      snapshotBudgetMs: opts.snapshotBudgetMs,
      logProfiles: opts.verboseProfiles === true,
      includeTextInProfiles,
      async onSnapshot({ line }) {
        if (writeSnapshotsPath) {
          await appendJsonlLine(writeSnapshotsPath, line);
        }
      },
      async onProfile(profile) {
        profiles.push(profile);
        if (writeProfilesPath) {
          await appendJsonlLine(writeProfilesPath, JSON.stringify({ type: "macos-ax.profile", profile }));
        }
        if (writeAggregatesPath && profile.aggregate) {
          await appendJsonlLine(writeAggregatesPath, JSON.stringify(profile.aggregate));
        }
      },
    });
  } finally {
    clearTimeout(timeout);
  }
  return profiles.filter(Boolean);
}

async function replaySnapshotsForCli(opts) {
  const replayPath = typeof opts.replaySnapshots === "string" && opts.replaySnapshots.trim()
    ? resolve(opts.replaySnapshots)
    : undefined;
  if (!replayPath) throw new Error("--replay-snapshots requires a JSONL path.");

  const config = normalizeConfig({
    "idle-threshold-seconds": opts.idleThresholdSeconds ?? DEFAULTS["idle-threshold-seconds"],
    "afk-threshold-seconds": opts.afkThresholdSeconds ?? DEFAULTS["afk-threshold-seconds"],
  });
  const writeProfilesPath = typeof opts.writeProfiles === "string" && opts.writeProfiles.trim()
    ? resolve(opts.writeProfiles)
    : undefined;
  const writeAggregatesPath = typeof opts.writeAggregates === "string" && opts.writeAggregates.trim()
    ? resolve(opts.writeAggregates)
    : undefined;
  const includeTextInProfiles = opts.includeTextInProfiles === true
    || (Boolean(writeProfilesPath) && opts.statsOnly !== true);
  const profiler = new SnapshotProfiler({
    profileWindowMs: readPositiveNumber(opts.profileWindowMs, INTERNAL_DEFAULTS.profileWindowMs),
    sampleIntervalMs: readPositiveNumber(opts.intervalMs, INTERNAL_DEFAULTS.intervalMs),
    noSampleGraceMs: Math.max(10_000, readPositiveNumber(opts.intervalMs, INTERNAL_DEFAULTS.intervalMs) * 10),
    idleThresholdSeconds: config["idle-threshold-seconds"],
    afkThresholdSeconds: config["afk-threshold-seconds"],
    includeTextInProfile: includeTextInProfiles,
  });
  const profiles = [];
  const body = await readFile(replayPath, "utf8");
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const snapshot = JSON.parse(line);
    const profilesForLine = profiler.add(snapshot, Buffer.byteLength(line), config);
    for (const profile of profilesForLine) {
      profiles.push(profile);
      if (writeProfilesPath) await appendJsonlLine(writeProfilesPath, JSON.stringify({ type: "macos-ax.profile", profile }));
      if (writeAggregatesPath && profile.aggregate) await appendJsonlLine(writeAggregatesPath, JSON.stringify(profile.aggregate));
    }
  }
  const finalProfile = profiler.flush({ final: true });
  if (finalProfile) {
    profiles.push(finalProfile);
    if (writeProfilesPath) await appendJsonlLine(writeProfilesPath, JSON.stringify({ type: "macos-ax.profile", profile: finalProfile }));
    if (writeAggregatesPath && finalProfile.aggregate) await appendJsonlLine(writeAggregatesPath, JSON.stringify(finalProfile.aggregate));
  }
  return profiles;
}

class SnapshotProfiler {
  constructor({
    profileWindowMs,
    sampleIntervalMs,
    noSampleGraceMs,
    idleThresholdSeconds,
    afkThresholdSeconds,
    includeTextInProfile,
  }) {
    this.profileWindowMs = profileWindowMs;
    this.sampleIntervalMs = sampleIntervalMs;
    this.noSampleGraceMs = noSampleGraceMs;
    this.idleThresholdSeconds = idleThresholdSeconds;
    this.afkThresholdSeconds = afkThresholdSeconds;
    this.includeTextInProfile = includeTextInProfile;
    this.samples = [];
    this.windowStartedAt = undefined;
    this.windowStartedWallClockAt = undefined;
    this.presenceTracker = new PresenceSegmentTracker({
      idleThresholdSeconds,
      afkThresholdSeconds,
    });
    this.pendingPresenceSegments = [];
  }

  add(snapshot, rawBytes, config) {
    const receivedAt = Date.now();
    const timestamp = readSnapshotTimestamp(snapshot);
    const redaction = redactSnapshot(snapshot);
    const redacted = applyCapturePolicy(redaction.value, config);
    this.pendingPresenceSegments.push(...this.presenceTracker.add(redacted));
    const sample = {
      timestamp,
      rawBytes,
      normalizedBytes: byteLengthJSON(snapshot?.normalized ?? {}),
      redactedBytes: byteLengthJSON(redacted),
      redactionCount: redaction.count,
      snapshot: redacted,
    };

    if (this.windowStartedAt === undefined) {
      this.windowStartedAt = timestamp;
      this.windowStartedWallClockAt = receivedAt;
    }
    this.samples.push(sample);

    const profiles = [];
    while (this.windowStartedAt !== undefined && timestamp >= this.windowStartedAt + this.profileWindowMs) {
      const windowEndedAt = this.windowStartedAt + this.profileWindowMs;
      const windowSamples = this.samples.filter((item) =>
        item.timestamp >= this.windowStartedAt && item.timestamp < windowEndedAt
      );
      if (windowSamples.length > 0) {
        profiles.push(this.buildProfile(windowSamples, {
          startedAt: this.windowStartedAt,
          endedAt: windowEndedAt,
          final: false,
          allowTailMissing: true,
        }));
      }
      this.samples = this.samples.filter((item) => item.timestamp >= windowEndedAt);
      this.windowStartedAt = windowEndedAt;
      this.windowStartedWallClockAt = (this.windowStartedWallClockAt ?? receivedAt) + this.profileWindowMs;
    }
    return profiles;
  }

  flush(opts = {}) {
    if (this.samples.length === 0) return undefined;
    if (opts.allowIncomplete !== true) {
      this.samples = [];
      this.windowStartedAt = undefined;
      this.windowStartedWallClockAt = undefined;
      return undefined;
    }
    const samples = this.samples;
    this.samples = [];
    const startedAt = this.windowStartedAt ?? samples[0].timestamp;
    const endedAt = Math.min(
      startedAt + this.profileWindowMs,
      samples[samples.length - 1].timestamp + this.sampleIntervalMs,
    );
    this.windowStartedAt = undefined;
    this.windowStartedWallClockAt = undefined;

    return this.buildProfile(samples, {
      startedAt,
      endedAt,
      final: opts.final === true,
      allowTailMissing: false,
    });
  }

  buildProfile(samples, opts) {
    const aggregate = buildContextAggregateV0(samples.map((sample) => sample.snapshot), {
      windowStartedAtMs: opts.startedAt,
      windowEndedAtMs: opts.endedAt,
      sampleIntervalMs: this.sampleIntervalMs,
      allowTailMissing: opts.allowTailMissing === true,
      idleThresholdSeconds: this.idleThresholdSeconds,
      afkThresholdSeconds: this.afkThresholdSeconds,
    });
    const aggregateBytes = byteLengthJSON(aggregate);
    const aggregateProfile = profileAggregate(aggregate, { includeText: this.includeTextInProfile });

    const profile = {
      schema: "macos-ax.profile.v1",
      final: opts.final === true,
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      durationMs: Math.max(0, opts.endedAt - opts.startedAt),
      sampleCount: samples.length,
      rawBytes: summarize(samples.map((sample) => sample.rawBytes)),
      normalizedBytes: summarize(samples.map((sample) => sample.normalizedBytes)),
      redactedBytes: summarize(samples.map((sample) => sample.redactedBytes)),
      redactionCount: samples.reduce((sum, sample) => sum + sample.redactionCount, 0),
      eventLocalDedupBytes: aggregateBytes,
      attentionSpanCount: aggregateProfile.attentionSpanCount,
      contentSampleCount: aggregateProfile.contentSampleCount,
      uniqueContentCount: aggregateProfile.uniqueContentCount,
      contentBytes: aggregateProfile.contentBytes,
      visibleWindowCount: summarize(aggregateProfile.observations
        .map((obs) => visibleWindowCountFromObservation(obs))
        .filter((value) => Number.isFinite(value))),
      dominantApps: dominantApps(aggregate),
      aggregateProfile,
    };
    Object.defineProperty(profile, "aggregate", {
      value: aggregate,
      enumerable: false,
    });
    return profile;
  }

  contextWindowDeadlineAt() {
    if (this.windowStartedWallClockAt === undefined) return undefined;
    if (this.windowStartedAt === undefined) return undefined;
    return this.windowStartedWallClockAt + this.profileWindowMs + this.noSampleGraceMs;
  }

  contextWindowDeadlineError() {
    const startedAt = this.windowStartedAt;
    const endedAt = startedAt === undefined ? undefined : startedAt + this.profileWindowMs;
    const graceSeconds = Math.round(this.noSampleGraceMs / 1000);
    if (startedAt === undefined) {
      return new ContextWindowDeadlineError(
        `macOS AX helper produced no samples within the ${graceSeconds}s context grace window.`,
        { hadSamples: false },
      );
    }
    return new ContextWindowDeadlineError(
      `macOS AX helper stopped producing samples; context window ${isoTimestamp(startedAt)}`
        + ` to ${isoTimestamp(endedAt)} could not be closed within ${graceSeconds}s grace.`,
      { hadSamples: true },
    );
  }

  drainPresenceSegments() {
    const segments = this.pendingPresenceSegments;
    this.pendingPresenceSegments = [];
    return segments;
  }

  flushPresence(opts = {}) {
    const segment = this.presenceTracker.flush(opts);
    if (segment) {
      this.pendingPresenceSegments.push(segment);
    }
    return this.drainPresenceSegments();
  }

  presenceOpenCursor() {
    return this.presenceTracker.openCursor();
  }
}

class PresenceSegmentTracker {
  constructor({ idleThresholdSeconds, afkThresholdSeconds }) {
    this.idleThresholdSeconds = idleThresholdSeconds;
    this.afkThresholdSeconds = afkThresholdSeconds;
    this.current = undefined;
    this.lastTimestamp = undefined;
    this.lastIntervalMs = INTERNAL_DEFAULTS.intervalMs;
  }

  add(snapshot) {
    const timestamp = readSnapshotTimestamp(snapshot);
    if (this.lastTimestamp !== undefined) {
      const intervalMs = timestamp - this.lastTimestamp;
      if (Number.isFinite(intervalMs) && intervalMs > 0) {
        this.lastIntervalMs = intervalMs;
      }
    }

    const state = publicPresenceState(presenceStateForSnapshot(snapshot, {
      idleThresholdSeconds: this.idleThresholdSeconds,
      afkThresholdSeconds: this.afkThresholdSeconds,
    }));
    if (!this.current) {
      this.current = {
        state,
        startedAt: timestamp,
        sampleCount: 1,
      };
      this.lastTimestamp = timestamp;
      return [];
    }

    if (state === this.current.state) {
      this.current.sampleCount += 1;
      this.lastTimestamp = timestamp;
      return [];
    }

    const segment = this.closeAt(timestamp);
    this.current = {
      state,
      startedAt: timestamp,
      sampleCount: 1,
    };
    this.lastTimestamp = timestamp;
    return segment ? [segment] : [];
  }

  flush(opts = {}) {
    if (!this.current) return undefined;
    const endedAt = (this.lastTimestamp ?? this.current.startedAt) + this.lastIntervalMs;
    return this.closeAt(endedAt, opts);
  }

  openCursor() {
    if (!this.current) return undefined;
    return {
      schema: "macos-ax.presence.open.v1",
      platform: "macos",
      state: this.current.state,
      startedAt: this.current.startedAt,
      lastObservedAt: this.lastTimestamp ?? this.current.startedAt,
      lastIntervalMs: this.lastIntervalMs,
      sampleCount: this.current.sampleCount,
      presenceModel: {
        source: "hid-any-input",
        idleThresholdSeconds: this.idleThresholdSeconds,
        afkThresholdSeconds: this.afkThresholdSeconds,
      },
    };
  }

  closeAt(endedAt, opts = {}) {
    if (!this.current) return undefined;
    const current = this.current;
    this.current = undefined;
    return {
      schema: "desktop.presence.segment.v0",
      final: opts.final === true ? true : undefined,
      recovered: opts.recovered === true ? true : undefined,
      endReason: typeof opts.endReason === "string" ? opts.endReason : undefined,
      platform: "macos",
      startedAt: isoTimestamp(current.startedAt),
      endedAt: isoTimestamp(endedAt),
      durationMs: Math.max(0, endedAt - current.startedAt),
      sampleCount: current.sampleCount,
      presenceModel: {
        source: "hid-any-input",
        idleThresholdSeconds: this.idleThresholdSeconds,
        afkThresholdSeconds: this.afkThresholdSeconds,
      },
      state: current.state,
    };
  }
}

function buildContextAggregateV0(snapshots, opts = {}) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return {
      type: "desktop.context",
      schema: "desktop.context.aggregate.v0",
      source: "macos-ax",
      startedAt: undefined,
      endedAt: undefined,
      durationMs: 0,
      sampleCount: 0,
      presence: { activeMs: 0, idleMs: 0, afkMs: 0, lockedMs: 0, missingMs: 0, unattributedMs: 0 },
      displays: {},
      windows: {},
      attentionSpans: [],
      observations: [],
      contents: {},
    };
  }

  const allRecords = snapshots
    .map((snapshot) => ({ snapshot, timestamp: readSnapshotTimestamp(snapshot) }))
    .filter((record) => Number.isFinite(record.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  const sampleIntervalMs = readPositiveNumber(
    opts.sampleIntervalMs,
    inferSampleIntervalMs(allRecords.map((record) => record.timestamp)),
  );
  const startedAtMs = typeof opts.windowStartedAtMs === "number" && Number.isFinite(opts.windowStartedAtMs)
    ? opts.windowStartedAtMs
    : allRecords[0].timestamp;
  const endedAtMs = typeof opts.windowEndedAtMs === "number" && Number.isFinite(opts.windowEndedAtMs)
    ? opts.windowEndedAtMs
    : allRecords[allRecords.length - 1].timestamp + sampleIntervalMs;
  const records = allRecords.filter((record) => record.timestamp >= startedAtMs && record.timestamp < endedAtMs);
  const contents = {};
  const contentIdsByHash = new Map();
  const displays = {};
  const displayIdsByKey = new Map();
  const windows = {};
  const windowIdsByKey = new Map();
  const spans = [];
  const observations = [];
  const presence = { activeMs: 0, idleMs: 0, afkMs: 0, lockedMs: 0, missingMs: 0, unattributedMs: 0 };
  let contentSequence = 0;
  let displaySequence = 0;
  let windowSequence = 0;
  let spanSequence = 0;
  let currentSpan;
  let currentSpanKey;
  let currentObservation;
  let cursorMs = startedAtMs;
  const gapThresholdMs = sampleIntervalMs * 1.5;

  const appendMissingInterval = (fromMs, toMs, opts = {}) => {
    const startedAt = Math.max(startedAtMs, Math.min(fromMs, endedAtMs));
    const endedAt = Math.max(startedAt, Math.min(toMs, endedAtMs));
    const durationMs = endedAt - startedAt;
    if (durationMs <= 0) return;
    if (opts.countPresenceMissing !== false) {
      presence.missingMs += durationMs;
    }

    const capture = { state: "missing", reason: opts.reason ?? "sample_gap" };
    const spanKey = stableJSONString({ capture });
    if (spanKey !== currentSpanKey) {
      spanSequence += 1;
      currentSpan = {
        id: `s${spanSequence}`,
        fromMs: Math.max(0, startedAt - startedAtMs),
        toMs: Math.max(0, endedAt - startedAtMs),
        durationMs,
        sampleCount: 0,
        capture,
        contentRefs: [],
      };
      spans.push(currentSpan);
      currentSpanKey = spanKey;
    } else {
      currentSpan.toMs = Math.max(0, endedAt - startedAtMs);
      currentSpan.durationMs += durationMs;
    }

    const observationKey = stableJSONString({
      attentionSpanId: currentSpan.id,
      capture,
    });
    if (currentObservation?._key === observationKey) {
      currentObservation.toMs = Math.max(currentObservation.toMs, endedAt - startedAtMs);
      currentObservation.durationMs += durationMs;
    } else {
      currentObservation = {
        _key: observationKey,
        fromMs: Math.max(0, startedAt - startedAtMs),
        toMs: Math.max(0, endedAt - startedAtMs),
        durationMs,
        sampleCount: 0,
        attentionSpanId: currentSpan.id,
        capture,
      };
      observations.push(currentObservation);
    }
  };

  const appendSampleRecord = (record, sampleStartedAtMs, sampleEndedAtMs) => {
    const { snapshot } = record;
    const sampleDurationMs = Math.max(0, sampleEndedAtMs - sampleStartedAtMs);
    if (sampleDurationMs <= 0) return;
    const normalized = isObject(snapshot.normalized) ? snapshot.normalized : {};
    const app = isObject(normalized.app) ? normalized.app : {};
    const window = isObject(normalized.window) ? normalized.window : {};
    const focus = isObject(normalized.focus) ? normalized.focus : {};
    const text = isObject(normalized.text) ? normalized.text : {};
    const session = isObject(normalized.session) ? normalized.session : {};
    const idle = isObject(normalized.idle) ? normalized.idle : {};
    const visibleWindows = Array.isArray(normalized.visibleWindows) ? normalized.visibleWindows : [];

    const presenceState = presenceFromSnapshot({
      session,
      idle,
      idleThresholdSeconds: opts.idleThresholdSeconds,
      afkThresholdSeconds: opts.afkThresholdSeconds,
    });
    if (!foregroundContextReliable(normalized.frontmostSource)) {
      if (presenceState === "screen_locked") presence.lockedMs += sampleDurationMs;
      else presence.unattributedMs += sampleDurationMs;
      appendMissingInterval(sampleStartedAtMs, sampleEndedAtMs, {
        countPresenceMissing: false,
        reason: "unattributed",
      });
      return;
    }

    if (presenceState === "screen_locked") presence.lockedMs += sampleDurationMs;
    else if (presenceState === "afk") presence.afkMs += sampleDurationMs;
    else if (presenceState === "idle") presence.idleMs += sampleDurationMs;
    else presence.activeMs += sampleDurationMs;

    const privacy = isObject(normalized.privacyDecision)
      ? normalized.privacyDecision
      : privacyDecision({ app, window, focus, text }, {});

    const isDisabledSpan = privacy.action === "disabled";
    const isRichSpan = privacy.action === "rich";

    let visibleWindowStacks;
    let visibleWindowRefs = [];
    if (!isDisabledSpan) {
      const displayRefsById = indexDisplays(snapshot, { displays, displayIdsByKey, nextId: () => `d${++displaySequence}` });
      const visibleWindowIndex = buildVisibleWindowIndex(visibleWindows, {
        windows,
        windowIdsByKey,
        displayRefsById,
        nextId: () => `w${++windowSequence}`,
      });
      visibleWindowStacks = visibleWindowIndex.stacks;
      visibleWindowRefs = visibleWindowIndex.refs;
    }

    const foregroundWindowRef = isDisabledSpan
      ? undefined
      : foregroundWindowRefForSnapshot({ app, window, visibleWindowRefs });

    let contentRef;
    if (isRichSpan) {
      const contentText = contentTextFromNormalizedText(text);
      if (contentText) {
        const hash = `sha256:${sha256(contentText)}`;
        contentRef = contentIdsByHash.get(hash);
        if (!contentRef) {
          contentSequence += 1;
          contentRef = `c${contentSequence}`;
          contentIdsByHash.set(hash, contentRef);
          contents[contentRef] = {
            hash,
            chars: contentText.length,
            text: contentText,
          };
        }
      }
    }

    const spanKey = isDisabledSpan
      ? stableJSONString({ privacy: "disabled" })
      : stableJSONString({
          app: app.bundleId ?? app.name,
          window: isRichSpan
            ? [window.title, window.role, window.subrole].filter(Boolean).join(":")
            : [window.role, window.subrole].filter(Boolean).join(":"),
          focus: isRichSpan
            ? [focus.role, focus.subrole, focus.identifier].filter(Boolean).join(":")
            : undefined,
          privacy: [privacy.action, privacy.category, ...(Array.isArray(privacy.categories) ? privacy.categories : [])].filter(Boolean).join(":"),
          surface: isRichSpan ? [privacy.domain, privacy.domainSource].filter(Boolean).join(":") : undefined,
          foregroundWindowRef,
        });

    if (spanKey !== currentSpanKey) {
      spanSequence += 1;
      currentSpan = compactObject({
        id: `s${spanSequence}`,
        fromMs: Math.max(0, sampleStartedAtMs - startedAtMs),
        toMs: Math.max(0, sampleEndedAtMs - startedAtMs),
        durationMs: sampleDurationMs,
        sampleCount: 1,
        app: isDisabledSpan ? undefined : compactObject({
          name: app.name,
          bundleId: app.bundleId,
          pid: app.pid,
        }),
        foregroundWindowRef,
        window: isDisabledSpan || foregroundWindowRef ? undefined : compactObject({
          title: window.title,
          role: window.role,
          subrole: window.subrole,
        }),
        focus: isDisabledSpan ? undefined : compactObject({
          role: focus.role,
          subrole: focus.subrole,
          identifier: focus.identifier,
        }),
        privacy: isDisabledSpan ? { action: "disabled" } : privacySummary(privacy),
        surface: privacy.action === "rich"
          ? compactObject({ domain: privacy.domain, domainSource: privacy.domainSource })
          : undefined,
        contentRefs: [],
      });
      spans.push(currentSpan);
      currentSpanKey = spanKey;
    } else {
      currentSpan.toMs = Math.max(0, sampleEndedAtMs - startedAtMs);
      currentSpan.durationMs += sampleDurationMs;
      currentSpan.sampleCount += 1;
    }

    if (contentRef && !currentSpan.contentRefs.includes(contentRef)) {
      currentSpan.contentRefs.push(contentRef);
    }

    const capture = isDisabledSpan ? undefined : captureSummaryFromPermission(normalized.permission);
    const observationKey = stableJSONString({
      attentionSpanId: currentSpan.id,
      contentRef: isDisabledSpan ? undefined : contentRef,
      capture,
      visibleWindowStacks: isDisabledSpan ? undefined : visibleWindowStacks,
    });
    const input = isDisabledSpan ? undefined : inputSummaryFromSnapshot(snapshot, normalized);
    if (currentObservation?._key === observationKey) {
      currentObservation.toMs = Math.max(currentObservation.toMs, sampleEndedAtMs - startedAtMs);
      currentObservation.durationMs += sampleDurationMs;
      currentObservation.sampleCount += 1;
      if (!isDisabledSpan) {
        currentObservation.input = mergeInputSummary(currentObservation.input, input);
      }
    } else {
      currentObservation = compactObject({
        _key: observationKey,
        fromMs: Math.max(0, sampleStartedAtMs - startedAtMs),
        toMs: Math.max(0, sampleEndedAtMs - startedAtMs),
        durationMs: sampleDurationMs,
        sampleCount: 1,
        attentionSpanId: currentSpan.id,
        contentRef: isDisabledSpan ? undefined : contentRef,
        capture,
        visibleWindowStacks: isDisabledSpan ? undefined : visibleWindowStacks,
        input,
      });
      observations.push(currentObservation);
    }
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const { timestamp } = record;
    if (timestamp > cursorMs) {
      appendMissingInterval(cursorMs, timestamp);
      cursorMs = timestamp;
    }

    const nextTimestamp = records[index + 1]?.timestamp;
    const deltaToNext = nextTimestamp === undefined ? undefined : nextTimestamp - timestamp;
    const sampleEndedAtMs = Math.min(
      endedAtMs,
      deltaToNext !== undefined && deltaToNext > 0 && deltaToNext <= gapThresholdMs
        ? nextTimestamp
        : timestamp + sampleIntervalMs,
    );
    appendSampleRecord(record, Math.max(timestamp, cursorMs), sampleEndedAtMs);
    cursorMs = Math.max(cursorMs, sampleEndedAtMs);
  }

  if (opts.allowTailMissing === true && cursorMs < endedAtMs) {
    appendMissingInterval(cursorMs, endedAtMs);
  }

  for (const observation of observations) {
    delete observation._key;
  }

  return {
    type: "desktop.context",
    schema: "desktop.context.aggregate.v0",
    source: "macos-ax",
    startedAt: isoTimestamp(startedAtMs),
    endedAt: isoTimestamp(endedAtMs),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    sampleCount: records.length,
    sampleIntervalMs,
    presenceModel: {
      source: "hid-any-input",
      idleThresholdSeconds: opts.idleThresholdSeconds,
      afkThresholdSeconds: opts.afkThresholdSeconds,
    },
    presence,
    displays,
    windows,
    attentionSpans: spans,
    observations,
    contents,
  };
}

function profileAggregate(aggregate, opts = {}) {
  const contents = Object.fromEntries(
    Object.entries(aggregate.contents).map(([hash, content]) => [
      hash,
      opts.includeText ? { chars: content.chars, text: content.text } : { chars: content.chars },
    ]),
  );
  return {
    schema: aggregate.schema,
    presenceModel: aggregate.presenceModel,
    presence: aggregate.presence,
    displays: aggregate.displays,
    windows: aggregate.windows,
    attentionSpans: aggregate.attentionSpans,
    observations: aggregate.observations,
    contents,
    attentionSpanCount: aggregate.attentionSpans.length,
    contentSampleCount: aggregate.observations.filter((observation) => observation.contentRef).length,
    uniqueContentCount: Object.keys(aggregate.contents).length,
    visibleDisplayCount: Object.keys(aggregate.displays ?? {}).length,
    visibleWindowSnapshotCount: Object.keys(aggregate.windows ?? {}).length,
    contentBytes: byteLengthJSON(aggregate.contents),
  };
}

function buildDesktopContextEvent(aggregate) {
  if (!isObject(aggregate) || aggregate.sampleCount <= 0) return undefined;
  const startedAt = Date.parse(aggregate.startedAt);
  const endedAt = Date.parse(aggregate.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    throw new Error("desktop.context aggregate requires finite startedAt and endedAt timestamps");
  }

  const payload = compactObject({
    schema: aggregate.schema,
    platform: "macos",
    sampleIntervalMs: aggregate.sampleIntervalMs,
    sampleCount: aggregate.sampleCount,
    presenceModel: aggregate.presenceModel,
    presence: aggregate.presence,
    displays: aggregate.displays ?? {},
    windows: aggregate.windows ?? {},
    attentionSpans: Array.isArray(aggregate.attentionSpans) ? aggregate.attentionSpans : [],
    observations: Array.isArray(aggregate.observations) ? aggregate.observations : [],
    contents: isObject(aggregate.contents) ? aggregate.contents : {},
  });
  const revision = sha256(stableJSONString(payload)).slice(0, 16);
  return {
    type: "desktop.context",
    externalId: `macos-ax:context:${new Date(startedAt).toISOString()}:${revision}`,
    startedAt,
    endedAt,
    payload,
  };
}

function buildDesktopPresenceEvent(segment) {
  if (!isObject(segment) || segment.sampleCount <= 0) return undefined;
  const startedAt = Date.parse(segment.startedAt);
  const endedAt = Date.parse(segment.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    throw new Error("desktop.presence segment requires finite startedAt and endedAt timestamps");
  }

  const payload = compactObject({
    schema: segment.schema,
    platform: segment.platform,
    state: segment.state,
    durationMs: segment.durationMs,
    sampleCount: segment.sampleCount,
    presenceModel: segment.presenceModel,
    recovered: segment.recovered === true ? true : undefined,
    endReason: typeof segment.endReason === "string" ? segment.endReason : undefined,
  });
  const revision = sha256(stableJSONString(payload)).slice(0, 16);
  return {
    type: "desktop.presence",
    externalId: `macos-ax:presence:${new Date(startedAt).toISOString()}:${segment.state}:${revision}`,
    startedAt,
    endedAt,
    payload,
  };
}

function countVisibleWindowStackRefs(stacks) {
  if (!isObject(stacks)) return 0;
  let count = 0;
  for (const refs of Object.values(stacks)) {
    if (Array.isArray(refs)) count += refs.length;
  }
  return count;
}

function visibleWindowCountFromObservation(observation) {
  if (!isObject(observation)) return undefined;
  if (!isObject(observation.visibleWindowStacks)) return undefined;
  return countVisibleWindowStackRefs(observation.visibleWindowStacks);
}

function inferSampleIntervalMs(timestamps) {
  const deltas = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = timestamps[index] - timestamps[index - 1];
    if (Number.isFinite(delta) && delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return INTERNAL_DEFAULTS.intervalMs;
  deltas.sort((a, b) => a - b);
  return percentile(deltas, 0.50);
}

function isoTimestamp(timestamp) {
  return new Date(timestamp).toISOString();
}

function contentTextFromNormalizedText(text) {
  if (!isObject(text) || !Array.isArray(text.excerpts)) return undefined;
  const parts = text.excerpts
    .filter((value) => typeof value === "string")
    .map((value) => normalizeContentTextPart(value))
    .filter(Boolean);
  const joined = parts.join("\n\n").trim();
  return joined || undefined;
}

function normalizeContentTextPart(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function privacySummary(privacy) {
  return compactObject({
    action: privacy.action,
    mode: privacy.mode,
    policyVersion: privacy.policyVersion,
    reason: privacy.reason,
    category: privacy.category,
    categories: privacy.categories,
    redactTitle: privacy.redactTitle,
    redactUrl: privacy.redactUrl,
    redactDomain: privacy.redactDomain,
  });
}

function indexDisplays(snapshot, state) {
  const refsByDisplayId = new Map();
  const rawDisplays = Array.isArray(snapshot?.raw?.displays) ? snapshot.raw.displays : [];
  for (const display of rawDisplays) {
    if (!isObject(display)) continue;
    const normalized = normalizeDisplaySnapshot(display);
    if (!normalized) continue;
    const key = stableJSONString(normalized);
    let ref = state.displayIdsByKey.get(key);
    if (!ref) {
      ref = state.nextId();
      state.displayIdsByKey.set(key, ref);
      state.displays[ref] = normalized;
    }
    refsByDisplayId.set(normalized.displayId, ref);
  }
  return refsByDisplayId;
}

function normalizeDisplaySnapshot(display) {
  const displayId = display.id;
  const bounds = normalizeBounds(display.bounds);
  if (!Number.isFinite(displayId) || !bounds) return undefined;
  return compactObject({
    displayId,
    main: display.main === true ? true : undefined,
    bounds,
    pixelsWide: Number.isFinite(display.pixelsWide) ? display.pixelsWide : undefined,
    pixelsHigh: Number.isFinite(display.pixelsHigh) ? display.pixelsHigh : undefined,
  });
}

function buildVisibleWindowStacks(visibleWindows, state) {
  return buildVisibleWindowIndex(visibleWindows, state).stacks;
}

function buildVisibleWindowIndex(visibleWindows, state) {
  const stacks = {};
  const refs = [];
  const coveredRectsByDisplay = new Map();
  for (const window of visibleWindows) {
    if (!shouldIncludeVisibleWindow(window)) continue;
    const displayRef = state.displayRefsById.get(window.displayId);
    if (!displayRef) continue;
    const normalized = normalizeVisibleWindowSnapshot(window, displayRef);
    if (!normalized) continue;
    const coveredRects = coveredRectsByDisplay.get(displayRef) ?? [];
    const visibleArea = visibleAreaAfterOcclusion(normalized.bounds, coveredRects);
    if (visibleArea <= 0) continue;
    coveredRects.push(normalized.bounds);
    coveredRectsByDisplay.set(displayRef, coveredRects);
    const key = stableJSONString(normalized);
    let ref = state.windowIdsByKey.get(key);
    if (!ref) {
      ref = state.nextId();
      state.windowIdsByKey.set(key, ref);
      state.windows[ref] = normalized;
    }
    stacks[displayRef] ??= [];
    stacks[displayRef].push(ref);
    refs.push({ ref, raw: window, window: normalized });
  }
  return {
    stacks: Object.fromEntries(Object.entries(stacks).sort(([left], [right]) => left.localeCompare(right))),
    refs,
  };
}

function foregroundWindowRefForSnapshot({ app, window, visibleWindowRefs }) {
  if (!Array.isArray(visibleWindowRefs) || visibleWindowRefs.length === 0) return undefined;

  const appPid = Number(app?.pid);
  const appBundleId = typeof app?.bundleId === "string" ? app.bundleId : undefined;
  const title = typeof window?.title === "string" && window.title.trim() ? window.title.trim() : undefined;

  let candidates = visibleWindowRefs;
  if (Number.isFinite(appPid)) {
    const pidCandidates = candidates.filter((candidate) => candidate.window?.app?.pid === appPid);
    if (pidCandidates.length > 0) candidates = pidCandidates;
  } else if (appBundleId) {
    const bundleCandidates = candidates.filter((candidate) => candidate.window?.app?.bundleId === appBundleId);
    if (bundleCandidates.length > 0) candidates = bundleCandidates;
  }

  if (title) {
    const titleMatch = candidates.find((candidate) => candidate.window?.title === title);
    if (titleMatch) return titleMatch.ref;
  }
  return candidates[0]?.ref;
}

function visibleAreaAfterOcclusion(bounds, coveringRects) {
  let remaining = [bounds];
  for (const cover of coveringRects) {
    remaining = remaining.flatMap((rect) => subtractRect(rect, cover));
    if (remaining.length === 0) return 0;
  }
  return remaining.reduce((sum, rect) => sum + rect.width * rect.height, 0);
}

function subtractRect(rect, cover) {
  const x1 = Math.max(rect.x, cover.x);
  const y1 = Math.max(rect.y, cover.y);
  const x2 = Math.min(rect.x + rect.width, cover.x + cover.width);
  const y2 = Math.min(rect.y + rect.height, cover.y + cover.height);
  if (x2 <= x1 || y2 <= y1) return [rect];

  const pieces = [];
  const rectRight = rect.x + rect.width;
  const rectBottom = rect.y + rect.height;
  if (y1 > rect.y) pieces.push({ x: rect.x, y: rect.y, width: rect.width, height: y1 - rect.y });
  if (y2 < rectBottom) pieces.push({ x: rect.x, y: y2, width: rect.width, height: rectBottom - y2 });
  if (x1 > rect.x) pieces.push({ x: rect.x, y: y1, width: x1 - rect.x, height: y2 - y1 });
  if (x2 < rectRight) pieces.push({ x: x2, y: y1, width: rectRight - x2, height: y2 - y1 });
  return pieces.filter((piece) => piece.width > 0 && piece.height > 0);
}

function shouldIncludeVisibleWindow(window) {
  if (!isObject(window)) return false;
  if (window.privacyDecision?.action === "disabled") return false;
  if (window.onscreen !== true) return false;
  if (typeof window.alpha === "number" && window.alpha <= 0) return false;
  if (window.layer !== 0) return false;
  if (!normalizeBounds(window.bounds)) return false;
  const bundleId = String(window.bundleId ?? "").toLowerCase();
  const ownerName = String(window.ownerName ?? "").toLowerCase();
  if (!bundleId) return false;
  if (bundleId === "com.apple.dock") return false;
  if (bundleId === "com.apple.systemuiserver") return false;
  if (bundleId === "com.apple.controlcenter") return false;
  if (bundleId === "com.apple.spotlight") return false;
  if (ownerName === "window server") return false;
  if (ownerName === "dock") return false;
  if (ownerName.includes("axvisualsupportagent")) return false;
  return true;
}

function normalizeVisibleWindowSnapshot(window, displayRef) {
  const bounds = normalizeBounds(window.bounds);
  if (!bounds) return undefined;
  const title = typeof window.title === "string" && window.title.trim() ? window.title.trim() : undefined;
  return compactObject({
    windowId: Number.isFinite(window.windowId) ? window.windowId : undefined,
    app: compactObject({
      name: window.ownerName,
      bundleId: window.bundleId,
      pid: Number.isFinite(window.ownerPid) ? window.ownerPid : undefined,
    }),
    title,
    privacy: isObject(window.privacyDecision) ? privacySummary(window.privacyDecision) : undefined,
    displayRef,
    bounds,
    layer: Number.isFinite(window.layer) ? window.layer : undefined,
  });
}

function normalizeBounds(bounds) {
  if (!isObject(bounds)) return undefined;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  if (width <= 24 || height <= 24) return undefined;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function inputSummaryFromSnapshot(snapshot, normalized) {
  const mouse = isObject(normalized.mouse) ? normalized.mouse : {};
  if (typeof mouse.x !== "number" || typeof mouse.y !== "number") return undefined;
  const displayId = displayIdForPoint(snapshot, mouse);
  const mouseSummary = compactObject({
    moved: false,
    osDisplayIds: displayId === undefined ? [] : [displayId],
    osWindowIds: Number.isFinite(mouse.hoveredWindowId) ? [mouse.hoveredWindowId] : [],
  });
  Object.defineProperty(mouseSummary, "_lastPoint", {
    value: { x: mouse.x, y: mouse.y },
    enumerable: false,
    writable: true,
  });
  return { mouse: mouseSummary };
}

function captureSummaryFromPermission(permission) {
  if (!isObject(permission)) return undefined;
  return compactObject({
    accessibilityTrusted: typeof permission.accessibility === "boolean" ? permission.accessibility : undefined,
  });
}

function foregroundContextReliable(frontmostSource) {
  if (!isObject(frontmostSource)) return true;
  return frontmostSource.source === "cg-window";
}

function displayIdForPoint(snapshot, mouse) {
  const displays = Array.isArray(snapshot?.raw?.displays) ? snapshot.raw.displays : [];
  for (const display of displays) {
    const bounds = isObject(display.bounds) ? display.bounds : {};
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (mouse.x >= x && mouse.x < x + width && mouse.y >= y && mouse.y < y + height) return display.id;
  }
  return undefined;
}

function mergeInputSummary(existing, next) {
  if (!existing) return next;
  if (!next) return existing;
  if (existing.mouse || next.mouse) {
    existing.mouse = mergeMouseSummary(existing.mouse, next.mouse);
  }
  return existing;
}

function mergeMouseSummary(existing, next) {
  if (!existing) return next;
  if (!next) return existing;
  const previousPoint = existing._lastPoint;
  const nextPoint = next._lastPoint;
  existing.moved = existing.moved === true
    || next.moved === true
    || (previousPoint && nextPoint && (previousPoint.x !== nextPoint.x || previousPoint.y !== nextPoint.y));
  existing.osDisplayIds = mergeUniqueNumbers(existing.osDisplayIds, next.osDisplayIds);
  existing.osWindowIds = mergeUniqueNumbers(existing.osWindowIds, next.osWindowIds);
  if (nextPoint) {
    Object.defineProperty(existing, "_lastPoint", {
      value: nextPoint,
      enumerable: false,
      writable: true,
    });
  }
  return existing;
}

function mergeUniqueNumbers(left, right) {
  return [...new Set([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]
    .filter((value) => Number.isFinite(value)))]
    .sort((a, b) => a - b);
}

function applyCapturePolicy(snapshot, config) {
  const clone = structuredCloneCompat(snapshot);
  const normalized = isObject(clone.normalized) ? clone.normalized : {};
  const app = isObject(normalized.app) ? normalized.app : {};
  const window = isObject(normalized.window) ? normalized.window : {};
  const focus = isObject(normalized.focus) ? normalized.focus : {};
  const text = isObject(normalized.text) ? normalized.text : {};
  const decision = privacyDecision({ app, window, focus, text }, config);

  if (isObject(clone.normalized)) {
    clone.normalized.privacyDecision = decision;
  }

  const withWindowPolicy = applyVisibleWindowPolicy(clone, config);
  if (decision.action === "rich") {
    return withWindowPolicy;
  }
  return stripRichContext(withWindowPolicy, decision);
}

function applyVisibleWindowPolicy(snapshot, config) {
  const clone = structuredCloneCompat(snapshot);
  if (isObject(clone.normalized) && Array.isArray(clone.normalized.visibleWindows)) {
    clone.normalized.visibleWindows = clone.normalized.visibleWindows.map((window) =>
      applySingleVisibleWindowPolicy(window, config));
  }
  return clone;
}

function applySingleVisibleWindowPolicy(window, config) {
  if (!isObject(window)) return window;
  const app = compactObject({
    name: window.ownerName,
    bundleId: window.bundleId,
    pid: window.ownerPid,
  });
  const decision = privacyDecision({
    app,
    window: { title: window.title },
    text: { excerpts: [] },
  }, config);
  if (decision.action === "rich" && decision.redactTitle !== true) return window;
  const next = { ...window };
  if (typeof next.title === "string") next.title = "[redacted-title]";
  next.privacyDecision = privacySummary(decision);
  return next;
}

function stripRichContext(snapshot, decision) {
  const clone = structuredCloneCompat(snapshot);
  const label = decision.action === "disabled" ? "disabled" : "metadata-only";
  const normalized = isObject(clone.normalized) ? clone.normalized : {};
  const app = isObject(normalized.app) ? normalized.app : {};
  const bundleId = typeof app.bundleId === "string" ? app.bundleId : undefined;
  const redactTitle = decision.action === "disabled" || decision.redactTitle === true;
  const redactUrl = decision.action === "disabled" || decision.redactUrl === true;

  if (isObject(clone.raw) && isObject(clone.raw.frontmost)) {
    clone.raw.frontmost.ax = `[${label}]`;
  }

  if (isObject(clone.normalized)) {
    clone.normalized.privacyDecision = decision;
    clone.normalized.text = {
      captureEnabled: false,
      excerpts: [],
      totalChars: 0,
      sourceCount: 0,
      truncated: false,
      policy: label,
    };
    clone.normalized.focus = stripElementRichFields(clone.normalized.focus, { redactTitle, redactUrl });
    clone.normalized.window = stripElementRichFields(clone.normalized.window, { redactTitle, redactUrl });
    clone.normalized.visibleWindows = stripVisibleWindowTitles(clone.normalized.visibleWindows, {
      bundleId,
      redactTitle,
    });
  }

  if (isObject(clone.raw)) {
    clone.raw.visibleWindows = stripVisibleWindowTitles(clone.raw.visibleWindows, { bundleId, redactTitle });
  }
  return clone;
}

function stripElementRichFields(value, opts = {}) {
  if (!isObject(value)) return value;
  const next = { ...value };
  delete next.value;
  delete next.visibleText;
  delete next.selectedText;
  delete next.description;
  delete next.help;
  delete next.children;
  if (opts.redactTitle && typeof next.title === "string") {
    next.title = "[redacted-title]";
  }
  if (opts.redactUrl) {
    delete next.url;
    delete next.document;
  }
  return next;
}

function stripVisibleWindowTitles(value, opts = {}) {
  if (!Array.isArray(value) || !opts.redactTitle) return value;
  return value.map((window) => {
    if (!isObject(window)) return window;
    if (opts.bundleId && window.bundleId !== opts.bundleId) return window;
    return { ...window, title: typeof window.title === "string" ? "[redacted-title]" : window.title };
  });
}

function redactSnapshot(snapshot) {
  const stats = { count: 0 };
  const value = redactValue(snapshot, stats);
  return { value, count: stats.count };
}

function redactValue(value, stats) {
  if (typeof value === "string") return redactString(value, stats);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, stats));
  if (isObject(value)) {
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = redactValue(child, stats);
    }
    return next;
  }
  return value;
}

function redactString(value, stats) {
  let output = value;
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{24,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    /\b(?:[A-Fa-f0-9]{40,}|[A-Za-z0-9+/=_-]{48,})\b/g,
  ];

  for (const pattern of patterns) {
    output = output.replace(pattern, () => {
      stats.count += 1;
      return "[REDACTED_SECRET]";
    });
  }
  return output;
}

function loadPrivacyDomainIndex() {
  const index = new Map();
  const manifestPath = join(privacyListsDir, "manifest.json");
  if (!existsSync(manifestPath)) return index;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return index;
  }
  if (!isObject(manifest.lists)) return index;

  for (const [category, list] of Object.entries(manifest.lists)) {
    if (!PRIVACY_CATEGORY_IDS.has(category) || !isObject(list) || list.kind !== "domain-list") continue;
    if (typeof list.file !== "string" || list.file.length === 0) continue;
    const listPath = join(privacyListsDir, basename(list.file));
    if (!existsSync(listPath)) continue;

    let text;
    try {
      text = readFileSync(listPath, "utf8");
    } catch {
      continue;
    }

    for (const domain of parseDomainList(text)) {
      if (!index.has(domain)) {
        index.set(domain, compactObject({
          category,
          listFile: basename(list.file),
          sourceName: typeof list.sourceName === "string" ? list.sourceName : undefined,
          sourceUrl: typeof list.sourceUrl === "string" ? list.sourceUrl : undefined,
          policyListVersion: typeof manifest.version === "string" ? manifest.version : undefined,
        }));
      }
    }
  }

  return index;
}

function parseDomainList(text) {
  const domains = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const domain = normalizeDomain(trimmed);
    if (domain && domain.includes(".") && /^[a-z0-9.-]+$/.test(domain)) {
      domains.push(domain);
    }
  }
  return domains;
}

function privacyDecision(input = {}, config) {
  const app = isObject(input.app) ? input.app : {};
  const window = isObject(input.window) ? input.window : {};
  const focus = isObject(input.focus) ? input.focus : {};
  const text = isObject(input.text) ? input.text : {};
  const matchedRules = [];
  const domainContext = extractDomainContext({ app, window, focus, text });
  const surfaceDomain = domainContext.surfaceDomain?.domain;

  const policy = normalizePrivacyPolicy(config.privacyPolicy);
  const bundleId = typeof app.bundleId === "string" ? app.bundleId : undefined;
  const candidates = [];
  const appRule = lookupPrivacyRule(policy.apps, bundleId);
  if (appRule) {
    matchedRules.push({
      kind: "app",
      value: bundleId,
      action: appRule.action,
    });
    candidates.push({
      action: appRule.action,
      reason: "app-policy",
      redactTitle: appRule.action === "disabled" || isSecretManagementApp(app, window),
      redactUrl: appRule.action === "disabled" || isSecretManagementApp(app, window),
    });
  }

  const categoryMatches = classifyCategories({ app, window, domain: surfaceDomain });
  if (categoryMatches.length > 0) {
    const categoryDecisions = categoryMatches.map((match) => ({
      match,
      rule: lookupPrivacyRule(policy.categories, match.category) ?? { action: "rich" },
    }));
    matchedRules.push(...categoryDecisions.map(({ match, rule }) =>
      compactObject({
        kind: "category",
        category: match.category,
        value: surfaceDomain,
        action: rule.action,
        matchedDomain: match.matchedDomain,
        listFile: match.listFile,
        sourceName: match.sourceName,
      })));
    candidates.push(...categoryDecisions.map(({ match, rule }) => ({
      action: rule.action,
      reason: "category-policy",
      category: match.category,
      categories: categoryMatches.map((item) => item.category),
      redactTitle: rule.action !== "rich",
      redactUrl: rule.action !== "rich",
      redactDomain: rule.action !== "rich",
    })));
  }

  const bundleIdText = String(app.bundleId ?? "").toLowerCase();
  if (bundleIdText.includes("loginwindow")) {
    matchedRules.push({ kind: "system", reason: "system-secure-surface", action: "metadata_only" });
    candidates.push({
      action: "metadata_only",
      reason: "system-secure-surface",
      redactTitle: true,
      redactUrl: true,
      redactDomain: true,
    });
  }

  const domainRule = lookupDomainRule(policy.domains, surfaceDomain);
  if (domainRule) {
    matchedRules.unshift({
      kind: "domain",
      value: surfaceDomain,
      action: domainRule.action,
    });
    return makePrivacyDecision(domainRule.action, matchedRules, {
      reason: "domain-policy",
      domainContext,
      redactTitle: domainRule.action !== "rich",
      redactUrl: domainRule.action !== "rich",
      redactDomain: domainRule.action !== "rich",
    });
  }

  const selected = selectStrongestPrivacyCandidate(candidates);
  return makePrivacyDecision(selected?.action ?? "rich", matchedRules, {
    ...selected,
    domainContext,
  });
}

function selectStrongestPrivacyCandidate(candidates) {
  return candidates
    .filter((candidate) => isObject(candidate) && PRIVACY_ACTIONS.has(candidate.action))
    .sort((a, b) => PRIVACY_ACTION_RANK[b.action] - PRIVACY_ACTION_RANK[a.action])[0];
}

function makePrivacyDecision(action, matchedRules, opts = {}) {
  const isRich = action === "rich";
  return compactObject({
    action,
    mode: action === "rich" ? "captured" : action === "disabled" ? "disabled" : "metadata-only",
    policyVersion: PRIVACY_POLICY_VERSION,
    reason: opts.reason,
    domain: isRich ? opts.domainContext?.surfaceDomain?.domain : undefined,
    domainSource: isRich ? opts.domainContext?.surfaceDomain?.source : undefined,
    mentionedDomains: isRich && opts.domainContext?.mentionedDomains?.length ? opts.domainContext.mentionedDomains : undefined,
    category: opts.category,
    categories: Array.isArray(opts.categories) && opts.categories.length > 0 ? opts.categories : undefined,
    redactTitle: opts.redactTitle === true || !isRich ? true : undefined,
    redactUrl: opts.redactUrl === true || !isRich ? true : undefined,
    redactDomain: opts.redactDomain === true || !isRich ? true : undefined,
    matchedRules: sanitizeMatchedRulesForAction(matchedRules, action),
  });
}

function sanitizeMatchedRulesForAction(rules, action) {
  if (!Array.isArray(rules)) return [];
  if (action === "rich") return rules;
  return rules.map((rule) => {
    if (!isObject(rule)) return rule;
    const next = {
      kind: rule.kind,
      category: rule.category,
      action: rule.action,
      reason: rule.reason,
    };
    if (rule.kind === "app" || rule.kind === "system" || rule.kind === "global") {
      next.value = rule.value;
    }
    return compactObject(next);
  });
}

function lookupPrivacyRule(rules, rawKey) {
  if (!rawKey || !isObject(rules)) return undefined;
  const key = String(rawKey).toLowerCase();
  for (const [candidate, rule] of Object.entries(rules)) {
    if (String(candidate).toLowerCase() === key && isObject(rule) && PRIVACY_ACTIONS.has(rule.action)) {
      return rule;
    }
  }
  return undefined;
}

function lookupDomainRule(rules, rawDomain) {
  if (!rawDomain || !isObject(rules)) return undefined;
  const domain = String(rawDomain).toLowerCase();
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join(".");
    const rule = lookupPrivacyRule(rules, candidate);
    if (rule) return rule;
  }
  return undefined;
}

function extractDomainContext({ app, window, focus, text }) {
  app = isObject(app) ? app : {};
  window = isObject(window) ? window : {};
  focus = isObject(focus) ? focus : {};
  text = isObject(text) ? text : {};
  const surfaceDomain = extractSurfaceDomain({ app, window, focus });
  return compactObject({
    surfaceDomain,
    mentionedDomains: collectMentionedDomains({ window, text }, surfaceDomain?.domain),
  });
}

function extractSurfaceDomain({ app, window, focus }) {
  const candidates = [
    { source: "window-url", value: window.url },
    { source: "window-document", value: window.document },
    { source: "focus-url", value: focus?.url },
    { source: "focus-document", value: focus?.document },
  ];

  for (const candidate of candidates) {
    const parsed = parseHttpUrlDomain(candidate.value);
    if (parsed) {
      return {
        domain: parsed.domain,
        source: candidate.source,
      };
    }
  }

  if (typeof window.title === "string") {
    const parsed = parseExplicitHttpUrlFromText(window.title);
    if (parsed) {
      return {
        domain: parsed.domain,
        source: "window-title-url",
      };
    }
  }

  const browserTitleDomain = extractBrowserTitleDomain(app, window.title);
  if (browserTitleDomain) {
    return {
      domain: browserTitleDomain,
      source: "browser-title-domain",
    };
  }
  return undefined;
}

function extractBrowserTitleDomain(app, title) {
  if (!isBrowserApp(app) || typeof title !== "string") return undefined;
  const withoutParenthetical = title.replace(/\([^)]*\)/g, " ");
  const matches = withoutParenthetical.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/giu);
  for (const match of matches) {
    const domain = normalizeWebsiteDomain(match[0]);
    if (domain) return domain;
  }
  return undefined;
}

function isBrowserApp(app) {
  const bundleId = String(app?.bundleId ?? "").toLowerCase();
  const name = String(app?.name ?? "").toLowerCase();
  return bundleId === "com.google.chrome"
    || bundleId === "com.google.chrome.canary"
    || bundleId === "com.apple.safari"
    || bundleId === "org.mozilla.firefox"
    || bundleId === "com.brave.browser"
    || bundleId === "com.vivaldi.vivaldi"
    || bundleId === "company.thebrowser.browser"
    || bundleId === "com.microsoft.edgemac"
    || name.includes("chrome")
    || name.includes("safari")
    || name.includes("firefox")
    || name.includes("brave")
    || name.includes("vivaldi")
    || name === "arc"
    || name.includes("edge");
}

function collectMentionedDomains({ window, text }, surfaceDomain) {
  const domains = new Map();
  const add = (domain, source) => {
    if (!domain || domain === surfaceDomain || domains.has(domain)) return;
    domains.set(domain, { domain, source });
  };

  if (typeof window.title === "string") {
    for (const parsed of extractExplicitHttpUrls(window.title)) add(parsed.domain, "window-title-url");
  }
  if (Array.isArray(text.excerpts)) {
    for (const value of text.excerpts) {
      if (typeof value !== "string") continue;
      for (const parsed of extractExplicitHttpUrls(value)) add(parsed.domain, "text-url");
    }
  }
  return [...domains.values()].slice(0, 16);
}

function parseExplicitHttpUrlFromText(value) {
  return extractExplicitHttpUrls(value)[0];
}

function extractExplicitHttpUrls(value) {
  if (typeof value !== "string") return [];
  const matches = value.matchAll(/\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#][^\s"'<>]*)?/giu);
  const domains = [];
  for (const match of matches) {
    const domain = normalizeWebsiteDomain(match[0]);
    if (domain) domains.push({ domain, raw: match[0] });
  }
  return domains;
}

function parseHttpUrlDomain(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^https?:\/\//iu.test(trimmed)) return undefined;
  const domain = normalizeWebsiteDomain(trimmed);
  return domain ? { domain } : undefined;
}

function normalizeDomain(value) {
  return String(value)
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "")
    .replace(/^www\./, "");
}

function normalizeWebsiteDomain(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return undefined;

  let hostname;
  try {
    hostname = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    hostname = trimmed.split(/[/?#]/, 1)[0].replace(/:\d+$/u, "");
  }

  const domain = normalizeDomain(hostname);
  if (!isValidDomain(domain)) return undefined;
  return domain;
}

function isValidDomain(domain) {
  if (typeof domain !== "string" || domain.length < 3 || domain.length > 253) return false;
  if (!domain.includes(".") || domain.includes("..")) return false;
  if (!/^[a-z0-9.-]+$/u.test(domain)) return false;
  return domain.split(".").every((label) =>
    label.length > 0
    && label.length <= 63
    && !label.startsWith("-")
    && !label.endsWith("-")
  );
}

function classifyCategory({ app, window, domain }) {
  return classifyCategories({ app, window, domain })[0];
}

function classifyCategories({ app, window, domain }) {
  const matches = [];
  const seen = new Set();
  const add = (match) => {
    if (!match?.category || seen.has(match.category)) return;
    seen.add(match.category);
    matches.push(match);
  };

  if (isPrivateBrowsingSurface(window)) {
    add({ category: "private_browsing", sourceName: "browser-mode-heuristic" });
  }
  if (domain) {
    const domainMatch = lookupCategoryDomain(domain);
    if (domainMatch) add(domainMatch);
  }
  return matches;
}

function lookupCategoryDomain(rawDomain) {
  if (!rawDomain || CATEGORY_DOMAIN_INDEX.size === 0) return undefined;
  const domain = normalizeDomain(rawDomain);
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join(".");
    const match = CATEGORY_DOMAIN_INDEX.get(candidate);
    if (match) {
      return {
        ...match,
        matchedDomain: candidate,
      };
    }
  }
  return undefined;
}

function isSecretManagementApp(app, window) {
  const appName = String(app.name ?? "").toLowerCase();
  const bundleId = String(app.bundleId ?? "").toLowerCase();
  const title = String(window.title ?? "").toLowerCase();
  return appName.includes("1password")
    || appName.includes("bitwarden")
    || appName.includes("lastpass")
    || appName.includes("dashlane")
    || appName.includes("password")
    || bundleId.includes("1password")
    || bundleId.includes("bitwarden")
    || bundleId.includes("lastpass")
    || bundleId.includes("dashlane")
    || bundleId.includes("password")
    || title.includes("password manager");
}

function isPrivateBrowsingSurface(window) {
  const title = String(window?.title ?? "").toLowerCase();
  return title.includes("private browsing") || title.includes("incognito");
}

function presenceStateForSnapshot(snapshot, opts = {}) {
  const normalized = isObject(snapshot?.normalized) ? snapshot.normalized : {};
  return presenceFromSnapshot({
    session: isObject(normalized.session) ? normalized.session : {},
    idle: isObject(normalized.idle) ? normalized.idle : {},
    idleThresholdSeconds: opts.idleThresholdSeconds,
    afkThresholdSeconds: opts.afkThresholdSeconds,
  });
}

function publicPresenceState(state) {
  return state === "screen_locked" ? "locked" : state;
}

function presenceFromSnapshot({ session, idle, idleThresholdSeconds, afkThresholdSeconds }) {
  if (session.screenLocked === true) return "screen_locked";
  const seconds = typeof idle.seconds === "number" ? idle.seconds : undefined;
  if (seconds !== undefined && seconds >= afkThresholdSeconds) return "afk";
  if (seconds !== undefined && seconds >= idleThresholdSeconds) return "idle";
  return "active";
}

function summarizeVisibleWindows(windows) {
  return windows.slice(0, 24).map((window) => compactObject({
    windowId: window.windowId,
    bundleId: window.bundleId,
    ownerName: window.ownerName,
    title: window.title,
    displayId: window.displayId,
    bounds: window.bounds,
    layer: window.layer,
  }));
}

async function publishProfile(profile, context, opts = {}) {
  if (opts.log) {
    console.log(JSON.stringify({ type: "macos-ax.profile", profile }));
  }
  await updateConnectorState(context, (state) => ({
    ...state,
    version: 1,
    lastProfile: profile,
    updatedAt: Date.now(),
  }));
}

async function publishContextEvent(profile, context, opts = {}) {
  const guard = opts.guard ?? context.guard;
  if (typeof guard?.writeEvent !== "function") {
    throw new Error("macos-ax requires guard.writeEvent to publish desktop.context events");
  }
  const aggregate = await externalizeLargeContents(profile.aggregate, guard);
  const event = buildDesktopContextEvent(aggregate);
  if (!event) return undefined;
  const result = await guard.writeEvent(event);
  await opts.onContextEvent?.({ event, result, profile });
  return { event, result };
}

async function externalizeLargeContents(aggregate, guard) {
  if (!isObject(aggregate) || !isObject(aggregate.contents)) return aggregate;
  const largeEntries = Object.entries(aggregate.contents)
    .filter(([, content]) => isObject(content)
      && typeof content.text === "string"
      && content.text.length > INLINE_CONTENT_TEXT_CHARS);
  if (largeEntries.length === 0) return aggregate;
  if (typeof guard?.writeTextBlob !== "function") {
    throw new Error("macos-ax requires guard.writeTextBlob for large desktop context text");
  }

  const next = structuredCloneCompat(aggregate);
  const writes = new Map();
  for (const [contentId, content] of largeEntries) {
    const text = content.text;
    let pending = writes.get(text);
    if (!pending) {
      pending = guard.writeTextBlob({
        text,
        mediaType: "text/plain; charset=utf-8",
      });
      writes.set(text, pending);
    }
    const result = await pending;
    if (!isObject(result?.ref)) {
      throw new Error("macos-ax large desktop context text blob did not return a content ref");
    }
    next.contents[contentId] = {
      hash: content.hash,
      chars: Number.isFinite(content.chars) ? content.chars : text.length,
      preview: text.slice(0, BLOB_CONTENT_PREVIEW_CHARS),
      contentRef: result.ref,
    };
  }
  return next;
}

async function publishPresenceSegments(segments, context, opts = {}) {
  if (opts.writeContextEvents !== true || !Array.isArray(segments) || segments.length === 0) return [];
  const guard = opts.guard ?? context.guard;
  if (typeof guard?.writeEvent !== "function") {
    throw new Error("macos-ax requires guard.writeEvent to publish desktop.presence events");
  }
  const results = [];
  for (const segment of segments) {
    const event = buildDesktopPresenceEvent(segment);
    if (!event) continue;
    const result = await guard.writeEvent(event);
    results.push({ event, result });
    await opts.onPresenceEvent?.({ event, result, segment });
  }
  return results;
}

async function recoverOpenPresenceSegment(context, opts = {}) {
  if (opts.writeContextEvents !== true) return undefined;
  const state = await readConnectorState(context);
  const open = normalizePresenceOpenCursor(state.presence?.open);
  if (!open) return undefined;
  const segment = presenceSegmentFromOpenCursor(open, {
    recovered: true,
    endReason: typeof opts.recoveryEndReason === "string"
      ? opts.recoveryEndReason
      : "connector-restart",
  });
  if (!segment) {
    await clearPresenceOpen(context, opts);
    return undefined;
  }
  const results = await publishPresenceSegments([segment], context, opts);
  if (results.length > 0) {
    await clearPresenceOpen(context, opts);
  }
  return results[0];
}

async function checkpointPresenceOpen(profiler, context, opts = {}) {
  if (opts.writeContextEvents !== true) return undefined;
  const open = profiler.presenceOpenCursor();
  if (!open) return undefined;
  return setPresenceOpen(context, open);
}

async function clearPresenceOpen(context, opts = {}) {
  if (opts.writeContextEvents !== true) return undefined;
  return setPresenceOpen(context, undefined);
}

async function setPresenceOpen(context, open) {
  return updateConnectorState(context, (state) => {
    const presence = isObject(state.presence) ? { ...state.presence } : {};
    if (open) {
      presence.open = {
        ...open,
        updatedAt: Date.now(),
      };
    } else {
      delete presence.open;
    }
    const next = {
      ...state,
      version: 1,
      updatedAt: Date.now(),
    };
    if (Object.keys(presence).length > 0) {
      next.presence = presence;
    } else {
      delete next.presence;
    }
    return next;
  });
}

async function readConnectorState(context) {
  if (typeof context.state?.get !== "function") return {};
  const value = await context.state.get();
  return isObject(value) ? value : {};
}

async function updateConnectorState(context, updater) {
  if (typeof context.state?.set !== "function") return undefined;
  const current = await readConnectorState(context);
  const next = updater(current);
  await context.state.set(next);
  return next;
}

function normalizePresenceOpenCursor(value) {
  if (!isObject(value)) return undefined;
  if (value.schema !== "macos-ax.presence.open.v1") return undefined;
  if (!["active", "idle", "afk", "locked"].includes(value.state)) return undefined;
  const startedAt = Number(value.startedAt);
  const lastObservedAt = Number(value.lastObservedAt);
  const lastIntervalMs = readPositiveNumber(value.lastIntervalMs, INTERNAL_DEFAULTS.intervalMs);
  const sampleCount = Math.max(1, Math.floor(readPositiveNumber(value.sampleCount, 1)));
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastObservedAt) || lastObservedAt < startedAt) {
    return undefined;
  }
  return {
    schema: value.schema,
    platform: value.platform === "macos" ? value.platform : "macos",
    state: value.state,
    startedAt,
    lastObservedAt,
    lastIntervalMs,
    sampleCount,
    presenceModel: isObject(value.presenceModel) ? value.presenceModel : {
      source: "hid-any-input",
      idleThresholdSeconds: DEFAULTS["idle-threshold-seconds"],
      afkThresholdSeconds: DEFAULTS["afk-threshold-seconds"],
    },
  };
}

function presenceSegmentFromOpenCursor(open, opts = {}) {
  const endedAt = open.lastObservedAt + open.lastIntervalMs;
  if (!Number.isFinite(endedAt) || endedAt <= open.startedAt) return undefined;
  return {
    schema: "desktop.presence.segment.v0",
    recovered: opts.recovered === true ? true : undefined,
    endReason: typeof opts.endReason === "string" ? opts.endReason : undefined,
    platform: "macos",
    startedAt: isoTimestamp(open.startedAt),
    endedAt: isoTimestamp(endedAt),
    durationMs: Math.max(0, endedAt - open.startedAt),
    sampleCount: open.sampleCount,
    presenceModel: open.presenceModel,
    state: open.state,
  };
}

class ContextWindowDeadlineError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "ContextWindowDeadlineError";
    this.hadSamples = opts.hadSamples === true;
  }
}

async function setWarningSafely(context, warning) {
  try {
    await context.warnings?.set?.(warning);
  } catch {
    // Warning persistence must not stop desktop context capture.
  }
}

async function clearWarningSafely(context, key) {
  try {
    await context.warnings?.clear?.(key);
  } catch {
    // Warning persistence must not stop desktop context capture.
  }
}

async function appendJsonlLine(path, line) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`);
}

function spawnHelper(args, opts = {}) {
  const hasBinary = existsSync(helperBinaryPath);
  const command = hasBinary ? helperBinaryPath : "swift";
  const finalArgs = hasBinary ? args : [helperSourcePath, ...args];
  const spawnImpl = opts.spawnImpl ?? spawn;
  if (!hasBinary) {
    mkdirSync(swiftModuleCachePath, { recursive: true });
  }
  const child = spawnImpl(command, finalArgs, {
    cwd: packageDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: process.env.CLANG_MODULE_CACHE_PATH ?? swiftModuleCachePath,
    },
  });
  child.axHelperUsedSwiftFallback = !hasBinary;
  return child;
}

function helperSpawnErrorMessage(err, child) {
  if (child?.axHelperUsedSwiftFallback && err?.code === "ENOENT") {
    return "AX helper binary is missing and Swift fallback is unavailable. Production packages must include bin/ax-helper.";
  }
  return err?.message || String(err);
}

async function runHelperJson(args, timeoutMs = 10_000) {
  return new Promise((resolveResult) => {
    const child = spawnHelper(args);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolveResult({ ok: false, error: "AX helper timed out." });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolveResult({ ok: false, error: helperSpawnErrorMessage(err, child) });
    });
    child.on("close", () => {
      clearTimeout(timeout);
      const line = stdout.trim().split("\n").find(Boolean);
      if (!line) {
        resolveResult({ ok: false, error: stderr.trim() || "AX helper produced no output." });
        return;
      }
      try {
        resolveResult({ ok: true, value: JSON.parse(line) });
      } catch (err) {
        resolveResult({ ok: false, error: `AX helper produced invalid JSON: ${err.message}` });
      }
    });
  });
}

async function consumeJsonLines(child, onLine) {
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    child.stdout.on("data", async (chunk) => {
      child.stdout.pause();
      try {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          await onLine({ line, value: JSON.parse(line) });
        }
        child.stdout.resume();
      } catch (err) {
        child.kill("SIGTERM");
        rejectPromise(err);
      }
    });
    child.on("error", (err) => rejectPromise(new Error(helperSpawnErrorMessage(err, child))));
    child.on("close", (code, signal) => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGKILL") {
        resolvePromise();
      } else {
        rejectPromise(new Error(stderr.trim() || `AX helper exited with code ${code}`));
      }
    });
  });
}

function readSnapshotTimestamp(snapshot) {
  const ts = snapshot?.timestamp ?? snapshot?.normalized?.timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
}

function summarize(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    total,
    avg: Math.round(total / sorted.length),
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function dominantApps(aggregate) {
  const spansById = new Map((aggregate.attentionSpans ?? []).map((span) => [span.id, span]));
  const counts = new Map();
  for (const observation of aggregate.observations ?? []) {
    const span = spansById.get(observation.attentionSpanId);
    if (span?.privacy?.action === "disabled") continue;
    const key = span?.app?.bundleId || span?.app?.name || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + (observation.sampleCount ?? 1));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([key, count]) => ({ key, count }));
}

function byteLengthJSON(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stableJSONString(value) {
  if (!isObject(value)) return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined && child !== null),
  );
}

function structuredCloneCompat(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function readPositiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function noopWarnings() {
  return {
    async set() {},
    async clear() {},
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") opts.profile = true;
    else if (arg === "--seconds") opts.seconds = Number(argv[++i]);
    else if (arg === "--interval-ms") opts.intervalMs = Number(argv[++i]);
    else if (arg === "--profile-window-ms") opts.profileWindowMs = Number(argv[++i]);
    else if (arg === "--ax-timeout-ms") opts.axTimeoutMs = Number(argv[++i]);
    else if (arg === "--snapshot-budget-ms") opts.snapshotBudgetMs = Number(argv[++i]);
    else if (arg === "--idle-threshold-seconds") opts.idleThresholdSeconds = Number(argv[++i]);
    else if (arg === "--afk-threshold-seconds") opts.afkThresholdSeconds = Number(argv[++i]);
    else if (arg === "--write-profiles") opts.writeProfiles = argv[++i];
    else if (arg === "--write-snapshots") opts.writeSnapshots = argv[++i];
    else if (arg === "--write-aggregates") opts.writeAggregates = argv[++i];
    else if (arg === "--replay-snapshots") opts.replaySnapshots = argv[++i];
    else if (arg === "--include-text-in-profiles") opts.includeTextInProfiles = true;
    else if (arg === "--stats-only") opts.statsOnly = true;
    else if (arg === "--print-profiles") opts.printProfiles = true;
    else if (arg === "--verbose-profiles") opts.verboseProfiles = true;
    else if (arg === "--quiet") opts.quiet = true;
  }
  return opts;
}

function printUsage() {
  console.error([
    "Usage:",
    "  node index.mjs --profile [--seconds 60] [--interval-ms 1000] [--quiet]",
    "  node index.mjs --profile --write-snapshots /tmp/macos-ax-snapshots.jsonl",
    "  node index.mjs --profile --write-profiles /tmp/macos-ax-profiles.jsonl",
    "  node index.mjs --replay-snapshots /tmp/macos-ax-snapshots.jsonl --write-aggregates /tmp/macos-ax-aggregates.jsonl",
    "  node index.mjs --profile --write-profiles /tmp/macos-ax-profiles.jsonl --stats-only",
    "  node index.mjs --profile --idle-threshold-seconds 15 --afk-threshold-seconds 60",
    "  node index.mjs --profile --ax-timeout-ms 500 --snapshot-budget-ms 850",
    "  node index.mjs --profile --verbose-profiles",
  ].join("\n"));
}

function isDirectRun() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export const __test__ = {
  decidePrivacy(input, config = {}) {
    return privacyDecision(input, normalizeConfig(config));
  },
  classifyCategory(input) {
    return classifyCategory(input);
  },
  classifyCategories(input) {
    return classifyCategories(input);
  },
  extractDomainContext(input) {
    return extractDomainContext(input);
  },
  applyCapturePolicy(snapshot, config = {}) {
    return applyCapturePolicy(snapshot, normalizeConfig(config));
  },
  buildContextAggregate(snapshots, config = {}, aggregateOpts = {}) {
    const normalizedConfig = normalizeConfig(config);
    const redacted = snapshots.map((snapshot) => applyCapturePolicy(snapshot, normalizedConfig));
    return buildContextAggregateV0(redacted, {
      ...aggregateOpts,
      idleThresholdSeconds: normalizedConfig["idle-threshold-seconds"],
      afkThresholdSeconds: normalizedConfig["afk-threshold-seconds"],
    });
  },
  buildDesktopContextEvent,
  buildDesktopPresenceEvent,
  runDesktopContextConnector,
  normalizeWebsiteDomain,
  loadedCategoryDomainCount() {
    return CATEGORY_DOMAIN_INDEX.size;
  },
  privacyCategories() {
    return PRIVACY_CATEGORIES.map((category) => ({ ...category }));
  },
  normalizeConfig,
};

if (isDirectRun()) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (!opts.profile && !opts.replaySnapshots) {
    printUsage();
    process.exitCode = 1;
  } else {
    const collect = opts.replaySnapshots ? replaySnapshotsForCli : collectProfileForCli;
    collect(opts)
      .then((profiles) => {
        const printProfiles = opts.printProfiles === true || (!opts.writeProfiles && opts.quiet !== true);
        const summary = {
          type: "macos-ax.profile-summary",
          profileCount: profiles.length,
          replaySnapshots: opts.replaySnapshots ? resolve(opts.replaySnapshots) : undefined,
          writeProfiles: opts.writeProfiles ? resolve(opts.writeProfiles) : undefined,
          writeAggregates: opts.writeAggregates ? resolve(opts.writeAggregates) : undefined,
          writeSnapshots: opts.writeSnapshots ? resolve(opts.writeSnapshots) : undefined,
          includeTextInProfiles: opts.includeTextInProfiles === true
            || (Boolean(opts.writeProfiles) && opts.statsOnly !== true),
          ...(printProfiles ? { profiles } : {}),
        };
        if (opts.quiet) {
          console.log(JSON.stringify({
            type: summary.type,
            profileCount: summary.profileCount,
            writeProfiles: summary.writeProfiles,
            writeAggregates: summary.writeAggregates,
          }));
        } else {
          console.log(JSON.stringify(summary, null, 2));
        }
      })
      .catch((err) => {
        console.error(err?.stack || err?.message || String(err));
        process.exitCode = 1;
      });
  }
}
