import { describe, expect, test } from "vitest";
import { validateSystemSdkProtocolMetadata } from "../src/build-manager";

describe("System SDK compatibility metadata", () => {
  test("accepts any package version that explicitly implements System protocol V1", () => {
    expect(() => validateSystemSdkProtocolMetadata({
      name: "@lamarck/system",
      version: "2.4.1",
      lamarckSystemProtocol: 1,
    })).not.toThrow();
  });

  test.each([
    {},
    { name: "@lamarck/system", version: "0.1.0" },
    { name: "@lamarck/system", version: "0.1.0", lamarckSystemProtocol: 2 },
    { name: "@other/system", version: "0.1.0", lamarckSystemProtocol: 1 },
    { name: "@lamarck/system", version: "latest", lamarckSystemProtocol: 1 },
  ])("rejects incompatible or forged package metadata %#", (metadata) => {
    expect(() => validateSystemSdkProtocolMetadata(metadata)).toThrow(
      "not compatible with System protocol V1",
    );
  });
});
