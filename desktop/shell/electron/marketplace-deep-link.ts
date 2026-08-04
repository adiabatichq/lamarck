export const MARKETPLACE_PROTOCOL = "lamarck";
export const MARKETPLACE_PROTOCOL_HOST = "marketplace";
export const MARKETPLACE_DEEP_LINK_MAX_BYTES = 512;

export type MarketplacePackageKind = "app" | "connector";

export interface MarketplaceDeepLink {
  readonly kind: MarketplacePackageKind;
  readonly packageId: string;
}

const SCOPED_PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Parse only the authority-free Marketplace identity carried by a deep link.
 * Artifact locations, releases, and hashes are deliberately not expressible
 * here; they can only come from the signed resolve response.
 */
export function parseMarketplaceDeepLink(rawUrl: unknown): MarketplaceDeepLink {
  if (
    typeof rawUrl !== "string"
    || rawUrl.length === 0
    || Buffer.byteLength(rawUrl, "utf8") > MARKETPLACE_DEEP_LINK_MAX_BYTES
  ) {
    throw new Error("Marketplace URL is missing or oversized");
  }
  if (rawUrl.includes("%") || rawUrl.includes("\\")) {
    throw new Error("Marketplace URL contains encoded or unsafe path characters");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Marketplace URL is malformed");
  }
  if (
    parsed.protocol !== `${MARKETPLACE_PROTOCOL}:`
    || parsed.hostname !== MARKETPLACE_PROTOCOL_HOST
    || parsed.host !== MARKETPLACE_PROTOCOL_HOST
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.port !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("Marketplace URL authority is not allowed");
  }

  const match = parsed.pathname.match(/^\/(app|connector)\/([^/]+)$/);
  if (!match || !SCOPED_PACKAGE_ID_PATTERN.test(match[2])) {
    throw new Error("Marketplace URL must contain one valid scoped package ID");
  }
  const canonicalUrl = `${MARKETPLACE_PROTOCOL}://${MARKETPLACE_PROTOCOL_HOST}/${match[1]}/${match[2]}`;
  if (rawUrl !== canonicalUrl) {
    throw new Error("Marketplace URL path is not canonical");
  }
  return Object.freeze({
    kind: match[1] as MarketplacePackageKind,
    packageId: match[2],
  });
}

/** Return accepted handoffs in argv order while ignoring unrelated arguments. */
export function marketplaceDeepLinksFromArgv(argv: readonly string[]): MarketplaceDeepLink[] {
  const links: MarketplaceDeepLink[] = [];
  for (const argument of argv) {
    if (typeof argument !== "string" || !argument.toLowerCase().startsWith("lamarck:")) continue;
    try {
      links.push(parseMarketplaceDeepLink(argument));
    } catch {
      // Electron argv can contain unrelated or malformed protocol attempts.
      // They are rejected without preventing the application from starting.
    }
  }
  return links;
}
