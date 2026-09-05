import {
  HOST_CLI_OPERATIONS,
  MANAGED_CLI_OPERATIONS,
  parseCliRequest,
  parseCliResponse,
  type AppShape,
  type AppSummary,
  type CliEnvironment,
  type CliHostCapabilities,
  type CliOperation,
  type CliRequest,
  type CliResponse,
} from "@lamarck/cli";
import type { Readable } from "node:stream";

export interface ManagedCliIdentity {
  readonly kind: "app";
  readonly appId: string;
  readonly workload: "ui" | `service:${string}` | `job:${string}`;
  readonly appCommit: string;
  readonly writeTables: readonly string[];
  readonly fileGrants: readonly string[];
  readonly workloadHandle: string;
}

export type CliDispatchContext =
  | { readonly environment: "host"; readonly principal: { readonly kind: "system" } }
  | { readonly environment: "managed"; readonly principal: ManagedCliIdentity };

export interface CliDispatchResult {
  readonly response: CliResponse;
}

export interface ManagedAppEditBaseV1 {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly version: string | null;
  readonly packageDigest: `sha256:${string}`;
  readonly lowerPath: string;
}

export class CliOperationDispatcher {
  constructor(private readonly options: {
    readonly coreBaseUrl: string | (() => string);
    readonly coreToken: string;
    readonly fetch?: typeof fetch;
    readonly runtimeStates: () => readonly { appId: string; runningWorkloads: number }[];
    readonly archive?: (
      request: CliRequest<"app.archive">,
      context: CliDispatchContext,
      executeCore: () => Promise<CliResponse<"app.archive">>,
    ) => Promise<CliDispatchResult>;
    readonly onAppCanonicalChange?: (
      appId?: string,
      editBase?: ManagedAppEditBaseV1,
    ) => Promise<void> | void;
  }) {}

  capabilities(environment: CliEnvironment): CliHostCapabilities {
    return Object.freeze({
      protocolVersion: 1,
      environment,
      supportedOperations: environment === "host" ? HOST_CLI_OPERATIONS : MANAGED_CLI_OPERATIONS,
    });
  }

  async dispatch(rawRequest: unknown, context: CliDispatchContext): Promise<CliDispatchResult> {
    let request: CliRequest;
    try {
      request = parseCliRequest(rawRequest, {
        allowUpload: context.environment === "managed",
        allowInlineFileBytes: true,
      });
    } catch {
      return failure("invalid", "CLI_USAGE", "The CLI request is invalid.");
    }
    const supported = context.environment === "host" ? HOST_CLI_OPERATIONS : MANAGED_CLI_OPERATIONS;
    if (!supported.includes(request.operation)) {
      return failure(request.requestId, "CLI_UNSUPPORTED_COMMAND", `${request.operation} is not available in the ${context.environment} CLI.`);
    }
    if (request.operation === "app.archive" && this.options.archive) {
      const result = await this.options.archive(
        request as CliRequest<"app.archive">,
        context,
        () => this.#executeCore(request, context) as Promise<CliResponse<"app.archive">>,
      );
      if (result.response.ok) await this.options.onAppCanonicalChange?.();
      return result;
    }
    const response = await this.#executeCore(request, context);
    if (response.ok && canonicalAppMutation(request.operation)) {
      const appId = request.operation === "app.save" || request.operation === "app.restore"
        ? (request as CliRequest<"app.save" | "app.restore">).input.appId
        : undefined;
      await this.options.onAppCanonicalChange?.(appId);
    }
    return { response: response.ok ? joinRuntime(response, request.operation, this.options.runtimeStates()) : response };
  }

