import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import connector, { __test__ } from "./index.mjs";

function spawnSnapshots(snapshots) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal = "SIGTERM") => {
      child.killed = true;
      setImmediate(() => child.emit("close", null, signal));
      return true;
    };
    setImmediate(() => {
      for (const snapshot of snapshots) {
        child.stdout.write(`${JSON.stringify(snapshot)}\n`);
      }
      child.stdout.end();
      setImmediate(() => child.emit("close", 0, null));
    });
    return child;
  };
}

function spawnSnapshotsThenSilence(snapshots) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal = "SIGTERM") => {
      child.killed = true;
      setImmediate(() => child.emit("close", null, signal));
      return true;
    };
    setImmediate(() => {
      for (const snapshot of snapshots) {
        child.stdout.write(`${JSON.stringify(snapshot)}\n`);
      }
    });
    return child;
  };
}

function spawnSequence(spawnImpls) {
  let callCount = 0;
  const spawnImpl = (...args) => {
    const next = spawnImpls[callCount];
    assert.ok(next, `unexpected helper spawn ${callCount + 1}`);
    callCount += 1;
    return next(...args);
  };
  spawnImpl.callCount = () => callCount;
  return spawnImpl;
}

function decisionForUrl(url, config = {}) {
  return __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: url },
    text: { excerpts: [url] },
  }, config);
}

test("privacy lists are loaded", () => {
  assert.ok(__test__.loadedCategoryDomainCount() > 70_000);
});

test("privacy categories only expose effective v0 categories", () => {
  assert.deepEqual(__test__.privacyCategories().map((category) => category.id), [
    "adult_content",
    "banking_finance",
    "gambling",
    "private_browsing",
    "social_media",
    "secret_management",
  ]);

  const config = __test__.normalizeConfig({
    privacyPolicy: {
      categories: {
        health_medical: { action: "disabled" },
        shopping: { action: "disabled" },
        entertainment: { action: "disabled" },
      },
    },
  });
  assert.equal(config.privacyPolicy.categories.health_medical, undefined);
  assert.equal(config.privacyPolicy.categories.shopping, undefined);
  assert.equal(config.privacyPolicy.categories.entertainment, undefined);
});

test("System Settings defaults to app-level metadata-only", () => {
  const decision = __test__.decidePrivacy({
    app: { name: "System Settings", bundleId: "com.apple.systempreferences" },
    window: { title: "Passwords" },
    text: { excerpts: ["saved password content"] },
  });

  assert.equal(decision.action, "metadata_only");
  assert.equal(decision.reason, "app-policy");
  assert.equal(decision.matchedRules[0].kind, "app");
  assert.equal(decision.matchedRules[0].value, "com.apple.systempreferences");
});

test("Lamarck release variants default to app-level metadata-only", () => {
  for (const bundleId of [
    "ai.lamarck.desktop",
    "ai.lamarck.desktop.alpha",
    "ai.lamarck.desktop.dev",
  ]) {
    const decision = __test__.decidePrivacy({
      app: { name: "Lamarck", bundleId },
      window: { title: "Personal system" },
      text: { excerpts: ["private workspace content"] },
    });

    assert.equal(decision.action, "metadata_only");
    assert.equal(decision.reason, "app-policy");
    assert.equal(decision.matchedRules[0].kind, "app");
    assert.equal(decision.matchedRules[0].value, bundleId);
  }
});

test("adult domains default to metadata-only", () => {
  const decision = decisionForUrl("https://www.pornhub.com/view_video.php");
  assert.equal(decision.action, "metadata_only");
  assert.equal(decision.category, "adult_content");
  assert.equal(decision.redactTitle, true);
  assert.equal(decision.redactUrl, true);
  assert.equal(decision.redactDomain, true);
  assert.equal(decision.domain, undefined);
  assert.equal(decision.domainSource, undefined);
  assert.equal(decision.matchedRules[0].matchedDomain, undefined);
  assert.equal(decision.matchedRules[0].listFile, undefined);
});

test("banking, secret-management, and gambling domains default to metadata-only", () => {
  const cases = [
    ["https://secure.chase.com/dashboard", "banking_finance", "chase.com"],
    ["https://pass.proton.me/u/0", "secret_management", "pass.proton.me"],
    ["https://pwpush.com/p/abc", "secret_management", "pwpush.com"],
    ["https://007win.com/login", "gambling", "007win.com"],
  ];

  for (const [url, category] of cases) {
    const decision = decisionForUrl(url);
    assert.equal(decision.action, "metadata_only", url);
    assert.equal(decision.category, category, url);
    assert.equal(decision.redactTitle, true, url);
    assert.equal(decision.redactDomain, true, url);
    assert.equal(decision.domain, undefined, url);
    assert.equal(decision.domainSource, undefined, url);
    assert.equal(decision.matchedRules[0].matchedDomain, undefined, url);
  }
});

test("browser password prompts are not special-cased as secret management", () => {
  const decision = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "Save password?", role: "AXWindow" },
    focus: { role: "AXButton", title: "Save" },
    text: { excerpts: ["Save password?"] },
  });

  assert.equal(decision.action, "rich");
  assert.equal(decision.category, undefined);
});

test("secret-management category is not inferred from app identity", () => {
  const category = __test__.classifyCategory({
    app: { name: "1Password", bundleId: "com.1password.1password" },
    window: { title: "1Password" },
    domain: undefined,
  });
  assert.equal(category, undefined);
});

test("legacy password and secret-sharing category overrides migrate to secret management", () => {
  const rich = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { url: "https://pass.proton.me/u/0" },
    text: { excerpts: [] },
  }, {
    privacyPolicy: {
      categories: {
        password_manager: { action: "rich" },
      },
    },
  });
  assert.equal(rich.action, "rich");
  assert.equal(rich.category, "secret_management");

  const disabled = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { url: "https://pwpush.com/p/abc" },
    text: { excerpts: [] },
  }, {
    privacyPolicy: {
      categories: {
        password_manager: { action: "rich" },
        secret_sharing: { action: "disabled" },
      },
    },
  });
  assert.equal(disabled.action, "disabled");
  assert.equal(disabled.category, "secret_management");
});

test("private browsing is an explicit category policy", () => {
  const decision = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "New Incognito Tab - Google Chrome (Incognito)" },
    text: { excerpts: ["private search text"] },
  });

  assert.equal(decision.action, "metadata_only");
  assert.equal(decision.reason, "category-policy");
  assert.equal(decision.category, "private_browsing");
  assert.deepEqual(decision.categories, ["private_browsing"]);
  assert.equal(decision.redactTitle, true);
  assert.equal(decision.matchedRules[0].kind, "category");
  assert.equal(decision.matchedRules[0].category, "private_browsing");
  assert.equal(decision.matchedRules[0].sourceName, undefined);

  const rich = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "New Incognito Tab - Google Chrome (Incognito)" },
    text: { excerpts: ["private search text"] },
  }, {
    privacyPolicy: {
      categories: {
        private_browsing: { action: "rich" },
      },
    },
  });
  assert.equal(rich.action, "rich");
  assert.equal(rich.category, "private_browsing");
});

test("multiple category matches use the most restrictive action", () => {
  const decision = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: {
      title: "Free Porn Videos - Google Chrome (Incognito)",
      url: "https://www.pornhub.com/view_video.php",
    },
    text: { excerpts: [] },
  }, {
    privacyPolicy: {
      categories: {
        private_browsing: { action: "rich" },
      },
    },
  });

  assert.equal(decision.action, "metadata_only");
  assert.equal(decision.category, "adult_content");
  assert.deepEqual(decision.categories, ["private_browsing", "adult_content"]);
  assert.deepEqual(decision.matchedRules.map((rule) => [rule.category, rule.action]), [
    ["private_browsing", "rich"],
    ["adult_content", "metadata_only"],
  ]);
});

