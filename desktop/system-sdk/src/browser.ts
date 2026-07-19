import { createSystem } from "./create-system.js";
import type { SystemInvoke } from "./protocol.js";

export * from "./create-system.js";
export * from "./protocol.js";

export const BROWSER_SYSTEM_HOST_GLOBAL = "__LAMARCK_SYSTEM_HOST__" as const;

export interface BrowserSystemHost {
  invoke: SystemInvoke;
}

type BrowserSystemGlobal = typeof globalThis & {
  __LAMARCK_SYSTEM_HOST__?: BrowserSystemHost;
};

const invoke: SystemInvoke = (operation, input) => {
  const host = (globalThis as BrowserSystemGlobal).__LAMARCK_SYSTEM_HOST__;
  if (!host || typeof host.invoke !== "function") {
    return Promise.reject(new Error("Lamarck Host did not inject the System SDK channel"));
  }
  return host.invoke(operation, input);
};

// The injected object exposes only invoke. It contains no App id, Core URL,
// bearer capability, credential, or other reusable authority material.
export const system = createSystem(invoke);