  async dispatchManagedAppSave(
    request: CliRequest<"app.save">,
    identity: ManagedCliIdentity,
    body: Readable,
  ): Promise<CliDispatchResult> {
    const upload = request.upload;
    if (!upload || upload.kind !== "app-package") {
      return failure(request.requestId, "APP_INVALID", "The App package upload is invalid.");
    }
    try {
      const metadata = {
        schemaVersion: 1,
        baseVersion: upload.baseVersion,
        basePackageDigest: upload.basePackageDigest,
        archiveDigest: upload.archiveDigest,
        archiveBytes: upload.archiveBytes,
        ...request.input,
      };
      const base = typeof this.options.coreBaseUrl === "function"
        ? this.options.coreBaseUrl()
        : this.options.coreBaseUrl;
      const response = await (this.options.fetch ?? fetch)(
        `${base}/api/apps/${encodeURIComponent(request.input.appId)}/edit-package`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.coreToken}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(upload.archiveBytes),
            "X-Lamarck-App-Edit-V1": Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
            "X-Lamarck-CLI-Principal": Buffer.from(JSON.stringify(identity), "utf8").toString("base64url"),
          },
          body,
          duplex: "half",
        } as unknown as RequestInit & { duplex: "half" },
      );
      const value = await response.json().catch(() => ({})) as {
        result?: unknown;
        editBase?: unknown;
        error?: { code?: unknown; message?: unknown } | string;
      };
      if (!response.ok) {
        const rawCode = typeof value.error === "object" && value.error ? String(value.error.code ?? "CLI_INTERNAL") : "CLI_INTERNAL";
        const code = rawCode === "APP_PACKAGE_INVALID" ? "APP_INVALID" : rawCode;
        const message = typeof value.error === "object" && value.error
          ? String(value.error.message ?? "Lamarck could not save the App package.")
          : "Lamarck could not save the App package.";
        return failure(request.requestId, code, message);
      }
      const editBase = parseManagedAppEditBase(value.editBase, request.input.appId);
      return {
        response: {
          requestId: request.requestId,
          ok: true,
          result: { result: value.result, editBase },
        } as unknown as CliResponse,
      };
    } catch {
      return failure(request.requestId, "LAMARCK_NOT_RUNNING", "Lamarck is not running.");
    }
  }

  async managedAppEditBase(appId: string): Promise<ManagedAppEditBaseV1> {
    try {
      const base = typeof this.options.coreBaseUrl === "function"
        ? this.options.coreBaseUrl()
        : this.options.coreBaseUrl;
      const response = await (this.options.fetch ?? fetch)(
        `${base}/api/apps/${encodeURIComponent(appId)}/edit-base`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.coreToken}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      const value = await response.json().catch(() => ({})) as { editBase?: unknown };
      if (!response.ok || !value.editBase) throw new Error("Core returned an invalid App editing base");
      return parseManagedAppEditBase(value.editBase, appId);
    } catch (error) {
      throw new Error("Lamarck could not materialize the App editing base.", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async managedAppEditBases(): Promise<readonly ManagedAppEditBaseV1[]> {
    try {
      const base = typeof this.options.coreBaseUrl === "function"
        ? this.options.coreBaseUrl()
        : this.options.coreBaseUrl;
      const response = await (this.options.fetch ?? fetch)(`${base}/api/apps/edit-bases`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.coreToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const value = await response.json().catch(() => ({})) as { editBases?: unknown };
      if (!response.ok || !Array.isArray(value.editBases)) {
        throw new Error("Core returned an invalid App editing-base inventory");
      }
      return Object.freeze(value.editBases.map((item) => parseManagedAppEditBase(item)));
    } catch (error) {
      throw new Error("Lamarck could not publish the App workspace inventory.", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async #executeCore(request: CliRequest, context: CliDispatchContext): Promise<CliResponse> {
    try {
      const base = typeof this.options.coreBaseUrl === "function"
        ? this.options.coreBaseUrl()
        : this.options.coreBaseUrl;
      const response = await (this.options.fetch ?? fetch)(`${base}/api/cli/execute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.coreToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ request, principal: context.principal }),
      });
      const value = await response.json();
      try {
        const parsed = parseCliResponse(value, request.requestId);
        if (!response.ok && parsed.ok) {
          return failure(request.requestId, "CLI_INTERNAL", "Lamarck could not complete the command.").response;
        }
        return parsed;
      } catch {
        return failure(request.requestId, "CLI_INTERNAL", "Lamarck could not complete the command.").response;
      }
    } catch {
      return failure(request.requestId, "LAMARCK_NOT_RUNNING", "Lamarck is not running.").response;
    }
  }
}

function joinRuntime(
  response: Extract<CliResponse, { ok: true }>,
  operation: CliOperation,
  states: readonly { appId: string; runningWorkloads: number }[],
): CliResponse {
  if (operation !== "app.list" && operation !== "app.inspect") return response;
  const running = new Set(states.filter((state) => state.runningWorkloads > 0).map((state) => state.appId));
  if (operation === "app.list") {
    if (!Array.isArray(response.result)) return failure(response.requestId, "CLI_INTERNAL", "Lamarck returned an invalid App list.").response;
    const result = response.result.map((raw) => {
      const app = raw as AppSummary;
      return { ...app, runtime: { running: running.has(app.id) } };
    });
    return { ...response, result } as CliResponse;
  }
  const app = response.result as AppShape;
  if (!app || typeof app !== "object" || typeof app.id !== "string") {
    return failure(response.requestId, "CLI_INTERNAL", "Lamarck returned an invalid App record.").response;
  }
  return { ...response, result: { ...app, runtime: { running: running.has(app.id) } } } as CliResponse;
}

function failure(requestId: string, code: string, message: string): CliDispatchResult {
  return { response: { requestId, ok: false, error: { code, message } } as CliResponse };
}

function canonicalAppMutation(operation: CliOperation): boolean {
  return operation === "app.create"
    || operation === "app.save"
    || operation === "app.restore";
}

function parseManagedAppEditBase(value: unknown, expectedAppId?: string): ManagedAppEditBaseV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Core returned an invalid App editing base");
  }
  const base = value as Record<string, unknown>;
  if (Object.keys(base).sort().join(",") !== "appId,lowerPath,packageDigest,schemaVersion,version"
    || base.schemaVersion !== 1
    || typeof base.appId !== "string"
    || (expectedAppId !== undefined && base.appId !== expectedAppId)
    || base.version !== null && (typeof base.version !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(base.version))
    || typeof base.packageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(base.packageDigest)
    || typeof base.lowerPath !== "string" || !base.lowerPath.startsWith(`${base.appId}/`)) {
    throw new Error("Core returned an invalid App editing base");
  }
  return Object.freeze(base as unknown as ManagedAppEditBaseV1);
}