test("surface domains from AX URL and document drive privacy decisions", () => {
  const finance = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "Chase Online", url: "https://secure.chase.com/dashboard" },
    text: { excerpts: [] },
  });
  assert.equal(finance.action, "metadata_only");
  assert.equal(finance.category, "banking_finance");
  assert.equal(finance.domain, undefined);
  assert.equal(finance.domainSource, undefined);
  assert.equal(finance.redactDomain, true);
  assert.equal(finance.matchedRules[0].matchedDomain, undefined);

  const adult = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "Video page" },
    focus: { role: "AXWebArea", document: "https://www.pornhub.com/view_video.php" },
    text: { excerpts: [] },
  });
  assert.equal(adult.action, "metadata_only");
  assert.equal(adult.category, "adult_content");
  assert.equal(adult.domain, undefined);
  assert.equal(adult.domainSource, undefined);
  assert.equal(adult.redactDomain, true);
});

test("mentioned domains do not drive privacy decisions", () => {
  const decision = __test__.decidePrivacy({
    app: { name: "Telegram", bundleId: "ru.keepcoder.Telegram" },
    window: { title: "Telegram Alice" },
    text: {
      excerpts: [
        "Testing chase.com as plain text should not classify the active app.",
        "Testing https://secure.chase.com/dashboard should remain only a mention.",
        "Testing https://www.pornhub.com/view_video.php should remain only a mention.",
      ],
    },
  });

  assert.equal(decision.action, "rich");
  assert.equal(decision.domain, undefined);
  assert.equal(decision.category, undefined);
  assert.deepEqual(decision.mentionedDomains, [
    { domain: "secure.chase.com", source: "text-url" },
    { domain: "pornhub.com", source: "text-url" },
  ]);
});

test("bare domain-like strings in titles are not surface domains", () => {
  const profileTitle = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "Chase Online - Google Chrome - Example User" },
    text: { excerpts: [] },
  });
  assert.equal(profileTitle.action, "rich");
  assert.equal(profileTitle.domain, undefined);
  assert.equal(profileTitle.mentionedDomains, undefined);

  const pdfTitle = __test__.decidePrivacy({
    app: { name: "Preview", bundleId: "com.apple.Preview" },
    window: { title: "-details-checking-9563.pdf" },
    text: { excerpts: [] },
  });
  assert.equal(pdfTitle.action, "rich");
  assert.equal(pdfTitle.domain, undefined);
  assert.equal(pdfTitle.mentionedDomains, undefined);
});

test("browser title domains outside profile suffix can drive category policy", () => {
  const decision = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "Credit Card, Mortgage, Banking, Auto | Chase Online | Chase.com - Google Chrome - Alice (Person 1)" },
    text: { excerpts: [] },
  });

  assert.equal(decision.action, "metadata_only");
  assert.equal(decision.category, "banking_finance");
  assert.equal(decision.redactDomain, true);
  assert.equal(decision.domain, undefined);
  assert.equal(decision.domainSource, undefined);
});

test("social media domains are classified but remain rich by default", () => {
  const category = __test__.classifyCategory({
    app: {},
    window: {},
    domain: "twitter.com",
  });
  assert.equal(category.category, "social_media");
  assert.equal(category.matchedDomain, "twitter.com");

  const decision = decisionForUrl("https://twitter.com/home");
  assert.equal(decision.action, "rich");
  assert.equal(decision.domain, "twitter.com");
});

test("domain overrides take precedence over category defaults", () => {
  const decision = decisionForUrl("https://www.pornhub.com/view_video.php", {
    privacyPolicy: {
      domains: {
        "pornhub.com": { action: "rich" },
      },
    },
  });
  assert.equal(decision.action, "rich");
  assert.equal(decision.reason, "domain-policy");
  assert.equal(decision.matchedRules[0].kind, "domain");
});

test("rich app policy does not bypass surface category protections", () => {
  const finance = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "Chase Online", url: "https://secure.chase.com/dashboard" },
    text: { excerpts: [] },
  }, {
    privacyPolicy: {
      apps: {
        "com.google.Chrome": { action: "rich" },
      },
    },
  });
  assert.equal(finance.action, "metadata_only");
  assert.equal(finance.reason, "category-policy");
  assert.equal(finance.category, "banking_finance");
  assert.deepEqual(finance.matchedRules.map((rule) => [rule.kind, rule.action, rule.category]), [
    ["app", "rich", undefined],
    ["category", "metadata_only", "banking_finance"],
  ]);

  const privateBrowsing = __test__.decidePrivacy({
    app: { name: "Chrome", bundleId: "com.google.Chrome" },
    window: { title: "New Incognito Tab - Google Chrome (Incognito)" },
    text: { excerpts: ["private search text"] },
  }, {
    privacyPolicy: {
      apps: {
        "com.google.Chrome": { action: "rich" },
      },
    },
  });
  assert.equal(privateBrowsing.action, "metadata_only");
  assert.equal(privateBrowsing.reason, "category-policy");
  assert.equal(privateBrowsing.category, "private_browsing");
});

test("explicit domain override applies after app and category candidates", () => {
  const decision = decisionForUrl("https://www.pornhub.com/view_video.php", {
    privacyPolicy: {
      apps: {
        "com.google.Chrome": { action: "metadata_only" },
      },
      domains: {
        "pornhub.com": { action: "rich" },
      },
    },
  });
  assert.equal(decision.action, "rich");
  assert.equal(decision.reason, "domain-policy");
  assert.deepEqual(decision.matchedRules.map((rule) => [rule.kind, rule.action, rule.category]), [
    ["domain", "rich", undefined],
    ["app", "metadata_only", undefined],
    ["category", "metadata_only", "adult_content"],
  ]);
});

test("domain override keys are normalized from URLs", () => {
  assert.equal(__test__.normalizeWebsiteDomain("https://www.pornhub.com/view_video.php?x=1"), "pornhub.com");
  assert.equal(__test__.normalizeWebsiteDomain("secure.chase.com/login"), "secure.chase.com");
  assert.equal(__test__.normalizeWebsiteDomain("not a domain"), undefined);

  const decision = decisionForUrl("https://www.pornhub.com/view_video.php", {
    privacyPolicy: {
      domains: {
        "https://www.pornhub.com/view_video.php?x=1": { action: "rich" },
      },
    },
  });
  assert.equal(decision.action, "rich");
  assert.equal(decision.reason, "domain-policy");
  assert.equal(decision.matchedRules[0].value, "pornhub.com");
});

