import { createHash } from "node:crypto";
import { join } from "node:path";
import { hashFile } from "./r2-object-store.mjs";

export const DESKTOP_RELEASE_PREFIX = "desktop/macos/arm64/stable";
export const DESKTOP_RELEASE_ORIGIN = "https://releases.lamarck.ai";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateDesktopRelease(release) {
  if (!release || release.channel !== "stable" || !VERSION.test(release.version ?? "")
    || release.file !== `Lamarck-${release.version}-macos-arm64.zip`
    || release.signing !== "developer-id-notarized"
    || !/^sha256:[a-f0-9]{64}$/.test(release.sha256 ?? "")
    || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > 8 * 1024 ** 3
    || typeof release.pub_date !== "string" || !Number.isFinite(Date.parse(release.pub_date))) {
    throw new Error("Invalid signed stable desktop release metadata");
  }
  return {
    channel: "stable", version: release.version, file: release.file,
    signing: release.signing, sha256: release.sha256, bytes: release.bytes, pub_date: release.pub_date,
    ...(release.openSource === undefined ? {} : { openSource: validatedOpenSource(release.openSource, DESKTOP_RELEASE_ORIGIN) }),
  };
}

export function desktopReleasePointer(value) {
  const release = validateDesktopRelease(value);
  const url = `${DESKTOP_RELEASE_ORIGIN}/${DESKTOP_RELEASE_PREFIX}/${release.version}/${release.file}`;
  // One atomic pointer serves both the website and Squirrel's static JSON feed.
  return { ...release, url, currentRelease: release.version, releases: [{
    version: release.version,
    updateTo: { version: release.version, name: release.version, pub_date: release.pub_date, notes: "", url },
  }] };
}

export async function publishDesktopRelease({ release: value, directory, store, fetchImpl = fetch }) {
  const release = validateDesktopRelease(value);
  const pointer = desktopReleasePointer(release);
  const archivePath = join(directory, release.file);
  const local = await hashFile(archivePath);
  if (`sha256:${local.sha256}` !== release.sha256 || local.size !== release.bytes) throw new Error("Local archive does not match release metadata");
  const pointerKey = `${DESKTOP_RELEASE_PREFIX}/latest.json`;
  const previous = await fetchImpl(`${DESKTOP_RELEASE_ORIGIN}/${pointerKey}`, {
    redirect: "error", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30000),
  });
  if (previous.ok) {
    const current = validateDesktopRelease(await previous.json());
    if (compareVersions(release.version, current.version) < 0) throw new Error("Refusing to downgrade the stable release pointer");
  } else {
    await previous.body?.cancel();
    if (previous.status !== 404) throw new Error(`Cannot check current release: HTTP ${previous.status}`);
  }
  const versionPrefix = `${DESKTOP_RELEASE_PREFIX}/${release.version}`;
  const immutable = { cacheControl: "public, max-age=31536000, immutable" };
  await store.putFileImmutable(`${versionPrefix}/${release.file}`, archivePath, { ...immutable, contentType: "application/zip" });
  await store.putBufferImmutable(`${versionPrefix}/SHA256SUMS`, Buffer.from(`${local.sha256}  ${release.file}\n`), { ...immutable, contentType: "text/plain" });
  const download = await fetchImpl(pointer.url, { redirect: "error", signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!download.ok || !download.body) throw new Error(`Cannot verify public release: HTTP ${download.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of download.body) {
    hash.update(chunk); bytes += chunk.byteLength;
    if (bytes > release.bytes) throw new Error("Public release exceeds expected size");
  }
  if (`sha256:${hash.digest("hex")}` !== release.sha256 || bytes !== release.bytes) throw new Error("Public release digest or size mismatch");
  await store.putBuffer(pointerKey, Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`), {
    contentType: "application/json", cacheControl: "no-cache",
  });
  return pointer;
}

function compareVersions(a, b) {
  const aa = a.split(".").map(BigInt), bb = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  return 0;
}

function validatedOpenSource(value, base) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("open-source release metadata must be an object");
  }
  const expectedUrlPrefix = `${base}/guest/macos/arm64/`;
  if (
    value.purpose !== "license-compliance"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.imageVersion ?? "")
    || typeof value.file !== "string"
    || !/^Lamarck-Capsule-Guest-[A-Za-z0-9._-]+-Open-Source\.tar\.gz$/.test(value.file)
    || typeof value.url !== "string"
    || !value.url.startsWith(expectedUrlPrefix)
    || !new RegExp(`^[a-f0-9]{16}/${escapeRegExp(value.file)}$`).test(
      value.url.slice(expectedUrlPrefix.length),
    )
    || !/^sha256:[a-f0-9]{64}$/.test(value.sha256 ?? "")
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1
    || value.bytes > 8 * 1024 * 1024 * 1024
    || value.mediaType !== "application/gzip"
    || value.format !== "tar+gzip"
  ) throw new Error("open-source release metadata is invalid");
  return {
    purpose: "license-compliance",
    imageVersion: value.imageVersion,
    file: value.file,
    url: value.url,
    sha256: value.sha256,
    bytes: value.bytes,
    mediaType: "application/gzip",
    format: "tar+gzip",
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
