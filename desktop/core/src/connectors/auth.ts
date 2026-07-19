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
  runtimeAuthType,
  type ConnectorAuthHandle,
  type ConnectorAuthSpec,
  type ConnectorIntegration,
  type ConnectorManagedProviderAuthSpec,
  type ConnectorOAuthAuthSpec,
  type ConnectorOAuthDirectAuthSpec,
} from "./types";

export type OAuthAttemptStatus = "pending" | "connected" | "failed" | "expired";

export interface OAuthStartResult {
  authorizationUrl: string;
  attemptId: string;
  redirectUri?: string;
  expiresAt: number;
}

export interface OAuthAttemptView {
  status: OAuthAttemptStatus;
  integrationId?: string;
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
      integrationId: string;
    };

interface OAuthAttempt {
  id: string;
  integrationId: string;
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
  credentialId?: string;
  error?: string;
}

interface ManagedProviderAttempt {
  id: string;
  integrationId: string;
  authRef: string;
  providerId: string;
  expiresAt: number;
  generation: number;
  status: OAuthAttemptStatus;
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
  managedProviderApiOrigin?: string;
  lamarckSession?: LamarckSessionCapability;
}

export class ConnectorAuthManager {
  private credentialStore: CredentialStore | undefined;
  private fetchImpl: typeof fetch;
  private refreshSkewMs: number;
  private attemptTtlMs: number;
  private managedProviderApiOrigin: string | undefined;
  private lamarckSession: LamarckSessionCapability | undefined;
  private attemptsById = new Map<string, OAuthAttempt>();
  private attemptsByState = new Map<string, OAuthAttempt>();
  private managedAttemptsById = new Map<string, ManagedProviderAttempt>();
  private removedIntegrationIds = new Set<string>();
  private authGenerationByIntegration = new Map<string, number>();
  private credentialRefsByIntegration = new Map<string, Set<string>>();
  private refreshFlights = new Map<string, Promise<string>>();

  constructor(
    private secrets: SecretStore = new MemorySecretStore(),
    opts: ConnectorAuthManagerOptions = {},
  ) {
    this.credentialStore = opts.credentialStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.refreshSkewMs = opts.refreshSkewMs ?? 60_000;
    this.attemptTtlMs = opts.attemptTtlMs ?? 10 * 60_000;
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
      this.assertIntegrationAuthActive(opts.ownerId, opts.generation);
    }
    await this.writePayload(authRef, { kind: "apiKey", value: token });
    if (opts?.ownerType === "connector" && opts.ownerId) {
      try {
        this.assertIntegrationAuthActive(opts.ownerId, opts.generation);
      } catch (err) {
        await this.deleteToken(authRef);
        throw err;
      }
    }
    this.trackIntegrationCredential(opts?.ownerType, opts?.ownerId, authRef);
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

  async deleteIntegrationCredentials(integrationId: string, currentAuthRef?: string): Promise<void> {
    const refs = new Set(
      this.credentialStore
        ?.listByOwner("connector", integrationId)
        .map((credential) => credential.id) ?? [],
    );
    for (const ref of this.credentialRefsByIntegration.get(integrationId) ?? []) refs.add(ref);
    if (currentAuthRef) refs.add(currentAuthRef);
    for (const ref of refs) {
      await this.deleteToken(ref);
    }
    this.credentialRefsByIntegration.delete(integrationId);
  }

  currentIntegrationAuthGeneration(integrationId: string): number {
    return this.authGenerationByIntegration.get(integrationId) ?? 0;
  }

