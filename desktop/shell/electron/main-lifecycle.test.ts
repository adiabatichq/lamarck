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
    expect(handler).toContain("closeAppViewersForOwner(shellState.currentOwner)");
    expect(handler).not.toContain("win.");
    expect(handler).not.toContain("webContents");
  });

  test("rotates the owner generation before retiring a replaced Shell renderer", () => {
    const setup = mainSource.match(
      /const shellContents = win\.webContents;[\s\S]*?await win\.loadURL/,
    )?.[0];
    if (!setup) throw new Error("Shell BrowserWindow setup is missing");

    expect(setup).toMatch(
      /const replaceShellRenderer = \(\) => \{[\s\S]*?const retiredOwner = shellState\.currentOwner;[\s\S]*?rendererGeneration: retiredOwner\.rendererGeneration \+ 1,[\s\S]*?closeAppViewersForOwner\(retiredOwner\)/,
    );
    expect(setup).toMatch(
      /shellState\.retirement = Promise\.allSettled\(\[[\s\S]*?shellState\.retirement,[\s\S]*?cleanup,[\s\S]*?\]\)\.then/,
    );
    expect(setup).toMatch(
      /on\("did-start-navigation",[\s\S]*?if \(details\.isSameDocument \|\| !details\.isMainFrame\) return;[\s\S]*?replaceShellRenderer\(\)/,
    );
    expect(setup).toMatch(
      /on\("render-process-gone",[\s\S]*?replaceShellRenderer\(\)/,
    );
  });
});

describe("App viewer IPC contract", () => {
  test("serializes a busy Host state for bounded renderer retry", () => {
    const handler = mainSource.match(
      /ipcMain\.handle\("app-viewer:open",[\s\S]*?\n  \}\);/,
    )?.[0];
    if (!handler) throw new Error("App viewer open IPC handler is missing");

    expect(handler).toContain("error instanceof AppViewerBusyError");
    expect(handler).toContain('"APP_VIEWER_BUSY"');
    expect(handler).toContain("const owner = requireShellRendererOwner(event)");
    expect(handler).toContain("await awaitShellRendererRetirement(event.sender, owner)");
    expect(handler).toContain("openAppViewer(event.sender, owner, appId)");
  });

  test("rechecks the renderer owner before publishing a prepared viewer", () => {
    const open = mainSource.match(
      /async function openAppViewer\([\s\S]*?\n\}\n\nasync function prepareReloadedAppViewer/,
    )?.[0];
    if (!open) throw new Error("App viewer open lifecycle is missing");

    expect(open).toContain("capsuleManager.openViewer(appId, ownerLease");
    const managerReturn = open.indexOf("opened = await capsuleManager.openViewer");
    const publication = open.indexOf("appViewers.set(opened.viewerId, record)");
    expect(managerReturn).toBeGreaterThan(-1);
    expect(publication).toBeGreaterThan(managerReturn);
    expect(open.slice(managerReturn, publication))
      .toContain("assertShellRendererOwnerCurrent(sender, ownerLease)");
  });
});