test("metadata-only policy strips rich context from snapshots", () => {
  const snapshot = {
    raw: {
      frontmost: {
        ax: {
          role: "AXWindow",
          title: "Adult page",
          value: "visible sensitive text",
        },
      },
      visibleWindows: [
        { bundleId: "com.google.Chrome", title: "https://www.pornhub.com/view_video.php" },
        { bundleId: "com.apple.Terminal", title: "Terminal" },
      ],
    },
    normalized: {
      app: { name: "Chrome", bundleId: "com.google.Chrome" },
      window: {
        title: "https://www.pornhub.com/view_video.php",
        document: "https://www.pornhub.com/view_video.php?viewkey=abc123",
        value: "visible sensitive text",
      },
      focus: {
        role: "AXTextArea",
        document: "https://www.pornhub.com/view_video.php?viewkey=abc123",
        value: "visible sensitive text",
        children: [{ value: "child text" }],
      },
      text: {
        captureEnabled: true,
        excerpts: ["https://www.pornhub.com/view_video.php", "visible sensitive text"],
        totalChars: 60,
        sourceCount: 2,
      },
      visibleWindows: [
        { bundleId: "com.google.Chrome", title: "https://www.pornhub.com/view_video.php" },
        { bundleId: "com.apple.Terminal", title: "Terminal" },
      ],
    },
  };

  const filtered = __test__.applyCapturePolicy(snapshot);

  assert.equal(filtered.normalized.privacyDecision.action, "metadata_only");
  assert.equal(filtered.normalized.privacyDecision.category, "adult_content");
  assert.equal(filtered.normalized.privacyDecision.domain, undefined);
  assert.equal(filtered.normalized.privacyDecision.domainSource, undefined);
  assert.equal(filtered.normalized.privacyDecision.redactUrl, true);
  assert.equal(filtered.normalized.privacyDecision.redactDomain, true);
  assert.deepEqual(filtered.normalized.text.excerpts, []);
  assert.equal(filtered.normalized.window.title, "[redacted-title]");
  assert.equal(filtered.normalized.window.document, undefined);
  assert.equal(filtered.normalized.window.value, undefined);
  assert.equal(filtered.normalized.focus.document, undefined);
  assert.equal(filtered.normalized.focus.value, undefined);
  assert.equal(filtered.normalized.focus.children, undefined);
  assert.equal(filtered.raw.frontmost.ax, "[metadata-only]");
  assert.equal(filtered.normalized.visibleWindows[0].title, "[redacted-title]");
  assert.equal(filtered.normalized.visibleWindows[1].title, "Terminal");
});

test("app metadata-only policy redacts titles before aggregation", () => {
  const startedAt = Date.UTC(2026, 6, 6, 16, 0, 0);
  const finderSnapshot = {
    timestamp: startedAt,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
      visibleWindows: [{
        windowId: 90,
        bundleId: "com.apple.finder",
        ownerName: "Finder",
        ownerPid: 321,
        displayId: 1,
        layer: 0,
        alpha: 1,
        onscreen: true,
        title: "Tax Returns",
        bounds: { x: 0, y: 25, width: 1280, height: 704 },
      }],
    },
    normalized: {
      app: { name: "Finder", bundleId: "com.apple.finder", pid: 321 },
      window: { title: "Tax Returns", role: "AXWindow", document: "file:///Users/alice/Tax Returns" },
      focus: { role: "AXOutline", title: "Tax Returns" },
      text: { captureEnabled: true, excerpts: ["Tax Returns"], totalChars: 11, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      mouse: { x: 10, y: 20, hoveredWindowId: 90 },
      visibleWindows: [{
        windowId: 90,
        bundleId: "com.apple.finder",
        ownerName: "Finder",
        ownerPid: 321,
        displayId: 1,
        layer: 0,
        alpha: 1,
        onscreen: true,
        title: "Tax Returns",
        bounds: { x: 0, y: 25, width: 1280, height: 704 },
      }],
      permission: { accessibility: true },
    },
  };

  const aggregate = __test__.buildContextAggregate([finderSnapshot]);
  assert.equal(aggregate.attentionSpans[0].privacy.action, "metadata_only");
  assert.equal(aggregate.attentionSpans[0].privacy.reason, "app-policy");
  assert.equal(aggregate.attentionSpans[0].foregroundWindowRef, "w1");
  assert.equal(aggregate.attentionSpans[0].window, undefined);
  assert.equal(aggregate.attentionSpans[0].surface, undefined);
  assert.deepEqual(aggregate.attentionSpans[0].contentRefs, []);
  assert.equal(aggregate.windows.w1.title, "[redacted-title]");

  const legacyGlobalCaptureConfig = __test__.buildContextAggregate([finderSnapshot], {
    "capture-mode": "metadata-only",
    "capture-visible-text": false,
    privacyPolicy: {
      apps: {
        "com.apple.finder": { action: "rich" },
      },
    },
  });
  assert.equal(legacyGlobalCaptureConfig.attentionSpans[0].privacy.action, "rich");
  assert.equal(legacyGlobalCaptureConfig.attentionSpans[0].foregroundWindowRef, "w1");
  assert.equal(legacyGlobalCaptureConfig.attentionSpans[0].window, undefined);
  assert.equal(legacyGlobalCaptureConfig.windows.w1.title, "Tax Returns");
});

test("disabled policy omits attributed desktop context and keeps presence summary", () => {
  const startedAt = Date.UTC(2026, 6, 6, 16, 30, 0);
  const snapshot = {
    timestamp: startedAt,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Finder", bundleId: "com.apple.finder", pid: 321 },
      window: { title: "Tax Returns", role: "AXWindow" },
      focus: { role: "AXOutline", identifier: "sidebar" },
      text: { captureEnabled: true, excerpts: ["Tax Returns"], totalChars: 11, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 90 },
      mouse: { x: 10, y: 20, hoveredWindowId: 90 },
      visibleWindows: [{
        windowId: 90,
        bundleId: "com.apple.finder",
        ownerName: "Finder",
        ownerPid: 321,
        displayId: 1,
        layer: 0,
        alpha: 1,
        onscreen: true,
        title: "Tax Returns",
        bounds: { x: 0, y: 25, width: 1280, height: 704 },
      }],
      permission: { accessibility: true },
    },
  };

  const aggregate = __test__.buildContextAggregate([snapshot], {
    privacyPolicy: {
      apps: {
        "com.apple.finder": { action: "disabled" },
      },
    },
  });
  assert.equal(aggregate.presence.afkMs, 1000);
  assert.deepEqual(aggregate.displays, {});
  assert.deepEqual(aggregate.windows, {});
  assert.deepEqual(aggregate.attentionSpans, [{
    id: "s1",
    fromMs: 0,
    toMs: 1000,
    durationMs: 1000,
    sampleCount: 1,
    privacy: { action: "disabled" },
    contentRefs: [],
  }]);
  assert.deepEqual(aggregate.observations, [{
    fromMs: 0,
    toMs: 1000,
    durationMs: 1000,
    sampleCount: 1,
    attentionSpanId: "s1",
  }]);
  assert.deepEqual(aggregate.contents, {});

  const contextEvent = __test__.buildDesktopContextEvent(aggregate);
  assert.equal(contextEvent.payload.presence.afkMs, 1000);
  assert.deepEqual(contextEvent.payload.attentionSpans, aggregate.attentionSpans);

  const presenceEvent = __test__.buildDesktopPresenceEvent({
    schema: "desktop.presence.segment.v0",
    platform: "macos",
    state: "afk",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(startedAt + 1000).toISOString(),
    durationMs: 1000,
    sampleCount: 1,
    presenceModel: {
      source: "hid-any-input",
      idleThresholdSeconds: 15,
      afkThresholdSeconds: 60,
    },
  });
  assert.equal(presenceEvent.type, "desktop.presence");
  assert.equal(presenceEvent.payload.schema, "desktop.presence.segment.v0");
  assert.equal(presenceEvent.payload.state, "afk");
  assert.equal(presenceEvent.payload.durationMs, 1000);
});

