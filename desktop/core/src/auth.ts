import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  APP_MANIFEST_DIGEST_PATTERN,
  type AppManifestDigest,
} from "../../capsule/src/app-manifest-authority";
import { validateFullGitCommit } from "./system-identity";
import { ENTRY_ID_PATTERN, PACKAGE_ID_PATTERN } from "./package-id";

export const APP_CAPABILITY_HEADER = "x-lamarck-app-capability";

export type AppWorkload =
  | "ui"
  | `service:${string}`
  | `job:${string}`;

export type HostAuthContext = Readonly<{ kind: "host" }>;

export type AppAuthorizationSnapshot = Readonly<{
  manifestGeneration: number;
  manifestDigest: AppManifestDigest;
  /** Host-resolved exact App activation commit; never accepted from App traffic. */
  appCommit: string;
  writeTables: readonly string[];
  fileGrants: readonly string[];
}>;

export type AppAuthContext = Readonly<{
  kind: "app";
  appId: string;
  workload: AppWorkload;
  channelId: string;
  authorization: AppAuthorizationSnapshot;
}>;

export type AuthContext = HostAuthContext | AppAuthContext;

export interface AuthSecrets {
  coreToken: string;
}

export type IssuedAppCapability = Readonly<{
  capability: string;
  channelId: string;
  manifestGeneration: number;
  manifestDigest: AppManifestDigest;
}>;

interface StoredChannel {
  readonly digest: string;
  readonly context: AppAuthContext;
  open: boolean;
  activeRequests: number;
  drainPromise: Promise<void> | null;
  resolveDrain: (() => void) | null;
  readonly controller: AbortController;
}

export type AuthAdmission = Readonly<{
  context: AuthContext;
  /** Aborts synchronously when the issuing channel is revoked. */
  signal: AbortSignal;
  release: () => void;
}>;

const RAW_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HOST_CONTEXT: HostAuthContext = Object.freeze({ kind: "host" });
const HOST_SIGNAL = new AbortController().signal;
const HOST_ADMISSION: AuthAdmission = Object.freeze({
  context: HOST_CONTEXT,
  signal: HOST_SIGNAL,
  release() {},
});

/**
 * Host-owned registry for launch-bound App capabilities.
 *
 * The raw capability is returned once to the Host. The registry retains only
 * its digest, so inspecting Core-owned registry state cannot recover a bearer
 * capability. App identity is stored alongside that digest and never read from
 * request headers or request bodies.
 */
export class AppCapabilityRegistry {
  #channelsByDigest = new Map<string, StoredChannel>();
  #channelsById = new Map<string, StoredChannel>();
  #channelDeletedListeners = new Set<(channelId: string) => void>();
  #invalidManifestGeneration = 0;

  get size(): number {
    return this.#channelsByDigest.size;
  }

  isOpen(channelId: string): boolean {
    return this.#channelsById.get(channelId)?.open === true;
  }

  onChannelDeleted(listener: (channelId: string) => void): () => void {
    this.#channelDeletedListeners.add(listener);
    return () => this.#channelDeletedListeners.delete(listener);
  }