describe("Shell Host configuration", () => {
  test("keeps Keychain work off the Electron main thread", () => {
    const load = mainSource.match(
      /async function loadVaultKey\([\s\S]*?\n\}\n\nasync function createVaultKey/,
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

    const created = mainSource.match(
      /async function createVaultKey\([\s\S]*?\n\}\n\nasync function requireVaultKey/,
    )?.[0];
    if (!created) throw new Error("async vault-key creator is missing");
    expect(created).toContain("await safeStorage.isAsyncEncryptionAvailable()");
    expect(created).toContain("await safeStorage.encryptStringAsync");
    expect(created).toContain("randomBytes(32)");
    expect(created).toContain("Workspace vault ID already has a local key record");

    const imported = mainSource.match(
      /async function importVaultKey\([\s\S]*?\n\}\n\nfunction requireWorkspaceVaultVerifier/,
    )?.[0];
    if (!imported) throw new Error("async recovery-code importer is missing");
    expect(imported).toContain("await safeStorage.isAsyncEncryptionAvailable()");
    expect(imported).toContain("await safeStorage.encryptStringAsync");
    expect(imported).toContain('.toString("base64")');
    expect(imported).toContain("return normalized");
    expect(imported).toContain("withEncryptedVaultRecord");
    const verifierCheck = imported.indexOf("validateWorkspaceVaultVerifier");
    const encrypt = imported.indexOf("await safeStorage.encryptStringAsync");
    const reinspection = imported.indexOf("inspectWorkspaceForOpen(descriptor.path)");
    const persist = imported.indexOf("saveVaultRecords(withEncryptedVaultRecord");
    expect(verifierCheck).toBeGreaterThan(-1);
    expect(encrypt).toBeGreaterThan(verifierCheck);
    expect(reinspection).toBeGreaterThan(encrypt);
    expect(persist).toBeGreaterThan(reinspection);
    expect(imported).not.toContain("vaultKey =");
    expect(imported).not.toContain("safeStorage.isEncryptionAvailable()");
    expect(imported).not.toMatch(/safeStorage\.encryptString\(/);

    const settings = mainSource.match(
      /async function ensureWorkspaceRuntimeSettings\([\s\S]*?\n\}\n\nasync function chooseAvailableCorePort/,
    )?.[0];
    if (!settings) throw new Error("Workspace runtime settings lifecycle is missing");
    expect(settings.indexOf("await requireVaultKey")).toBeLessThan(
      settings.indexOf("saveWorkspaceSettings(settings"),
    );
    expect(settings.indexOf("assertWorkspaceVaultKeyMatches")).toBeLessThan(
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
    expect(mainSource).toContain("await importVaultKey(descriptor, recoveryCode)");
    expect(mainSource).toContain("workspaceVault.recoveryCode(workspace)");
    const initialization = mainSource.match(
      /async function initializeWorkspace\([\s\S]*?\n\}\n\nasync function ensureWorkspaceRuntimeSettings/,
    )?.[0];
    if (!initialization) throw new Error("Workspace initialization lifecycle is missing");
    const createKey = initialization.indexOf("await createVaultKey(vaultId)");
    const createVerifier = initialization.indexOf(
      "createWorkspaceVaultVerifier(vaultId, recoveryCode)",
    );
    const initializeDirectory = initialization.indexOf("initializeWorkspaceDirectory");
    const settingsCommit = initialization.indexOf(
      "saveWorkspaceSettings({ vaultId, vaultKeyVerifier, corePort }, targetPath)",
    );
    expect(createKey).toBeGreaterThan(-1);
    expect(createVerifier).toBeGreaterThan(createKey);
    expect(initializeDirectory).toBeGreaterThan(createVerifier);
    expect(settingsCommit).toBeGreaterThan(initializeDirectory);
    expect(mainSource).not.toMatch(
      /async function openWorkspace\([\s\S]*?createVaultKey/,
    );
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

  test("collapses App authority synchronously when either control-plane process is lost", () => {
    const collapse = mainSource.match(
      /function beginUnexpectedControlPlaneTeardown\([\s\S]*?\n\}\n\nfunction beginUnexpectedGuardTeardown/,
    )?.[0];
    if (!collapse) throw new Error("unexpected control-plane teardown is missing");

    const unbind = collapse.indexOf("systemBroker.unbindAll()");
    const detach = collapse.indexOf("detachAllAppWebContents()");
    const capsuleStop = collapse.indexOf(
      "capsuleManager.stopAll({ controlPlaneLost: true })",
    );
    const coreStop = collapse.indexOf(
      "stopControlPlaneProcesses(coreChild, guardChild)",
    );
    const queue = collapse.indexOf("enqueueRuntime(async () =>");
    expect(unbind).toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(unbind);
    expect(capsuleStop).toBeGreaterThan(detach);
    expect(coreStop).toBeGreaterThan(capsuleStop);
    expect(queue).toBeGreaterThan(coreStop);
    expect(collapse).toContain("expectedGuardStops.add(guardChild)");
    expect(collapse).toContain("extendControlPlaneTeardownBarrier(teardown)");

    const barrier = mainSource.match(
      /function extendControlPlaneTeardownBarrier\([\s\S]*?\n\}\n\nfunction latchControlPlaneRestartRequired/,
    )?.[0];
    if (!barrier) throw new Error("control-plane teardown barrier is missing");
    expect(barrier).toContain("controlPlaneTeardownBarrier");
    expect(barrier).toContain("void barrier.catch(() => {})");

    const guardLoss = mainSource.match(
      /function beginUnexpectedGuardTeardown\([\s\S]*?\n\}\n\nfunction beginUnexpectedCoreTeardown/,
    )?.[0];
    if (!guardLoss) throw new Error("unexpected Guard teardown is missing");
    expect(guardLoss).toContain("handledGuardLosses.has(child)");
    expect(guardLoss).toContain("expectedGuardStops.has(child)");
    expect(guardLoss).toContain("guard !== child");

    const coreLoss = mainSource.match(
      /function beginUnexpectedCoreTeardown\([\s\S]*?\n\}\n\nfunction isGuardReadyMessage/,
    )?.[0];
    if (!coreLoss) throw new Error("unexpected Core teardown is missing");
    expect(coreLoss).toContain("handledCoreLosses.has(child)");
    expect(coreLoss).toContain("expectedCoreStops.has(child)");
    expect(coreLoss).toContain("core !== child");

    const heartbeat = mainSource.match(
      /function startGuardHeartbeat\([\s\S]*?\n\}\n\nasync function startGuard/,
    )?.[0];
    if (!heartbeat) throw new Error("Guard heartbeat lifecycle is missing");
    expect(heartbeat).toMatch(
      /beginUnexpectedGuardTeardown\([\s\S]*?Guard utility became unresponsive/,
    );
    expect(heartbeat).toMatch(
      /catch \(error\) \{[\s\S]*?beginUnexpectedGuardTeardown/,
    );

    const guardStartup = mainSource.match(
      /async function startGuard\([\s\S]*?\n\}\n\nfunction startCore/,
    )?.[0];
    if (!guardStartup) throw new Error("Guard process lifecycle is missing");
    expect(guardStartup).toMatch(
      /child\.on\("error", \(type, location, report\)[\s\S]*?beginUnexpectedGuardTeardown/,
    );
    expect(guardStartup).toMatch(
      /child\.on\("exit", \(code\)[\s\S]*?beginUnexpectedGuardTeardown/,
    );

    const coreStartup = mainSource.match(
      /function startCore\([\s\S]*?\n\}\n\nasync function stopCore/,
    )?.[0];
    if (!coreStartup) throw new Error("Core process lifecycle is missing");
    expect(coreStartup).toMatch(
      /child\.on\("error", \(error\)[\s\S]*?beginUnexpectedCoreTeardown/,
    );
    expect(coreStartup).toMatch(
      /child\.on\("exit", \(code, signal\)[\s\S]*?beginUnexpectedCoreTeardown/,
    );

    const runtimeStartup = mainSource.match(
      /async function startRuntime\([\s\S]*?\n\}\n\nasync function stopRuntime/,
    )?.[0];
    if (!runtimeStartup) throw new Error("runtime startup lifecycle is missing");
    expect(runtimeStartup.indexOf("await controlPlaneTeardownBarrier")).toBeLessThan(
      runtimeStartup.indexOf("markCoreStarting()"),
    );

    const processStops = mainSource.match(
      /async function stopCore\([\s\S]*?\n\}\n\nasync function stopGuard\([\s\S]*?\n\}\n\nasync function startRuntime/,
    )?.[0];
    if (!processStops) throw new Error("control-plane process stop lifecycle is missing");
    expect(processStops).toContain('child.kill("SIGKILL")');
    expect(processStops).toContain("await waitForCoreExit(child, 500)");
    expect(processStops).toContain("Node Core termination was not confirmed");
    expect(processStops).toContain("latchControlPlaneRestartRequired(failure)");
    expect(processStops).toContain("await waitForGuardExit(child, 500)");
    expect(processStops).toContain("Guard utility termination was not confirmed");
    expect(processStops).toContain("async function stopControlPlaneProcesses");
    expect(processStops).toMatch(
      /child\.postMessage\(\{ type: "shutdown" \}\);\s*\} catch \{\s*try \{\s*child\.kill\(\);\s*\} catch \{\}/,
    );
    expect(processStops.indexOf("await stopCore(coreChild)")).toBeLessThan(
      processStops.indexOf("await stopGuard(guardChild)"),
    );
    expect(processStops).toMatch(
      /if \(failures\.length === 0\) return;[\s\S]*?latchControlPlaneRestartRequired/,
    );
  });

  test("starts only a validated remembered Workspace and reserves it before renderer IPC can race", () => {
    const ready = mainSource.match(
      /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\n\}\);/,
    )?.[0];
    if (!ready) throw new Error("app ready lifecycle is missing");
    const selection = ready.indexOf("const initialWorkspace = initializeWorkspaceSelection()");
    const initial = ready.indexOf("const initialStartup = initialWorkspace");
    const queue = ready.indexOf("? enqueueRuntime", initial);
    const window = ready.indexOf("await createWindow()");
    const release = ready.indexOf("releaseInitialStartup()");
    const awaitInitial = ready.indexOf("await initialStartup");
    expect(selection).toBeGreaterThan(-1);
    expect(initial).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(initial);
    expect(window).toBeGreaterThan(queue);
    expect(release).toBeGreaterThan(window);
    expect(awaitInitial).toBeGreaterThan(release);
    expect(ready).toContain(": null;");
    expect(ready).not.toContain("ensureWorkspace()");
    expect(ready).not.toContain("loadWorkspacePath()");
  });

  test("resets runtime phase before retry, port rotation, and recovery restart", () => {
    for (const [name, nextName] of [
      ["retryCore", "rotateCorePort"],
      ["rotateCorePort", "createWindow"],
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
    expect(recovery).toContain("inspectWorkspaceForOpen(targetWorkspace)");
    expect(recovery).toContain(
      "await startRuntime({ expectedVaultId: descriptor.vaultId })",
    );
    expect(recovery).toContain("markCoreFailed(error)");
  });

  test("commits a Workspace switch only after readiness and restores the old selection before rollback", () => {
    const activation = mainSource.match(
      /async function activateWorkspace\([\s\S]*?\n\}\n\nasync function createWorkspace/,
    )?.[0];
    if (!activation) throw new Error("Workspace activation lifecycle is missing");

    const keyPreflight = activation.indexOf(
      "await requireVerifiedWorkspaceVaultKey(candidate)",
    );
    const stopOld = activation.indexOf("await stopRuntime()");
    const reinspection = activation.indexOf("inspectWorkspaceForOpen(candidate.path)");
    const startCandidate = activation.indexOf(
      "await startRuntime({ expectedVaultId: currentCandidate.vaultId })",
    );
    const candidateReady = activation.indexOf("await waitForCore(generation)", startCandidate);
    const commit = activation.indexOf("saveActiveWorkspace(currentCandidate)");
    const cleanupCandidate = activation.indexOf("if (candidateSelected)");
    const restorePrevious = activation.indexOf("if (previous)", cleanupCandidate);
    const restorePath = activation.indexOf("workspace = previous.path", restorePrevious);
    const restoreVault = activation.indexOf(
      "workspaceVault.begin(previous.path, previous.vaultId)",
      restorePath,
    );
    const restartGate = activation.indexOf(
      "if (failures.length === 1 && previous)",
      restoreVault,
    );
    const restartPrevious = activation.indexOf(
      "await startRuntime({ expectedVaultId: previous.vaultId })",
      restartGate,
    );
    expect(keyPreflight).toBeGreaterThan(-1);
    expect(stopOld).toBeGreaterThan(keyPreflight);
    expect(reinspection).toBeGreaterThan(stopOld);
    expect(startCandidate).toBeGreaterThan(reinspection);
    expect(candidateReady).toBeGreaterThan(startCandidate);
    expect(commit).toBeGreaterThan(candidateReady);
    expect(cleanupCandidate).toBeGreaterThan(commit);
    expect(restorePrevious).toBeGreaterThan(cleanupCandidate);
    expect(restorePath).toBeGreaterThan(restorePrevious);
    expect(restoreVault).toBeGreaterThan(restorePath);
    expect(restartGate).toBeGreaterThan(restoreVault);
    expect(restartPrevious).toBeGreaterThan(restartGate);
    expect(activation).toContain("await waitForCore(generation)");
  });

  test("keeps Create and Open explicit and treats path as a locator", () => {
    expect(mainSource).toContain(`ipcMain.handle("workspace:create"`);
    expect(mainSource).toContain(`ipcMain.handle("workspace:open"`);
    expect(mainSource).toContain(`ipcMain.handle("workspace:getState"`);
    expect(mainSource).not.toContain(`ipcMain.handle("workspace:set"`);
    expect(mainSource).toContain("saveActiveWorkspace(currentCandidate)");
    expect(mainSource).toContain("lastKnownPath: currentCandidate.path");
    expect(mainSource).toContain(
      "appViewerPartition(currentWorkspaceVaultId(), appId, browserChannelId)",
    );
    expect(mainSource).toMatch(
      /suggestedPath: workspaceSetupReason === "invalid"\s*\? ""\s*: workspaceSetupReason === "missing"\s*\? rememberedWorkspace\?\.lastKnownPath/,
    );
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
      /async function stopRuntime\(\): Promise<void> \{[\s\S]*?\n\}\n\nasync function activateWorkspace/,
    );
    if (!match) throw new Error("runtime shutdown lifecycle is missing");

    const shutdown = match[0];
    expect(shutdown).toContain("capsuleFailure = error");
    expect(shutdown).toContain("await stopControlPlaneProcesses()");
    expect(shutdown).toContain("processFailure = error");
    expect(shutdown).toContain('new AggregateError(failures, "Runtime shutdown was incomplete")');
  });
});