test("disabled and rich samples share one context envelope with privacy-hidden spans", () => {
  const startedAt = Date.UTC(2026, 6, 6, 16, 40, 0);
  const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }];
  const aggregate = __test__.buildContextAggregate([
    {
      timestamp: startedAt,
      raw: { displays },
      normalized: {
        app: { name: "Finder", bundleId: "com.apple.finder", pid: 321 },
        window: { title: "Tax Returns", role: "AXWindow" },
        focus: { role: "AXOutline", identifier: "sidebar" },
        text: { captureEnabled: true, excerpts: ["Tax Returns"], totalChars: 11, sourceCount: 1 },
        session: { screenLocked: false },
        idle: { seconds: 90 },
        visibleWindows: [{
          windowId: 90,
          bundleId: "com.apple.finder",
          ownerName: "Finder",
          ownerPid: 321,
          displayId: 1,
          layer: 0,
          alpha: 1,
          onscreen: true,
          title: "Tax Returns",
          bounds: { x: 0, y: 25, width: 1280, height: 704 },
        }],
        permission: { accessibility: true },
      },
    },
    {
      timestamp: startedAt + 1000,
      raw: { displays },
      normalized: {
        app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
        window: { title: "Codex", role: "AXWindow" },
        focus: { role: "AXTextArea" },
        text: { captureEnabled: true, excerpts: ["working note"], totalChars: 12, sourceCount: 1 },
        session: { screenLocked: false },
        idle: { seconds: 0 },
        visibleWindows: [{
          windowId: 7,
          bundleId: "com.openai.codex",
          ownerName: "Codex",
          ownerPid: 123,
          displayId: 1,
          layer: 0,
          alpha: 1,
          onscreen: true,
          title: "Codex",
          bounds: { x: 0, y: 25, width: 1280, height: 704 },
        }],
        permission: { accessibility: true },
      },
    },
  ], {
    privacyPolicy: {
      apps: {
        "com.apple.finder": { action: "disabled" },
      },
    },
  });

  assert.equal(aggregate.durationMs, 2000);
  assert.deepEqual(aggregate.presence, {
    activeMs: 1000,
    idleMs: 0,
    afkMs: 1000,
    missingMs: 0,
    unattributedMs: 0,
  });
  assert.equal(aggregate.attentionSpans.length, 2);
  assert.deepEqual(aggregate.attentionSpans[0], {
    id: "s1",
    fromMs: 0,
    toMs: 1000,
    durationMs: 1000,
    sampleCount: 1,
    privacy: { action: "disabled" },
    contentRefs: [],
  });
  assert.equal(aggregate.attentionSpans[1].app.bundleId, "com.openai.codex");
  assert.equal(aggregate.attentionSpans[1].privacy.action, "rich");
  assert.deepEqual(aggregate.observations[0], {
    fromMs: 0,
    toMs: 1000,
    durationMs: 1000,
    sampleCount: 1,
    attentionSpanId: "s1",
  });
  assert.equal(aggregate.observations[1].attentionSpanId, "s2");
  assert.deepEqual(Object.keys(aggregate.windows), ["w1"]);
  assert.equal(aggregate.windows.w1.app.bundleId, "com.openai.codex");
  assert.deepEqual(Object.keys(aggregate.contents), ["c1"]);
});

test("visible window policy redacts sensitive background window titles", () => {
  const snapshot = {
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex" },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: ["working note"], totalChars: 12, sourceCount: 1 },
      visibleWindows: [
        {
          windowId: 1,
          ownerName: "Codex",
          bundleId: "com.openai.codex",
          ownerPid: 10,
          title: "Codex",
        },
        {
          windowId: 2,
          ownerName: "Google Chrome",
          bundleId: "com.google.Chrome",
          ownerPid: 20,
          title: "Credit Card, Mortgage, Banking, Auto | Chase Online | Chase.com - Google Chrome",
        },
      ],
    },
  };

  const filtered = __test__.applyCapturePolicy(snapshot);

  assert.equal(filtered.normalized.privacyDecision.action, "rich");
  assert.equal(filtered.normalized.visibleWindows[0].title, "Codex");
  assert.equal(filtered.normalized.visibleWindows[1].title, "[redacted-title]");
  assert.equal(filtered.normalized.visibleWindows[1].privacyDecision.action, "metadata_only");
  assert.equal(filtered.normalized.visibleWindows[1].privacyDecision.category, "banking_finance");
});

test("disabled visible windows are omitted from aggregate layout", () => {
  const startedAt = Date.UTC(2026, 6, 6, 16, 45, 0);
  const aggregate = __test__.buildContextAggregate([{
    timestamp: startedAt,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 10 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: ["working note"], totalChars: 12, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      visibleWindows: [
        {
          windowId: 1,
          ownerName: "Codex",
          bundleId: "com.openai.codex",
          ownerPid: 10,
          displayId: 1,
          layer: 0,
          alpha: 1,
          onscreen: true,
          title: "Codex",
          bounds: { x: 0, y: 25, width: 640, height: 704 },
        },
        {
          windowId: 2,
          ownerName: "Google Chrome",
          bundleId: "com.google.Chrome",
          ownerPid: 20,
          displayId: 1,
          layer: 0,
          alpha: 1,
          onscreen: true,
          title: "Credit Card, Mortgage, Banking, Auto | Chase Online | Chase.com - Google Chrome",
          bounds: { x: 640, y: 25, width: 640, height: 704 },
        },
      ],
      permission: { accessibility: true },
    },
  }], {
    privacyPolicy: {
      categories: {
        banking_finance: { action: "disabled" },
      },
    },
  });

  assert.equal(Object.keys(aggregate.windows).length, 1);
  assert.equal(aggregate.windows.w1.app.bundleId, "com.openai.codex");
  assert.deepEqual(aggregate.observations[0].visibleWindowStacks, { d1: ["w1"] });
  assert.equal(aggregate.observations[0].visibleWindowCount, undefined);
});

