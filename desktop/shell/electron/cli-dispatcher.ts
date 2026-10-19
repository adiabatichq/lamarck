import {
  HOST_CLI_OPERATIONS,
  HOST_APP_RUNTIME_OPERATIONS,
  MANAGED_CLI_OPERATIONS,
  parseCliRequest,
  parseCliResponse,
  type AppShape,
  type AppSummary,
  type AppRuntimeState,
  type AppWorkloadDiagnostic,
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
    readonly runtimeStates: () => readonly AppRuntimeState[];
    readonly setAppEnabled?: (appId: string, enabled: boolean) => Promise<unknown>;
    readonly setServiceEnabled?: (appId: string, serviceId: string, enabled: boolean) => Promise<unknown>;
    readonly workloadDiagnostics?: (appId: string) => readonly AppWorkloadDiagnostic[];
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
    if (HOST_APP_RUNTIME_OPERATIONS.includes(request.operation)) {
      return this.#dispatchAppRuntime(request, context);
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
    return { response: response.ok ? joinRuntime(response, request.operation, this.options.runtimeStates(), context.environment) : response };
  }

  async #dispatchAppRuntime(request: CliRequest, context: CliDispatchContext): Promise<CliDispatchResult> {
    const { appId, serviceId } = request.input as { appId: string; serviceId?: string };
    // Core remains authoritative for installed Apps and declared workloads.
    const inspected = await this.#executeCore({ requestId: request.requestId, operation: "app.inspect", input: { appId } }, context);
    if (!inspected.ok) return { response: inspected };
    const app = inspected.result as AppShape;
    if (serviceId && !Object.hasOwn(app.workloads?.services ?? {}, serviceId)) {
      return failure(request.requestId, "APP_SERVICE_NOT_FOUND", `Service ${serviceId} is not declared by App ${appId}.`);
    }
    try {
      if (request.operation === "app.activity") {
        if (!this.options.workloadDiagnostics) throw new Error("App diagnostics are unavailable.");
        const result = this.options.workloadDiagnostics(appId).map(boundActivityOutput);
        return { response: { requestId: request.requestId, ok: true, result } };
      }
      const enabled = request.operation === "app.enable" || request.operation === "app.service.enable";
      if (serviceId) {
        if (!this.options.setServiceEnabled) throw new Error("Service management is unavailable.");
        await this.options.setServiceEnabled(appId, serviceId, enabled);
      } else {
        if (!this.options.setAppEnabled) throw new Error("App management is unavailable.");
        await this.options.setAppEnabled(appId, enabled);
      }
      return { response: { requestId: request.requestId, ok: true, result: { appId, ...(serviceId ? { serviceId } : {}), enabled } } as CliResponse };
    } catch {
      return failure(request.requestId, "APP_RUNTIME_FAILED", "Lamarck could not confirm the App runtime operation. Inspect the App and its activity before retrying.");
    }
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
  states: readonly AppRuntimeState[],
  environment: CliEnvironment,
): CliResponse {
  if (operation !== "app.list" && operation !== "app.inspect") return response;
  const running = new Set(states.filter((state) => state.runningWorkloads > 0).map((state) => state.appId));
  if (operation === "app.list") {
    if (!Array.isArray(response.result)) return failure(response.requestId, "CLI_INTERNAL", "Lamarck returned an invalid App list.").response;
    const result = response.result.map((raw) => {
      const app = raw as AppSummary;
      return { ...app, runtime: { ...app.runtime, running: running.has(app.id) } };
    });
    return { ...response, result } as CliResponse;
  }
  const app = response.result as AppShape;
  if (!app || typeof app !== "object" || typeof app.id !== "string") {
    return failure(response.requestId, "CLI_INTERNAL", "Lamarck returned an invalid App record.").response;
  }
  const state = states.find(state => state.appId === app.id);
  const serviceIds = new Set([...Object.keys(app.workloads?.services ?? {}), ...(state?.services ?? []).map(service => service.serviceId)]);
  const runtime: AppShape["runtime"] = environment === "managed" ? { running: running.has(app.id) } : {
    running: running.has(app.id),
    enabled: app.runtime.enabled ?? state?.enabled ?? null,
    ui: state?.ui ?? "closed",
    stopping: state?.stopping ?? false,
    latestFailure: state?.latestFailure ?? null,
    jobs: state?.jobs ?? [],
    services: [...serviceIds].map(serviceId => state?.services?.find(service => service.serviceId === serviceId) ?? {
      serviceId, enabled: null, state: "unconfigured", executionId: null, restartAt: null, failure: null,
    }),
  };
  return { ...response, result: { ...app, runtime } } as CliResponse;
}

function boundActivityOutput(value: AppWorkloadDiagnostic): AppWorkloadDiagnostic {
  // Eight retained records must fit the existing 2 MiB control frame even
  // after JSON escaping. Keep a UTF-8 tail and account for discarded bytes.
  const bytes = Buffer.from(value.output, "utf8");
  let start = Math.max(0, bytes.length - 64 * 1024);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return { ...value, output: bytes.subarray(start).toString("utf8"), droppedBytes: value.droppedBytes + start };
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
