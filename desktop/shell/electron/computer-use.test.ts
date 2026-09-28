import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ComputerUseService } from './computer-use';

const names = ['list_apps', 'list_windows', 'launch_app', 'bring_to_front', 'get_window_state', 'get_desktop_state', 'get_accessibility_tree', 'click', 'double_click', 'right_click', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag', 'set_value', 'invoke_menu', 'set_window_frame'];
const mocks = vi.hoisted(() => ({ connect: vi.fn(), listTools: vi.fn(), callTool: vi.fn(), close: vi.fn(), transport: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = mocks.connect; listTools = mocks.listTools; callTool = mocks.callTool; } }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { constructor(options: unknown) { mocks.transport(options); } close = mocks.close; } }));
const sessionId = '00000000-0000-0000-0000-000000000001';
const signal = new AbortController().signal;
function host(authorize: (appId: string, signal: AbortSignal) => Promise<void> = vi.fn(async () => {})) {
  mocks.listTools.mockResolvedValue({ tools: [...names, 'clipboard_read', 'set_config', 'install_extension'].map(name => ({ name, inputSchema: { type: 'object', properties: { screenshot_out_file: { type: 'string' }, pid: { type: 'integer' } } } })) });
  return new ComputerUseService({ executable: '/bundled/cua-driver', bundleId: 'ai.lamarck.desktop', authorize });
}
beforeEach(() => { vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64' }); });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
test('unsupported hosts fail before prompting or starting a process', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  const authorize = vi.fn(async () => {});
  await expect(host(authorize).invoke('owner', 'app', 'computer.open', { sessionId }, signal)).rejects.toThrow('Apple Silicon');
  expect(authorize).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
});
test('scope permission precedes process startup; only supported desktop tools are exposed', async () => {
  const authorize = vi.fn(async () => { expect(mocks.transport).not.toHaveBeenCalled(); });
  const service = host(authorize);
  try {
    const result = await service.invoke('owner', 'app', 'computer.open', { sessionId }, signal) as any;
    expect(authorize).toHaveBeenCalledWith('app', expect.any(AbortSignal));
    expect(result.tools.map((t: any) => t.name)).toEqual(names);
    expect(result.tools.every((t: any) => !('screenshot_out_file' in t.inputSchema.properties))).toBe(true);
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ command: '/bundled/cua-driver', args: ['mcp', '--direct', '--embedded', '--host-bundle-id', 'ai.lamarck.desktop'], env: expect.objectContaining({ CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_DRIVER_RS_UPDATE_CHECK: 'false', CUA_DRIVER_PERMISSION_MODE: 'standard' }) }));
    await expect(service.invoke('other', 'app', 'computer.call', { sessionId, name: 'click', arguments: {} }, signal)).rejects.toThrow('unavailable');
    for (const input of [{ sessionId, name: 'clipboard_read', arguments: {} }, { sessionId, name: 'click', arguments: { debug_image_out: '/tmp/image.png' } }]) await expect(service.invoke('owner', 'app', 'computer.call', input, signal)).rejects.toThrow();
    expect(mocks.callTool).not.toHaveBeenCalled();
  } finally { await service.close(); }
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
test('denial and cancellation during permission approval never start the driver', async () => {
  const deny = host(vi.fn(async () => { throw new Error('Declined'); }));
  await expect(deny.invoke('owner', 'app', 'computer.open', { sessionId }, signal)).rejects.toThrow('Declined');
  const service = host(vi.fn(async (_app: string, signal: AbortSignal) => { await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }));
  const pending = service.invoke('owner', 'app', 'computer.open', { sessionId }, signal);
  const rejected = expect(pending).rejects.toThrow('closed');
  await expect(service.invoke('other', 'app', 'computer.open', { sessionId }, signal)).rejects.toThrow('active');
  await service.invoke('owner', 'app', 'computer.close', { sessionId }, signal);
  await rejected;
  expect(mocks.transport).not.toHaveBeenCalled();
});
test('disconnect and aborted actions close the private transport without replay', async () => {
  const service = host();
  await service.invoke('owner', 'app', 'computer.open', { sessionId }, signal);
  mocks.callTool.mockImplementation((_input, _schema, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })));
  const pending = service.invoke('owner', 'app', 'computer.call', { sessionId, name: 'click', arguments: {} }, signal);
  const rejected = expect(pending).rejects.toThrow('closed');
  await expect(service.invoke('owner', 'app', 'computer.call', { sessionId, name: 'click', arguments: {} }, signal)).rejects.toThrow('sequential');
  await service.closeOwner('other'); expect(mocks.close).not.toHaveBeenCalled();
  await service.closeOwner('owner'); await rejected;
  expect(mocks.callTool).toHaveBeenCalledTimes(1); expect(mocks.close).toHaveBeenCalledTimes(1);
});