test("context aggregate separates attention spans from visible text observations", () => {
  const startedAt = Date.UTC(2026, 6, 6, 14, 0, 0);
  const chromeVisibleWindow = {
    windowId: 42,
    bundleId: "com.google.Chrome",
    ownerName: "Google Chrome",
    ownerPid: 101,
    displayId: 1,
    layer: 0,
    alpha: 1,
    onscreen: true,
    title: "Article - Google Chrome",
    bounds: { x: 0, y: 25, width: 1280, height: 704 },
  };
  const codexVisibleWindow = {
    windowId: 43,
    bundleId: "com.openai.codex",
    ownerName: "Codex",
    ownerPid: 202,
    displayId: 1,
    layer: 0,
    alpha: 1,
    onscreen: true,
    title: "Codex",
    bounds: { x: 640, y: 25, width: 640, height: 704 },
  };
  const richSnapshot = (offsetMs, text) => ({
    timestamp: startedAt + offsetMs,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 101 },
      window: {
        title: "Article - Google Chrome",
        role: "AXWindow",
        document: "https://example.com/article",
      },
      focus: { role: "AXWebArea" },
      text: { captureEnabled: true, excerpts: [text], totalChars: text.length, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      mouse: { x: 10 + offsetMs / 1000, y: 20, hoveredWindowId: 42 },
      visibleWindows: [chromeVisibleWindow],
      permission: { accessibility: true },
    },
  });
  const metadataOnlySnapshot = {
    timestamp: startedAt + 3000,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 101 },
      window: {
        title: "Adult page",
        role: "AXWindow",
        document: "https://www.pornhub.com/view_video.php",
      },
      focus: { role: "AXWebArea" },
      text: { captureEnabled: true, excerpts: ["visible sensitive text"], totalChars: 22, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      mouse: { x: 30, y: 20, hoveredWindowId: 42 },
      visibleWindows: [{ ...chromeVisibleWindow, title: "Adult page" }],
      permission: { accessibility: true },
    },
  };

  const metadataOnlySnapshot2 = JSON.parse(JSON.stringify(metadataOnlySnapshot));
  metadataOnlySnapshot2.timestamp = startedAt + 4000;
  metadataOnlySnapshot2.normalized.focus = { role: "AXButton", identifier: "confirm" };
  metadataOnlySnapshot2.normalized.mouse.x = 40;
  metadataOnlySnapshot2.normalized.visibleWindows = [
    { ...chromeVisibleWindow, title: "Adult page", bounds: { x: 0, y: 25, width: 640, height: 704 } },
    codexVisibleWindow,
  ];

  const aggregate = __test__.buildContextAggregate([
    richSnapshot(0, "aaa\nbbb\nccc"),
    richSnapshot(1000, "aaa\nbbb\nccc"),
    richSnapshot(2000, "ccc\nddd\neee"),
    metadataOnlySnapshot,
    metadataOnlySnapshot2,
  ]);

  assert.equal(aggregate.schema, "desktop.context.aggregate.v0");
  assert.equal(aggregate.sampleCount, 5);
  assert.equal(aggregate.attentionSpans.length, 3);
  assert.equal(aggregate.observations.length, 4);
  assert.equal(Object.keys(aggregate.displays).length, 1);
  assert.equal(Object.keys(aggregate.windows).length, 4);
  assert.equal(aggregate.windows.w1.app.bundleId, "com.google.Chrome");
  assert.equal(aggregate.windows.w4.app.bundleId, "com.openai.codex");
  assert.equal(aggregate.attentionSpans[0].foregroundWindowRef, "w1");
  assert.equal(aggregate.attentionSpans[0].window, undefined);
  assert.deepEqual(aggregate.attentionSpans[0].contentRefs, ["c1", "c2"]);
  assert.deepEqual(aggregate.attentionSpans[1].contentRefs, []);
  assert.deepEqual(aggregate.attentionSpans[2].contentRefs, []);
  assert.deepEqual(Object.keys(aggregate.contents), ["c1", "c2"]);
  assert.equal(aggregate.contents.c1.text, "aaa\nbbb\nccc");
  assert.equal(aggregate.contents.c2.text, "ccc\nddd\neee");
  assert.equal(aggregate.observations[0].attentionSpanId, "s1");
  assert.equal(aggregate.observations[0].contentRef, "c1");
  assert.equal(aggregate.observations[0].sampleCount, 2);
  assert.equal(aggregate.observations[1].contentRef, "c2");
  assert.equal(aggregate.observations[2].attentionSpanId, "s2");
  assert.equal(aggregate.observations[2].contentRef, undefined);
  assert.equal(aggregate.observations[2].sampleCount, 1);
  assert.deepEqual(aggregate.observations[2].visibleWindowStacks, { d1: ["w2"] });
  assert.equal(aggregate.observations[3].attentionSpanId, "s3");
  assert.equal(aggregate.observations[3].sampleCount, 1);
  assert.deepEqual(aggregate.observations[3].visibleWindowStacks, { d1: ["w3", "w4"] });
  assert.equal(aggregate.attentionSpans[1].privacy.action, "metadata_only");
  assert.equal(aggregate.attentionSpans[1].privacy.category, "adult_content");
  assert.equal(aggregate.attentionSpans[1].foregroundWindowRef, "w2");
  assert.equal(aggregate.attentionSpans[1].window, undefined);
  assert.equal(aggregate.attentionSpans[1].surface, undefined);
  assert.equal(aggregate.attentionSpans[2].privacy.action, "metadata_only");
  assert.equal(aggregate.attentionSpans[2].foregroundWindowRef, "w3");
  assert.equal(aggregate.attentionSpans[2].window, undefined);
  assert.equal(aggregate.observations[0].input.mouse.moved, true);
  assert.deepEqual(aggregate.observations[0].input.mouse.osDisplayIds, [1]);
  assert.deepEqual(aggregate.observations[0].input.mouse.osWindowIds, [42]);
  assert.deepEqual(aggregate.observations[0].capture, { accessibilityTrusted: true });
  assert.equal(aggregate.observations[0].permission, undefined);

  const event = __test__.buildDesktopContextEvent(aggregate);
  assert.equal(event.type, "desktop.context");
  assert.equal(event.startedAt, startedAt);
  assert.equal(event.endedAt, startedAt + 5000);
  assert.match(event.externalId, /^macos-ax:context:2026-07-06T14:00:00\.000Z:[a-f0-9]{16}$/u);
  assert.equal(event.payload.schema, "desktop.context.aggregate.v0");
  assert.equal(event.payload.provider, undefined);
  assert.equal(event.payload.platform, "macos");
  assert.equal(event.payload.durationMs, undefined);
  assert.equal(event.payload.sampleCount, 5);
  assert.equal(event.payload.type, undefined);
  assert.equal(event.payload.source, undefined);
  assert.equal(event.payload.startedAt, undefined);
  assert.equal(event.payload.endedAt, undefined);
  assert.equal(event.payload.attentionSpans.length, 3);
  assert.equal(event.payload.observations[0].attentionSpanId, "s1");
  assert.deepEqual(Object.keys(event.payload.contents), ["c1", "c2"]);
});

test("context aggregate records bounded sample gaps as missing capture", () => {
  const startedAt = Date.UTC(2026, 6, 6, 14, 30, 0);
  const snapshot = (offsetMs) => ({
    timestamp: startedAt + offsetMs,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: ["steady visible text"], totalChars: 19, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      visibleWindows: [],
      permission: { accessibility: true },
    },
  });

  const aggregate = __test__.buildContextAggregate([
    snapshot(0),
    snapshot(1000),
    snapshot(2000),
    snapshot(34_000),
  ], {}, {
    windowStartedAtMs: startedAt,
    windowEndedAtMs: startedAt + 30_000,
    sampleIntervalMs: 1000,
    allowTailMissing: true,
  });

  assert.equal(aggregate.startedAt, new Date(startedAt).toISOString());
  assert.equal(aggregate.endedAt, new Date(startedAt + 30_000).toISOString());
  assert.equal(aggregate.sampleCount, 3);
  assert.deepEqual(aggregate.presence, {
    activeMs: 3000,
    idleMs: 0,
    afkMs: 0,
    missingMs: 27_000,
    unattributedMs: 0,
  });
  assert.equal(aggregate.attentionSpans.length, 2);
  assert.deepEqual(aggregate.attentionSpans[1], {
    id: "s2",
    fromMs: 3000,
    toMs: 30_000,
    durationMs: 27_000,
    sampleCount: 0,
    capture: { state: "missing", reason: "sample_gap" },
    contentRefs: [],
  });
  assert.deepEqual(aggregate.observations[1], {
    fromMs: 3000,
    toMs: 30_000,
    durationMs: 27_000,
    sampleCount: 0,
    attentionSpanId: "s2",
    capture: { state: "missing", reason: "sample_gap" },
  });
});

