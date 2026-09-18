#!/usr/bin/env node
// Ephemeral GitHub-hosted runner keychain. Never print command arguments or secrets.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";

if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
  throw new Error("This helper is only for macOS GitHub Actions runners");
}
const directory = join(process.env.RUNNER_TEMP, "lamarck-signing");
const keychain = join(directory, "release.keychain-db");
const previousPath = join(directory, "previous-keychains.json");
function security(args) { return command("security", args); }
function command(name, args) {
  try { return execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error(`${name} failed during CI signing setup; credential arguments and output omitted`); }
}
function secret(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
if (process.argv[2] === "cleanup") {
  const previous = await readFile(previousPath, "utf8").then(JSON.parse).catch(() => null);
  if (previous) security(["list-keychains", "-d", "user", "-s", ...previous]);
  try { security(["delete-keychain", keychain]); } catch { /* Setup may not have reached creation. */ }
  await rm(directory, { recursive: true, force: true });
} else if (process.argv[2] === "setup") {
  const team = secret("APPLE_TEAM_ID");
  const keyId = secret("APPLE_API_KEY_ID");
  const issuer = secret("APPLE_API_ISSUER_ID");
  if (!/^[A-Z0-9]{10}$/.test(team) || !/^[A-Z0-9]{10}$/.test(keyId)
    || !/^[a-f0-9-]{36}$/i.test(issuer)) throw new Error("Invalid Apple team, API key or issuer identifier");
  const password = randomBytes(32).toString("hex");
  console.log(`::add-mask::${password}`);
  await mkdir(directory, { mode: 0o700 });
  const previous = security(["list-keychains", "-d", "user"]).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line.trim()));
  await writeFile(previousPath, JSON.stringify(previous), { mode: 0o600 });
  security(["create-keychain", "-p", password, keychain]);
  security(["set-keychain-settings", "-lut", "21600", keychain]);
  security(["unlock-keychain", "-p", password, keychain]);
  const p12 = join(directory, "signing.p12");
  const p8 = join(directory, "AuthKey.p8");
  try {
    await writeFile(p12, Buffer.from(secret("LAMARCK_CODESIGN_P12_BASE64"), "base64"), { mode: 0o600 });
    await writeFile(p8, Buffer.from(secret("APPLE_API_KEY_P8_BASE64"), "base64"), { mode: 0o600 });
    security(["import", p12, "-k", keychain, "-P", secret("LAMARCK_CODESIGN_P12_PASSWORD"), "-T", "/usr/bin/codesign"]);
    const intermediate = join(directory, "DeveloperIDG2CA.cer");
    const response = await fetch("https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer", { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Could not download Apple Developer ID intermediate");
    await writeFile(intermediate, Buffer.from(await response.arrayBuffer()));
    security(["import", intermediate, "-k", keychain]);
    security(["set-key-partition-list", "-S", "apple-tool:,apple:", "-k", password, keychain]);
    security(["list-keychains", "-d", "user", "-s", keychain, ...previous]);
    const identities = security(["find-identity", "-v", "-p", "codesigning", keychain]);
    const matches = [...identities.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(Developer ID Application:[^"]+)"\s*$/gm)]
      .filter((match) => match[2].endsWith(`(${team})`));
    if (matches.length !== 1) throw new Error("P12 must contain exactly one valid Developer ID Application identity for APPLE_TEAM_ID");
    command("xcrun", ["notarytool", "store-credentials", "lamarck-release", "--key", p8, "--key-id", keyId, "--issuer", issuer, "--keychain", keychain]);
    await appendFile(secret("GITHUB_ENV"), `LAMARCK_CODESIGN_IDENTITY=${matches[0][1]}\nLAMARCK_NOTARY_PROFILE=lamarck-release\nLAMARCK_NOTARY_KEYCHAIN=${keychain}\n`);
  } finally {
    await rm(p12, { force: true });
    await rm(p8, { force: true });
  }
} else {
  throw new Error("Usage: ci-macos-signing.mjs setup|cleanup");
}
