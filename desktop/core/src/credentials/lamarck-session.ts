import { createHash, randomBytes } from "crypto";
import type { CredentialStore } from "./credential-store";
import type { SecretStore } from "./secret-store";

const SESSION_REF = "lamarck-session:current";
const SESSION_EXPIRED_MESSAGE = "Lamarck desktop session expired. Sign in again.";

export type LamarckSessionStatus = "signed_out" | "signed_in" | "expired";

export interface LamarckSessionView {
  status: LamarckSessionStatus;
  userId?: string;
  sessionId?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  apiOrigin?: string;
  appOrigin?: string;
  nextUrl?: string;
}

export interface LamarckLoginStart {
  authorizationUrl: string;
  attemptId: string;
  redirectUri: string;
  expiresAt: number;
}

interface LamarckSessionPayload {
  kind: "lamarckSession";
  tokenType: "Bearer";
  userId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  apiOrigin: string;
  appOrigin: string;
}

interface LoginAttempt {
  id: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  nextUrl?: string;
  expiresAt: number;
}

interface LamarckTokenResponse {
  tokenType: "Bearer";
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  userId: string;
  sessionId: string;
}

interface LamarckSessionManagerOptions {
  apiOrigin: string;
  appOrigin: string;
  redirectUri: string;
  credentialStore?: CredentialStore;
  fetchImpl?: typeof fetch;
  attemptTtlMs?: number;
  refreshSkewMs?: number;
}

export class LamarckSessionManager {
  private credentialStore: CredentialStore | undefined;
  private fetchImpl: typeof fetch;
  private attemptTtlMs: number;
  private refreshSkewMs: number;
  private attemptsByState = new Map<string, LoginAttempt>();

  constructor(
    private secrets: SecretStore,
    private opts: LamarckSessionManagerOptions,
  ) {
    this.credentialStore = opts.credentialStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.attemptTtlMs = opts.attemptTtlMs ?? 10 * 60_000;
    this.refreshSkewMs = opts.refreshSkewMs ?? 60_000;
  }

