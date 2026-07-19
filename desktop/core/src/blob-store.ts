import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type {
  ContentBlobRef,
  ResolveContentRefResult,
} from "@lamarck/system/protocol";

export type {
  ContentBlobRef,
  ResolveContentRefResult,
} from "@lamarck/system/protocol";

export interface WriteTextBlobInput {
  text: string;
  variant?: "redacted-text";
  mediaType?: "text/plain; charset=utf-8";
}

export interface WriteTextBlobResult {
  ref: ContentBlobRef;
  bytes: number;
  compressedBytes: number;
}

export class ContentBlobStore {
  constructor(private workspacePath: string) {}

  writeText(input: WriteTextBlobInput): WriteTextBlobResult {
    if (typeof input.text !== "string") {
      throw new Error("Content blob text must be a string");
    }
    const bytes = Buffer.from(input.text, "utf8");
    const digestHex = createHash("sha256").update(bytes).digest("hex");
    const digest = `sha256:${digestHex}`;
    const compressed = gzipSync(bytes);
    const filePath = this.pathForDigest(digestHex);
    mkdirSync(filePath.dir, { recursive: true });
    try {
      writeFileSync(filePath.path, compressed, { flag: "wx" });
    } catch (err) {
      if (!isNodeErrorCode(err, "EEXIST")) throw err;
    }
    return {
      ref: {
        kind: "content-blob",
        version: 1,
        digest,
        variant: input.variant ?? "redacted-text",
        mediaType: input.mediaType ?? "text/plain; charset=utf-8",
        encoding: "gzip",
      },
      bytes: bytes.byteLength,
      compressedBytes: compressed.byteLength,
    };
  }

  resolve(ref: unknown): ResolveContentRefResult {
    const parsed = parseContentBlobRef(ref);
    if (!parsed.ok) return { status: "unsupported", reason: parsed.reason };

    const filePath = this.pathForDigest(parsed.digestHex);
    if (!existsSync(filePath.path)) {
      return { status: "missing", digest: parsed.ref.digest };
    }

    let compressed: Buffer;
    try {
      compressed = readFileSync(filePath.path);
    } catch (err) {
      if (isNodeErrorCode(err, "ENOENT")) {
        return { status: "missing", digest: parsed.ref.digest };
      }
      return { status: "decode_error", message: errorMessage(err) };
    }

    let bytes: Buffer;
    try {
      bytes = gunzipSync(compressed);
    } catch (err) {
      return { status: "decode_error", message: errorMessage(err) };
    }

    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== parsed.ref.digest) {
      return { status: "digest_mismatch", expected: parsed.ref.digest, actual };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (err) {
      return { status: "decode_error", message: errorMessage(err) };
    }

    return {
      status: "resolved",
      kind: "text",
      text,
      bytes: bytes.byteLength,
      digest: parsed.ref.digest,
      mediaType: parsed.ref.mediaType,
      variant: parsed.ref.variant,
    };
  }

  private pathForDigest(digestHex: string): { dir: string; path: string } {
    const dir = join(this.workspacePath, ".lamarck", "blobs", "content", "v1", "sha256", digestHex.slice(0, 2), digestHex.slice(2, 4));
    return { dir, path: join(dir, `${digestHex}.gz`) };
  }
}

function parseContentBlobRef(value: unknown): { ok: true; ref: ContentBlobRef; digestHex: string } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "contentRef must be an object" };
  if (value.kind !== "content-blob") return { ok: false, reason: "unsupported contentRef kind" };
  if (value.version !== 1) return { ok: false, reason: "unsupported contentRef version" };
  if (value.variant !== "redacted-text") return { ok: false, reason: "unsupported contentRef variant" };
  if (value.mediaType !== "text/plain; charset=utf-8") return { ok: false, reason: "unsupported contentRef mediaType" };
  if (value.encoding !== "gzip") return { ok: false, reason: "unsupported contentRef encoding" };
  if (typeof value.digest !== "string") return { ok: false, reason: "contentRef digest must be a string" };
  const digestHex = value.digest.startsWith("sha256:") ? value.digest.slice("sha256:".length) : "";
  if (!/^[a-f0-9]{64}$/.test(digestHex)) return { ok: false, reason: "unsupported contentRef digest" };
  return { ok: true, ref: value as unknown as ContentBlobRef, digestHex };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object"
    && err !== null
    && "code" in err
    && (err as { code?: unknown }).code === code;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
