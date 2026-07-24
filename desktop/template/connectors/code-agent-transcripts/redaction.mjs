const LARGE_TOKEN_PREFILTER_LENGTH = 4096;
const STRUCTURED_JSON_MAX_BYTES = 1_000_000;
const STRUCTURED_REDACTION_MAX_DEPTH = 32;
const REDACTED_SECRET = "[REDACTED_SECRET]";
const REDACTED_STRUCTURED_VALUE = "[REDACTED_STRUCTURED_VALUE]";
const REDACTED_PAYLOAD = "[REDACTED_PAYLOAD]";

export function redactValue(value, fieldName, depth = 0) {
  if (fieldName && isSensitiveFieldName(fieldName)) return REDACTED_SECRET;
  if (typeof value === "string") {
    const structured = redactStructuredJsonString(value, fieldName, depth);
    return structured ?? redactString(value);
  }
  if (depth >= STRUCTURED_REDACTION_MAX_DEPTH) return REDACTED_STRUCTURED_VALUE;
  if (Array.isArray(value)) {
    return value.map((child) => redactValue(child, undefined, depth + 1));
  }
  if (isObject(value)) {
    const encodedPayloadField = providerEncodedPayloadField(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === encodedPayloadField
          ? REDACTED_PAYLOAD
          : redactValue(child, key, depth + 1),
      ]),
    );
  }
  return value;
}

function providerEncodedPayloadField(value) {
  if (value.type === "image_generation_call" && isLargeBase64Payload(value.result)) {
    return "result";
  }
  if (value.type === "base64" && isLargeBase64Payload(value.data)) {
    return "data";
  }
  return undefined;
}

function isLargeBase64Payload(value) {
  if (typeof value !== "string" || value.length < LARGE_TOKEN_PREFILTER_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isBase64TokenCharacter(value.charCodeAt(index))) return false;
  }
  return true;
}

function redactStructuredJsonString(value, fieldName, depth = 0) {
  if (!fieldName || !isStructuredJsonFieldName(fieldName)) return undefined;
  const trimmed = value.trim();
  const isObjectText = trimmed.startsWith("{") && trimmed.endsWith("}");
  const isArrayText = trimmed.startsWith("[") && trimmed.endsWith("]");
  if ((!isObjectText && !isArrayText)
    || Buffer.byteLength(value) > STRUCTURED_JSON_MAX_BYTES) {
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) && !Array.isArray(parsed)) return undefined;

  const pending = [{ value: parsed, depth: depth + 1 }];
  while (pending.length) {
    const current = pending.pop();
    if (current.depth >= STRUCTURED_REDACTION_MAX_DEPTH) {
      return REDACTED_STRUCTURED_VALUE;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        if (typeof child === "string" && redactString(child) !== child) {
          return REDACTED_STRUCTURED_VALUE;
        }
        if (isObject(child) || Array.isArray(child)) {
          pending.push({ value: child, depth: current.depth + 1 });
        }
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (isSensitiveFieldName(key)) return REDACTED_STRUCTURED_VALUE;
      if (typeof child === "string") {
        if (redactString(child) !== child) return REDACTED_STRUCTURED_VALUE;
        const nested = redactStructuredJsonString(child, key, current.depth);
        if (nested !== undefined && nested !== child) return REDACTED_STRUCTURED_VALUE;
      } else if (isObject(child) || Array.isArray(child)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return value;
}

export function redactString(value) {
  return redactKnownSecrets(redactLargeDataUrls(value));
}

function redactKnownSecrets(value) {
  let output = value;
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{24,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  ];
  for (const pattern of patterns) output = output.replace(pattern, REDACTED_SECRET);
  return output;
}

function isStructuredJsonFieldName(value) {
  const compact = String(value).replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
  return [
    "argument",
    "arguments",
    "args",
    "input",
    "output",
    "result",
    "toolinput",
    "tooloutput",
  ].includes(compact);
}

function isSensitiveFieldName(value) {
  const words = String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
  const descriptors = new Set(["count", "counts", "limit", "limits", "usage", "budget", "length", "size", "index", "type", "name"]);
  if (words.some((word) => descriptors.has(word))) return false;
  if (words.some((word) => ["password", "passwd", "pwd", "secret", "credential", "credentials", "authorization", "cookie"].includes(word))) {
    return true;
  }
  const compact = words.join("");
  if (compact.includes("apikey") || compact.includes("privatekey")) return true;
  return words.includes("token");
}

function redactLargeDataUrls(value) {
  const parts = [];
  let copiedThrough = 0;
  let searchFrom = 0;

  while (searchFrom < value.length) {
    const dataStart = value.indexOf("data:", searchFrom);
    if (dataStart < 0) break;
    const comma = value.indexOf(",", dataStart + 5);
    if (comma < 0 || comma - dataStart > 512) {
      searchFrom = dataStart + 5;
      continue;
    }
    const header = value.slice(dataStart + 5, comma).toLowerCase();
    if (!header.includes(";base64")) {
      searchFrom = comma + 1;
      continue;
    }
    const payloadStart = comma + 1;
    let payloadEnd = payloadStart;
    while (payloadEnd < value.length
      && isBase64TokenCharacter(value.charCodeAt(payloadEnd))) {
      payloadEnd += 1;
    }
    if (payloadEnd - payloadStart < LARGE_TOKEN_PREFILTER_LENGTH) {
      searchFrom = Math.max(payloadEnd, payloadStart + 1);
      continue;
    }
    parts.push(value.slice(copiedThrough, payloadStart), REDACTED_PAYLOAD);
    copiedThrough = payloadEnd;
    searchFrom = payloadEnd;
  }

  if (copiedThrough === 0) return value;
  parts.push(value.slice(copiedThrough));
  return parts.join("");
}

function isBase64TokenCharacter(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 43
    || code === 45
    || code === 47
    || code === 61
    || code === 95;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