test("context aggregate drops ns-workspace foreground fallback as missing capture", () => {
  const startedAt = Date.UTC(2026, 6, 6, 14, 45, 0);
  const snapshot = (frontmostSource) => ({
    timestamp: startedAt,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      frontmostSource,
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: ["should not persist"], totalChars: 18, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      visibleWindows: [{
        windowId: 7,
        bundleId: "com.openai.codex",
        ownerName: "Codex",
        ownerPid: 123,
        displayId: 1,
        layer: 0,
        alpha: 1,
        onscreen: true,
        title: "Codex",
        bounds: { x: 0, y: 25, width: 1280, height: 704 },
      }],
      permission: { accessibility: true },
    },
  });

  const aggregate = __test__.buildContextAggregate([
    snapshot({ source: "ns-workspace", selectedPid: 123, workspacePid: 123, workspaceMatched: true }),
  ], {}, {
    windowStartedAtMs: startedAt,
    windowEndedAtMs: startedAt + 1000,
    sampleIntervalMs: 1000,
  });

  assert.deepEqual(aggregate.presence, {
    activeMs: 0,
    idleMs: 0,
    afkMs: 0,
    missingMs: 0,
    unattributedMs: 1000,
  });
  assert.deepEqual(aggregate.displays, {});
  assert.deepEqual(aggregate.windows, {});
  assert.deepEqual(aggregate.contents, {});
  assert.deepEqual(aggregate.attentionSpans, [{
    id: "s1",
    fromMs: 0,
    toMs: 1000,
    durationMs: 1000,
    sampleCount: 0,
    capture: { state: "missing", reason: "unattributed" },
    contentRefs: [],
  }]);
  assert.deepEqual(aggregate.observations, [{
    fromMs: 0,
    toMs: 1000,
    durationMs: 1000,
    sampleCount: 0,
    attentionSpanId: "s1",
    capture: { state: "missing", reason: "unattributed" },
  }]);
});

test("context aggregate trusts cg-window foreground even when workspace mismatches", () => {
  const startedAt = Date.UTC(2026, 6, 6, 14, 46, 0);
  const aggregate = __test__.buildContextAggregate([{
    timestamp: startedAt,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Chrome", bundleId: "com.google.Chrome", pid: 123 },
      frontmostSource: { source: "cg-window", selectedPid: 123, workspacePid: 456, workspaceMatched: false },
      window: { title: "AX Research", role: "AXWindow" },
      focus: { role: "AXWebArea" },
      text: { captureEnabled: true, excerpts: ["trusted cg foreground text"], totalChars: 26, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      visibleWindows: [{
        windowId: 7,
        bundleId: "com.google.Chrome",
        ownerName: "Chrome",
        ownerPid: 123,
        displayId: 1,
        layer: 0,
        alpha: 1,
        onscreen: true,
        title: "AX Research",
        bounds: { x: 0, y: 25, width: 1280, height: 704 },
      }],
      permission: { accessibility: true },
    },
  }], {}, {
    windowStartedAtMs: startedAt,
    windowEndedAtMs: startedAt + 1000,
    sampleIntervalMs: 1000,
  });

  assert.deepEqual(aggregate.presence, {
    activeMs: 1000,
    idleMs: 0,
    afkMs: 0,
    missingMs: 0,
    unattributedMs: 0,
  });
  assert.equal(aggregate.attentionSpans[0].capture, undefined);
  assert.equal(aggregate.attentionSpans[0].foregroundWindowRef, "w1");
  assert.deepEqual(aggregate.attentionSpans[0].contentRefs, ["c1"]);
  assert.equal(aggregate.contents.c1.text, "trusted cg foreground text");
});

test("desktop context connector run writes D0 context events", async () => {
  const startedAt = Date.UTC(2026, 6, 6, 15, 0, 0);
  const snapshot = (offsetMs, text) => ({
    timestamp: startedAt + offsetMs,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: [text], totalChars: text.length, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      mouse: { x: 10, y: 20, hoveredWindowId: 7 },
      visibleWindows: [{
        windowId: 7,
        bundleId: "com.openai.codex",
        ownerName: "Codex",
        ownerPid: 123,
        displayId: 1,
        layer: 0,
        alpha: 1,
        onscreen: true,
        title: "Codex",
        bounds: { x: 0, y: 25, width: 1280, height: 704 },
      }],
      permission: { accessibility: true },
    },
  });
  const writes = [];
  let stateValue = {};

  await __test__.runDesktopContextConnector({
    config: {},
    signal: new AbortController().signal,
    guard: {
      async writeEvent(event) {
        writes.push(event);
        return { id: `event-${writes.length}` };
      },
    },
    state: {
      async get() {
        return stateValue;
      },
      async set(value) {
        stateValue = value;
      },
    },
    warnings: { async set() {}, async clear() {} },
  }, {
    profileWindowMs: 2000,
    intervalMs: 1000,
    spawnImpl: spawnSnapshots([
      snapshot(0, "first visible text"),
      snapshot(1000, "second visible text"),
      snapshot(2000, "boundary visible text"),
    ]),
  });

  assert.equal(writes.length, 2);
  assert.equal(writes[0].type, "desktop.context");
  assert.equal(writes[0].startedAt, startedAt);
  assert.equal(writes[0].endedAt, startedAt + 2000);
  assert.equal(writes[0].payload.schema, "desktop.context.aggregate.v0");
  assert.equal(writes[0].payload.provider, undefined);
  assert.equal(writes[0].payload.attentionSpans.length, 1);
  assert.equal(writes[0].payload.observations.length, 2);
  assert.equal(writes[0].payload.observations[0].attentionSpanId, "s1");
  assert.deepEqual(Object.keys(writes[0].payload.contents), ["c1", "c2"]);
  assert.equal(writes[1].type, "desktop.presence");
  assert.equal(writes[1].startedAt, startedAt);
  assert.equal(writes[1].endedAt, startedAt + 3000);
  assert.equal(writes[1].payload.schema, "desktop.presence.segment.v0");
  assert.equal(writes[1].payload.state, "active");
  assert.equal(writes[1].payload.durationMs, 3000);
  assert.equal(writes[1].payload.sampleCount, 3);
  assert.equal(stateValue.version, 1);
  assert.equal(stateValue.lastProfile.attentionSpanCount, 1);
});

test("desktop context connector writes large visible text through content blobs", async () => {
  const startedAt = Date.UTC(2026, 6, 6, 15, 5, 0);
  const largeText = Array.from({ length: 260 }, (_, index) =>
    `Visible editor paragraph ${index} contains ordinary prose with spaces so it remains rich context text.`
  ).join("\n");
  const snapshot = (offsetMs, text) => ({
    timestamp: startedAt + offsetMs,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: [text], totalChars: text.length, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      visibleWindows: [{
        windowId: 7,
        bundleId: "com.openai.codex",
        ownerName: "Codex",
        ownerPid: 123,
        displayId: 1,
        layer: 0,
        alpha: 1,
        onscreen: true,
        title: "Codex",
        bounds: { x: 0, y: 25, width: 1280, height: 704 },
      }],
      permission: { accessibility: true },
    },
  });
  const writes = [];
  const blobWrites = [];

  await __test__.runDesktopContextConnector({
    config: {},
    signal: new AbortController().signal,
    guard: {
      async writeTextBlob(input) {
        blobWrites.push(input);
        return {
          ref: { kind: "content-blob", digest: "sha256:large-text" },
          bytes: input.text.length,
          compressedBytes: 123,
        };
      },
      async writeEvent(event) {
        writes.push(event);
        return { id: `event-${writes.length}` };
      },
    },
    state: {
      async get() {
        return {};
      },
      async set() {},
    },
    warnings: { async set() {}, async clear() {} },
  }, {
    profileWindowMs: 2000,
    intervalMs: 1000,
    spawnImpl: spawnSnapshots([
      snapshot(0, largeText),
      snapshot(2000, "boundary"),
    ]),
  });

  assert.equal(blobWrites.length, 1);
  assert.equal(blobWrites[0].text, largeText);
  const contextEvent = writes.find((event) => event.type === "desktop.context");
  assert.ok(contextEvent);
  assert.equal(contextEvent.payload.contents.c1.text, undefined);
  assert.equal(contextEvent.payload.contents.c1.preview, largeText.slice(0, 4096));
  assert.equal(contextEvent.payload.contents.c1.chars, largeText.length);
  assert.deepEqual(contextEvent.payload.contents.c1.contentRef, {
    kind: "content-blob",
    digest: "sha256:large-text",
  });
});