  issue(
    appId: string,
    workload: AppWorkload,
    authorization: AppAuthorizationSnapshot,
  ): IssuedAppCapability {
    validateAppIdentity(appId, workload);
    const frozenAuthorization = freezeAuthorizationSnapshot(authorization);
    if (frozenAuthorization.manifestGeneration <= this.#invalidManifestGeneration) {
      throw new Error(
        `App manifest generation ${frozenAuthorization.manifestGeneration} is no longer active`,
      );
    }

    let capability: string;
    let digest: string;
    do {
      capability = randomBytes(32).toString("base64url");
      digest = digestCapability(capability);
    } while (this.#channelsByDigest.has(digest));

    let channelId: string;
    do {
      channelId = `appch_${randomBytes(16).toString("base64url")}`;
    } while (this.#channelsById.has(channelId));

    const context: AppAuthContext = Object.freeze({
      kind: "app",
      appId,
      workload,
      channelId,
      authorization: frozenAuthorization,
    });
    const channel: StoredChannel = {
      digest,
      context,
      open: true,
      activeRequests: 0,
      drainPromise: null,
      resolveDrain: null,
      controller: new AbortController(),
    };
    this.#channelsByDigest.set(digest, channel);
    this.#channelsById.set(channelId, channel);

    return Object.freeze({
      capability,
      channelId,
      manifestGeneration: frozenAuthorization.manifestGeneration,
      manifestDigest: frozenAuthorization.manifestDigest,
    });
  }

  admit(capability: string): AuthAdmission | null {
    if (!RAW_CAPABILITY_PATTERN.test(capability)) return null;
    const channel = this.#channelsByDigest.get(digestCapability(capability));
    if (!channel?.open) return null;

    channel.activeRequests++;
    let released = false;
    return Object.freeze({
      context: channel.context,
      signal: channel.controller.signal,
      release: () => {
        if (released) return;
        released = true;
        channel.activeRequests--;
        if (channel.activeRequests === 0 && !channel.open) {
          channel.resolveDrain?.();
          channel.resolveDrain = null;
        }
      },
    });
  }

  async revoke(channelId: string): Promise<boolean> {
    const channel = this.#channelsById.get(channelId);
    if (!channel) return false;
    const newlyClosed = this.#close(channel);
    await this.#drain(channel);
    this.#deleteDrained(channel);
    return newlyClosed;
  }

  async revokeApp(appId: string): Promise<number> {
    const channels = [...this.#channelsById.values()].filter(
      ({ context }) => context.appId === appId,
    );
    let newlyClosed = 0;
    for (const channel of channels) {
      if (this.#close(channel)) newlyClosed++;
    }
    await Promise.all(channels.map((channel) => this.#drain(channel)));
    for (const channel of channels) this.#deleteDrained(channel);
    return newlyClosed;
  }

  /**
   * Atomically retires a manifest generation before waiting for its requests.
   * Calls to issue() for that generation fail closed even while drain is in
   * progress, preventing a reload/issuance race from reviving old authority.
   */
  async invalidateManifestGeneration(manifestGeneration: number): Promise<number> {
    if (!Number.isSafeInteger(manifestGeneration) || manifestGeneration < 1) {
      throw new Error("manifestGeneration must be a positive safe integer");
    }
    this.#invalidManifestGeneration = Math.max(
      this.#invalidManifestGeneration,
      manifestGeneration,
    );
    const channels = [...this.#channelsById.values()].filter(
      ({ context }) => context.authorization.manifestGeneration <= manifestGeneration,
    );
    let newlyClosed = 0;
    for (const channel of channels) {
      if (this.#close(channel)) newlyClosed++;
    }
    await Promise.all(channels.map((channel) => this.#drain(channel)));
    for (const channel of channels) this.#deleteDrained(channel);
    return newlyClosed;
  }

  #close(channel: StoredChannel): boolean {
    if (!channel.open) return false;
    channel.open = false;
    channel.controller.abort(new Error("App capability was revoked"));
    this.#channelsByDigest.delete(channel.digest);
    if (channel.activeRequests > 0 && !channel.drainPromise) {
      channel.drainPromise = new Promise<void>((resolve) => {
        channel.resolveDrain = resolve;
      });
    }
    return true;
  }

  async #drain(channel: StoredChannel): Promise<void> {
    if (channel.activeRequests === 0) return;
    await channel.drainPromise;
  }

  #deleteDrained(channel: StoredChannel): void {
    if (channel.open || channel.activeRequests !== 0) return;
    if (!this.#channelsById.delete(channel.context.channelId)) return;
    for (const listener of this.#channelDeletedListeners) {
      listener(channel.context.channelId);
    }
  }
}

export function requireSecret(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function admitRequest(
  req: Request,
  secrets: AuthSecrets,
  appCapabilities?: AppCapabilityRegistry,
): AuthAdmission | null {
  const authorization = req.headers.get("authorization");
  const bearerPrefix = "Bearer ";
  if (
    authorization?.startsWith(bearerPrefix)
    && secretEquals(authorization.slice(bearerPrefix.length), secrets.coreToken)
  ) {
    return HOST_ADMISSION;
  }

  const capability = req.headers.get(APP_CAPABILITY_HEADER);
  if (!capability || !appCapabilities) return null;
  return appCapabilities.admit(capability);
}

function digestCapability(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("base64url");
}

function secretEquals(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

function validateAppIdentity(appId: string, workload: AppWorkload): void {
  if (!PACKAGE_ID_PATTERN.test(appId)) {
    throw new Error(`Invalid app id: ${appId}`);
  }
  if (workload === "ui") return;

  const separator = workload.indexOf(":");
  const kind = workload.slice(0, separator);
  const entryId = workload.slice(separator + 1);
  if ((kind !== "service" && kind !== "job") || !ENTRY_ID_PATTERN.test(entryId)) {
    throw new Error(`Invalid app workload: ${workload}`);
  }
}

function freezeAuthorizationSnapshot(
  authorization: AppAuthorizationSnapshot,
): AppAuthorizationSnapshot {
  if (
    !Number.isSafeInteger(authorization.manifestGeneration)
    || authorization.manifestGeneration < 1
  ) {
    throw new Error("manifestGeneration must be a positive safe integer");
  }
  if (!APP_MANIFEST_DIGEST_PATTERN.test(authorization.manifestDigest)) {
    throw new Error("manifestDigest must be a canonical sha256 digest");
  }
  if (
    !Array.isArray(authorization.writeTables)
    || authorization.writeTables.some((table) => typeof table !== "string")
    || !Array.isArray(authorization.fileGrants)
    || authorization.fileGrants.some((grant) => typeof grant !== "string")
  ) {
    throw new Error("App authorization grants must be string arrays");
  }
  return Object.freeze({
    manifestGeneration: authorization.manifestGeneration,
    manifestDigest: authorization.manifestDigest,
    appCommit: validateFullGitCommit(authorization.appCommit, "App authorization commit"),
    writeTables: Object.freeze([...authorization.writeTables]),
    fileGrants: Object.freeze([...authorization.fileGrants]),
  });
}
