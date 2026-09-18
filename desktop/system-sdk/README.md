# `@lamarck/system`

The canonical TypeScript/JavaScript client for Lamarck Personal System Apps.

App code imports the same package in browser UI and Node workloads:

```ts
import { system } from "@lamarck/system";
```

The package supplies the client and protocol contract. At runtime, Lamarck binds it to the App Capsule's Host-mediated System channel; importing this package does not grant ambient Host, network, filesystem, or cross-App authority.

`@lamarck/system` follows System protocol V1 and declares that compatibility in its package metadata. Apps should declare an explicit compatible version in `package.json` and commit the generated npm lockfile.

The D1 surface is `system.vfs.command(command, options?)`, using explicit real paths under the Workspace `files/` authority, plus `system.vfs.open(path)` for brokered browser display. There are no document IDs, implicit `.md` suffixes, or legacy document compatibility methods. D2 mutations require an existing granted table with an explicit non-null primary key; primary-key values are immutable.

D1 filenames follow the local filesystem. On macOS and Linux, names containing `?`, `|`, `:`, backslashes, or Windows device names remain accessible; VFS does not impose Windows naming restrictions or an extra portable path-length limit. Paths must stay relative to `files/`, without empty, `.` or `..` segments or NUL. Reserved operational paths and link protections still apply. Quote literal paths in commands, for example `system.vfs.command("cat -- 'myKB/why?.md'")`; quoting does not enable shell expansion.

`ls` and `stat` display paths containing control characters or backslashes as JSON string literals. Use `ls -0` (or `ls -0R`) for exact, unescaped paths separated and terminated by NUL, including names containing newlines or tabs. Filenames are not silently omitted for lacking cross-platform portability.

## Release

Publishing a GitHub Release whose tag is `system-sdk-v<version>` publishes the exact tarball produced by `scripts/pack-system-sdk.mjs`. The release gate verifies the SDK, reproducible tarball contents, clean consumer installation, and registry bytes without depending on Core, Shell, or first-party App lockfiles. It accepts an existing immutable version only when the registry integrity and tarball URL match the locally verified artifact.

After publication succeeds, a separate downstream job reads the official version, tarball URL, and SHA-512 integrity from the npm registry. It updates the official App and local blank-App scaffold lockfiles and opens an independent pull request for review. Those consumer locks therefore record published registry bytes instead of predicting an unpublished tarball; incompatible version-range changes remain an explicit manual decision. Run `npm run verify` from the repository root for repository-wide source validation.

Publishing uses npm trusted publishing from the protected GitHub `npm-publish` environment and does not store an npm token. npm requires a package to exist before a trusted publisher can be configured, so the first release is a one-time bootstrap: an npm scope owner publishes that same verified tarball interactively with 2FA, configures the trusted publisher for this repository, workflow, and environment, and then removes any bootstrap credential. The GitHub Release workflow is idempotent for that bootstrap version: it accepts an existing version only when the registry integrity and tarball URL exactly match the locally verified artifact.

## AI model access

Install the official `ai` package in the App. The verified pairing is `ai@7.0.105` with the SDK's provider V4 contracts. Browser and Node workloads share the same API:

```ts
import { generateText, streamText, embed } from 'ai';
import { system } from '@lamarck/system';

const { models, accessSources } = await system.ai.listOptions();
// Persist these two independent selections in your App's settings.
const selection = { model: 'openai:gpt-5.6-luna', accessSource: settings.accessSource };
const source = accessSources.find(source => source.id === selection.accessSource);
const selectableModels = models.filter(model =>
  source?.status === 'ready' && source.discovery === 'known' &&
  source.support.some(support => support.model === model.id));
if (!selectableModels.some(model => model.id === selection.model)) {
  throw new Error('Choose a compatible model and access source.');
}
const model = system.ai.languageModel(selection);
const result = await generateText({ model, prompt: 'Summarize this note.' });

const controller = new AbortController();
for await (const text of streamText({ model, prompt: 'Explain this idea.', abortSignal: controller.signal }).textStream) {
  renderChunk(text);
}
// controller.abort() cancels an active call.

const vector = await embed({
  model: system.ai.embeddingModel({ model: 'openai:text-embedding-3-small', accessSource: settings.accessSource }),
  value: 'Text to index',
});
```