test("desktop context connector skips an incomplete window and restarts its helper", async () => {
  const startedAt = Date.UTC(2026, 6, 6, 15, 15, 0);
  const snapshot = (offsetMs) => ({
    timestamp: startedAt + offsetMs,
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: ["visible text"], totalChars: 12, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      visibleWindows: [],
      permission: { accessibility: true },
    },
  });
  const writes = [];
  const warningOperations = [];
  const helperRestarts = [];
  let stateValue = {};
  const spawnImpl = spawnSequence([
    spawnSnapshotsThenSilence([
      snapshot(0),
      snapshot(10),
      snapshot(20),
    ]),
    spawnSnapshots([
      snapshot(1000),
      snapshot(1010),
      snapshot(1020),
      snapshot(1030),
    ]),
  ]);

  await __test__.runDesktopContextConnector({
    config: {},
    signal: new AbortController().signal,
    guard: {
      async writeEvent(event) {
        writes.push(event);
        return { id: `event-${writes.length}` };
      },
    },
    state: {
      async get() {
        return stateValue;
      },
      async set(value) {
        stateValue = value;
      },
    },
    warnings: {
      async set(warning) {
        warningOperations.push({ operation: "set", warning });
      },
      async clear(key) {
        warningOperations.push({ operation: "clear", key });
      },
    },
  }, {
    profileWindowMs: 30,
    intervalMs: 10,
    noSampleGraceMs: 20,
    spawnImpl,
    async onHelperRestart(input) {
      helperRestarts.push(input);
    },
  });

  assert.equal(spawnImpl.callCount(), 2);
  assert.deepEqual(helperRestarts.map((item) => item.reason), ["sample-gap"]);
  assert.equal(writes.filter((event) => event.type === "desktop.context").length, 1);
  const contextEvent = writes.find((event) => event.type === "desktop.context");
  assert.equal(contextEvent.startedAt, startedAt + 1000);
  assert.equal(contextEvent.endedAt, startedAt + 1030);
  const presenceEvents = writes.filter((event) => event.type === "desktop.presence");
  assert.equal(presenceEvents.length, 2);
  assert.equal(presenceEvents[0].startedAt, startedAt);
  assert.equal(presenceEvents[0].endedAt, startedAt + 30);
  assert.equal(presenceEvents[0].payload.recovered, true);
  assert.equal(presenceEvents[0].payload.endReason, "sample-gap");
  assert.equal(presenceEvents[1].startedAt, startedAt + 1000);
  assert.equal(presenceEvents[1].endedAt, startedAt + 1040);
  const warningSetIndex = warningOperations.findIndex((item) => item.operation === "set");
  assert.ok(warningSetIndex >= 0);
  assert.equal(warningOperations[warningSetIndex].warning.key, "macos-ax-sample-gap");
  assert.ok(warningOperations.slice(warningSetIndex + 1).some((item) =>
    item.operation === "clear" && item.key === "macos-ax-sample-gap"
  ));
});

test("desktop context connector fails after three helpers emit no first sample", async () => {
  const warningOperations = [];
  const spawnImpl = spawnSequence([
    spawnSnapshotsThenSilence([]),
    spawnSnapshotsThenSilence([]),
    spawnSnapshotsThenSilence([]),
  ]);

  await assert.rejects(
    __test__.runDesktopContextConnector({
      config: {},
      signal: new AbortController().signal,
      guard: {
        async writeEvent() {
          throw new Error("should not write events");
        },
      },
      state: {
        async get() {
          return {};
        },
        async set() {},
      },
      warnings: {
        async set(warning) {
          warningOperations.push({ operation: "set", warning });
        },
        async clear(key) {
          warningOperations.push({ operation: "clear", key });
        },
      },
    }, {
      profileWindowMs: 30,
      intervalMs: 10,
      noSampleGraceMs: 20,
      spawnImpl,
    }),
    /failed to produce a first sample in 3 consecutive sessions/u,
  );

  assert.equal(spawnImpl.callCount(), 3);
  assert.deepEqual(
    warningOperations.filter((item) => item.operation === "set")
      .map((item) => item.warning.details.failureCount),
    [1, 2],
  );
  assert.deepEqual(warningOperations.at(-1), {
    operation: "clear",
    key: "macos-ax-sample-gap",
  });
});

test("desktop availability lifecycle closes context and suppresses it until resume", async () => {
  const startedAt = Date.UTC(2026, 6, 6, 15, 25, 0);
  const snapshot = (offsetMs, text) => ({
    timestamp: startedAt + offsetMs,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: [text], totalChars: text.length, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      visibleWindows: [],
      permission: { accessibility: true },
    },
  });
  const lifecycle = (offsetMs, available, reasons, trigger) => ({
    schema: "macos-ax.lifecycle.v1",
    type: "desktop_availability",
    timestamp: startedAt + offsetMs,
    available,
    reasons,
    trigger,
  });
  const writes = [];
  let stateValue = {};

  await __test__.runDesktopContextConnector({
    config: {},
    signal: new AbortController().signal,
    guard: {
      async writeEvent(event) {
        writes.push(event);
        return { id: `event-${writes.length}` };
      },
    },
    state: {
      async get() {
        return stateValue;
      },
      async set(value) {
        stateValue = value;
      },
    },
    warnings: { async set() {}, async clear() {} },
  }, {
    profileWindowMs: 10_000,
    intervalMs: 1000,
    spawnImpl: spawnSnapshots([
      snapshot(0, "before unavailable"),
      snapshot(1000, "still observable"),
      lifecycle(1500, false, ["screen_off"], "screens_did_sleep"),
      lifecycle(2000, false, ["screen_off", "system_sleep"], "will_sleep"),
      lifecycle(5000, true, [], "screens_did_wake"),
      snapshot(5000, "after resume"),
      snapshot(6000, "after resume again"),
    ]),
  });

  const contextEvents = writes.filter((event) => event.type === "desktop.context");
  assert.equal(contextEvents.length, 1);
  assert.equal(contextEvents[0].startedAt, startedAt);
  assert.equal(contextEvents[0].endedAt, startedAt + 1500);
  assert.equal(JSON.stringify(contextEvents[0].payload).includes("after resume"), false);

  const presenceEvents = writes.filter((event) => event.type === "desktop.presence");
  assert.deepEqual(presenceEvents.map((event) => [
    event.payload.state,
    event.payload.reason,
    event.startedAt,
    event.endedAt,
  ]), [
    ["active", undefined, startedAt, startedAt + 1500],
    ["unavailable", "screen_off", startedAt + 1500, startedAt + 2000],
    ["unavailable", "system_sleep", startedAt + 2000, startedAt + 5000],
    ["active", undefined, startedAt + 5000, startedAt + 7000],
  ]);
});

