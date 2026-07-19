import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openTestDatabases as openDatabases } from "./support/test-databases";
import { ConnectorAuthManager } from "../src/connectors/auth";
import {
  CredentialStore,
  LamarckSessionManager,
  SqliteEncryptedSecretStore,
  createVaultKey,
  encodeVaultKey,
} from "../src/credentials";
import type { ConnectorAuthHandle, ConnectorIntegration } from "../src/connectors";

describe("Secret store and connector credential broker", () => {
  let workspace: string;
  let opened: ReturnType<typeof openDatabases>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lamarck-auth-test-"));
    mkdirSync(join(workspace, ".lamarck"), { recursive: true });
    opened = openDatabases(workspace);
  });

  afterEach(() => {
    opened.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("encrypts secret values in system db", async () => {
    const key = createVaultKey();
    const store = new SqliteEncryptedSecretStore(opened.systemDb, key);

    await store.set("credential-1", "top-secret-token");

    const row = opened.systemDb.prepare(
      "SELECT ciphertext, nonce, algorithm FROM auth_secret_items WHERE id = ?",
    ).get("credential-1") as { ciphertext: string; nonce: string; algorithm: string };
    expect(row.algorithm).toBe("aes-256-gcm");
    expect(row.ciphertext).not.toContain("top-secret-token");
    expect(await store.get("credential-1")).toBe("top-secret-token");

    const reopened = new SqliteEncryptedSecretStore(opened.systemDb, encodeVaultKey(key));
    expect(await reopened.get("credential-1")).toBe("top-secret-token");
    const wrongKey = new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey());
    await expect(wrongKey.get("credential-1")).rejects.toThrow();
  });

  test("api key connect creates credential metadata without D0 events", async () => {
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      { credentialStore: new CredentialStore(opened.systemDb) },
    );

    await manager.setToken("auth-ref", "secret-token", {
      ownerType: "connector",
      ownerId: "integration-1",
    });

    const credential = manager.credential("auth-ref");
    expect(credential).toMatchObject({
      id: "auth-ref",
      kind: "apiKey",
      ownerType: "connector",
      ownerId: "integration-1",
      status: "active",
    });
    expect(await authToken(manager.createHandle({ type: "apiKey" }, integration("auth-ref")))).toBe("secret-token");
    expect(opened.dataDb.prepare("SELECT * FROM events WHERE type LIKE 'auth.%'").all()).toEqual([]);
  });

  test("Source credential cleanup removes every rotated credential owned by that Source", async () => {
    const secrets = new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey());
    const credentials = new CredentialStore(opened.systemDb);
    const manager = new ConnectorAuthManager(secrets, { credentialStore: credentials });

    await manager.setToken("old-auth-ref", "old-token", {
      ownerType: "connector",
      ownerId: "source-1",
    });
    await manager.setToken("current-auth-ref", "current-token", {
      ownerType: "connector",
      ownerId: "source-1",
    });

    await manager.deleteIntegrationCredentials("source-1", "current-auth-ref");

    expect(credentials.listByOwner("connector", "source-1")).toEqual([]);
    expect(await secrets.has("old-auth-ref")).toBe(false);
    expect(await secrets.has("current-auth-ref")).toBe(false);
  });

  test("oauth callback stores token and attempt status", async () => {
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore: new CredentialStore(opened.systemDb),
        fetchImpl: async (_url, init) => {
          const body = String(init?.body);
          expect(body).toContain("grant_type=authorization_code");
          expect(body).not.toContain("client_secret=");
          return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
        },
      },
    );
    const auth = {
      type: "oauth2-public" as const,
      authorizationEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      clientId: "client-id",
      scope: ["read", "write"],
    };

    const started = manager.startOAuth(integration("oauth-ref"), auth, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const authUrl = new URL(started.authorizationUrl);
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://localhost:32123/oauth/callback");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const result = await manager.completeOAuthCallback(new URLSearchParams({
      state: authUrl.searchParams.get("state")!,
      code: "code-1",
    }));

    expect(result).toMatchObject({ status: "connected", credentialId: "oauth-ref", authRef: "oauth-ref" });
    expect(await manager.getOAuthAttempt("integration-1", started.attemptId)).toMatchObject({
      status: "connected",
      credentialId: "oauth-ref",
    });
    expect(await authToken(manager.createHandle(auth, integration("oauth-ref")))).toBe("access-1");
    expect(opened.dataDb.prepare("SELECT * FROM events WHERE type LIKE 'auth.%'").all()).toEqual([]);
  });

  test("oauth refresh single-flights concurrent getToken calls", async () => {
    let calls = 0;
    const manager = new ConnectorAuthManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore: new CredentialStore(opened.systemDb),
        fetchImpl: async (_url, init) => {
          calls++;
          const body = String(init?.body);
          if (body.includes("authorization_code")) {
            return jsonResponse({ access_token: "old", refresh_token: "refresh", expires_in: -1 });
          }
          return jsonResponse({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
        },
      },
    );
    const auth = {
      type: "oauth2-public" as const,
      authorizationEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      clientId: "client-id",
    };
    const started = manager.startOAuth(integration("oauth-ref"), auth, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" }));

    const handle = manager.createHandle(auth, integration("oauth-ref"));
    await expect(Promise.all([authToken(handle), authToken(handle)])).resolves.toEqual(["new", "new"]);
    expect(calls).toBe(2);
  });

  test("Source removal prevents an in-flight OAuth refresh from restoring credentials", async () => {
    let releaseRefresh!: (response: Response) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshResponse = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    const secrets = new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey());
    const credentials = new CredentialStore(opened.systemDb);
    const manager = new ConnectorAuthManager(secrets, {
      credentialStore: credentials,
      fetchImpl: async (_url, init) => {
        if (String(init?.body).includes("authorization_code")) {
          return jsonResponse({ access_token: "old", refresh_token: "refresh", expires_in: -1 });
        }
        markRefreshStarted();
        return refreshResponse;
      },
    });
    const auth = {
      type: "oauth2-public" as const,
      authorizationEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      clientId: "client-id",
    };
    const source = integration("oauth-ref");
    const started = manager.startOAuth(source, auth, {
      redirectUri: "http://localhost:32123/oauth/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeOAuthCallback(new URLSearchParams({ state, code: "code-1" }));

    const token = authToken(manager.createHandle(auth, source));
    await refreshStarted;
    manager.cancelAttemptsForIntegration(source.id, { removed: true });
    await manager.deleteIntegrationCredentials(source.id, source.authRef);
    releaseRefresh(jsonResponse({ access_token: "must-not-survive", expires_in: 3600 }));

    await expect(token).rejects.toThrow("Source was removed during authentication");
    expect(await secrets.has("oauth-ref")).toBe(false);
    expect(credentials.get("oauth-ref")).toBeUndefined();
  });

  test("managed provider start builds the Lamarck connect URL", async () => {
    const manager = new ConnectorAuthManager();
    const started = await manager.startManagedProvider(integration("managed-ref"), {
      type: "managedProvider",
      providerId: "oura",
    }, {
      appOrigin: "https://app.lamarck.ai",
    });
    expect(started.authorizationUrl.startsWith("https://app.lamarck.ai/providers/oura/connect?")).toBe(true);
    expect(new URL(started.authorizationUrl).searchParams.get("start")).toBe("1");
    expect(started.redirectUri).toBeUndefined();
  });

  test("managed provider start sends signed-out desktops through identity authorize first", async () => {
    const secretStore = new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey());
    const sessionManager = new LamarckSessionManager(secretStore, {
      apiOrigin: "https://api.lamarck.ai",
      appOrigin: "https://app.lamarck.ai",
      redirectUri: "http://localhost:32100/auth/callback",
      fetchImpl: async () => jsonResponse({
        tokenType: "Bearer",
        accessToken: "desktop-access",
        refreshToken: "desktop-refresh",
        accessTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        userId: "usr_123",
        sessionId: "dsk_123",
      }),
    });
    const manager = new ConnectorAuthManager(secretStore, {
      managedProviderApiOrigin: "https://api.lamarck.ai",
      lamarckSession: sessionManager,
      fetchImpl: async () => jsonResponse({
        tokenType: "Bearer",
        accessToken: "lamarck-capability-token",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        providerId: "oura",
        integrationId: "integration-1",
      }),
    });

    const started = await manager.startManagedProvider(integration("managed-ref"), {
      type: "managedProvider",
      providerId: "oura",
    }, {
      appOrigin: "https://app.lamarck.ai",
    });
    const loginUrl = new URL(started.authorizationUrl);
    expect(loginUrl.pathname).toBe("/auth/authorize");
    await expect(manager.getOAuthAttempt("integration-1", started.attemptId)).resolves.toMatchObject({
      status: "pending",
    });

    const result = await sessionManager.completeCallback(new URLSearchParams({
      state: loginUrl.searchParams.get("state")!,
      code: "desktop-code",
    }));
    const nextUrl = new URL(result.nextUrl!);
    expect(nextUrl.toString().startsWith("https://app.lamarck.ai/providers/oura/connect?")).toBe(true);
    expect(nextUrl.searchParams.get("integrationId")).toBe("integration-1");
    expect(nextUrl.searchParams.get("start")).toBe("1");
    await expect(manager.getOAuthAttempt("integration-1", started.attemptId)).resolves.toMatchObject({
      status: "connected",
      credentialId: "managed-ref",
    });
  });

  test("managed provider invalid desktop session clears local Lamarck session", async () => {
    const secretStore = new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey());
    const credentialStore = new CredentialStore(opened.systemDb);
    const sessionManager = new LamarckSessionManager(secretStore, {
      credentialStore,
      apiOrigin: "https://api.lamarck.ai",
      appOrigin: "https://app.lamarck.ai",
      redirectUri: "http://localhost:32100/auth/callback",
      fetchImpl: async () => jsonResponse({
        tokenType: "Bearer",
        accessToken: "desktop-access",
        refreshToken: "desktop-refresh",
        accessTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        userId: "usr_123",
        sessionId: "dsk_123",
      }),
    });

    const login = sessionManager.startLogin();
    await sessionManager.completeCallback(new URLSearchParams({
      state: new URL(login.authorizationUrl).searchParams.get("state")!,
      code: "desktop-code",
    }));
    expect(credentialStore.get("lamarck-session:current")).toBeTruthy();
    expect(await secretStore.get("lamarck-session:current")).toBeTruthy();

    const manager = new ConnectorAuthManager(
      secretStore,
      {
        managedProviderApiOrigin: "https://api.lamarck.ai",
        lamarckSession: sessionManager,
        fetchImpl: async () => new Response(JSON.stringify({
          error: "invalid_session",
          message: "Desktop session was not found.",
        }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      },
    );

    const started = await manager.startManagedProvider(integration("managed-ref"), {
      type: "managedProvider",
      providerId: "oura",
    }, {
      appOrigin: "https://app.lamarck.ai",
    });

    await expect(manager.getOAuthAttempt("integration-1", started.attemptId)).resolves.toMatchObject({
      status: "failed",
      error: "Lamarck desktop session expired. Sign in again.",
    });
    expect(credentialStore.get("lamarck-session:current")).toBeUndefined();
    expect(await secretStore.get("lamarck-session:current")).toBeUndefined();
  });

  test("lamarck desktop login stores session credentials", async () => {
    let tokenCalls = 0;
    const credentialStore = new CredentialStore(opened.systemDb);
    const manager = new LamarckSessionManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore,
        apiOrigin: "https://api.lamarck.ai",
        appOrigin: "https://app.lamarck.ai",
        redirectUri: "http://localhost:32100/auth/callback",
        fetchImpl: async (url, init) => {
          tokenCalls++;
          expect(String(url)).toBe("https://api.lamarck.ai/desktop/auth/token");
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          expect(body.grantType).toBe("authorization_code");
          expect(body.redirectUri).toBe("http://localhost:32100/auth/callback");
          expect(body.codeVerifier).toBeTruthy();
          return jsonResponse({
            tokenType: "Bearer",
            accessToken: "desktop-access",
            refreshToken: "desktop-refresh",
            accessTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
            refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            userId: "usr_123",
            sessionId: "dsk_123",
          });
        },
      },
    );

    const started = manager.startLogin();
    const url = new URL(started.authorizationUrl);
    expect(url.toString().startsWith("https://app.lamarck.ai/auth/authorize?")).toBe(true);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:32100/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const view = await manager.completeCallback(new URLSearchParams({
      state: url.searchParams.get("state")!,
      code: "desktop-code",
    }));

    expect(view).toMatchObject({ status: "signed_in", userId: "usr_123", sessionId: "dsk_123" });
    expect(await manager.accessToken()).toBe("desktop-access");
    expect(credentialStore.get("lamarck-session:current")).toMatchObject({
      kind: "lamarckSession",
      ownerType: "desktop",
      ownerId: "identity",
      status: "active",
    });
    expect(tokenCalls).toBe(1);
  });

  test("lamarck desktop session refreshes expired access tokens", async () => {
    let calls = 0;
    const manager = new LamarckSessionManager(
      new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey()),
      {
        credentialStore: new CredentialStore(opened.systemDb),
        apiOrigin: "https://api.lamarck.ai",
        appOrigin: "https://app.lamarck.ai",
        redirectUri: "http://localhost:32100/auth/callback",
        fetchImpl: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          if (body.grantType === "authorization_code") {
            return jsonResponse({
              tokenType: "Bearer",
              accessToken: "old-access",
              refreshToken: "old-refresh",
              accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
              refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              userId: "usr_123",
              sessionId: "dsk_123",
            });
          }
          expect(body).toMatchObject({ grantType: "refresh_token", refreshToken: "old-refresh" });
          return jsonResponse({
            tokenType: "Bearer",
            accessToken: "new-access",
            refreshToken: "new-refresh",
            accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            userId: "usr_123",
            sessionId: "dsk_123",
          });
        },
      },
    );

    const started = manager.startLogin();
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeCallback(new URLSearchParams({ state, code: "desktop-code" }));

    await expect(manager.accessToken()).resolves.toBe("new-access");
    expect(calls).toBe(2);
  });

  test("lamarck desktop session clears local credentials when refresh is invalid", async () => {
    let calls = 0;
    const secretStore = new SqliteEncryptedSecretStore(opened.systemDb, createVaultKey());
    const credentialStore = new CredentialStore(opened.systemDb);
    const manager = new LamarckSessionManager(
      secretStore,
      {
        credentialStore,
        apiOrigin: "https://api.lamarck.ai",
        appOrigin: "https://app.lamarck.ai",
        redirectUri: "http://localhost:32100/auth/callback",
        fetchImpl: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          if (body.grantType === "authorization_code") {
            return jsonResponse({
              tokenType: "Bearer",
              accessToken: "old-access",
              refreshToken: "old-refresh",
              accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
              refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              userId: "usr_123",
              sessionId: "dsk_123",
            });
          }
          expect(body).toMatchObject({ grantType: "refresh_token", refreshToken: "old-refresh" });
          return new Response(JSON.stringify({
            error: "session_revoked",
            message: "Desktop session was revoked.",
          }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    );

    const started = manager.startLogin();
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await manager.completeCallback(new URLSearchParams({ state, code: "desktop-code" }));
    expect(credentialStore.get("lamarck-session:current")).toBeTruthy();
    expect(await secretStore.get("lamarck-session:current")).toBeTruthy();

    await expect(manager.accessToken()).rejects.toThrow("Lamarck desktop session expired. Sign in again.");
    expect(calls).toBe(2);
    expect(credentialStore.get("lamarck-session:current")).toBeUndefined();
    expect(await secretStore.get("lamarck-session:current")).toBeUndefined();
  });
});

function integration(authRef: string): ConnectorIntegration {
  return {
    id: "integration-1",
    connectorId: "connector-1",
    integrationKey: undefined,
    pausedAt: undefined,
    resumeAt: undefined,
    status: "idle",
    setupStatus: "ready",
    trustStatus: "custom",
    scheduleCron: undefined,
    nextRunAt: undefined,
    packageHash: undefined,
    config: undefined,
    syncState: undefined,
    requirementsStatus: undefined,
    authRef,
    lastError: undefined,
    warnings: undefined,
    lastRunAt: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function authToken(handle: ConnectorAuthHandle): Promise<string> {
  if (handle.type === "none") throw new Error("Expected a token-bearing auth handle");
  return handle.getToken();
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