Console configures API keys, Codex/Claude subscription accounts, and local OpenAI-compatible services. A model ID uses the Vercel registry format `provider:model`; an access-source ID identifies a saved configuration. Multiple accounts or keys may share a provider. Source permissions apply to discovery and every call. New sources allow all Apps, including future Apps; Console can restrict that to selected Apps. Reconfiguring a source preserves its policy. Removing a source preserves the independent model catalog.

Read each source's `status`, `discovery`, and `support` before showing available combinations. Unknown or failed discovery does not mean an empty supported catalog. A source can support language without embeddings, or text without tools/structured output. Current local services advertise text and streaming; subscription adapters do not support embeddings. Unsupported combinations throw; the Host never chooses another source, model, or billing method.

Source discovery and adapter capabilities determine usable model/source combinations; Lamarck has no model-family eligibility policy. Subscription sources use authenticated CLI access and do not promise that every discovered model is included in a subscription allowance. Native model identifiers and upstream resolution are preserved, with fresh selection validation and no automatic source/model/billing fallback. Codex direct and code-mode dispatch share the same scoped App-tool boundary. API options, including Anthropic thinking `blockBinding` with or without a `type`, retain the official provider's semantics, warnings and errors.

Streaming waits for the selected provider to start before returning the model stream, so Vercel's `maxRetries` applies to retryable startup failures. Empty event polls and tool-only batches keep the receive loop active. Once the provider stream has started, failures stay in the stream; startup failures after an App tool callback are marked non-retryable to avoid repeating tool side effects.

### App tools

API providers use Vercel's usual App-side tool loop. For subscription tools, use `withTools` so the Host can relay a native callback to its originating Capsule. The same helper works with API sources:

```ts
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { system } from '@lamarck/system';

const tools = {
  readNote: tool({
    description: 'Read a note that this App is allowed to access',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => system.vfs.command(`cat -- '${path.replaceAll("'", "'\\''")}'`),
  }),
};
const result = await system.ai.withTools({ ...selection, tools }, async ({ model, tools }) => {
  return generateText({ model, tools, prompt: 'Read the selected note.', stopWhen: stepCountIs(3) });
});
```

Consume streams inside the helper callback before returning. Tool schemas are validated with the original App schema, and tool implementations run in that App, including any nested System calls. Subscription tool results are marked provider-executed so Vercel does not execute them again. Scope exit cancels outstanding work and rejects later use of its model. No bridge retry replays tool side effects.

The callback seam supports ordinary function tools with `inputSchema` and `execute`. Subscription callbacks receive the tool-call ID and abort signal; the standard provider contract does not supply Vercel's original message/context objects, so these callback fields are empty/undefined. Use closures for App context. Approval-requiring tools, provider tools, streaming tool results, output schemas, and custom output conversion are rejected by this helper. Subscription forced-tool selection and runtime overrides are unsupported. Codex currently accepts text prompts/history and structured JSON output; unsupported file/history parts fail explicitly. API file data uses bounded bytes; remote URL inputs are rejected instead of being downloaded outside Capsule policy.

Calls keep Vercel usage, finish information, warnings, and sanitized errors. `providerMetadata.lamarck.invocationId` identifies the Host invocation. Tool writes retain the existing Guard evidence; AI call status is not added to the permanent D0 ledger. Custom HTTP headers and raw provider chunks are not exposed. Provider request/debug bodies, credentials, and CLI diagnostics do not cross the App channel. Calls are limited to eight per channel and 64 globally, with bounded event queues, a 60-second idle timeout, and a ten-minute deadline. Cancellation, disconnect, permission withdrawal, or source reconfiguration ends the corresponding work.
