import { expect, test } from 'vitest';
import { toMcpToolResult, toCodexToolResult } from '../src/ai/tool-output';

test('preserves explicit image bytes and text in native subscription tool results', () => {
  const output = { type: 'content' as const, value: [
    { type: 'text' as const, text: 'Screenshot' },
    { type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data: new Uint8Array([1, 2, 3]) } },
  ] };
  expect(toMcpToolResult(output)).toEqual({ content: [{ type: 'text', text: 'Screenshot' }, { type: 'image', mimeType: 'image/png', data: 'AQID' }], isError: false });
  expect(toCodexToolResult(output)).toEqual({ contentItems: [{ type: 'inputText', text: 'Screenshot' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,AQID' }], success: true });
});
test('never guesses images from App JSON, or silently drops unsupported content', () => {
  expect(toMcpToolResult({ type: 'json', value: { type: 'image', data: 'AQID' } }).content).toEqual([{ type: 'text', text: '{"type":"image","data":"AQID"}' }]);
  for (const part of [
    { type: 'file', data: { type: 'url', url: 'https://example.com/a.png' }, mediaType: 'image/png' },
    { type: 'file', data: { type: 'data', data: 'AQID' }, mediaType: 'application/pdf' },
    { type: 'file', data: { type: 'data', data: 'invalid base64' }, mediaType: 'image/png' },
    { type: 'text', text: 'x', providerOptions: { unknown: true } },
  ]) expect(() => toMcpToolResult({ type: 'content', value: [part] } as any)).toThrow();
});
