#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GUEST_NODE_VERSION = "24.18.0";
const GUEST_WORKSPACE = "desktop/capsule-guest";
const NODE_FLOOR_PATTERN = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Proves that every Lamarck workspace in the selected Guest dependency
 * closure, and its exact lock entry, explicitly accepts the pinned Guest Node.
 * Host-only workspaces are intentionally outside this closure and retain their
 * independent Electron/Host engine floor.
 */
export async function verifyGuestNodeClosure(
  rootValue,
  { runtimeVersion = process.versions.node } = {},
) {
  const root = resolve(rootValue);
  if (runtimeVersion !== GUEST_NODE_VERSION) {
    throw new Error(
      `Guest JavaScript build requires Node ${GUEST_NODE_VERSION}; received ${runtimeVersion}`,
    );
  }
  const rootManifest = await readJson(join(root, "package.json"), "root package manifest");
  const lock = await readJson(join(root, "package-lock.json"), "root package lock");
  if (!Array.isArray(rootManifest.workspaces) || !isObject(lock.packages)) {
    throw new Error("Guest JavaScript build requires a canonical npm workspace lock");
  }

  const workspaceByName = new Map();
  for (const workspace of rootManifest.workspaces) {
    if (typeof workspace !== "string" || !isObject(lock.packages[workspace])) continue;
    const name = lock.packages[workspace].name;
    if (typeof name !== "string" || workspaceByName.has(name)) {
      throw new Error("Guest JavaScript build found an ambiguous workspace identity");
    }
    workspaceByName.set(name, workspace);
  }

  const pending = [GUEST_WORKSPACE];
  const closure = new Set();
  while (pending.length > 0) {
    const workspace = pending.shift();
    if (closure.has(workspace)) continue;
    closure.add(workspace);
    const manifest = await readJson(
      join(root, workspace, "package.json"),
      `Guest closure manifest ${workspace}`,
    );
    const locked = lock.packages[workspace];
    if (!isObject(locked)
      || locked.name !== manifest.name
      || locked.version !== manifest.version
      || locked.engines?.node !== manifest.engines?.node
      || !acceptsPinnedNode(manifest.engines?.node, runtimeVersion)) {
      throw new Error(
        `Guest closure workspace ${workspace} does not accept pinned Node ${GUEST_NODE_VERSION}`,
      );
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith("@lamarck/")) continue;
      const dependencyWorkspace = workspaceByName.get(name);
      if (!dependencyWorkspace) {
        throw new Error(`Guest closure dependency ${name} has no exact workspace lock entry`);
      }
      pending.push(dependencyWorkspace);
    }
  }
  return Object.freeze([...closure].sort());
}

async function readJson(path, description) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`${description} is not valid JSON`, { cause });
  }
  if (!isObject(value)) throw new Error(`${description} must be an object`);
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function acceptsPinnedNode(engine, runtimeVersion) {
  if (typeof engine !== "string") return false;
  const floor = NODE_FLOOR_PATTERN.exec(engine);
  const runtime = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(runtimeVersion);
  if (!floor || !runtime) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(runtime[index]) - Number(floor[index]);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root] = process.argv.slice(2);
  if (!root) throw new Error("usage: verify-guest-node-closure.mjs <snapshot-root>");
  const closure = await verifyGuestNodeClosure(root);
  process.stdout.write(`${JSON.stringify({
    nodeVersion: GUEST_NODE_VERSION,
    workspaces: closure,
  })}\n`);
}
