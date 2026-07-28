import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadVerifiedFile } from "./download-verified-file.mjs";

test("retries a timed-out response body from a clean partial file", async () => {
  const root = await mkdtemp(join(tmpdir(), "lamarck-download-retry-"));
  try {
    const target = join(root, "artifact.tar.gz");
    const payload = Buffer.from("complete immutable artifact");
    const retries = [];
    let calls = 0;
    await downloadVerifiedFile({
      url: "https://releases.example/artifact.tar.gz",
      label: "test artifact",
      target,
      expectedBytes: payload.byteLength,
      expectedSha256: sha256(payload),
      timeoutMs: 10,
      timeoutSignalFactory: timeoutSignal,
      retryDelayMs: 0,
      onRetry: (event) => retries.push(event),
      fetchImpl: async (_url, { signal }) => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            status: 200,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(payload.subarray(0, 7));
                signal.addEventListener("abort", () => {
                  controller.error(signal.reason);
                }, { once: true });
              },
            }),
          };
        }
        return new Response(payload);
      },
    });

    assert.equal(calls, 2);
    assert.equal(retries.length, 1);
    assert.deepEqual(await readFile(target), payload);
    assert.equal((await stat(target)).size, payload.byteLength);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes an invalid completed download without retrying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "lamarck-download-integrity-"));
  try {
    const target = join(root, "artifact.tar.gz");
    const payload = Buffer.from("wrong artifact");
    let calls = 0;
    await assert.rejects(
      downloadVerifiedFile({
        url: "https://releases.example/artifact.tar.gz",
        label: "test artifact",
        target,
        expectedBytes: payload.byteLength,
        expectedSha256: "0".repeat(64),
        retryDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          return new Response(payload);
        },
      }),
      /failed verification/,
    );
    assert.equal(calls, 1);
    await assert.rejects(stat(target), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);
  return controller.signal;
}
