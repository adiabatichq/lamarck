// ULID generator — time-sortable unique IDs
// Spec: https://github.com/ulid/spec

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford's Base32

function encodeTime(now: number, len: number): string {
  let str = "";
  for (let i = len; i > 0; i--) {
    str = ENCODING[now % 32] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < len; i++) {
    str += ENCODING[bytes[i] % 32];
  }
  return str;
}

export function ulid(): string {
  const now = Date.now();
  return encodeTime(now, 10) + encodeRandom(16);
}
