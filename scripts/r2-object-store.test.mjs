import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { R2ObjectStore } from "./r2-object-store.mjs";

const MEBIBYTE = 1024 * 1024;

test("multipart immutable upload retries one part and keeps identical reruns", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lamarck-r2-test-"));
  try {
    const file = join(fixture, "guest.img");
    const bytes = Buffer.alloc(11 * MEBIBYTE + 17, 0x5a);
    await writeFile(file, bytes);
    const memory = memoryR2({ failFirstPartOnce: true });
    const store = testStore(memory.transport);

    const first = await store.putFileImmutable("guest/macos/arm64/digest/rootfs.ext4", file, {
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    });
    assert.equal(first.uploaded, true);
    assert.equal(first.size, bytes.byteLength);
    assert.equal(first.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(memory.uploadedPartSizes, [5 * MEBIBYTE, 5 * MEBIBYTE, MEBIBYTE + 17]);
    assert.equal(memory.failedPartAttempts, 1);
    assert.deepEqual(memory.objects.get("guest/macos/arm64/digest/rootfs.ext4")?.body, bytes);

    const requestCount = memory.requests.length;
    const second = await store.putFileImmutable("guest/macos/arm64/digest/rootfs.ext4", file, {
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    });
    assert.equal(second.uploaded, false);
    assert.equal(memory.requests.length, requestCount + 1, "an identical retry should perform only HEAD");
    assert.match(
      memory.requests.find((request) => request.method === "POST" && request.path.includes("uploads="))
        ?.headers.authorization ?? "",
      /SignedHeaders=.*x-amz-meta-sha256/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("immutable upload rejects an existing object with different bytes", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lamarck-r2-test-"));
  try {
    const file = join(fixture, "release.json");
    const memory = memoryR2();
    const store = testStore(memory.transport);
    await writeFile(file, "first\n");
    await store.putFileImmutable("desktop/release.json", file, {
      contentType: "application/json",
      cacheControl: "public, max-age=31536000, immutable",
    });
    await writeFile(file, "second\n");
    await assert.rejects(
      store.putFileImmutable("desktop/release.json", file, {
        contentType: "application/json",
        cacheControl: "public, max-age=31536000, immutable",
      }),
      /refusing to overwrite immutable R2 object/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function testStore(transport) {
  return new R2ObjectStore({
    accountId: "account123",
    accessKeyId: "accesskey123",
    secretAccessKey: "secretkey123",
    bucket: "release-test",
    transport,
    now: () => new Date("2026-07-21T12:34:56.000Z"),
    sleep: async () => {},
    multipartThresholdBytes: 5 * MEBIBYTE,
    multipartPartBytes: 5 * MEBIBYTE,
  });
}

function memoryR2({ failFirstPartOnce = false } = {}) {
  const objects = new Map();
  const uploads = new Map();
  const requests = [];
  const uploadedPartSizes = [];
  let failedPartAttempts = 0;

  async function transport(request) {
    const body = await bodyBuffer(request.body);
    requests.push({ ...request, body });
    const url = new URL(request.path, "https://r2.invalid");
    const key = url.pathname.split("/").slice(2).map(decodeURIComponent).join("/");
    const uploadId = url.searchParams.get("uploadId");

    if (request.method === "HEAD") {
      const object = objects.get(key);
      if (!object) return response(404);
      return response(200, {
        "content-length": String(object.body.byteLength),
        "x-amz-meta-sha256": object.sha256,
        etag: '"stored"',
      });
    }
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = "upload&1";
      uploads.set(id, { key, headers: request.headers, parts: new Map() });
      return response(200, {}, `<InitiateMultipartUploadResult><UploadId>upload&amp;1</UploadId></InitiateMultipartUploadResult>`);
    }
    if (request.method === "PUT" && uploadId) {
      const partNumber = Number(url.searchParams.get("partNumber"));
      if (failFirstPartOnce && partNumber === 1 && failedPartAttempts === 0) {
        failedPartAttempts += 1;
        return response(503, {}, "retry");
      }
      const upload = uploads.get(uploadId);
      assert.ok(upload, "multipart upload id must exist");
      upload.parts.set(partNumber, body);
      uploadedPartSizes.push(body.byteLength);
      return response(200, { etag: `"part-${partNumber}"` });
    }
    if (request.method === "POST" && uploadId) {
      const upload = uploads.get(uploadId);
      assert.ok(upload, "multipart upload id must exist");
      const combined = Buffer.concat([...upload.parts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, part]) => part));
      objects.set(upload.key, {
        body: combined,
        sha256: upload.headers["x-amz-meta-sha256"],
      });
      uploads.delete(uploadId);
      return response(200, {}, "<CompleteMultipartUploadResult />");
    }
    if (request.method === "DELETE" && uploadId) {
      uploads.delete(uploadId);
      return response(204);
    }
    if (request.method === "PUT") {
      objects.set(key, {
        body,
        sha256: request.headers["x-amz-meta-sha256"],
      });
      return response(200, { etag: '"stored"' });
    }
    return response(400, {}, "unexpected request");
  }

  return {
    objects,
    requests,
    uploadedPartSizes,
    get failedPartAttempts() {
      return failedPartAttempts;
    },
    transport,
  };
}

async function bodyBuffer(body) {
  if (body === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function response(statusCode, headers = {}, body = "") {
  return { statusCode, headers, body };
}
