import { chmod, readFile, rm, writeFile } from "node:fs/promises";

export const MARKETPLACE_SIGNING_KEY_ID_ENV = "LAMARCK_MARKETPLACE_SIGNING_KEY_ID";
export const MARKETPLACE_SIGNING_PUBLIC_KEY_ENV = "LAMARCK_MARKETPLACE_SIGNING_PUBLIC_KEY";

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Build a sealed, data-only public trust-root resource for Desktop Core. */
export function marketplaceTrustRootDocument(env = process.env, options = {}) {
  const keyId = env[MARKETPLACE_SIGNING_KEY_ID_ENV];
  const publicKey = env[MARKETPLACE_SIGNING_PUBLIC_KEY_ENV];
  if (keyId === undefined && publicKey === undefined && options.required !== true) {
    return Object.freeze({ schemaVersion: 1, keys: Object.freeze([]) });
  }
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`${MARKETPLACE_SIGNING_KEY_ID_ENV} is required and must be a canonical key ID`);
  }
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
    throw new Error(`${MARKETPLACE_SIGNING_PUBLIC_KEY_ENV} is required and must be canonical base64`);
  }
  const decoded = Buffer.from(publicKey, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== publicKey) {
    throw new Error(`${MARKETPLACE_SIGNING_PUBLIC_KEY_ENV} must encode one raw 32-byte Ed25519 key`);
  }
  return Object.freeze({
    schemaVersion: 1,
    keys: Object.freeze([Object.freeze({
      keyId,
      algorithm: "Ed25519",
      publicKey,
    })]),
  });
}

export function requireMarketplaceTrustRoot(env = process.env) {
  return marketplaceTrustRootDocument(env, { required: true });
}

export async function writeMarketplaceTrustRootResource(path, env = process.env) {
  const document = marketplaceTrustRootDocument(env);
  await rm(path, { force: true });
  await writeFile(path, `${JSON.stringify(document)}\n`, {
    encoding: "utf8",
    mode: 0o444,
    flag: "wx",
  });
  await chmod(path, 0o444);
  return document;
}

export async function validateMarketplaceTrustRootResource(path, env = process.env) {
  const expected = requireMarketplaceTrustRoot(env);
  const bytes = await readFile(path);
  if (bytes.length < 1 || bytes.length > 4096) {
    throw new Error("packaged Marketplace trust-root resource is not bounded");
  }
  let actual;
  try {
    actual = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("packaged Marketplace trust-root resource is malformed");
  }
  if (`${JSON.stringify(actual)}\n` !== bytes.toString("utf8")) {
    throw new Error("packaged Marketplace trust-root resource is not canonical");
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("packaged Marketplace trust root does not match the release build authority");
  }
  return actual;
}