  cancelAttemptsForIntegration(integrationId: string, opts?: { removed?: boolean }): void {
    this.authGenerationByIntegration.set(
      integrationId,
      this.currentIntegrationAuthGeneration(integrationId) + 1,
    );
    if (opts?.removed) this.removedIntegrationIds.add(integrationId);
    for (const [attemptId, attempt] of this.attemptsById) {
      if (attempt.integrationId !== integrationId) continue;
      attempt.status = "failed";
      attempt.error = "Source was removed during authentication";
      this.attemptsById.delete(attemptId);
      this.attemptsByState.delete(attempt.state);
    }
    for (const [attemptId, attempt] of this.managedAttemptsById) {
      if (attempt.integrationId === integrationId) {
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
    integration: ConnectorIntegration,
    auth: ConnectorOAuthAuthSpec,
    input: { redirectUri: string },
  ): OAuthStartResult {
    const codeVerifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(32));
    const attemptId = base64url(randomBytes(16));
    const expiresAt = Date.now() + this.attemptTtlMs;
    const authRef = integration.authRef ?? `connector-integration:${integration.id}:auth`;
    const attempt: OAuthAttempt = {
      id: attemptId,
      integrationId: integration.id,
      authRef,
      auth,
      ownerType: "connector",
      ownerId: integration.id,
      clientId: auth.clientId,
      codeVerifier,
      state,
      redirectUri: input.redirectUri,
      expiresAt,
      generation: this.currentIntegrationAuthGeneration(integration.id),
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
    integration: ConnectorIntegration,
    auth: ConnectorManagedProviderAuthSpec,
    input: { appOrigin: string },
  ): Promise<OAuthStartResult> {
    const attemptId = base64url(randomBytes(16));
    const expiresAt = Date.now() + this.attemptTtlMs;
    const authRef = integration.authRef ?? `connector-integration:${integration.id}:auth`;
    const attempt: ManagedProviderAttempt = {
      id: attemptId,
      integrationId: integration.id,
      authRef,
      providerId: auth.providerId,
      expiresAt,
      generation: this.currentIntegrationAuthGeneration(integration.id),
      status: "pending",
    };
    this.managedAttemptsById.set(attemptId, attempt);

    const url = new URL(`/providers/${encodeURIComponent(auth.providerId)}/connect`, normalizeOrigin(input.appOrigin));
    url.searchParams.set("integrationId", integration.id);
    url.searchParams.set("start", "1");
    if (integration.integrationKey) {
      url.searchParams.set("integrationKey", integration.integrationKey);
    }
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

  async getOAuthAttempt(integrationId: string, attemptId: string): Promise<OAuthAttemptView> {
    const attempt = this.attemptsById.get(attemptId);
    if (!attempt) {
      return this.getManagedProviderAttempt(integrationId, attemptId);
    }
    if (attempt.integrationId !== integrationId) {
      return { status: "failed", error: "Auth attempt not found" };
    }
    if (attempt.status === "pending" && Date.now() > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.error = "OAuth attempt expired";
      this.attemptsByState.delete(attempt.state);
    }
    return {
      status: attempt.status,
      integrationId: attempt.integrationId,
      authRef: attempt.authRef,
      credentialId: attempt.credentialId,
      error: attempt.error,
    };
  }

  private async getManagedProviderAttempt(integrationId: string, attemptId: string): Promise<OAuthAttemptView> {
    const attempt = this.managedAttemptsById.get(attemptId);
    if (!attempt || attempt.integrationId !== integrationId) {
      return { status: "failed", error: "Auth attempt not found" };
    }
    if (attempt.status === "pending" && Date.now() > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.error = "Managed provider auth attempt expired";
    }
    if (attempt.status === "pending") {
      try {
        await this.fetchManagedProviderCapability(attempt.providerId, attempt.integrationId);
        this.assertIntegrationAuthActive(attempt.integrationId, attempt.generation);
        await this.persistManagedProviderBinding(attempt.authRef, {
          providerId: attempt.providerId,
          integrationId: attempt.integrationId,
          ownerId: attempt.integrationId,
          generation: attempt.generation,
        });
        attempt.status = "connected";
        attempt.credentialId = attempt.authRef;
      } catch (err) {
        if (!(err instanceof ManagedProviderNotConnectedError) && !isLamarckSessionNotSignedInError(err)) {
          attempt.status = "failed";
          attempt.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
    return {
      status: attempt.status,
      integrationId: attempt.integrationId,
      authRef: attempt.authRef,
      credentialId: attempt.credentialId,
      error: attempt.error,
    };
  }

  async completeOAuthCallback(params: URLSearchParams): Promise<OAuthAttemptView> {
    const state = params.get("state") ?? "";
    const code = params.get("code") ?? "";
    const providerError = params.get("error");
    const attempt = this.attemptsByState.get(state);
    if (!attempt || attempt.status !== "pending") {
      return { status: "failed", error: "OAuth state is invalid or already used" };
    }
    this.attemptsByState.delete(state);
    if (Date.now() > attempt.expiresAt) {
      attempt.status = "expired";
      attempt.error = "OAuth attempt expired";
      return {
        status: "expired",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }
    if (providerError) {
      attempt.status = "failed";
      attempt.error = params.get("error_description") ?? providerError;
      return {
        status: "failed",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }
    if (!code) {
      attempt.status = "failed";
      attempt.error = "OAuth callback did not include a code";
      return {
        status: "failed",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }

    try {
      const token = await this.exchangeCode(attempt, code);
      this.assertIntegrationAuthActive(attempt.integrationId, attempt.generation);
      await this.persistOAuthToken(attempt, token);
      attempt.status = "connected";
      attempt.credentialId = attempt.authRef;
      return {
        status: "connected",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        credentialId: attempt.authRef,
      };
    } catch (err) {
      attempt.status = "failed";
      attempt.error = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        integrationId: attempt.integrationId,
        authRef: attempt.authRef,
        error: attempt.error,
      };
    }
  }

  createHandle(auth: ConnectorAuthSpec, integration: ConnectorIntegration): ConnectorAuthHandle {
    if (auth.type === "none") {
      return { type: "none" };
    }

    const authRef = integration.authRef;
    if (!authRef) {
      throw new Error(`Connector integration ${integration.id} requires auth_ref`);
    }

    return {
      type: runtimeAuthType(auth),
      getToken: async () => {
        const payload = await this.readPayload(authRef);
        if (!payload) {
          throw new Error(`Connector integration ${integration.id} is missing credentials`);
        }
        if (auth.type === "apiKey") {
          if (payload.kind !== "apiKey") {
            throw new Error(`Connector integration ${integration.id} credential kind mismatch`);
          }
          return payload.value;
        }
        if (auth.type === "managedProvider") {
          if (payload.kind !== "managedProvider") {
            throw new Error(`Connector integration ${integration.id} credential kind mismatch`);
          }
          return this.managedProviderAccessToken(authRef, auth, integration.id, payload);
        }
        if (!isOAuthAuthSpec(auth) || payload.kind !== "oauth2") {
          throw new Error(`Connector integration ${integration.id} credential kind mismatch`);
        }
        return this.oauthAccessToken(authRef, auth, payload, integration.id);
      },
    };
  }

  private async oauthAccessToken(
    authRef: string,
    auth: ConnectorOAuthAuthSpec,
    payload: Extract<SecretPayload, { kind: "oauth2" }>,
    integrationId: string,
  ): Promise<string> {
    if (!payload.expiresAt || payload.expiresAt - Date.now() > this.refreshSkewMs) {
      return payload.accessToken;
    }
    const existing = this.refreshFlights.get(authRef);
    if (existing) return existing;
    const generation = this.currentIntegrationAuthGeneration(integrationId);
    const flight = this.refreshOAuthToken(authRef, auth, payload, integrationId, generation)
      .finally(() => this.refreshFlights.delete(authRef));
    this.refreshFlights.set(authRef, flight);
    return flight;
  }

  private async managedProviderAccessToken(
    authRef: string,
    auth: ConnectorManagedProviderAuthSpec,
    integrationId: string,
    payload: Extract<SecretPayload, { kind: "managedProvider" }>,
  ): Promise<string> {
    if (payload.providerId !== auth.providerId) {
      throw new Error(`Managed provider credential is for ${payload.providerId}, not ${auth.providerId}`);
    }
    if (payload.integrationId !== integrationId) {
      throw new Error(`Managed provider credential is for integration ${payload.integrationId}, not ${integrationId}`);
    }
    const existing = this.refreshFlights.get(authRef);
    if (existing) return existing;
    const generation = this.currentIntegrationAuthGeneration(integrationId);
    const flight = this.issueManagedProviderToken(authRef, auth, integrationId, generation)
      .finally(() => this.refreshFlights.delete(authRef));
    this.refreshFlights.set(authRef, flight);
    return flight;
  }

  private async issueManagedProviderToken(
    authRef: string,
    auth: ConnectorManagedProviderAuthSpec,
    integrationId: string,
    generation: number,
  ): Promise<string> {
    try {
      const token = await this.fetchManagedProviderCapability(auth.providerId, integrationId);
      this.assertIntegrationAuthActive(integrationId, generation);
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
    integrationId: string,
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
      body: JSON.stringify({ integrationId }),
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
      data.integrationId !== integrationId
    ) {
      throw new Error("Managed provider capability endpoint returned an invalid token response");
    }
    return data as ManagedProviderCapabilityToken;
  }

  private async persistManagedProviderBinding(
    authRef: string,
    input: {
      providerId: string;
      integrationId: string;
      ownerId: string;
      generation: number;
    },
  ): Promise<void> {
    const payload: Extract<SecretPayload, { kind: "managedProvider" }> = {
      kind: "managedProvider",
      providerId: input.providerId,
      integrationId: input.integrationId,
    };
    await this.writePayload(authRef, payload);
    try {
      this.assertIntegrationAuthActive(input.integrationId, input.generation);
    } catch (err) {
      await this.deleteToken(authRef);
      throw err;
    }
    this.trackIntegrationCredential("connector", input.integrationId, authRef);
    this.credentialStore?.upsert({
      id: authRef,
      kind: "managedProvider",
      ownerType: "connector",
      ownerId: input.ownerId,
      status: "active",
      secretItemId: authRef,
      metadata: {
        provider_id: input.providerId,
        integration_id: input.integrationId,
      },
    });
  }

  private async refreshOAuthToken(
    authRef: string,
    auth: ConnectorOAuthDirectAuthSpec,
    payload: Extract<SecretPayload, { kind: "oauth2" }>,
    integrationId: string,
    generation: number,
  ): Promise<string> {
    if (!payload.refreshToken) {
      this.credentialStore?.setStatus(authRef, "refresh_failed", { refresh_error: "missing refresh token" });
      throw new Error("OAuth credential is expired and has no refresh token");
    }
    try {
      const token = await this.exchangeRefresh(auth, payload);
      this.assertIntegrationAuthActive(integrationId, generation);
      const nextPayload: Extract<SecretPayload, { kind: "oauth2" }> = {
        ...payload,
        accessToken: requireAccessToken(token),
        refreshToken: token.refresh_token ?? payload.refreshToken,
        expiresAt: tokenExpiresAt(token),
        tokenType: token.token_type ?? payload.tokenType,
      };
      await this.writePayload(authRef, nextPayload);
      try {
        this.assertIntegrationAuthActive(integrationId, generation);
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
      expiresAt: tokenExpiresAt(token),
      tokenType: token.token_type,
    };
    await this.writePayload(attempt.authRef, payload);
    try {
      this.assertIntegrationAuthActive(attempt.integrationId, attempt.generation);
    } catch (err) {
      await this.deleteToken(attempt.authRef);
      throw err;
    }
    this.trackIntegrationCredential(attempt.ownerType, attempt.ownerId, attempt.authRef);
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

  private assertIntegrationAuthActive(integrationId: string, generation?: number): void {
    if (this.removedIntegrationIds.has(integrationId)) {
      throw new Error("Source was removed during authentication");
    }
    if (generation !== undefined && generation !== this.currentIntegrationAuthGeneration(integrationId)) {
      throw new Error("Authentication was cancelled for this Source");
    }
  }

  private trackIntegrationCredential(
    ownerType: string | undefined,
    ownerId: string | undefined,
    authRef: string,
  ): void {
    if (ownerType !== "connector" || !ownerId) return;
    const refs = this.credentialRefsByIntegration.get(ownerId) ?? new Set<string>();
    refs.add(authRef);
    this.credentialRefsByIntegration.set(ownerId, refs);
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

function tokenExpiresAt(token: TokenResponse): number | undefined {
  if (typeof token.expires_at === "number") return token.expires_at;
  if (typeof token.expires_in === "number") return Date.now() + token.expires_in * 1000;
  return undefined;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
