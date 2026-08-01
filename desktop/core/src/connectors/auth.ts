import { createHash, randomBytes } from "crypto";
import {
  CredentialStore,
  MemorySecretStore,
  type LamarckSessionManager,
  type CredentialRecord,
  type SecretStore,
} from "../credentials";
import {
  isOAuthAuthSpec,
  type ConnectorAuthHandle,
  type ConnectorAuthSpec,
  type ConnectorSource,
  type ConnectorManagedProviderAuthSpec,
  type ConnectorOAuthAuthSpec,
  type ConnectorOAuthDirectAuthSpec,
} from "./types";
import { defaultAuthRef } from "./state";

export type OAuthAttemptStatus = "pending" | "connected" | "failed" | "expired";

export interface OAuthStartResult {
  authorizationUrl: string;
  attemptId: string;
  redirectUri?: string;
  expiresAt: number;
}

export interface OAuthAttemptView {
  status: OAuthAttemptStatus;
  attemptId?: string;
  sourceId?: string;
  authRef?: string;
  credentialId?: string;
  error?: string;
}

type SecretPayload =
  | { kind: "apiKey"; value: string }
  | {
      kind: "oauth2";
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      tokenType?: string;
    }
  | {
      kind: "managedProvider";
      providerId: string;
      sourceId: string;
    };

interface OAuthAttempt {
  id: string;
  sourceId: string;
  authRef: string;
  auth: ConnectorOAuthDirectAuthSpec;
  ownerType: string;
  ownerId: string;
  clientId: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
  generation: number;
  status: OAuthAttemptStatus;
  terminalAt?: number;
  finalizationClaimed?: boolean;
  credentialId?: string;
  error?: string;
}

interface ManagedProviderAttempt {
  id: string;
  sourceId: string;
  authRef: string;
  providerId: string;
  expiresAt: number;
  generation: number;
  status: OAuthAttemptStatus;
  terminalAt?: number;
  finalizationClaimed?: boolean;
  credentialId?: string;
  error?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

// Shape of the Lamarck backend's capability-token response. These are wire
// field names owned by the backend, not internal vocabulary: `integrationId`
// stays because the two sides deploy independently and renaming one alone
// makes every token fail validation below.
interface ManagedProviderCapabilityToken {
  tokenType: "Bearer";
  accessToken: string;
  expiresAt: string;
  providerId: string;
  integrationId: string;
}

type LamarckSessionCapability =
  Pick<LamarckSessionManager, "accessToken" | "clearLocalSession">
  & Partial<Pick<LamarckSessionManager, "session" | "startLogin">>;

class ManagedProviderNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedProviderNotConnectedError";
  }
}

interface ConnectorAuthManagerOptions {
  credentialStore?: CredentialStore;
  fetchImpl?: typeof fetch;
  refreshSkewMs?: number;
  attemptTtlMs?: number;
  now?: () => number;
  managedProviderApiOrigin?: string;
  lamarckSession?: LamarckSessionCapability;
}

export class ConnectorAuthManager {
  private credentialStore: CredentialStore | undefined;
  private fetchImpl: typeof fetch;
  private refreshSkewMs: number;
  private attemptTtlMs: number;
  private now: () => number;
  private managedProviderApiOrigin: string | undefined;
  private lamarckSession: LamarckSessionCapability | undefined;
  private attemptsById = new Map<string, OAuthAttempt>();
  private attemptsByState = new Map<string, OAuthAttempt>();
  private managedAttemptsById = new Map<string, ManagedProviderAttempt>();
  private removedSourceIds = new Set<string>();
  private authGenerationBySource = new Map<string, number>();
  private credentialRefsBySource = new Map<string, Set<string>>();
  private refreshFlights = new Map<string, Promise<string>>();

  constructor(
    private secrets: SecretStore = new MemorySecretStore(),
    opts: ConnectorAuthManagerOptions = {},
  ) {
    this.credentialStore = opts.credentialStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.refreshSkewMs = opts.refreshSkewMs ?? 60_000;
    this.attemptTtlMs = opts.attemptTtlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    this.managedProviderApiOrigin = opts.managedProviderApiOrigin;
    this.lamarckSession = opts.lamarckSession;
  }

