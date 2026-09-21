import { app, BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurnTelemetryProbe } from './turn-telemetry-fixture';

app.on('window-all-closed', () => {});
async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'ai-turn-telemetry-'));
  app.setPath('userData', profile);
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    const node = await runTurnTelemetryProbe();
    await window.loadFile(join(import.meta.dirname, 'index.html'));
    const browser = await window.webContents.executeJavaScript('turnTelemetryFixture.runTurnTelemetryProbe()');
    const evidence = { versions: process.versions, ai: '7.0.105', node, browser };
    await writeFile(join(import.meta.dirname, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log('AI_TURN_TELEMETRY_CONTRACT_REPRODUCED: Node and isolated Electron renderer; onEnd before output validation, then rejection/onError or success without another telemetry event');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    await rm(profile, { recursive: true, force: true });
    app.exit(Number(process.exitCode ?? 0));
  }
}
void main().catch(error => { console.error(error); app.exit(1); });
