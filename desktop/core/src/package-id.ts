/**
 * Local App and Connector package IDs are one or more lowercase ID segments.
 * Marketplace authorization applies the stricter namespace.name requirement;
 * Desktop runtime components keep the complete accepted ID opaque.
 */
export const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

export const SCOPED_PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/;

export const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