  async setToken(
    authRef: string,
    token: string,
    opts?: {
      ownerType?: string;
      ownerId?: string;
      scopes?: string[];
      metadata?: Record<string, unknown>;
      generation?: number;
    },
  ): Promise<void> {
    if (opts?.ownerType === "connector" && opts.ownerId) {
      this.assertSourceAuthActive(opts.ownerId, opts.generation);
    }
    await this.writePayload(authRef, { kind: "apiKey", value: token });
    if (opts?.ownerType === "connector" && opts.ownerId) {
      try {
        this.assertSourceAuthActive(opts.ownerId, opts.generation);
      } catch (err) {
        await this.deleteToken(authRef);
        throw err;
      }
    }
    this.trackSourceCredential(opts?.ownerType, opts?.ownerId, authRef);
    this.credentialStore?.upsert({
      id: authRef,
      kind: "apiKey",
      ownerType: opts?.ownerType ?? "connector",
      ownerId: opts?.ownerId ?? authRef,
      scopes: opts?.scopes,
      status: "active",
      secretItemId: authRef,
      metadata: opts?.metadata,
    });
  }

  async deleteToken(authRef: string): Promise<void> {
    this.credentialStore?.delete(authRef);
    // CredentialStore normally removes the backing secret too. Always ask the
    // SecretStore as well so an auth write that was cancelled between its
    // async payload write and metadata upsert cannot leave an orphan secret.
    await this.secrets.delete(authRef);
  }

  async deleteSourceCredentials(sourceId: string, currentAuthRef?: string): Promise<void> {
    const refs = new Set(
      this.credentialStore
        ?.listByOwner("connector", sourceId)
        .map((credential) => credential.id) ?? [],
    );
    for (const ref of this.credentialRefsBySource.get(sourceId) ?? []) refs.add(ref);
    if (currentAuthRef) refs.add(currentAuthRef);
    for (const ref of refs) {
      await this.deleteToken(ref);
    }
    this.credentialRefsBySource.delete(sourceId);
  }

  currentSourceAuthGeneration(sourceId: string): number {
    return this.authGenerationBySource.get(sourceId) ?? 0;
  }

  cancelAttemptsForSource(sourceId: string, opts?: { removed?: boolean }): void {
    this.authGenerationBySource.set(
      sourceId,
      this.currentSourceAuthGeneration(sourceId) + 1,
    );
    if (opts?.removed) this.removedSourceIds.add(sourceId);
    for (const [attemptId, attempt] of this.attemptsById) {
      if (attempt.sourceId !== sourceId) continue;
      attempt.status = "failed";
      attempt.error = "Source was removed during authentication";
      this.attemptsById.delete(attemptId);
      this.attemptsByState.delete(attempt.state);
    }
    for (const [attemptId, attempt] of this.managedAttemptsById) {
      if (attempt.sourceId === sourceId) {
        attempt.status = "failed";
        attempt.error = "Source was removed during authentication";
        this.managedAttemptsById.delete(attemptId);
      }
    }
  }

  async hasToken(authRef: string): Promise<boolean> {
    const credential = this.credentialStore?.get(authRef);
    if (credential && (credential.status === "revoked" || credential.status === "refresh_failed")) {
      return false;
    }
    if (this.secrets.has) return this.secrets.has(authRef);
    return Boolean(await this.secrets.get(authRef));
  }

  credential(authRef: string): CredentialRecord | undefined {
    return this.credentialStore?.get(authRef);
  }

  startOAuth(
    sourceRecord: ConnectorSource,
    auth: ConnectorOAuthAuthSpec,
    input: { redirectUri: string },
  ): OAuthStartResult {
    const now = this.now();
    this.pruneAuthAttempts(now);
    const codeVerifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(32));
    const attemptId = base64url(randomBytes(16));
    const expiresAt = now + this.attemptTtlMs;
    const authRef = sourceRecord.authRef ?? defaultAuthRef(sourceRecord.id);
    const attempt: OAuthAttempt = {
      id: attemptId,
      sourceId: sourceRecord.id,
      authRef,
      auth,
      ownerType: "connector",
      ownerId: sourceRecord.id,
      clientId: auth.clientId,
      codeVerifier,
      state,
      redirectUri: input.redirectUri,
      expiresAt,
      generation: this.currentSourceAuthGeneration(sourceRecord.id),
      status: "pending",
    };
    this.attemptsById.set(attemptId, attempt);
    this.attemptsByState.set(state, attempt);

