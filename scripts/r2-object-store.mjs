// Dependency-free S3 SigV4 client for the Cloudflare R2 releases bucket.
// Release objects are uploaded immutably and files above 100 MiB use S3
// multipart upload so a transient failure retries one part instead of the
// complete desktop or Guest payload.
//
// Credentials are supplied through the environment. See RELEASING.md for
// release-infrastructure setup and the required variables:
//   R2_ACCOUNT_ID, R2_RELEASES_ACCESS_KEY_ID, R2_RELEASES_SECRET_ACCESS_KEY

import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MEBIBYTE = 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 100 * MEBIBYTE;
const MULTIPART_PART_BYTES = 64 * MEBIBYTE;
const MAX_REQUEST_ATTEMPTS = 4;

export function r2StoreFromEnvironment(bucket) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_RELEASES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_RELEASES_SECRET_ACCESS_KEY;
  for (const [name, value] of [
    ["R2_ACCOUNT_ID", accountId],
    ["R2_RELEASES_ACCESS_KEY_ID", accessKeyId],
    ["R2_RELEASES_SECRET_ACCESS_KEY", secretAccessKey],
  ]) {
    if (!/^[A-Za-z0-9+/=_-]{8,128}$/.test(value ?? "")) {
      throw new Error(`${name} is missing or malformed in the environment`);
    }
  }
  return new R2ObjectStore({ accountId, accessKeyId, secretAccessKey, bucket });
}

