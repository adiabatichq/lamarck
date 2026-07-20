import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createCapsulePackageSnapshot,
  createCapsuleVirtualTreeSnapshot,
  readCapsuleTreeFile,
  type CapsuleTreeSnapshot,
} from "./package-snapshot";
import {
  createNpmDependencyBundle,
  NPM_DEPENDENCY_BUNDLE_FORMAT,
  type NpmDependencyBrokerLimits,
} from "./dependency-broker";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("Host npm dependency broker", () => {
  test("downloads a deterministic closed bundle, deduplicates lock identities, and reuses verified CAS", async () => {
    const fixture = await createFixture();
    const alpha = Buffer.from("alpha-tarball");
    const beta = Buffer.from("beta-tarball");
    const alphaLocked = locked("alpha", "1.0.0", alpha);
    const betaLocked = locked("beta", "2.0.0", beta);
    const snapshot = await snapshotLock(fixture, lock([
      { path: "node_modules/beta", ...betaLocked },
      { path: "node_modules/alpha", ...alphaLocked },
      { path: "node_modules/beta/node_modules/alpha", ...alphaLocked },
    ]));
    const bodies = new Map([
      [alphaLocked.resolved, alpha],
      [betaLocked.resolved, beta],
    ]);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const body = bodies.get(url);
      if (!body) throw new Error(`unexpected URL ${url}`);
      return response(body);
    });

    const first = await createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
    });
    expect(first.format).toBe(NPM_DEPENDENCY_BUNDLE_FORMAT);
    expect(first.entries).toBe(2);
    expect(first.tarballBytes).toBe(alpha.byteLength + beta.byteLength);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of calls) {
      expect(call.init).toMatchObject({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
    }

    const manifestBytes = await readCapsuleTreeFile(first.snapshot, "manifest.json", 64 * 1024);
    const expectedEntries = [alphaLocked, betaLocked]
      .sort((left, right) => compareUtf8(`${left.resolved}\0${left.integrity}`, `${right.resolved}\0${right.integrity}`))
      .map((entry) => ({
        resolved: entry.resolved,
        integrity: entry.integrity,
        bytes: bodies.get(entry.resolved)!.byteLength,
        file: `tarballs/${digestHex(entry.integrity)}.tgz`,
      }));
    const expectedManifest = Buffer.from(`${JSON.stringify({ version: 1, entries: expectedEntries })}\n`);
    expect(manifestBytes).toEqual(expectedManifest);
    for (const entry of expectedEntries) {
      expect(await readCapsuleTreeFile(first.snapshot, entry.file, 1024)).toEqual(
        bodies.get(entry.resolved),
      );
      const rawCas = join(fixture.brokerCache, "tarballs", `${digestHex(entry.integrity)}.tgz`);
      expect((await lstat(rawCas)).mode & 0o777).toBe(0o400);
    }

    const noNetwork = vi.fn(async () => { throw new Error("cache miss"); });
    const second = await createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: noNetwork as typeof globalThis.fetch,
    });
    expect(noNetwork).not.toHaveBeenCalled();
    expect(second.snapshot.digest).toBe(first.snapshot.digest);
    expect(second.snapshot.bytes).toBe(first.snapshot.bytes);
  });

  test("omits canonical package-local links from the registry bundle", async () => {
    const fixture = await createFixture();
    const body = Buffer.from("registry-tarball");
    const registry = locked("registry", "1.0.0", body);
    const lockValue = {
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", workspaces: ["sdk/*"] },
        "node_modules/local-sdk": { resolved: "sdk/system", link: true },
        "sdk/system": { name: "@lamarck/system", version: "0.1.0" },
        "node_modules/registry": { version: "1.0.0", ...registry },
      },
    };
    const snapshot = await snapshotLock(fixture, lockValue);
    const fetchMock = vi.fn(async (input) => {
      expect(String(input)).toBe(registry.resolved);
      return response(body);
    });

    const bundle = await createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
    });
    expect(bundle.entries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(
      (await readCapsuleTreeFile(bundle.snapshot, "manifest.json", 64 * 1024))!.toString(),
    ) as { entries: Array<{ resolved: string }> };
    expect(manifest.entries.map((entry) => entry.resolved)).toEqual([registry.resolved]);
  });

  test("treats @lamarck/system as an ordinary integrity-pinned registry package", async () => {
    const fixture = await createFixture();
    const registryBody = Buffer.from("registry-tarball");
    const systemBody = Buffer.from("lamarck-system-tarball");
    const registry = locked("registry", "1.0.0", registryBody);
    const system = {
      resolved: "https://registry.npmjs.org/@lamarck/system/-/system-0.1.0.tgz",
      integrity: sri(systemBody),
    };
    const snapshot = await snapshotLock(fixture, {
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            "@lamarck/system": "^0.1.0",
            registry: "^1.0.0",
          },
        },
        "node_modules/@lamarck/system": { version: "0.1.0", ...system },
        "node_modules/registry": { version: "1.0.0", ...registry },
      },
    });
    const fetchMock = vi.fn(async (input) => {
      const bodies = new Map([
        [registry.resolved, registryBody],
        [system.resolved, systemBody],
      ]);
      const body = bodies.get(String(input));
      if (!body) throw new Error(`unexpected URL ${String(input)}`);
      return response(body);
    });

    const bundle = await createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
    });
    expect(bundle.entries).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(fetchMock.mock.calls.map(([input]) => String(input)))).toEqual(
      new Set([registry.resolved, system.resolved]),
    );

    const noNetwork = vi.fn(async () => { throw new Error("unexpected cache miss"); });
    const cached = await createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: noNetwork as typeof globalThis.fetch,
    });
    expect(noNetwork).not.toHaveBeenCalled();
    expect(cached.snapshot.digest).toBe(bundle.snapshot.digest);
  });

  test("rejects the former SDK placeholder before networking", async () => {
    const fixture = await createFixture();
    const snapshot = await snapshotLock(fixture, {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "@lamarck/system": "^0.1.0" } },
        "node_modules/@lamarck/system": { version: "0.1.0" },
      },
    });
    const fetchMock = vi.fn();
    await expect(createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
    })).rejects.toThrow("node_modules/@lamarck/system.resolved must be a bounded URL string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects absolute, file, git, HTTP, reserved, and absent local-link targets", async () => {
    const unsafe = [
      "/absolute/sdk",
      "file:../sdk",
      "git+https://example.com/sdk.git",
      "https://example.com/sdk",
      "packages/../../outside",
      ".lamarck/sdk",
      "node_modules/other",
    ];
    for (const target of unsafe) {
      const fixture = await createFixture();
      const snapshot = await snapshotLock(fixture, {
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/local": { link: true, resolved: target },
        },
      });
      const fetchMock = vi.fn();
      await expect(createNpmDependencyBundle({
        packageSnapshot: snapshot,
        cacheDir: fixture.brokerCache,
        fetch: fetchMock as typeof globalThis.fetch,
      }), target).rejects.toThrow("captured package");
      expect(fetchMock, target).not.toHaveBeenCalled();
    }

    const absentFixture = await createFixture();
    const absentSnapshot = await snapshotLock(absentFixture, {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/local": { link: true, resolved: "packages/missing" },
      },
    });
    await expect(createNpmDependencyBundle({
      packageSnapshot: absentSnapshot,
      cacheDir: absentFixture.brokerCache,
      fetch: vi.fn() as typeof globalThis.fetch,
    })).rejects.toThrow("target is absent from captured packages");
  });

  test("rejects missing, malformed, unsupported, unsafe-linked, and incomplete lockfiles before networking", async () => {
    const cases: Array<{ name: string; value: unknown | Buffer; message: string }> = [
      { name: "invalid JSON", value: Buffer.from("{"), message: "not valid JSON" },
      { name: "old lock", value: { lockfileVersion: 1, packages: { "": {} } }, message: "must be 2 or 3" },
      { name: "packages array", value: { lockfileVersion: 3, packages: [] }, message: "packages must contain an object" },
      { name: "missing root", value: { lockfileVersion: 3, packages: { "node_modules/a": {} } }, message: "root packages entry" },
      {
        name: "escaping workspace link",
        value: {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/a": { link: true, resolved: "../outside" },
            "../outside": { name: "outside" },
          },
        },
        message: "canonical relative target inside the captured package",
      },
      {
        name: "missing SRI",
        value: {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/a": { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
          },
        },
        message: "canonical sha512 SRI",
      },
      {
        name: "multiple SRI values",
        value: {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/a": {
              resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
              integrity: `${sri(Buffer.from("a"))} sha256-deadbeef`,
            },
          },
        },
        message: "one canonical sha512 SRI",
      },
      {
        name: "non-install path",
        value: {
          lockfileVersion: 3,
          packages: {
            "": {},
            "packages/a": locked("a", "1.0.0", Buffer.from("a")),
          },
        },
        message: "not an npm install path",
      },
    ];
    for (const item of cases) {
      const fixture = await createFixture();
      const snapshot = await snapshotLock(fixture, item.value);
      const fetchMock = vi.fn();
      await expect(createNpmDependencyBundle({
        packageSnapshot: snapshot,
        cacheDir: fixture.brokerCache,
        fetch: fetchMock as typeof globalThis.fetch,
      }), item.name).rejects.toThrow(item.message);
      expect(fetchMock, item.name).not.toHaveBeenCalled();
    }

    const fixture = await createFixture();
    const snapshot = await createCapsuleVirtualTreeSnapshot({
      cacheDir: fixture.snapshotCache,
      entries: [{ type: "file", path: "package.json", contentBytes: 2, content: Buffer.from("{}") }],
    });
    await expect(createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: vi.fn() as typeof globalThis.fetch,
    })).rejects.toThrow("must contain package-lock.json");

    const capped = await createFixture();
    const dependency = locked("a", "1.0.0", Buffer.from("a"));
    const cappedSnapshot = await snapshotLock(capped, lock([{ path: "node_modules/a", ...dependency }]));
    await expect(createNpmDependencyBundle({
      packageSnapshot: cappedSnapshot,
      cacheDir: capped.brokerCache,
      fetch: vi.fn() as typeof globalThis.fetch,
      limits: { packages: 0 },
    })).rejects.toThrow("0 package cap");
    await expect(createNpmDependencyBundle({
      packageSnapshot: cappedSnapshot,
      cacheDir: capped.brokerCache,
      fetch: vi.fn() as typeof globalThis.fetch,
      limits: { lockBytes: 4 },
    })).rejects.toThrow("exceeds read bound");
  });

  test("rejects registry SSRF URL forms and redirects", async () => {
    const body = Buffer.from("tarball");
    const integrity = sri(body);
    const urls = [
      "http://registry.npmjs.org/a/-/a-1.0.0.tgz",
      "https://evil.example/a/-/a-1.0.0.tgz",
      "https://registry.npmjs.org.evil.example/a/-/a-1.0.0.tgz",
      "https://user@registry.npmjs.org/a/-/a-1.0.0.tgz",
      "https://registry.npmjs.org:443/a/-/a-1.0.0.tgz",
      "https://registry.npmjs.org:444/a/-/a-1.0.0.tgz",
      "https://registry.npmjs.org/a/-/a-1.0.0.tgz?download=1",
      "https://registry.npmjs.org/a/-/a-1.0.0.tgz#fragment",
      "https://registry.npmjs.org/%61/-/a-1.0.0.tgz",
      "https://registry.npmjs.org/a/latest",
    ];
    for (const resolved of urls) {
      const fixture = await createFixture();
      const snapshot = await snapshotLock(fixture, lock([{
        path: "node_modules/a",
        resolved,
        integrity,
      }]));
      const fetchMock = vi.fn();
      await expect(createNpmDependencyBundle({
        packageSnapshot: snapshot,
        cacheDir: fixture.brokerCache,
        fetch: fetchMock as typeof globalThis.fetch,
      }), resolved).rejects.toThrow("exact registry.npmjs.org HTTPS tarball URL");
      expect(fetchMock, resolved).not.toHaveBeenCalled();
    }

    const fixture = await createFixture();
    const dependency = locked("a", "1.0.0", body);
    const snapshot = await snapshotLock(fixture, lock([{ path: "node_modules/a", ...dependency }]));
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/tarball.tgz" },
    }));
    await expect(createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
    })).rejects.toThrow("redirected or returned a non-200");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  test("fails closed for integrity, Content-Length, per-file, total, truncated, and extra-byte violations", async () => {
    const expected = Buffer.from("12345");
    const dependency = locked("a", "1.0.0", expected);
    const scenarios: Array<{
      name: string;
      body: Buffer;
      declared?: string | null;
      headers?: Record<string, string>;
      limits?: Partial<NpmDependencyBrokerLimits>;
      message: string;
    }> = [
      { name: "integrity", body: Buffer.from("abcde"), message: "sha512 integrity mismatch" },
      { name: "missing length", body: expected, headers: {}, declared: null, message: "requires one canonical Content-Length" },
      { name: "leading-zero length", body: expected, declared: "05", message: "requires one canonical Content-Length" },
      {
        name: "per file",
        body: expected,
        limits: { tarballBytes: 4, totalBytes: 10 },
        message: "per-file cap",
      },
      { name: "truncated", body: expected.subarray(0, 4), declared: "5", message: "body was truncated" },
      { name: "extra", body: Buffer.from("123456"), declared: "5", message: "exceeded Content-Length" },
      {
        name: "encoded",
        body: expected,
        headers: { "content-encoding": "gzip" },
        message: "unsupported content transformation",
      },
    ];
    for (const scenario of scenarios) {
      const fixture = await createFixture();
      const snapshot = await snapshotLock(fixture, lock([{ path: "node_modules/a", ...dependency }]));
      const fetchMock = vi.fn(async () => response(
        scenario.body,
        scenario.declared === undefined && scenario.name !== "missing length"
          ? String(scenario.body.byteLength)
          : scenario.declared,
        scenario.headers,
      ));
      await expect(createNpmDependencyBundle({
        packageSnapshot: snapshot,
        cacheDir: fixture.brokerCache,
        fetch: fetchMock as typeof globalThis.fetch,
        limits: scenario.limits,
      }), scenario.name).rejects.toThrow(scenario.message);
    }

    const fixture = await createFixture();
    const a = locked("a", "1.0.0", Buffer.from("aaaa"));
    const b = locked("b", "1.0.0", Buffer.from("bbbb"));
    const snapshot = await snapshotLock(fixture, lock([
      { path: "node_modules/a", ...a },
      { path: "node_modules/b", ...b },
    ]));
    const bodyByUrl = new Map([[a.resolved, Buffer.from("aaaa")], [b.resolved, Buffer.from("bbbb")]]);
    await expect(createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: (async (input) => response(bodyByUrl.get(String(input))!)) as typeof globalThis.fetch,
      limits: { totalBytes: 7, tarballBytes: 7, concurrency: 1 },
    })).rejects.toThrow("total cap");
  });

  test("detects corrupt cached tarballs and never replaces them or falls back to network", async () => {
    const fixture = await createFixture();
    const body = Buffer.from("trusted-tarball");
    const dependency = locked("safe", "1.0.0", body);
    const snapshot = await snapshotLock(fixture, lock([{ path: "node_modules/safe", ...dependency }]));
    await createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: (async () => response(body)) as typeof globalThis.fetch,
    });
    const path = join(fixture.brokerCache, "tarballs", `${digestHex(dependency.integrity)}.tgz`);
    const corrupt = Buffer.alloc(body.byteLength, 0x78);
    await chmod(path, 0o600);
    await writeFile(path, corrupt);
    await chmod(path, 0o400);
    const fetchMock = vi.fn();

    await expect(createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
    })).rejects.toThrow("CAS integrity failure");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(corrupt);
  });

  test("derives URLs only from the immutable package snapshot, never a second live lockfile read", async () => {
    const fixture = await createFixture();
    const body = Buffer.from("captured");
    const captured = locked("captured", "1.0.0", body);
    const livePath = join(fixture.packageDir, "package-lock.json");
    await writeFile(livePath, JSON.stringify(lock([{ path: "node_modules/captured", ...captured }])));
    const packageSnapshot = await createCapsulePackageSnapshot({
      packageDir: fixture.packageDir,
      cacheDir: fixture.snapshotCache,
    });
    await writeFile(livePath, JSON.stringify(lock([{
      path: "node_modules/evil",
      resolved: "http://127.0.0.1/steal.tgz",
      integrity: captured.integrity,
    }])));
    const fetchMock = vi.fn(async (input) => {
      expect(String(input)).toBe(captured.resolved);
      return response(body);
    });

    const bundle = await createNpmDependencyBundle({
      packageSnapshot,
      cacheDir: fixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
    });
    expect(bundle.entries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("bounds concurrent registry requests", async () => {
    const fixture = await createFixture();
    const dependencies = Array.from({ length: 6 }, (_, index) => {
      const body = Buffer.from(`tarball-${index}`);
      return { path: `node_modules/p${index}`, body, ...locked(`p${index}`, "1.0.0", body) };
    });
    const snapshot = await snapshotLock(fixture, lock(dependencies));
    const bodyByUrl = new Map(dependencies.map((entry) => [entry.resolved, entry.body] as const));
    let active = 0;
    let maximum = 0;
    const fetchMock = vi.fn(async (input) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return response(bodyByUrl.get(String(input))!);
      } finally {
        active -= 1;
      }
    });

    const bundle = await createNpmDependencyBundle({
      packageSnapshot: snapshot,
      cacheDir: fixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
      limits: { concurrency: 2 },
    });
    expect(bundle.entries).toBe(6);
    expect(maximum).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test("propagates AbortSignal and enforces a timeout across the response body", async () => {
    const abortFixture = await createFixture();
    const body = Buffer.from("abort");
    const dependency = locked("abort", "1.0.0", body);
    const abortSnapshot = await snapshotLock(abortFixture, lock([{ path: "node_modules/abort", ...dependency }]));
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      notifyStarted();
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const operation = createNpmDependencyBundle({
      packageSnapshot: abortSnapshot,
      cacheDir: abortFixture.brokerCache,
      fetch: fetchMock as typeof globalThis.fetch,
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error("user cancelled dependency fetch"));
    await expect(operation).rejects.toThrow("user cancelled dependency fetch");

    const timeoutFixture = await createFixture();
    const timeoutSnapshot = await snapshotLock(timeoutFixture, lock([{ path: "node_modules/abort", ...dependency }]));
    const neverEnding = new ReadableStream<Uint8Array>({ start() {} });
    await expect(createNpmDependencyBundle({
      packageSnapshot: timeoutSnapshot,
      cacheDir: timeoutFixture.brokerCache,
      fetch: (async () => new Response(neverEnding, {
        status: 200,
        headers: { "content-length": "5" },
      })) as typeof globalThis.fetch,
      limits: { requestTimeoutMs: 25 },
    })).rejects.toThrow("exceeded 25 ms");
    const names = await readdir(join(timeoutFixture.brokerCache, "tarballs"));
    expect(names.filter((name) => name.startsWith(".download-"))).toEqual([]);
  });
});

interface LockDependency {
  path: string;
  resolved: string;
  integrity: string;
}

interface Fixture {
  root: string;
  packageDir: string;
  snapshotCache: string;
  brokerCache: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "lamarck-dependency-broker-"));
  temporaryRoots.push(root);
  const packageDir = join(root, "package");
  await mkdir(packageDir);
  return {
    root,
    packageDir,
    snapshotCache: join(root, "snapshot-cache"),
    brokerCache: join(root, "broker-cache"),
  };
}

async function snapshotLock(fixture: Fixture, value: unknown | Buffer): Promise<CapsuleTreeSnapshot> {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return createCapsuleVirtualTreeSnapshot({
    cacheDir: fixture.snapshotCache,
    entries: [{
      type: "file",
      path: "package-lock.json",
      contentBytes: bytes.byteLength,
      content: bytes,
    }],
  });
}

function lock(dependencies: readonly LockDependency[]): Record<string, unknown> {
  return {
    name: "fixture",
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries([
      ["", { name: "fixture", version: "1.0.0" }],
      ...dependencies.map((dependency) => [dependency.path, {
        version: "1.0.0",
        resolved: dependency.resolved,
        integrity: dependency.integrity,
      }]),
    ]),
  };
}

function locked(name: string, version: string, body: Buffer): { resolved: string; integrity: string } {
  return {
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: sri(body),
  };
}

function sri(value: Uint8Array): string {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function digestHex(integrity: string): string {
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

function response(
  body: Uint8Array,
  contentLength: string | null = String(body.byteLength),
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers(extraHeaders);
  if (contentLength !== null) headers.set("content-length", contentLength);
  return new Response(Buffer.from(body), { status: 200, headers });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
