import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import {
  APP_EDIT_ROOT_PATH,
  encodeAppCliFrame,
  isCanonicalAppPackageId,
  parseAppCliRequest,
  type AppCliRequestV1,
  type AppCliResponseV1,
  type AppEditBaseDescriptorV1,
} from "../../../capsule/src/app-edit/protocol";
import { AppCliStreamReader, writeAppCliBytes } from "../../../capsule/src/app-edit/stream";

const MAX_UPLOAD_BYTES = 1536 * 1024 * 1024;

export interface AppCliWorkloadIdentityV1 {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly workloadHandle: string;
}

/** Terminates the workload-bound private App CLI stream in the trusted Host. */
export class AppCliStreamServer {
  constructor(private readonly options: {
    readonly coreBaseUrl: string | (() => string);
    readonly coreToken: string;
    readonly fetch?: typeof fetch;
  }) {}

  attach(identity: AppCliWorkloadIdentityV1, stream: Duplex): () => void {
    validateIdentity(identity);
    let closed = false;
    const reader = new AppCliStreamReader(stream);
    const run = async () => {
      while (!closed && !stream.destroyed) {
        let request: AppCliRequestV1;
        try {
          request = parseAppCliRequest(await reader.readFrame(), true);
        } catch (error) {
          if (stream.readableEnded || stream.destroyed) return;
          throw error;
        }
        const response = await this.#handle(request, reader, identity);
        await writeAppCliBytes(stream, encodeAppCliFrame(response));
      }
    };
    void run().catch((error) => {
      if (!stream.destroyed) stream.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    return () => {
      if (closed) return;
      closed = true;
      if (!stream.destroyed) stream.destroy();
    };
  }

  async #handle(
    request: AppCliRequestV1,
    reader: AppCliStreamReader,
    _identity: AppCliWorkloadIdentityV1,
  ): Promise<AppCliResponseV1> {
    try {
      switch (request.operation) {
        case "app.list": {
          const inventory = await this.#json("/api/apps", { method: "GET" }) as { apps?: unknown };
          if (!Array.isArray(inventory.apps)) throw new Error("Core returned invalid App inventory");
          const items = await Promise.all(inventory.apps.map(async (raw) => {
            if (!raw || typeof raw !== "object") throw new Error("Core returned invalid App inventory");
            const app = raw as { id?: unknown; name?: unknown; version?: unknown };
            const appId = requireAppId(app.id);
            const editBase = await this.#editBase(appId);
            return {
              schemaVersion: 1,
              id: appId,
              name: typeof app.name === "string" ? app.name : appId,
              path: `${APP_EDIT_ROOT_PATH}/${appId}`,
              version: editBase.version,
              editBase,
            };
          }));
          return success(request, items);
        }
        case "app.save": {
          const appId = requireAppId(request.input.appId);
          const upload = request.upload;
          if (!upload || upload.archiveBytes > MAX_UPLOAD_BYTES) {
            throw coded("APP_PACKAGE_INVALID", "App package upload is outside the V1 bound");
          }
          const metadata = {
            schemaVersion: 1,
            baseVersion: upload.baseVersion,
            basePackageDigest: upload.basePackageDigest,
            archiveDigest: upload.archiveDigest,
            archiveBytes: upload.archiveBytes,
            ...(request.input.message === undefined ? {} : { message: requireText(request.input.message, "message") }),
            ...(request.input.author === undefined ? {} : { author: requireText(request.input.author, "author") }),
          };
          const body = Readable.from(readUpload(reader, upload.archiveBytes));
          const result = await this.#json(`/api/apps/${encodeURIComponent(appId)}/edit-package`, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(upload.archiveBytes),
              "X-Lamarck-App-Edit-V1": Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
            },
            body,
            duplex: "half",
          } as unknown as RequestInit & { duplex: "half" });
          return success(request, result);
        }
        case "app.versions": {
          const appId = requireAppId(request.input.appId);
          const versions: unknown[] = [];
          const seenCursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const query = new URLSearchParams({ limit: "100" });
            if (cursor !== null) query.set("cursor", cursor);
            const page = await this.#json(
              `/api/apps/${encodeURIComponent(appId)}/versions?${query}`,
              { method: "GET" },
            ) as { versions?: unknown; nextCursor?: unknown };
            if (
              !Array.isArray(page.versions)
              || (page.nextCursor !== null && typeof page.nextCursor !== "string")
            ) throw new Error("Core returned an invalid App version page");
            versions.push(...page.versions);
            cursor = page.nextCursor;
            if (cursor !== null && seenCursors.has(cursor)) {
              throw new Error("Core returned a repeated App version cursor");
            }
            if (cursor !== null) seenCursors.add(cursor);
          } while (cursor !== null);
          return success(request, versions);
        }
        case "app.restore": {
          const appId = requireAppId(request.input.appId);
          const result = await this.#json(`/api/apps/${encodeURIComponent(appId)}/restore`, {
            method: "POST",
            body: JSON.stringify({
              version: requireText(request.input.version, "version"),
              ...(request.input.message === undefined ? {} : { message: requireText(request.input.message, "message") }),
              ...(request.input.author === undefined ? {} : { author: requireText(request.input.author, "author") }),
            }),
          });
          return success(request, { result, editBase: await this.#editBase(appId) });
        }
        case "app.refresh": {
          const appId = requireAppId(request.input.appId);
          return success(request, { result: { refreshed: true }, editBase: await this.#editBase(appId) });
        }
      }
    } catch (error) {
      return failure(request, error);
    }
  }

  async #editBase(appId: string): Promise<AppEditBaseDescriptorV1> {
    const value = await this.#json(`/api/apps/${encodeURIComponent(appId)}/edit-base`, {
      method: "POST",
      body: "{}",
    }) as { editBase?: AppEditBaseDescriptorV1 };
    if (!value.editBase || value.editBase.schemaVersion !== 1 || value.editBase.appId !== appId) {
      throw new Error("Core returned an invalid App editing base");
    }
    return value.editBase;
  }

  async #json(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.options.coreToken}`);
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const base = typeof this.options.coreBaseUrl === "function"
      ? this.options.coreBaseUrl()
      : this.options.coreBaseUrl;
    const response = await (this.options.fetch ?? globalThis.fetch)(`${base}${path}`, { ...init, headers });
    const value = await response.json().catch(() => ({})) as { error?: unknown };
    if (!response.ok) {
      const detail = value.error;
      if (detail && typeof detail === "object") {
        const error = detail as { code?: unknown; message?: unknown };
        throw coded(
          typeof error.code === "string" ? error.code : "APP_CORE_ERROR",
          typeof error.message === "string" ? error.message : `Core returned HTTP ${response.status}`,
        );
      }
      throw coded("APP_CORE_ERROR", typeof detail === "string" ? detail : `Core returned HTTP ${response.status}`);
    }
    return value;
  }
}

