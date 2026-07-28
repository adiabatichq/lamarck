import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

class NonRetryableDownloadError extends Error {}

export async function downloadVerifiedFile({
  url,
  label,
  target,
  expectedBytes,
  expectedSha256,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  timeoutSignalFactory = AbortSignal.timeout,
  onRetry = ({ attempt, error }) => {
    console.warn(`[guest] RETRY ${label} after attempt ${attempt}: ${error.message}`);
  },
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let destinationOpened = false;
    try {
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: timeoutSignalFactory(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`${label} download failed with ${response.status}`);
        if (![408, 429].includes(response.status) && response.status < 500) {
          throw new NonRetryableDownloadError(error.message);
        }
        throw error;
      }
      if (!response.body) throw new Error(`${label} response has no body`);

      const digest = createHash("sha256");
      let bytes = 0;
      const destinationHandle = await open(target, "wx");
      destinationOpened = true;
      const destination = createWriteStream(target, {
        fd: destinationHandle.fd,
        autoClose: false,
      });
      try {
        await pipeline(
          response.body,
          async function* verify(sourceStream) {
            for await (const chunk of sourceStream) {
              digest.update(chunk);
              bytes += chunk.byteLength;
              if (bytes > expectedBytes) {
                throw new NonRetryableDownloadError(`${label} exceeded its inventory size`);
              }
              yield chunk;
            }
          },
          destination,
        );
      } finally {
        await destinationHandle.close();
      }
      if (bytes !== expectedBytes || digest.digest("hex") !== expectedSha256) {
        throw new NonRetryableDownloadError(`${label} failed verification`);
      }
      return;
    } catch (error) {
      if (destinationOpened) await unlinkIfPresent(target);
      if (error instanceof NonRetryableDownloadError) throw error;
      lastError = error;
      if (attempt < attempts) {
        onRetry({ attempt, error });
        await new Promise((resolvePromise) => {
          setTimeout(resolvePromise, retryDelayMs * (2 ** (attempt - 1)));
        });
      }
    }
  }
  throw lastError ?? new Error(`${label} download failed`);
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