    const url = new URL(auth.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", auth.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (auth.scope?.length) {
      url.searchParams.set("scope", auth.scope.join(" "));
    }

    return {
      authorizationUrl: url.toString(),
      attemptId,
      redirectUri: input.redirectUri,
      expiresAt,
    };
  }

  async startManagedProvider(
    sourceRecord: ConnectorSource,
    auth: ConnectorManagedProviderAuthSpec,
    input: { appOrigin: string },
  ): Promise<OAuthStartResult> {
    const now = this.now();
    this.pruneAuthAttempts(now);
    const attemptId = base64url(randomBytes(16));
    const expiresAt = now + this.attemptTtlMs;
    const authRef = sourceRecord.authRef ?? defaultAuthRef(sourceRecord.id);
    const attempt: ManagedProviderAttempt = {
      id: attemptId,
      sourceId: sourceRecord.id,
      authRef,
      providerId: auth.providerId,
      expiresAt,
      generation: this.currentSourceAuthGeneration(sourceRecord.id),
      status: "pending",
    };
    this.managedAttemptsById.set(attemptId, attempt);

    const url = new URL(`/providers/${encodeURIComponent(auth.providerId)}/connect`, normalizeOrigin(input.appOrigin));
    // Wire field, not an internal name: the Lamarck web app reads
    // `integrationId` from this URL. Renaming it here alone breaks the hosted
    // OAuth flow, since the two sides ship and deploy independently.
    url.searchParams.set("integrationId", sourceRecord.id);
    url.searchParams.set("start", "1");
    let authorizationUrl = url.toString();
    if (this.lamarckSession?.session && this.lamarckSession.startLogin) {
      const session = await this.lamarckSession.session().catch(() => ({ status: "signed_out" as const }));
      if (session.status !== "signed_in") {
        authorizationUrl = this.lamarckSession.startLogin({ nextUrl: authorizationUrl }).authorizationUrl;
      }
    }

    return {
      authorizationUrl,
      attemptId,
      expiresAt,
    };
  }

  async getOAuthAttempt(sourceId: string, attemptId: string): Promise<OAuthAttemptView> {
    const now = this.now();
    this.pruneAuthAttempts(now);
    const attempt = this.attemptsById.get(attemptId);
    if (!attempt) {
      return this.getManagedProviderAttempt(sourceId, attemptId, now);
    }
    if (attempt.sourceId !== sourceId) {
      return { status: "failed", error: "Auth attempt not found" };
    }
    if (attempt.status === "pending" && now > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.terminalAt = now;
      attempt.error = "OAuth attempt expired";
      this.attemptsByState.delete(attempt.state);
      const result: OAuthAttemptView = {
        status: attempt.status,
        attemptId: attempt.id,
        sourceId: attempt.sourceId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
      // Poll-observed expiry is a cancellation boundary. Invalidate the
      // generation before Supervisor releases the identity fence so a callback
      // already awaiting token exchange cannot commit after expiry.
      this.cancelAttemptsForSource(attempt.sourceId);
      return result;
    }
    return {
      status: attempt.status,
      attemptId: attempt.id,
      sourceId: attempt.sourceId,
      authRef: attempt.authRef,
      credentialId: attempt.credentialId,
      error: attempt.error,
    };
  }

  claimConnectedAttemptFinalization(attemptId: string): boolean {
    const attempt = this.authAttemptById(attemptId);
    if (
      !attempt
      || attempt.status !== "connected"
      || attempt.finalizationClaimed
    ) {
      return false;
    }
    attempt.finalizationClaimed = true;
    return true;
  }

  releaseConnectedAttemptFinalization(attemptId: string): void {
    const attempt = this.authAttemptById(attemptId);
    if (attempt?.status === "connected") {
      attempt.finalizationClaimed = false;
    }
  }

  private async getManagedProviderAttempt(
    sourceId: string,
    attemptId: string,
    now: number,
  ): Promise<OAuthAttemptView> {
    const attempt = this.managedAttemptsById.get(attemptId);
    if (!attempt || attempt.sourceId !== sourceId) {
      return { status: "failed", error: "Auth attempt not found" };
    }
    if (attempt.status === "pending" && now > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.terminalAt = now;
      attempt.error = "Managed provider auth attempt expired";
      const result: OAuthAttemptView = {
        status: attempt.status,
        attemptId: attempt.id,
        sourceId: attempt.sourceId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
      this.cancelAttemptsForSource(attempt.sourceId);
      return result;
    }
    if (attempt.status === "pending") {
      try {
        await this.fetchManagedProviderCapability(attempt.providerId, attempt.sourceId);
        this.assertSourceAuthActive(attempt.sourceId, attempt.generation);
        await this.persistManagedProviderBinding(attempt.authRef, {
          providerId: attempt.providerId,
          sourceId: attempt.sourceId,
          ownerId: attempt.sourceId,
          generation: attempt.generation,
        });
        attempt.status = "connected";
        attempt.terminalAt = this.now();
        attempt.credentialId = attempt.authRef;
      } catch (err) {
        if (!this.isSourceAuthGenerationCurrent(
          attempt.sourceId,
          attempt.generation,
        )) {
          return {
            status: "failed",
            attemptId: attempt.id,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        if (!(err instanceof ManagedProviderNotConnectedError) && !isLamarckSessionNotSignedInError(err)) {
          attempt.status = "failed";
          attempt.terminalAt = this.now();
          attempt.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
    return {
      status: attempt.status,
      attemptId: attempt.id,
      sourceId: attempt.sourceId,
      authRef: attempt.authRef,
      credentialId: attempt.credentialId,
      error: attempt.error,
    };
  }

  private authAttemptById(
    attemptId: string,
  ): OAuthAttempt | ManagedProviderAttempt | undefined {
    return this.attemptsById.get(attemptId)
      ?? this.managedAttemptsById.get(attemptId);
  }

  private pruneAuthAttempts(now: number): void {
    // Pending attempts remain pollable for one TTL after expiry, and terminal
    // attempts for one TTL after completion. The finalization claim lives on
    // the attempt record, so pruning the attempt also prunes its dedup state.
    for (const [attemptId, attempt] of this.attemptsById) {
      const retentionStartedAt = attempt.terminalAt ?? attempt.expiresAt;
      if (now <= retentionStartedAt + this.attemptTtlMs) continue;
      this.attemptsById.delete(attemptId);
      this.attemptsByState.delete(attempt.state);
    }
    for (const [attemptId, attempt] of this.managedAttemptsById) {
      const retentionStartedAt = attempt.terminalAt ?? attempt.expiresAt;
      if (now > retentionStartedAt + this.attemptTtlMs) {
        this.managedAttemptsById.delete(attemptId);
      }
    }
  }

  async completeOAuthCallback(params: URLSearchParams): Promise<OAuthAttemptView> {
    const state = params.get("state") ?? "";
    const code = params.get("code") ?? "";
    const providerError = params.get("error");
    const now = this.now();
    this.pruneAuthAttempts(now);
    const attempt = this.attemptsByState.get(state);
    if (!attempt || attempt.status !== "pending") {
      return { status: "failed", error: "OAuth state is invalid or already used" };
    }
    this.attemptsByState.delete(state);
    if (now > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.terminalAt = now;
      attempt.error = "OAuth attempt expired";
      const result: OAuthAttemptView = {
        status: "expired",
        attemptId: attempt.id,
        sourceId: attempt.sourceId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
      this.cancelAttemptsForSource(attempt.sourceId);
      return result;
    }
    if (providerError) {
      attempt.status = "failed";
      attempt.terminalAt = now;
      attempt.error = params.get("error_description") ?? providerError;
      return {
        status: "failed",
        attemptId: attempt.id,
        sourceId: attempt.sourceId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }
    if (!code) {
      attempt.status = "failed";
      attempt.terminalAt = now;
      attempt.error = "OAuth callback did not include a code";
      return {
        status: "failed",
        attemptId: attempt.id,
        sourceId: attempt.sourceId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }

    try {
      const token = await this.exchangeCode(attempt, code);
      this.assertSourceAuthActive(attempt.sourceId, attempt.generation);
      await this.persistOAuthToken(attempt, token);
      attempt.status = "connected";
      attempt.terminalAt = this.now();
      attempt.credentialId = attempt.authRef;
      return {
        status: "connected",
        attemptId: attempt.id,
        sourceId: attempt.sourceId,
        authRef: attempt.authRef,
        credentialId: attempt.authRef,
      };
    } catch (err) {
      attempt.status = "failed";
      attempt.terminalAt = this.now();
      attempt.error = err instanceof Error ? err.message : String(err);
      if (!this.isSourceAuthGenerationCurrent(
        attempt.sourceId,
        attempt.generation,
      )) {
        return {
          status: "failed",
          attemptId: attempt.id,
          error: attempt.error,
        };
      }
      return {
        status: "failed",
        attemptId: attempt.id,
        sourceId: attempt.sourceId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }
  }

  createHandle(auth: ConnectorAuthSpec, sourceRecord: ConnectorSource): ConnectorAuthHandle {
    if (auth.type === "none") {
      return { type: "none" };
    }

    const authRef = sourceRecord.authRef;
    if (!authRef) {
      throw new Error(`Connector Source ${sourceRecord.id} requires auth_ref`);
    }

    const getToken = async (): Promise<string> => {
      const payload = await this.readPayload(authRef);
      if (!payload) {
        throw new Error(`Connector Source ${sourceRecord.id} is missing credentials`);
      }
      if (auth.type === "apiKey") {
        if (payload.kind !== "apiKey") {
          throw new Error(`Connector Source ${sourceRecord.id} credential kind mismatch`);
        }
        return payload.value;
      }
      if (auth.type === "managedProvider") {
        if (payload.kind !== "managedProvider") {
          throw new Error(`Connector Source ${sourceRecord.id} credential kind mismatch`);
        }
        return this.managedProviderAccessToken(authRef, auth, sourceRecord.id, payload);
      }
      if (!isOAuthAuthSpec(auth) || payload.kind !== "oauth2") {
        throw new Error(`Connector Source ${sourceRecord.id} credential kind mismatch`);
      }
      return this.oauthAccessToken(authRef, auth, payload, sourceRecord.id);
    };

    if (auth.type === "managedProvider") {
      if (!this.managedProviderApiOrigin) {
        throw managedProviderUnavailable(sourceRecord.connectorId);
      }
      return {
        type: "managedProvider",
        getToken,
        providerOrigin: this.managedProviderApiOrigin,
      };
    }

    return {
      type: auth.type === "apiKey" ? "apiKey" : "oauth2",
      getToken,
    };
  }

  private async oauthAccessToken(
    authRef: string,
    auth: ConnectorOAuthAuthSpec,
    payload: Extract<SecretPayload, { kind: "oauth2" }>,
    sourceId: string,
  ): Promise<string> {
    if (!payload.expiresAt || payload.expiresAt - this.now() > this.refreshSkewMs) {
      return payload.accessToken;
    }
    const existing = this.refreshFlights.get(authRef);
    if (existing) return existing;
    const generation = this.currentSourceAuthGeneration(sourceId);
    const flight = this.refreshOAuthToken(authRef, auth, payload, sourceId, generation)
      .finally(() => this.refreshFlights.delete(authRef));
    this.refreshFlights.set(authRef, flight);
    return flight;
  }

  private async managedProviderAccessToken(
    authRef: string,
    auth: ConnectorManagedProviderAuthSpec,
    sourceId: string,
    payload: Extract<SecretPayload, { kind: "managedProvider" }>,
  ): Promise<string> {
    if (payload.providerId !== auth.providerId) {
      throw new Error(`Managed provider credential is for ${payload.providerId}, not ${auth.providerId}`);
    }
    if (payload.sourceId !== sourceId) {
      throw new Error(`Managed provider credential is for Source ${payload.sourceId}, not ${sourceId}`);
    }
    const existing = this.refreshFlights.get(authRef);
    if (existing) return existing;
    const generation = this.currentSourceAuthGeneration(sourceId);
    const flight = this.issueManagedProviderToken(authRef, auth, sourceId, generation)
      .finally(() => this.refreshFlights.delete(authRef));
    this.refreshFlights.set(authRef, flight);
    return flight;
  }

  private async issueManagedProviderToken(
    authRef: string,
    auth: ConnectorManagedProviderAuthSpec,
    sourceId: string,
    generation: number,
  ): Promise<string> {
    try {
      const token = await this.fetchManagedProviderCapability(auth.providerId, sourceId);
      this.assertSourceAuthActive(sourceId, generation);
      return token.accessToken;
    } catch (err) {
      this.credentialStore?.setStatus(authRef, "refresh_failed", {
        refresh_error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async fetchManagedProviderCapability(
    providerId: string,
    sourceId: string,
  ): Promise<ManagedProviderCapabilityToken> {
    if (!this.managedProviderApiOrigin || !this.lamarckSession) {
      throw managedProviderUnavailable();
    }
    const sessionToken = await this.lamarckSession.accessToken();
    const url = new URL(
      `/providers/${encodeURIComponent(providerId)}/capability-token`,
      normalizeOrigin(this.managedProviderApiOrigin),
    );
    const res = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
      },
      // Wire field, not an internal name — the backend reads `integrationId`.
      body: JSON.stringify({ integrationId: sourceId }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) as Partial<ManagedProviderCapabilityToken> & { error?: string; message?: string } : {};
    if (!res.ok) {
      const message = data.message ?? data.error ?? `Managed provider capability endpoint returned ${res.status}`;
      if (isLamarckSessionInvalid(res.status, data.error)) {
        await this.lamarckSession.clearLocalSession();
        throw new Error("Lamarck desktop session expired. Sign in again.");
      }
      if (res.status === 409 || data.error === "managed_provider_not_connected") {
        throw new ManagedProviderNotConnectedError(message);
      }
      throw new Error(message);
    }
    if (
      data.tokenType !== "Bearer" ||
      !data.accessToken ||
      !data.expiresAt ||
      data.providerId !== providerId ||
      data.integrationId !== sourceId
    ) {
      throw new Error("Managed provider capability endpoint returned an invalid token response");
    }
    return data as ManagedProviderCapabilityToken;
  }

  private async persistManagedProviderBinding(
    authRef: string,
    input: {
      providerId: string;
      sourceId: string;
      ownerId: string;
      generation: number;
    },
  ): Promise<void> {
    const payload: Extract<SecretPayload, { kind: "managedProvider" }> = {
      kind: "managedProvider",
      providerId: input.providerId,
      sourceId: input.sourceId,
    };
    await this.writePayload(authRef, payload);
    try {
      this.assertSourceAuthActive(input.sourceId, input.generation);
    } catch (err) {
      await this.deleteToken(authRef);
      throw err;
    }
    this.trackSourceCredential("connector", input.sourceId, authRef);
    this.credentialStore?.upsert({
      id: authRef,
      kind: "managedProvider",
      ownerType: "connector",
      ownerId: input.ownerId,
      status: "active",
      secretItemId: authRef,
      metadata: {
        provider_id: input.providerId,
        source_id: input.sourceId,
      },
    });
  }

  private async refreshOAuthToken(
    authRef: string,
    auth: ConnectorOAuthDirectAuthSpec,
    payload: Extract<SecretPayload, { kind: "oauth2" }>,
    sourceId: string,
    generation: number,
  ): Promise<string> {
    if (!payload.refreshToken) {
      this.credentialStore?.setStatus(authRef, "refresh_failed", { refresh_error: "missing refresh token" });
      throw new Error("OAuth credential is expired and has no refresh token");
    }
    try {
      const token = await this.exchangeRefresh(auth, payload);
      this.assertSourceAuthActive(sourceId, generation);
      const nextPayload: Extract<SecretPayload, { kind: "oauth2" }> = {
        ...payload,
        accessToken: requireAccessToken(token),
        refreshToken: token.refresh_token ?? payload.refreshToken,
        expiresAt: tokenExpiresAt(token, this.now()),
        tokenType: token.token_type ?? payload.tokenType,
      };
      await this.writePayload(authRef, nextPayload);
      try {
        this.assertSourceAuthActive(sourceId, generation);
      } catch (err) {
        await this.deleteToken(authRef);
        throw err;
      }
      const current = this.credentialStore?.get(authRef);
      this.credentialStore?.upsert({
        id: authRef,
        kind: "oauth2",
        ownerType: current?.ownerType ?? "connector",
        ownerId: current?.ownerId ?? authRef,
        scopes: auth.scope,
        status: "active",
        secretItemId: authRef,
        expiresAt: nextPayload.expiresAt,
        metadata: current?.metadata,
      });
      return nextPayload.accessToken;
    } catch (err) {
      this.credentialStore?.setStatus(authRef, "refresh_failed", {
        refresh_error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async exchangeCode(attempt: OAuthAttempt, code: string): Promise<TokenResponse> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", attempt.redirectUri);
    body.set("client_id", attempt.clientId);
    body.set("code_verifier", attempt.codeVerifier);
    return this.fetchToken(attempt.auth, body);
  }

  private async exchangeRefresh(
    auth: ConnectorOAuthDirectAuthSpec,
    payload: Extract<SecretPayload, { kind: "oauth2" }>,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", payload.refreshToken!);
    body.set("client_id", auth.clientId);
    return this.fetchToken(auth, body);
  }

  private async fetchToken(
    auth: ConnectorOAuthDirectAuthSpec,
    body: URLSearchParams,
  ): Promise<TokenResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    const res = await this.fetchImpl(auth.tokenEndpoint, {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) as TokenResponse : {};
    if (!res.ok || data.error) {
      throw new Error(data.error_description ?? data.error ?? `OAuth token endpoint returned ${res.status}`);
    }
    requireAccessToken(data);
    return data;
  }

  private async persistOAuthToken(attempt: OAuthAttempt, token: TokenResponse): Promise<void> {
    const payload: Extract<SecretPayload, { kind: "oauth2" }> = {
      kind: "oauth2",
      accessToken: requireAccessToken(token),
      refreshToken: token.refresh_token,
      expiresAt: tokenExpiresAt(token, this.now()),
      tokenType: token.token_type,
    };
    await this.writePayload(attempt.authRef, payload);
    try {
      this.assertSourceAuthActive(attempt.sourceId, attempt.generation);
    } catch (err) {
      await this.deleteToken(attempt.authRef);
      throw err;
    }
    this.trackSourceCredential(attempt.ownerType, attempt.ownerId, attempt.authRef);
    this.credentialStore?.upsert({
      id: attempt.authRef,
      kind: "oauth2",
      ownerType: attempt.ownerType,
      ownerId: attempt.ownerId,
      scopes: attempt.auth.scope,
      status: "active",
      secretItemId: attempt.authRef,
      expiresAt: payload.expiresAt,
      metadata: {
        redirect_uri: attempt.redirectUri,
      },
    });
  }

  private async readPayload(ref: string): Promise<SecretPayload | undefined> {
    const raw = await this.secrets.get(ref);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as SecretPayload;
      if (parsed.kind === "apiKey" || parsed.kind === "oauth2" || parsed.kind === "managedProvider") {
        return parsed;
      }
    } catch {
      return { kind: "apiKey", value: raw };
    }
    throw new Error(`Invalid credential payload for ${ref}`);
  }

  private async writePayload(ref: string, payload: SecretPayload): Promise<void> {
    await this.secrets.set(ref, JSON.stringify(payload));
  }

  private assertSourceAuthActive(sourceId: string, generation?: number): void {
    if (this.removedSourceIds.has(sourceId)) {
      throw new Error("Source was removed during authentication");
    }
    if (!this.isSourceAuthGenerationCurrent(sourceId, generation)) {
      throw new Error("Authentication was cancelled for this Source");
    }
  }

  private isSourceAuthGenerationCurrent(
    sourceId: string,
    generation?: number,
  ): boolean {
    return !this.removedSourceIds.has(sourceId)
      && (
        generation === undefined
        || generation === this.currentSourceAuthGeneration(sourceId)
      );
  }

  private trackSourceCredential(
    ownerType: string | undefined,
    ownerId: string | undefined,
    authRef: string,
  ): void {
    if (ownerType !== "connector" || !ownerId) return;
    const refs = this.credentialRefsBySource.get(ownerId) ?? new Set<string>();
    refs.add(authRef);
    this.credentialRefsBySource.set(ownerId, refs);
  }
}

function managedProviderUnavailable(connectorId?: string): Error {
  return new Error(
    connectorId
      ? `Connector ${connectorId} managed provider auth is not available in this build`
      : "Managed provider auth is not available in this build",
  );
}

function isLamarckSessionInvalid(status: number, error: string | undefined): boolean {
  return status === 401 && (
    error === "invalid_session" ||
    error === "session_expired" ||
    error === "session_revoked"
  );
}

function isLamarckSessionNotSignedInError(err: unknown): boolean {
  return err instanceof Error && err.message === "Lamarck desktop session is not signed in";
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function requireAccessToken(token: TokenResponse): string {
  if (!token.access_token) {
    throw new Error("OAuth token endpoint did not return an access_token");
  }
  return token.access_token;
}

function tokenExpiresAt(token: TokenResponse, now: number): number | undefined {
  if (typeof token.expires_at === "number") return token.expires_at;
  if (typeof token.expires_in === "number") return now + token.expires_in * 1000;
  return undefined;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