async function* readUpload(reader: AppCliStreamReader, bytes: number): AsyncIterable<Buffer> {
  let remaining = bytes;
  while (remaining > 0) {
    const chunk = await reader.readExact(Math.min(64 * 1024, remaining));
    remaining -= chunk.byteLength;
    yield chunk;
  }
}

function success(request: AppCliRequestV1, result: unknown): AppCliResponseV1 {
  return { version: 1, requestId: request.requestId, ok: true, result };
}

function failure(request: AppCliRequestV1, error: unknown): AppCliResponseV1 {
  return {
    version: 1,
    requestId: request.requestId,
    ok: false,
    error: {
      code: error instanceof BrokerError ? error.code : "APP_INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "App CLI operation failed",
    },
  };
}

class BrokerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function coded(code: string, message: string): BrokerError { return new BrokerError(code, message); }

function validateIdentity(value: AppCliWorkloadIdentityV1): void {
  if (
    value.schemaVersion !== 1
    || !isCanonicalAppPackageId(value.appId)
    || typeof value.workloadHandle !== "string"
    || value.workloadHandle.length < 1
  ) throw new Error("Invalid workload-bound App CLI identity");
}

function requireAppId(value: unknown): string {
  if (!isCanonicalAppPackageId(value)) {
    throw coded("APP_NOT_FOUND", "A valid App id is required");
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.trim() !== value) {
    throw coded("APP_PACKAGE_INVALID", `${field} must be non-empty trimmed text`);
  }
  return value;
}
