#!/usr/bin/env node

import { readValidatedGuestSigningKey } from "./signing-key.mjs";

const [keyPath, repositoryRoot] = process.argv.slice(2);
if (!keyPath || !repositoryRoot) {
  throw new Error("usage: validate-signing-key.mjs <key.pem> <repository-root>");
}
await readValidatedGuestSigningKey(keyPath, { repositoryRoot });
process.stdout.write("Guest signing key custody validated\n");
