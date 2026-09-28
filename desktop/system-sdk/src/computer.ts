import { jsonSchema, type Tool, type ToolResultOutput } from '@ai-sdk/provider-utils';
import type { SystemInvoke } from './protocol.js';

export interface ComputerTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
}
export interface ComputerResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}
export interface SystemComputer {
  /** Host asks for control permission. Consume all work/streams inside this scope. */
  withTools<R>(run: (computer: { tools: Record<string, Tool<Record<string, unknown>, ComputerResult>>; instructions: string }) => Promise<R>, options?: { abortSignal?: AbortSignal }): Promise<R>;
}

export function createComputer(invoke: SystemInvoke): SystemComputer {
  return Object.freeze<SystemComputer>({
    async withTools(run, options) {
      const signal = options?.abortSignal;
      signal?.throwIfAborted();
      const sessionId = crypto.randomUUID();
      let open = true;
      let opened = false;
      let closing: Promise<unknown> | undefined;
      let active = 0;
      const close = () => {
        open = false;
        return closing ??= invoke('computer.close', { sessionId });
      };
      const abort = () => { void close().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const session = await invoke('computer.open', { sessionId });
        opened = true;
        signal?.throwIfAborted();
        if (session.sessionId !== sessionId) throw new Error('Computer Use scope identity mismatch');
        const tools = Object.fromEntries(session.tools.map(definition => [definition.name, {
          description: definition.description,
          inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema),
          async execute(input: Record<string, unknown>, context: { abortSignal?: AbortSignal }) {
            if (!open) throw new Error('Computer Use scope is closed');
            signal?.throwIfAborted();
            context.abortSignal?.throwIfAborted();
            context.abortSignal?.addEventListener('abort', abort, { once: true });
            active++;
            try {
              const result = await invoke('computer.call', { sessionId, name: definition.name, arguments: input });
              signal?.throwIfAborted();
              context.abortSignal?.throwIfAborted();
              return result;
            } finally {
              active--;
              context.abortSignal?.removeEventListener('abort', abort);
            }
          },
          toModelOutput({ output }: { output: ComputerResult }): ToolResultOutput {
            if (output.isError) return { type: 'error-text', value: output.content.filter(p => p.type === 'text').map(p => p.text).join('\n') || 'Computer action failed' };
            return { type: 'content', value: output.content.map(part => part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'file', data: { type: 'data', data: part.data }, mediaType: part.mimeType }) };
          },
        } satisfies Tool<Record<string, unknown>, ComputerResult>]));
        const result = await run({ tools, instructions: session.instructions });
        if (active || (result && typeof result === 'object' && ('stream' in result || 'consumeStream' in result))) throw new Error('Consume Computer Use work inside withTools before returning');
        signal?.throwIfAborted();
        return result;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (opened || closing) await close();
      }
    },
  });
}
