import type { LanguageModelV4ToolResultOutput } from '@ai-sdk/provider';
import type { AiToolResult } from '@lamarck/system/protocol';
import { AiError } from './errors';

type Output = AiToolResult['modelOutput'] | LanguageModelV4ToolResultOutput;
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Translate Vercel's model-facing output, never infer content from arbitrary App JSON. */
export function toMcpToolResult(output: Output): { content: Content[]; isError: boolean } {
  if (!output || typeof output !== 'object') throw new AiError('invalid_tool', 'Invalid model tool output');
  if ('providerOptions' in output && output.providerOptions && Object.keys(output.providerOptions).length) throw new AiError('unsupported', 'Subscription tool output provider options are unsupported');
  switch (output.type) {
    case 'text': case 'error-text':
      if (typeof output.value !== 'string') throw new AiError('invalid_tool', 'Tool text output must be a string');
      return { content: [{ type: 'text', text: output.value }], isError: output.type === 'error-text' };
    case 'json': case 'error-json': {
      const text = JSON.stringify(output.value);
      if (text === undefined) throw new AiError('invalid_tool', 'Invalid JSON tool output');
      return { content: [{ type: 'text', text }], isError: output.type === 'error-json' };
    }
    case 'execution-denied':
      return { content: [{ type: 'text', text: output.reason ?? 'Tool execution denied' }], isError: true };
    case 'content':
      if (!Array.isArray(output.value)) throw new AiError('invalid_tool', 'Tool content must be an array');
      return { content: output.value.map((part): Content => {
        if (part.providerOptions && Object.keys(part.providerOptions).length) throw new AiError('unsupported', 'Subscription tool content provider options are unsupported');
        switch (part.type) {
          case 'text':
            if (typeof part.text !== 'string') throw new AiError('invalid_tool', 'Tool text content must be a string');
            return { type: 'text', text: part.text };
          case 'file':
            if (part.data?.type !== 'data') throw new AiError('unsupported', 'Subscription tool images require inline bytes or base64');
            return image(part.data.data, part.mediaType);
          // Also accept the image forms retained by the installed Vercel SDK.
          case 'image-data': case 'file-data': return image(part.data, part.mediaType);
          default: throw new AiError('unsupported', 'Subscription tools support text and inline images only');
        }
      }), isError: false };
    default: throw new AiError('unsupported', 'Unsupported model tool output');
  }
}

function image(data: unknown, mimeType: string): Extract<Content, { type: 'image' }> {
  if (typeof mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) throw new AiError('unsupported', 'Subscription tool files must have an explicit image media type');
  let bytes: Buffer;
  if (data instanceof Uint8Array) bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (typeof data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) throw new AiError('invalid_tool', 'Invalid image base64');
  } else throw new AiError('invalid_tool', 'Tool images require bytes or base64');
  if (!bytes.length) throw new AiError('invalid_tool', 'Tool image must not be empty');
  return { type: 'image', data: bytes.toString('base64'), mimeType };
}

export function toCodexToolResult(output: Output) {
  const result = toMcpToolResult(output);
  return {
    contentItems: result.content.map(part => part.type === 'text'
      ? { type: 'inputText' as const, text: part.text }
      : { type: 'inputImage' as const, imageUrl: `data:${part.mimeType};base64,${part.data}` }),
    success: !result.isError,
  };
}
