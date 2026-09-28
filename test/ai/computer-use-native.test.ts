import { expect, test, vi } from 'vitest';
import { resolve } from 'node:path';
import { ComputerUseService } from '../../desktop/shell/electron/computer-use';
import { SystemBroker } from '../../desktop/shell/electron/capsule/system-broker';
import { createSystem } from '@lamarck/system/browser';

// Requires a macOS GUI session for native runtime initialization. No screenshot,
// keyboard/mouse action, OS permission grant, account, or inference is performed.
test.runIf(process.env.LAMARCK_COMPUTER_USE_NATIVE_SMOKE === '1')('bundled driver opens through SDK/Host and exits at scope end', async () => {
  const authorize = vi.fn(async () => {});
  const service = new ComputerUseService({ executable: resolve('desktop/shell/dist-electron/computer-use/cua-driver'), bundleId: 'ai.lamarck.desktop', authorize });
  const broker = new SystemBroker({ coreBaseUrl: 'http://unused.invalid', revokeCapability() {}, computer: service });
  broker.bindSender('native-computer', { appId: 'native-fixture', channelId: 'private-channel', capability: 'unused' });
  const system = createSystem((operation, input) => broker.invoke('native-computer', operation, input));
  let pid: number | undefined;
  // Upstream's Rust uint formats are annotations; its default MCP validator
  // reports each one. Keep that schema noise out of the smoke result.
  const originalWarn = console.warn;
  const warnings = vi.spyOn(console, 'warn').mockImplementation((...args) => { if (!String(args[0]).startsWith('unknown format')) originalWarn(...args); });
  try {
    await system.computer.withTools(async ({ tools }) => {
      pid = (service as any).session.transport.pid;
      expect(pid).toBeGreaterThan(0);
      expect(tools.get_window_state).toBeDefined(); expect(tools.click).toBeDefined();
      expect(tools.type_text).toBeDefined(); expect(tools.scroll).toBeDefined();
      expect(tools.set_config).toBeUndefined(); expect(tools.install_extension).toBeUndefined();
    });
    expect(authorize).toHaveBeenCalledWith('native-fixture', expect.any(AbortSignal));
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
  } finally { broker.unbindAll(); await service.close(); warnings.mockRestore(); }
}, 30_000);
