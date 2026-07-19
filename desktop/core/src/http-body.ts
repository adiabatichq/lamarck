const DEFAULT_MAX_JSON_BODY_BYTES = 20 * 1024 * 1024;

export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function readJsonBody<T>(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpStatusError(413, "request body is too large");
  }
  if (!request.body) throw new HttpStatusError(400, "request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpStatusError(413, "request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpStatusError(400, "request body must be valid JSON");
  }
}