  startLogin(input: { nextUrl?: string } = {}): LamarckLoginStart {
    const attemptId = base64url(randomBytes(16));
    const state = base64url(randomBytes(32));
    const codeVerifier = base64url(randomBytes(32));
    const expiresAt = Date.now() + this.attemptTtlMs;
    const attempt: LoginAttempt = {
      id: attemptId,
      state,
      codeVerifier,
      redirectUri: this.opts.redirectUri,
      nextUrl: input.nextUrl,
      expiresAt,
    };
    this.attemptsByState.set(state, attempt);

    const url = new URL("/auth/authorize", normalizeOrigin(this.opts.appOrigin));
    url.searchParams.set("redirect_uri", this.opts.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");

    return {
      authorizationUrl: url.toString(),
      attemptId,
      redirectUri: this.opts.redirectUri,
      expiresAt,
    };
  }

  async completeCallback(params: URLSearchParams): Promise<LamarckSessionView> {
    const state = params.get("state") ?? "";
    const code = params.get("code") ?? "";
    const providerError = params.get("error");
    const attempt = this.attemptsByState.get(state);
    if (!attempt) {
      throw new Error("Desktop login state is invalid or expired");
    }
    this.attemptsByState.delete(state);
    if (Date.now() > attempt.expiresAt) {
      throw new Error("Desktop login attempt expired");
    }
    if (providerError) {
      throw new Error(params.get("error_description") ?? providerError);
    }
    if (!code) {
      throw new Error("Desktop login callback did not include a code");
    }

    const token = await this.fetchToken({
      grantType: "authorization_code",
      code,
      redirectUri: attempt.redirectUri,
      codeVerifier: attempt.codeVerifier,
    });
    await this.persistToken(token);
    return {
      ...payloadToView(await this.readPayloadOrThrow()),
      nextUrl: attempt.nextUrl,
    };
  }

  async session(): Promise<LamarckSessionView> {
    const payload = await this.readPayload();
    if (!payload) return { status: "signed_out" };
    if (Date.parse(payload.refreshTokenExpiresAt) <= Date.now()) {
      return {
        ...payloadToView(payload),
        status: "expired",
      };
    }
    if (Date.parse(payload.accessTokenExpiresAt) - Date.now() <= this.refreshSkewMs) {
      try {
        await this.refresh();
        return payloadToView(await this.readPayloadOrThrow());
      } catch {
        return {
          ...payloadToView(payload),
          status: "expired",
        };
      }
    }
    return payloadToView(payload);
  }

  async accessToken(): Promise<string> {
    const payload = await this.readPayload();
    if (!payload) {
      throw new Error("Lamarck desktop session is not signed in");
    }
    if (Date.parse(payload.accessTokenExpiresAt) - Date.now() <= this.refreshSkewMs) {
      await this.refresh();
      return (await this.readPayloadOrThrow()).accessToken;
    }
    return payload.accessToken;
  }

  async logout(): Promise<void> {
    const payload = await this.readPayload();
    if (payload) {
      await this.fetchImpl(new URL("/desktop/auth/logout", normalizeOrigin(payload.apiOrigin)).toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${payload.accessToken}`,
        },
      }).catch(() => undefined);
    }
    await this.clearLocalSession();
  }

  async clearLocalSession(): Promise<void> {
    this.credentialStore?.delete(SESSION_REF);
    if (!this.credentialStore) {
      await this.secrets.delete(SESSION_REF);
    }
  }

  private async refresh(): Promise<void> {
    const payload = await this.readPayloadOrThrow();
    let token: LamarckTokenResponse;
    try {
      token = await this.fetchToken({
        grantType: "refresh_token",
        refreshToken: payload.refreshToken,
      });
    } catch (err) {
      if (err instanceof LamarckSessionInvalidError) {
        await this.clearLocalSession();
        throw new Error(SESSION_EXPIRED_MESSAGE);
      }
      throw err;
    }
    await this.persistToken(token);
  }

  private async fetchToken(body: Record<string, string>): Promise<LamarckTokenResponse> {
    const res = await this.fetchImpl(new URL("/desktop/auth/token", normalizeOrigin(this.opts.apiOrigin)).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) as Partial<LamarckTokenResponse> & { error?: string; message?: string } : {};
    if (!res.ok) {
      if (isLamarckSessionInvalid(res.status, data.error)) {
        throw new LamarckSessionInvalidError(data.message ?? data.error ?? SESSION_EXPIRED_MESSAGE);
      }
      throw new Error(data.message ?? data.error ?? `Desktop token endpoint returned ${res.status}`);
    }
    if (
      data.tokenType !== "Bearer" ||
      !data.accessToken ||
      !data.refreshToken ||
      !data.accessTokenExpiresAt ||
      !data.refreshTokenExpiresAt ||
      !data.userId ||
      !data.sessionId
    ) {
      throw new Error("Desktop token endpoint returned an invalid token response");
    }
    return data as LamarckTokenResponse;
  }

  private async persistToken(token: LamarckTokenResponse): Promise<void> {
    const payload: LamarckSessionPayload = {
      kind: "lamarckSession",
      tokenType: "Bearer",
      userId: token.userId,
      sessionId: token.sessionId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
      apiOrigin: this.opts.apiOrigin,
      appOrigin: this.opts.appOrigin,
    };
    await this.writePayload(payload);
    this.credentialStore?.upsert({
      id: SESSION_REF,
      kind: "lamarckSession",
      ownerType: "desktop",
      ownerId: "identity",
      status: "active",
      secretItemId: SESSION_REF,
      expiresAt: Date.parse(payload.accessTokenExpiresAt),
      metadata: {
        api_origin: payload.apiOrigin,
        app_origin: payload.appOrigin,
        session_id: payload.sessionId,
      },
    });
  }

  private async readPayloadOrThrow(): Promise<LamarckSessionPayload> {
    const payload = await this.readPayload();
    if (!payload) {
      throw new Error("Lamarck desktop session is not signed in");
    }
    return payload;
  }

  private async readPayload(): Promise<LamarckSessionPayload | undefined> {
    const raw = await this.secrets.get(SESSION_REF);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as LamarckSessionPayload;
    if (parsed.kind !== "lamarckSession") {
      throw new Error(`Invalid Lamarck session payload for ${SESSION_REF}`);
    }
    return parsed;
  }

  private async writePayload(payload: LamarckSessionPayload): Promise<void> {
    await this.secrets.set(SESSION_REF, JSON.stringify(payload));
  }
}

function payloadToView(payload: LamarckSessionPayload): LamarckSessionView {
  return {
    status: "signed_in",
    userId: payload.userId,
    sessionId: payload.sessionId,
    accessTokenExpiresAt: payload.accessTokenExpiresAt,
    refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
    apiOrigin: payload.apiOrigin,
    appOrigin: payload.appOrigin,
  };
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

class LamarckSessionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LamarckSessionInvalidError";
  }
}

function isLamarckSessionInvalid(status: number, error: string | undefined): boolean {
  return status === 401 && (
    error === "invalid_session" ||
    error === "session_expired" ||
    error === "session_revoked"
  );
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