export class R2ObjectStore {
  constructor({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    transport = sendHttpsRequest,
    now = () => new Date(),
    sleep = delay,
    multipartThresholdBytes = MULTIPART_THRESHOLD_BYTES,
    multipartPartBytes = MULTIPART_PART_BYTES,
  }) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(accountId ?? "")) throw new Error("invalid R2 account id");
    if (!/^[A-Za-z0-9+/=_-]{8,128}$/.test(accessKeyId ?? "")) throw new Error("invalid R2 access key id");
    if (!/^[A-Za-z0-9+/=_-]{8,128}$/.test(secretAccessKey ?? "")) throw new Error("invalid R2 secret access key");
    if (!/^[a-z0-9-]{3,63}$/.test(bucket ?? "")) throw new Error("invalid R2 bucket name");
    if (!Number.isSafeInteger(multipartThresholdBytes) || multipartThresholdBytes < 5 * MEBIBYTE) {
      throw new Error("invalid multipart threshold");
    }
    if (
      !Number.isSafeInteger(multipartPartBytes)
      || multipartPartBytes < 5 * MEBIBYTE
      || multipartPartBytes > 5 * 1024 * MEBIBYTE
    ) throw new Error("invalid multipart part size");
    this.host = `${accountId}.r2.cloudflarestorage.com`;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
    this.transport = transport;
    this.now = now;
    this.sleep = sleep;
    this.multipartThresholdBytes = multipartThresholdBytes;
    this.multipartPartBytes = multipartPartBytes;
  }

  /** Returns immutable identity metadata, or null when the object is absent. */
  async headObject(key) {
    const response = await this.#signedRequest("HEAD", key, EMPTY_SHA256);
    if (response.statusCode === 404) return null;
    if (response.statusCode !== 200) {
      throw new Error(`R2 HEAD ${key} failed with ${response.statusCode}: ${response.body}`);
    }
    const rawSize = headerValue(response.headers, "content-length");
    const size = Number(rawSize);
    return {
      size: Number.isSafeInteger(size) && size >= 0 ? size : null,
      sha256: headerValue(response.headers, "x-amz-meta-sha256") ?? null,
      etag: headerValue(response.headers, "etag") ?? null,
    };
  }

  async objectExists(key) {
    return (await this.headObject(key)) !== null;
  }

  /** Uploads a file, replacing an existing object. Prefer putFileImmutable for release paths. */
  async putFile(key, filePath, options) {
    const identity = await hashFile(filePath);
    await this.#putFileWithIdentity(key, filePath, identity, options);
    await this.#assertPublishedIdentity(key, identity);
    return identity;
  }

  /**
   * Publishes a file exactly once. A retry skips an existing byte-identical
   * object and rejects an existing object whose size or digest differs.
   */
  async putFileImmutable(key, filePath, options) {
    const identity = await hashFile(filePath);
    const existing = await this.headObject(key);
    if (existing) {
      assertSameIdentity(key, existing, identity);
      return { ...identity, uploaded: false };
    }
    await this.#putFileWithIdentity(key, filePath, identity, options);
    await this.#assertPublishedIdentity(key, identity);
    return { ...identity, uploaded: true };
  }

  async putBuffer(key, buffer, options) {
    const identity = bufferIdentity(buffer);
    await this.#putBufferWithIdentity(key, buffer, identity, options);
    await this.#assertPublishedIdentity(key, identity);
    return identity;
  }

  async putBufferImmutable(key, buffer, options) {
    const identity = bufferIdentity(buffer);
    const existing = await this.headObject(key);
    if (existing) {
      assertSameIdentity(key, existing, identity);
      return { ...identity, uploaded: false };
    }
    await this.#putBufferWithIdentity(key, buffer, identity, options);
    await this.#assertPublishedIdentity(key, identity);
    return { ...identity, uploaded: true };
  }

  async #assertPublishedIdentity(key, identity) {
    const published = await this.headObject(key);
    if (!published || !sameIdentity(published, identity)) {
      throw new Error(`R2 object ${key} does not expose the expected immutable identity after upload`);
    }
  }

  async #putFileWithIdentity(key, filePath, identity, options) {
    if (identity.size >= this.multipartThresholdBytes) {
      await this.#putMultipartFile(key, filePath, identity, options);
      return;
    }
    const response = await this.#signedRequest("PUT", key, identity.sha256, {
      body: () => createReadStream(filePath),
      contentLength: identity.size,
      headers: releaseHeaders(options, identity.sha256),
    });
    requireStatus(response, [200], `R2 PUT ${key}`);
  }

  async #putBufferWithIdentity(key, buffer, identity, options) {
    const response = await this.#signedRequest("PUT", key, identity.sha256, {
      body: buffer,
      contentLength: identity.size,
      headers: releaseHeaders(options, identity.sha256),
    });
    requireStatus(response, [200], `R2 PUT ${key}`);
  }

  async #putMultipartFile(key, filePath, identity, options) {
    const initiation = await this.#signedRequest("POST", key, EMPTY_SHA256, {
      query: { uploads: "" },
      headers: releaseHeaders(options, identity.sha256),
    });
    requireStatus(initiation, [200], `R2 initiate multipart ${key}`);
    const uploadId = xmlElement(initiation.body, "UploadId");
    if (!uploadId) throw new Error(`R2 initiate multipart ${key} returned no UploadId`);

    const parts = [];
    let completed = false;
    const handle = await open(filePath, "r");
    try {
      for (let offset = 0, partNumber = 1; offset < identity.size; partNumber += 1) {
        const length = Math.min(this.multipartPartBytes, identity.size - offset);
        const buffer = Buffer.allocUnsafe(length);
        let readBytes = 0;
        while (readBytes < length) {
          const read = await handle.read(buffer, readBytes, length - readBytes, offset + readBytes);
          if (read.bytesRead === 0) throw new Error(`release file ended during multipart upload: ${filePath}`);
          readBytes += read.bytesRead;
        }
        const partSha256 = createHash("sha256").update(buffer).digest("hex");
        const response = await this.#signedRequest("PUT", key, partSha256, {
          query: { partNumber: String(partNumber), uploadId },
          body: buffer,
          contentLength: buffer.byteLength,
        });
        requireStatus(response, [200], `R2 upload part ${partNumber} for ${key}`);
        const etag = headerValue(response.headers, "etag");
        if (!etag || etag.length > 256 || /[\u0000-\u001f\u007f]/.test(etag)) {
          throw new Error(`R2 upload part ${partNumber} for ${key} returned an invalid ETag`);
        }
        parts.push({ etag, partNumber });
        offset += length;
      }

      const completionBody = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${parts.map((part) => (
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`
        )).join("")}</CompleteMultipartUpload>`,
        "utf8",
      );
      const completionSha256 = createHash("sha256").update(completionBody).digest("hex");
      let completion;
      try {
        completion = await this.#signedRequest("POST", key, completionSha256, {
          query: { uploadId },
          body: completionBody,
          contentLength: completionBody.byteLength,
          headers: { "content-type": "application/xml" },
        });
      } catch (error) {
        const published = await this.headObject(key).catch(() => null);
        if (published && sameIdentity(published, identity)) {
          completed = true;
          return;
        }
        throw error;
      }
      const published = await this.headObject(key).catch(() => null);
      if (!published || !sameIdentity(published, identity)) {
        if (completion.statusCode !== 200) requireStatus(completion, [200], `R2 complete multipart ${key}`);
        throw new Error(`R2 complete multipart ${key} did not publish the expected object identity`);
      }
      completed = true;
    } finally {
      await handle.close();
      if (!completed) {
        await this.#signedRequest("DELETE", key, EMPTY_SHA256, {
          query: { uploadId },
          maxAttempts: 2,
        }).catch(() => undefined);
      }
    }
  }

  async #signedRequest(method, key, payloadSha256, options = {}) {
    const maximumAttempts = options.maxAttempts ?? MAX_REQUEST_ATTEMPTS;
    let lastError;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const response = await this.#signedRequestOnce(method, key, payloadSha256, options);
        if (!isRetryableStatus(response.statusCode) || attempt === maximumAttempts) return response;
        lastError = new Error(`R2 ${method} ${key} returned retryable status ${response.statusCode}`);
      } catch (error) {
        lastError = error;
        if (attempt === maximumAttempts) throw error;
      }
      await this.sleep(250 * (2 ** (attempt - 1)));
    }
    throw lastError ?? new Error(`R2 ${method} ${key} failed`);
  }

  #signedRequestOnce(method, key, payloadSha256, options) {
    const encodedKey = key.split("/").map(awsEncode).join("/");
    const canonicalPath = `/${awsEncode(this.bucket)}/${encodedKey}`;
    const canonicalQuery = queryString(options.query ?? {});
    const requestPath = canonicalQuery ? `${canonicalPath}?${canonicalQuery}` : canonicalPath;
    const amzDate = this.now().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const headers = {
      host: this.host,
      "x-amz-content-sha256": payloadSha256,
      "x-amz-date": amzDate,
      ...normalizeHeaders(options.headers ?? {}),
    };
    if (options.contentLength !== undefined) headers["content-length"] = String(options.contentLength);
    const signedHeaderNames = Object.keys(headers).sort();
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${canonicalHeaderValue(headers[name])}\n`)
      .join("");
    const canonicalRequest = [
      method,
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadSha256,
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    let signingKey = Buffer.from(`AWS4${this.secretAccessKey}`, "utf8");
    for (const part of [dateStamp, "auto", "s3", "aws4_request"]) {
      signingKey = createHmac("sha256", signingKey).update(part).digest();
    }
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const body = typeof options.body === "function" ? options.body() : options.body;
    return this.transport({
      host: this.host,
      method,
      path: requestPath,
      headers,
      body,
      timeoutMs: 120_000,
    });
  }
}

export async function hashFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`${filePath} is not a regular file`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return { sha256: hash.digest("hex"), size: details.size };
  } finally {
    await handle.close();
  }
}

function bufferIdentity(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("R2 buffer payload must be a Buffer");
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    size: buffer.byteLength,
  };
}

function releaseHeaders({ contentType, cacheControl } = {}, sha256) {
  if (typeof contentType !== "string" || contentType.length < 1) throw new Error("R2 content type is required");
  if (typeof cacheControl !== "string" || cacheControl.length < 1) throw new Error("R2 cache control is required");
  return {
    "cache-control": cacheControl,
    "content-type": contentType,
    "x-amz-meta-sha256": sha256,
  };
}

function assertSameIdentity(key, actual, expected) {
  if (!sameIdentity(actual, expected)) {
    throw new Error(
      `refusing to overwrite immutable R2 object ${key}; `
      + `existing size=${actual.size ?? "unknown"} sha256=${actual.sha256 ?? "missing"}`,
    );
  }
}

function sameIdentity(actual, expected) {
  return actual.size === expected.size && actual.sha256 === expected.sha256;
}

function requireStatus(response, expected, operation) {
  if (!expected.includes(response.statusCode)) {
    throw new Error(`${operation} failed with ${response.statusCode}: ${response.body}`);
  }
}

function isRetryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function normalizeHeaders(headers) {
  const result = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name) || rawValue === undefined || rawValue === null) {
      throw new Error(`invalid signed R2 header ${rawName}`);
    }
    result[name] = String(rawValue);
  }
  return result;
}

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function queryString(query) {
  return Object.entries(query)
    .map(([name, value]) => [awsEncode(name), awsEncode(String(value))])
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      if (leftValue === rightValue) return 0;
      return leftValue < rightValue ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function xmlElement(document, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(document);
  return match ? xmlDecode(match[1]) : null;
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlDecode(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function headerValue(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function sendHttpsRequest({ host, method, path, headers, body, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const clientRequest = httpsRequest(
      { host, method, path, headers, timeout: timeoutMs },
      (response) => {
        const chunks = [];
        let capturedBytes = 0;
        response.on("data", (chunk) => {
          if (capturedBytes >= 64 * 1024) return;
          const retained = chunk.subarray(0, 64 * 1024 - capturedBytes);
          chunks.push(retained);
          capturedBytes += retained.byteLength;
        });
        response.on("end", () => resolvePromise({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    clientRequest.on("timeout", () => clientRequest.destroy(new Error("R2 request timed out")));
    clientRequest.on("error", rejectPromise);
    if (body === undefined) {
      clientRequest.end();
    } else if (Buffer.isBuffer(body)) {
      clientRequest.end(body);
    } else {
      body.on("error", (error) => clientRequest.destroy(error));
      body.pipe(clientRequest);
    }
  });
}
