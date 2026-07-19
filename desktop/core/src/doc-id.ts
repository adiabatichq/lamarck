import { isAbsolute, relative, resolve, sep } from "path";

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const PORTABLE_PATH_CHARS = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_DOC_ID_BYTES = 768;
const MAX_DOC_SEGMENT_BYTES = 240;

export function validateDocId(id: string): void {
  if (!id || id.trim() !== id) {
    throw new Error("Invalid doc id");
  }
  if (isAbsolute(id) || id.startsWith("/") || id.includes("\\") || CONTROL_CHARS.test(id)) {
    throw new Error("Invalid doc id");
  }

  const parts = id.split("/");
  if (
    Buffer.byteLength(id, "utf8") > MAX_DOC_ID_BYTES
    || parts.some((part) =>
      part === ""
      || part === "."
      || part === ".."
      || part.endsWith(" ")
      || part.endsWith(".")
      || PORTABLE_PATH_CHARS.test(part)
      || WINDOWS_RESERVED_NAME.test(part)
      || Buffer.byteLength(part, "utf8") > MAX_DOC_SEGMENT_BYTES
    )
  ) {
    throw new Error("Invalid doc id");
  }
}

/**
 * Conservative identity for a doc id once it is materialized on a portable
 * user filesystem. NFKD covers canonical/compatibility normalization aliases;
 * upper-then-lower approximates Unicode case folding (including characters
 * such as ß) without depending on the Host locale.
 */
export function portableDocIdKey(id: string): string {
  validateDocId(id);
  return id.normalize("NFKD").toUpperCase().toLowerCase().normalize("NFKD");
}

export interface PortableDocMaterializationSegment {
  spelling: string;
  key: string;
  kind: "directory" | "file";
}

export function portableDocMaterializationSegments(
  id: string,
): PortableDocMaterializationSegment[] {
  validateDocId(id);
  const parts = id.split("/");
  return parts.map((part, index) => {
    const kind = index === parts.length - 1 ? "file" : "directory";
    const spelling = kind === "file" ? `${part}.md` : part;
    return { spelling, key: portablePathSegmentKey(spelling), kind };
  });
}

export function docIdsHavePortableMaterializationConflict(a: string, b: string): boolean {
  if (a === b) return false;
  const left = portableDocMaterializationSegments(a);
  const right = portableDocMaterializationSegments(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l.key !== r.key) return false;
    if (l.spelling !== r.spelling || l.kind !== r.kind) return true;
  }
  // Equal physical paths or one materialized file occupying the directory the
  // other id needs are both impossible to represent simultaneously.
  return true;
}

export function portablePathSegmentKey(value: string): string {
  return value.normalize("NFKD").toUpperCase().toLowerCase().normalize("NFKD");
}

export function resolveDocFilePath(pagesDir: string, docId: string): string {
  validateDocId(docId);

  const root = resolve(pagesDir);
  const target = resolve(root, `${docId}.md`);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Invalid doc id");
  }
  return target;
}