test("locked snapshots become unavailable presence without persisting locked AX content", async () => {
  const startedAt = Date.UTC(2026, 6, 6, 15, 27, 0);
  const snapshot = (offsetMs, screenLocked, text) => ({
    timestamp: startedAt + offsetMs,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: [text], totalChars: text.length, sourceCount: 1 },
      session: { screenLocked },
      idle: { seconds: 0 },
      visibleWindows: [],
      permission: { accessibility: true },
    },
  });
  const writes = [];

  await __test__.runDesktopContextConnector({
    config: {},
    signal: new AbortController().signal,
    guard: {
      async writeEvent(event) {
        writes.push(event);
        return { id: `event-${writes.length}` };
      },
    },
    state: { async get() { return {}; }, async set() {} },
    warnings: { async set() {}, async clear() {} },
  }, {
    profileWindowMs: 10_000,
    intervalMs: 1000,
    spawnImpl: spawnSnapshots([
      snapshot(0, false, "visible before lock"),
      snapshot(1000, true, "secret captured by an older helper"),
      snapshot(2000, true, "another locked secret"),
      snapshot(3000, false, "visible after unlock"),
      snapshot(4000, false, "still visible after unlock"),
    ]),
  });

  const contextEvents = writes.filter((event) => event.type === "desktop.context");
  assert.equal(contextEvents.length, 1);
  assert.equal(contextEvents[0].endedAt, startedAt + 1000);
  assert.equal(JSON.stringify(contextEvents[0].payload).includes("secret"), false);

  const presenceEvents = writes.filter((event) => event.type === "desktop.presence");
  assert.deepEqual(presenceEvents.map((event) => [event.payload.state, event.payload.reason]), [
    ["active", undefined],
    ["unavailable", "locked"],
    ["active", undefined],
  ]);
  assert.equal(presenceEvents[1].startedAt, startedAt + 1000);
  assert.equal(presenceEvents[1].endedAt, startedAt + 3000);
});

test("desktop presence is emitted as state segments, not context-window aggregates", async () => {
  const startedAt = Date.UTC(2026, 6, 6, 15, 30, 0);
  const snapshot = (offsetMs, idleSeconds) => ({
    timestamp: startedAt + offsetMs,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: ["visible text"], totalChars: 12, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: idleSeconds },
      visibleWindows: [],
      permission: { accessibility: true },
    },
  });
  const writes = [];
  let stateValue = {};

  await __test__.runDesktopContextConnector({
    config: {},
    signal: new AbortController().signal,
    guard: {
      async writeEvent(event) {
        writes.push(event);
        return { id: `event-${writes.length}` };
      },
    },
    state: {
      async get() {
        return stateValue;
      },
      async set(value) {
        stateValue = value;
      },
    },
    warnings: { async set() {}, async clear() {} },
  }, {
    profileWindowMs: 100_000,
    spawnImpl: spawnSnapshots([
      snapshot(0, 0),
      snapshot(1000, 20),
      snapshot(2000, 70),
    ]),
  });

  assert.deepEqual(writes.map((event) => event.type), [
    "desktop.presence",
    "desktop.presence",
    "desktop.presence",
  ]);
  assert.deepEqual(writes
    .filter((event) => event.type === "desktop.presence")
    .map((event) => [event.payload.schema, event.payload.state, event.startedAt, event.endedAt, event.payload.sampleCount]), [
    ["desktop.presence.segment.v0", "active", startedAt, startedAt + 1000, 1],
    ["desktop.presence.segment.v0", "idle", startedAt + 1000, startedAt + 2000, 1],
    ["desktop.presence.segment.v0", "afk", startedAt + 2000, startedAt + 3000, 1],
  ]);
  assert.equal(stateValue.presence, undefined);
});

test("desktop presence recovers open segment from connector state on restart", async () => {
  const previousStartedAt = Date.UTC(2026, 6, 6, 16, 0, 0);
  const currentStartedAt = Date.UTC(2026, 6, 6, 16, 1, 0);
  const snapshot = {
    timestamp: currentStartedAt,
    raw: {
      displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    },
    normalized: {
      app: { name: "Codex", bundleId: "com.openai.codex", pid: 123 },
      window: { title: "Codex", role: "AXWindow" },
      focus: { role: "AXTextArea" },
      text: { captureEnabled: true, excerpts: ["current visible text"], totalChars: 20, sourceCount: 1 },
      session: { screenLocked: false },
      idle: { seconds: 0 },
      visibleWindows: [],
      permission: { accessibility: true },
    },
  };
  const writes = [];
  let stateValue = {
    version: 1,
    presence: {
      open: {
        schema: "macos-ax.presence.open.v1",
        platform: "macos",
        state: "afk",
        startedAt: previousStartedAt,
        lastObservedAt: previousStartedAt + 30_000,
        lastIntervalMs: 1000,
        sampleCount: 30,
        presenceModel: {
          source: "hid-any-input",
          idleThresholdSeconds: 15,
          afkThresholdSeconds: 60,
        },
      },
    },
  };

  await __test__.runDesktopContextConnector({
    config: {},
    signal: new AbortController().signal,
    guard: {
      async writeEvent(event) {
        writes.push(event);
        return { id: `event-${writes.length}` };
      },
    },
    state: {
      async get() {
        return stateValue;
      },
      async set(value) {
        stateValue = value;
      },
    },
    warnings: { async set() {}, async clear() {} },
  }, {
    profileWindowMs: 100_000,
    spawnImpl: spawnSnapshots([snapshot]),
  });

  assert.deepEqual(writes.map((event) => event.type), [
    "desktop.presence",
    "desktop.presence",
  ]);
  assert.equal(writes[0].startedAt, previousStartedAt);
  assert.equal(writes[0].endedAt, previousStartedAt + 31_000);
  assert.equal(writes[0].payload.schema, "desktop.presence.segment.v0");
  assert.equal(writes[0].payload.state, "afk");
  assert.equal(writes[0].payload.recovered, true);
  assert.equal(writes[0].payload.endReason, "connector-restart");
  assert.equal(writes[1].payload.state, "active");
  assert.equal(stateValue.presence, undefined);
  assert.equal(stateValue.lastProfile, undefined);
});

test("config panel can add and remove website overrides", async (t) => {
  let config = {};
  const controller = new AbortController();
  t.after(() => controller.abort());

  let result;
  try {
    result = await connector.configUi({
      panelId: "privacy-controls",
      config,
      host: { workspacePath: "/tmp" },
      signal: controller.signal,
      configStore: {
        async get() {
          return config;
        },
        async replace(next) {
          config = next;
        },
        async patch(patch) {
          config = { ...config, ...(patch.set ?? {}) };
          for (const key of patch.remove ?? []) {
            delete config[key];
          }
          return config;
        },
      },
    });
  } catch (err) {
    if (err?.code === "EPERM") {
      t.skip("sandbox does not allow binding localhost");
      return;
    }
    throw err;
  }

  async function post(path, body) {
    const url = new URL(result.url);
    url.pathname = path;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    assert.equal(response.ok, true, JSON.stringify(json));
    return json;
  }

  const added = await post("/api/policy/websites", {
    domain: "https://www.pornhub.com/view_video.php",
    action: "rich",
  });
  assert.equal(added.domain, "pornhub.com");
  assert.equal(config.privacyPolicy.domains["pornhub.com"].action, "rich");

  const removed = await post("/api/policy/websites/remove", {
    domain: "www.pornhub.com",
  });
  assert.equal(removed.domain, "pornhub.com");
  assert.equal(config.privacyPolicy.domains["pornhub.com"], undefined);
});
