export interface BlobTransferPolicy {
  /** Maximum time with no bytes moving after the DATA stream is attached. */
  readonly idleTimeoutMs: number;
  /** Fixed setup/flush allowance in addition to the size-derived deadline. */
  readonly baseDeadlineMs: number;
  /** Minimum sustained local-vsock throughput accepted by the runtime. */
  readonly minimumBytesPerSecond: number;
}

export const DEFAULT_BLOB_TRANSFER_POLICY: BlobTransferPolicy = Object.freeze({
  idleTimeoutMs: 30_000,
  baseDeadlineMs: 60_000,
  minimumBytesPerSecond: 1024 * 1024,
});

const MAX_BLOB_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_MINIMUM_BYTES_PER_SECOND = 1024 * 1024 * 1024;

export function normalizeBlobTransferPolicy(
  value: Partial<BlobTransferPolicy> | undefined,
): BlobTransferPolicy {
  const policy = {
    idleTimeoutMs: value?.idleTimeoutMs ?? DEFAULT_BLOB_TRANSFER_POLICY.idleTimeoutMs,
    baseDeadlineMs: value?.baseDeadlineMs ?? DEFAULT_BLOB_TRANSFER_POLICY.baseDeadlineMs,
    minimumBytesPerSecond: value?.minimumBytesPerSecond
      ?? DEFAULT_BLOB_TRANSFER_POLICY.minimumBytesPerSecond,
  };
  boundedInteger(policy.idleTimeoutMs, "idleTimeoutMs", 1, MAX_TIMEOUT_MS);
  boundedInteger(policy.baseDeadlineMs, "baseDeadlineMs", 1, MAX_TIMEOUT_MS);
  boundedInteger(
    policy.minimumBytesPerSecond,
    "minimumBytesPerSecond",
    1,
    MAX_MINIMUM_BYTES_PER_SECOND,
  );
  return Object.freeze(policy);
}

export function blobTransferAbsoluteDeadlineMs(
  bytes: number,
  policy: BlobTransferPolicy = DEFAULT_BLOB_TRANSFER_POLICY,
): number {
  boundedInteger(bytes, "blob bytes", 1, MAX_BLOB_BYTES);
  const transferMs = Math.ceil((bytes * 1000) / policy.minimumBytesPerSecond);
  const deadlineMs = policy.baseDeadlineMs + transferMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs > MAX_TIMEOUT_MS) {
    throw new Error("blob transfer deadline exceeds the 24-hour protocol bound");
  }
  return deadlineMs;
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}
