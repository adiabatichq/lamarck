import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("Shell window lifecycle", () => {
  test("does not dereference a destroyed BrowserWindow from its closed handler", () => {
    const match = mainSource.match(/win\.on\("closed", \(\) => \{([\s\S]*?)\n  \}\);/);
    if (!match) throw new Error("Shell BrowserWindow closed handler is missing");

    const handler = match[1];
    expect(mainSource).toContain("const shellWebContentsId = shellContents.id;");
    expect(handler).toContain("shellWebContents.delete(shellWebContentsId)");
    expect(handler).toContain("disposeTerminalsForWebContents(shellWebContentsId)");
    expect(handler).toContain("closeAppViewersForOwner(shellWebContentsId)");
    expect(handler).not.toContain("win.");
    expect(handler).not.toContain("webContents");
  });
});

describe("Shell Host configuration", () => {
  test("keeps Keychain work off the Electron main thread", () => {
    const load = mainSource.match(
      /async function loadOrCreateVaultKey\([\s\S]*?\n\}\n\nasync function importVaultKey/,
    )?.[0];
    if (!load) throw new Error("async vault-key loader is missing");
    expect(load).toContain("await safeStorage.isAsyncEncryptionAvailable()");
    expect(load).toContain("await safeStorage.decryptStringAsync");
    expect(load).toContain("await safeStorage.encryptStringAsync");
    expect(load).toContain('.toString("base64")');
    expect(load).toContain("saveVaultRecords(withEncryptedVaultRecord");
    expect(load).not.toContain("safeStorage.isEncryptionAvailable()");
    expect(load).not.toMatch(/safeStorage\.decryptString\(/);
    expect(load).not.toMatch(/safeStorage\.encryptString\(/);

    const imported = mainSource.match(
      /async function importVaultKey\([\s\S]*?\n\}\n\nfunction saveWorkspacePath/,
    )?.[0];
    if (!imported) throw new Error("async recovery-code importer is missing");
    expect(imported).toContain("await safeStorage.isAsyncEncryptionAvailable()");
    expect(imported).toContain("await safeStorage.encryptStringAsync");
    expect(imported).toContain('.toString("base64")');
    expect(imported).toContain("return normalized");
    expect(imported).toContain("withEncryptedVaultRecord");
    expect(imported).not.toContain("vaultKey =");
    expect(imported).not.toContain("safeStorage.isEncryptionAvailable()");
    expect(imported).not.toMatch(/safeStorage\.encryptString\(/);

    const settings = mainSource.match(
      /async function ensureWorkspaceRuntimeSettings\([\s\S]*?\n\}\n\nasync function chooseAvailableCorePort/,
    )?.[0];
    if (!settings) throw new Error("Workspace runtime settings lifecycle is missing");
    expect(settings.indexOf("await loadOrCreateVaultKey")).toBeLessThan(
      settings.indexOf("saveWorkspaceSettings(settings"),
    );
    expect(settings.indexOf("if (isQuitting)")).toBeLessThan(
      settings.indexOf("saveWorkspaceSettings(settings"),
    );
    expect(settings.indexOf("workspaceVault.begin")).toBeLessThan(
      settings.indexOf("await chooseAvailableCorePort"),
    );
    expect(settings.indexOf("saveWorkspaceSettings(settings")).toBeLessThan(
      settings.indexOf("workspaceVault.unlock"),
    );
    expect(mainSource).toContain("renameSync(temporary, path)");
    expect(mainSource).toContain("await importVaultKey(selection.vaultId, recoveryCode)");
    expect(mainSource).toContain("workspaceVault.recoveryCode(workspace)");
    expect(mainSource).not.toMatch(/\blet vault(?:Id|Key) =/);
  });

  test("does not create runtime authority after quit begins during Keychain access", () => {
    const startup = mainSource.match(
      /async function startRuntime\([\s\S]*?\n\}\n\nasync function stopRuntime/,
    )?.[0];
    if (!startup) throw new Error("runtime startup lifecycle is missing");

    const loadSettings = startup.indexOf("await ensureWorkspaceRuntimeSettings(opts)");
    const firstQuitFence = startup.indexOf("if (isQuitting)", loadSettings);
    const startGuard = startup.indexOf("await startGuard(generation)");
    const secondQuitFence = startup.indexOf("if (isQuitting)", startGuard);
    const startCore = startup.indexOf("startCore(generation)");
    expect(loadSettings).toBeGreaterThan(-1);
    expect(firstQuitFence).toBeGreaterThan(loadSettings);
    expect(startGuard).toBeGreaterThan(firstQuitFence);
    expect(secondQuitFence).toBeGreaterThan(startGuard);
    expect(startCore).toBeGreaterThan(secondQuitFence);

    const quit = mainSource.match(
      /app\.on\("before-quit", \(event\) => \{[\s\S]*?\n\}\);/,
    )?.[0];
    if (!quit) throw new Error("before-quit lifecycle is missing");
    expect(quit.indexOf("isQuitting = true")).toBeLessThan(
      quit.indexOf("void stopRuntime()"),
    );
  });

  test("reports starting, ready, and failed Core phases from the Host lifecycle", () => {
    const startup = mainSource.match(
      /async function startRuntime\([\s\S]*?\n\}\n\nasync function stopRuntime/,
    )?.[0];
    if (!startup) throw new Error("runtime startup lifecycle is missing");
    expect(startup.indexOf("markCoreStarting()")).toBeLessThan(
      startup.indexOf("await ensureWorkspaceRuntimeSettings(opts)"),
    );
    expect(startup).toContain("markCoreFailed(error, generation)");

    const readiness = mainSource.match(
      /async function waitForCore\([\s\S]*?\n\}\n\nfunction coreBaseUrl/,
    )?.[0];
    if (!readiness) throw new Error("Core readiness lifecycle is missing");
    const successfulResponse = readiness.indexOf("if (!res.ok)");
    const ready = readiness.indexOf("markCoreReady(generation)");
    expect(ready).toBeGreaterThan(successfulResponse);
    expect(readiness).toContain("markCoreFailed(failure, generation)");
    expect(readiness).toContain("performance.now()");
    expect(readiness).toContain("const request = new AbortController()");
    expect(readiness).toContain("signal: request.signal");
    expect(readiness).toContain("clearTimeout(requestTimeout)");

    expect(mainSource).toContain(`ipcMain.handle("core:getRuntimeState"`);
    expect(mainSource).toContain(`contents.send("core:runtimeState", state)`);
    expect(mainSource).toContain("return coreRuntime.snapshot()");
  });

  test("reserves initial startup in the runtime queue before renderer IPC can race it", () => {
    const ready = mainSource.match(
      /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\n\}\);/,
    )?.[0];
    if (!ready) throw new Error("app ready lifecycle is missing");
    const initial = ready.indexOf("const initialStartup = enqueueRuntime");
    const window = ready.indexOf("await createWindow()");
    const release = ready.indexOf("releaseInitialStartup()");
    const awaitInitial = ready.indexOf("await initialStartup");
    expect(initial).toBeGreaterThan(-1);
    expect(window).toBeGreaterThan(initial);
    expect(release).toBeGreaterThan(window);
    expect(awaitInitial).toBeGreaterThan(release);
  });

  test("resets runtime phase before retry, port rotation, workspace switch, and recovery restart", () => {
    for (const [name, nextName] of [
      ["retryCore", "rotateCorePort"],
      ["rotateCorePort", "createWindow"],
      ["switchWorkspace", "createTerminal"],
    ]) {
      const start = mainSource.indexOf(`async function ${name}(`);
      const end = mainSource.indexOf(`function ${nextName}(`, start + 1);
      if (start < 0 || end < 0) throw new Error(`${name} lifecycle is missing`);
      const lifecycle = mainSource.slice(start, end);
      expect(lifecycle).toContain("markCoreStarting()");
      expect(lifecycle).toContain("markCoreFailed(error)");
    }

    const recovery = mainSource.match(
      /ipcMain\.handle\("auth:importRecoveryCode"[\s\S]*?\n  \}\);/,
    )?.[0];
    if (!recovery) throw new Error("recovery restart lifecycle is missing");
    expect(recovery.indexOf("await importVaultKey")).toBeLessThan(
      recovery.indexOf("markCoreStarting()"),
    );
    expect(recovery).toContain("markCoreFailed(error)");
  });

  test("exits Electron only after bounded runtime cleanup settles", () => {
    const quit = mainSource.match(
      /app\.on\("before-quit", \(event\) => \{[\s\S]*?\n\}\);/,
    )?.[0];
    if (!quit) throw new Error("before-quit lifecycle is missing");

    const stopRuntime = quit.indexOf("void stopRuntime()");
    const failureLog = quit.indexOf("Runtime shutdown required process exit");
    const finallyBlock = quit.indexOf(".finally(() =>");
    const shutdownComplete = quit.indexOf("shutdownComplete = true");
    const forcedExit = quit.indexOf("app.exit(0)");
    expect(stopRuntime).toBeGreaterThan(-1);
    expect(failureLog).toBeGreaterThan(stopRuntime);
    expect(finallyBlock).toBeGreaterThan(failureLog);
    expect(shutdownComplete).toBeGreaterThan(finallyBlock);
    expect(forcedExit).toBeGreaterThan(shutdownComplete);
    expect(quit).not.toContain("app.quit()");
    expect(quit).not.toContain("process.exit(");
  });

  test("selects the Alpha Capsule cache before checking packaged layout", () => {
    expect(mainSource).toContain(`const capsuleCacheNamespace = app.getVersion().includes("-alpha")
  ? "ai.lamarck.desktop.alpha"
  : app.isPackaged
    ? "ai.lamarck.desktop"
    : "ai.lamarck.desktop.dev";`);
  });

  test("loads a prepared App viewer through its exact candidate route before publication", () => {
    const preparation = mainSource.match(
      /async function prepareAppViewerSurface\([\s\S]*?\n\}\n\nasync function disposePreparedAppViewerSurface/,
    );
    if (!preparation) throw new Error("Prepared App viewer lifecycle is missing");

    const lifecycle = preparation[0];
    const readiness = lifecycle.indexOf("await waitForViewerHttpReady");
    const documentLoad = lifecycle.indexOf("await loadAppViewerDocument");
    expect(lifecycle).toContain("instanceId: binding.instanceId");
    expect(lifecycle).toContain("view.setVisible(false)");
    expect(readiness).toBeGreaterThan(-1);
    expect(documentLoad).toBeGreaterThan(readiness);

    const match = mainSource.match(
      /async function openAppViewer\([\s\S]*?\n\}\n\nasync function prepareReloadedAppViewer/,
    );
    if (!match) throw new Error("App viewer open lifecycle is missing");

    const open = match[0];
    const managerPrepare = open.indexOf("await capsuleManager.openViewer");
    const hiddenLoad = open.indexOf("await prepareAppViewerSurface");
    const publication = open.indexOf("owner.contentView.addChildView(surface.view)");
    expect(managerPrepare).toBeGreaterThan(-1);
    expect(hiddenLoad).toBeGreaterThan(managerPrepare);
    expect(publication).toBeGreaterThan(hiddenLoad);
    expect(open).not.toContain("instanceId: binding.viewerId");
  });

  test("waits for an explicit bounded main-frame response before publication", () => {
    const match = mainSource.match(
      /async function loadAppViewerDocument\([\s\S]*?\n\}\n\nasync function openAppViewer/,
    );
    if (!match) throw new Error("App viewer document loader is missing");

    const loader = match[0];
    expect(loader).toContain("viewerSession.webRequest.onCompleted");
    expect(loader).toContain("mainResponse");
    expect(loader).toContain("contents.stop()");
    expect(loader).toContain("8_000");
    expect(loader).not.toContain("setImmediate");
  });

  test("invalidates a hidden preparation when its renderer or document becomes unhealthy", () => {
    const preparation = mainSource.match(
      /async function prepareAppViewerSurface\([\s\S]*?\n\}\n\nasync function disposePreparedAppViewerSurface/,
    );
    if (!preparation) throw new Error("Prepared App viewer lifecycle is missing");

    const lifecycle = preparation[0];
    const renderGoneListener = lifecycle.indexOf(`on("render-process-gone"`);
    const destroyedListener = lifecycle.indexOf(`on("destroyed"`);
    const failedLoadListener = lifecycle.indexOf(`on("did-fail-load"`);
    const navigationListener = lifecycle.indexOf(`on("did-start-navigation"`);
    const documentLoad = lifecycle.indexOf("await loadAppViewerDocument");
    expect(renderGoneListener).toBeGreaterThan(-1);
    expect(destroyedListener).toBeGreaterThan(-1);
    expect(failedLoadListener).toBeGreaterThan(-1);
    expect(navigationListener).toBeGreaterThan(-1);
    expect(renderGoneListener).toBeLessThan(documentLoad);
    expect(destroyedListener).toBeLessThan(documentLoad);
    expect(failedLoadListener).toBeLessThan(documentLoad);
    expect(navigationListener).toBeLessThan(documentLoad);
    expect(lifecycle).toMatch(
      /const markUnhealthy = \(error: Error\) => \{[\s\S]*?binding\.invalidate\(error\);[\s\S]*?\n  \};/,
    );
    expect(lifecycle).toMatch(
      /const onRenderProcessGone = \([\s\S]*?markUnhealthy\(/,
    );
    expect(lifecycle).toMatch(
      /const onDestroyed = \(\) => \{[\s\S]*?markUnhealthy\(/,
    );
    expect(lifecycle).toMatch(
      /const onDidFailLoad = \([\s\S]*?if \(!isMainFrame\) return;[\s\S]*?markUnhealthy\(/,
    );
    expect(lifecycle).toMatch(
      /const onDidStartNavigation = \([\s\S]*?mainFrameNavigationStarted[\s\S]*?markUnhealthy\(/,
    );
    expect(lifecycle).toMatch(
      /loadAppViewerDocument\([\s\S]*?markUnhealthy/,
    );
    expect(lifecycle).toMatch(
      /const cleanupFailures = cleanup[\s\S]*?throw new AggregateError\(/,
    );

    const loader = mainSource.match(
      /async function loadAppViewerDocument\([\s\S]*?\n\}\n\nasync function openAppViewer/,
    )?.[0];
    if (!loader) throw new Error("App viewer document loader is missing");
    expect(loader).toContain("onUnexpectedMainResponse");
    expect(loader).toMatch(
      /statusCode < 200 \|\| response\.statusCode > 299[\s\S]*?onUnexpectedMainResponse/,
    );
  });

  test("revokes hidden first-launch browser authority synchronously on cancellation", () => {
    const preparation = mainSource.match(
      /async function prepareAppViewerSurface\([\s\S]*?\n\}\n\nasync function disposePreparedAppViewerSurface/,
    );
    if (!preparation) throw new Error("Prepared App viewer lifecycle is missing");

    const lifecycle = preparation[0];
    const abortListener = lifecycle.indexOf(
      `binding.signal.addEventListener("abort", onAuthorityAborted`,
    );
    const bindSender = lifecycle.indexOf(
      "systemBroker.bindSender(view.webContents.id, binding)",
    );
    expect(lifecycle).toMatch(
      /const onAuthorityAborted = \(\) => \{[\s\S]*?systemBroker\.unbindSender\(view\.webContents\.id\);[\s\S]*?\n  \};/,
    );
    expect(abortListener).toBeGreaterThan(-1);
    expect(bindSender).toBeGreaterThan(abortListener);
    expect(lifecycle).toContain(
      `binding.signal.removeEventListener("abort", onAuthorityAborted)`,
    );
    expect(lifecycle.indexOf("preparedAppViewerSenderIds.add")).toBeLessThan(
      bindSender,
    );

    const open = mainSource.match(
      /async function openAppViewer\([\s\S]*?\n\}\n\nasync function prepareReloadedAppViewer/,
    )?.[0];
    if (!open) throw new Error("App viewer open lifecycle is missing");
    expect(open.indexOf("appViewers.set(opened.viewerId, record)")).toBeLessThan(
      open.indexOf("surface.stopHealthMonitoring()"),
    );

    const globalDetach = mainSource.match(
      /function detachAllAppWebContents\(\): void \{[\s\S]*?\n\}\n\nasync function stopAllAppViewers/,
    )?.[0];
    if (!globalDetach) throw new Error("Global App viewer detach lifecycle is missing");
    expect(globalDetach).toMatch(
      /for \(const senderId of preparedAppViewerSenderIds\) \{[\s\S]*?systemBroker\.unbindSender\(senderId\);/,
    );
  });

  test("keeps the prior renderer attached until the prepared replacement commits", () => {
    const reload = mainSource.match(
      /function reloadAppRuntime\([\s\S]*?\n\}\n\nfunction assertCurrentAppViewer/,
    );
    if (!reload) throw new Error("App viewer reload lifecycle is missing");
    const lifecycle = reload[0];
    const managerCommit = lifecycle.indexOf("await capsuleManager.reloadApp");
    const hiddenLoad = lifecycle.indexOf("await prepareReloadedAppViewer");
    const rendererCommit = lifecycle.indexOf("commitReloadedAppViewer");
    expect(managerCommit).toBeGreaterThan(-1);
    expect(hiddenLoad).toBeGreaterThan(managerCommit);
    expect(rendererCommit).toBeGreaterThan(hiddenLoad);

    const cutover = mainSource.match(
      /function commitReloadedAppViewer\([\s\S]*?\n\}\n\nfunction reloadAppRuntime/,
    );
    if (!cutover) throw new Error("App viewer renderer commit is missing");
    const commit = cutover[0];
    const captureVisibility = commit.indexOf("previousView.getVisible()");
    const attachReplacement = commit.indexOf("addChildView(replacement.view)");
    const restoreVisibility = commit.indexOf("replacement.view.setVisible(previousVisible)");
    const removePrevious = commit.indexOf("removeChildView(previousView)");
    expect(captureVisibility).toBeGreaterThan(-1);
    expect(attachReplacement).toBeGreaterThan(captureVisibility);
    expect(restoreVisibility).toBeGreaterThan(attachReplacement);
    expect(removePrevious).toBeGreaterThan(restoreVisibility);
  });

  test("hands prepared health monitoring to published renderer cleanup without a gap", () => {
    const match = mainSource.match(
      /async function openAppViewer\([\s\S]*?\n\}\n\nasync function prepareReloadedAppViewer/,
    );
    if (!match) throw new Error("App viewer open lifecycle is missing");

    const open = match[0];
    const assertHealthy = open.indexOf("surface.assertHealthy()");
    const bindPublishedCleanup = open.indexOf("bindAppViewerCleanup(surface.view");
    const postBindHealth = open.indexOf("surface.assertHealthy()", assertHealthy + 1);
    const stopPreparedMonitoring = open.indexOf("surface.stopHealthMonitoring()");
    const postStopHealth = open.indexOf(
      "surface.assertHealthy()",
      stopPreparedMonitoring + 1,
    );
    const publication = open.indexOf("owner.contentView.addChildView(surface.view)");
    expect(assertHealthy).toBeGreaterThan(-1);
    expect(bindPublishedCleanup).toBeGreaterThan(assertHealthy);
    expect(postBindHealth).toBeGreaterThan(bindPublishedCleanup);
    expect(stopPreparedMonitoring).toBeGreaterThan(postBindHealth);
    expect(postStopHealth).toBeGreaterThan(stopPreparedMonitoring);
    expect(publication).toBeGreaterThan(postStopHealth);

    const cutover = mainSource.match(
      /function commitReloadedAppViewer\([\s\S]*?\n\}\n\nfunction reloadAppRuntime/,
    );
    if (!cutover) throw new Error("App viewer renderer commit is missing");
    const commit = cutover[0];
    const replacementHealth = commit.indexOf("replacement.assertHealthy()");
    const bindReplacementCleanup = commit.indexOf("bindAppViewerCleanup(replacement.view");
    const postBindReplacementHealth = commit.indexOf(
      "replacement.assertHealthy()",
      replacementHealth + 1,
    );
    const stopReplacementMonitoring = commit.indexOf("replacement.stopHealthMonitoring()");
    const postStopReplacementHealth = commit.indexOf(
      "replacement.assertHealthy()",
      stopReplacementMonitoring + 1,
    );
    const attachReplacement = commit.indexOf("addChildView(replacement.view)");
    expect(replacementHealth).toBeGreaterThan(-1);
    expect(bindReplacementCleanup).toBeGreaterThan(replacementHealth);
    expect(postBindReplacementHealth).toBeGreaterThan(bindReplacementCleanup);
    expect(stopReplacementMonitoring).toBeGreaterThan(postBindReplacementHealth);
    expect(postStopReplacementHealth).toBeGreaterThan(stopReplacementMonitoring);
    expect(attachReplacement).toBeGreaterThan(postStopReplacementHealth);

    const disposal = mainSource.match(
      /async function disposePreparedAppViewerSurface\([\s\S]*?\n\}\n\nasync function openAppViewer/,
    );
    if (!disposal) throw new Error("Prepared App viewer disposal is missing");
    expect(disposal[0]).toContain("surface.stopHealthMonitoring()");
  });

  test("does not suppress launch or reload cleanup failures", () => {
    const open = mainSource.match(
      /async function openAppViewer\([\s\S]*?\n\}\n\nasync function prepareReloadedAppViewer/,
    )?.[0];
    if (!open) throw new Error("App viewer open lifecycle is missing");
    expect(open).not.toContain(".catch(() => {})");
    expect(open).toContain("App viewer launch cleanup also failed");

    const reload = mainSource.match(
      /function reloadAppRuntime\([\s\S]*?\n\}\n\nfunction assertCurrentAppViewer/,
    )?.[0];
    if (!reload) throw new Error("App viewer reload lifecycle is missing");
    expect(reload).not.toContain(".catch(() => {})");
    expect(reload).toContain("cleanupResults");
    expect(reload).toContain("committed renderer cleanup also failed");
  });

  test("does not restart an in-process runtime after ambiguous Capsule shutdown", () => {
    const match = mainSource.match(
      /async function stopRuntime\(\): Promise<void> \{[\s\S]*?\n\}\n\nasync function switchWorkspace/,
    );
    if (!match) throw new Error("runtime shutdown lifecycle is missing");

    const shutdown = match[0];
    expect(shutdown).toContain("capsuleFailure = error");
    expect(shutdown).toContain("if (capsuleFailure !== undefined) throw capsuleFailure");
  });
});
