import { describe, expect, test, vi } from "vitest";
import {
  INVALID_VAULT_IDENTITY_REASON,
  UNSUPPORTED_DEVICE_PLATFORM_REASON,
  resolveDeviceIdentity,
} from "../src/device-identity";
import {
  DEVICE_IDENTITY_SCHEMES,
  clearMutableBytes,
  frameDeviceIdentity,
  isCanonicalVaultId,
  reduceDeviceIdentity,
} from "../src/device-identity/reduce";
import {
  DARWIN_HOST_UUID_TIMEOUT_SECONDS,
  DARWIN_IDENTITY_UNAVAILABLE_REASON,
  readDarwinMachineIdentifier,
} from "../src/device-identity/platform/darwin";
import {
  WINDOWS_IDENTITY_UNAVAILABLE_REASON,
  WINDOWS_SYSTEM_ID_MAX_BYTES,
  readWindowsMachineIdentifier,
} from "../src/device-identity/platform/win32";
import {
  LINUX_IDENTITY_UNAVAILABLE_REASON,
  readLinuxMachineIdentifier,
} from "../src/device-identity/platform/linux";

const SYNTHETIC_VAULT_ID = "AAECAwQFBgcICQoLDA0ODw";

function expectUnavailable(
  state: { status: string; reason?: string; value?: string },
): asserts state is { status: "unavailable"; reason: string } {
  expect(state.status).toBe("unavailable");
  expect(state).not.toHaveProperty("value");
  if (state.status !== "unavailable" || typeof state.reason !== "string") {
    throw new Error("Expected unavailable device identity state.");
  }
}

describe("device identity reduction", () => {
  test("pins the v1 frame and first-half SHA-256 vector", () => {
    const identifier = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    const frame = frameDeviceIdentity(
      "linux",
      DEVICE_IDENTITY_SCHEMES.linux,
      SYNTHETIC_VAULT_ID,
      identifier,
    );
    try {
      expect(frame.toString("hex")).toBe(
        "6c616d6172636b2e6465766963652d6964656e746974792e763100"
        + "6c696e7578006d616368696e652d69642e763100"
        + "41414543417751464267634943516f4c4441304f44770010203040",
      );
    } finally {
      clearMutableBytes(frame);
      clearMutableBytes(identifier);
    }

    const reductionInput = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    expect(
      reduceDeviceIdentity(
        "linux",
        DEVICE_IDENTITY_SCHEMES.linux,
        SYNTHETIC_VAULT_ID,
        reductionInput,
      ),
    ).toBe("d9c8d21e48ff3ab8d39fcb95485e2b28");
    expect(reductionInput.every((byte) => byte === 0)).toBe(true);
  });

  test("is deterministic and changes when one framing component changes", () => {
    const first = reduceDeviceIdentity(
      "linux",
      DEVICE_IDENTITY_SCHEMES.linux,
      SYNTHETIC_VAULT_ID,
      Buffer.from([1, 2, 3, 4]),
    );
    const second = reduceDeviceIdentity(
      "linux",
      DEVICE_IDENTITY_SCHEMES.linux,
      SYNTHETIC_VAULT_ID,
      Buffer.from([1, 2, 3, 4]),
    );
    const changed = reduceDeviceIdentity(
      "linux",
      DEVICE_IDENTITY_SCHEMES.linux,
      "AQECAwQFBgcICQoLDA0ODw",
      Buffer.from([1, 2, 3, 4]),
    );

    expect(first).toBe(second);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  test("accepts only the canonical 16-byte unpadded base64url vault form", () => {
    expect(isCanonicalVaultId(SYNTHETIC_VAULT_ID)).toBe(true);
    expect(isCanonicalVaultId(`${SYNTHETIC_VAULT_ID}==`)).toBe(false);
    expect(isCanonicalVaultId("AAECAwQFBgcICQoLDA0OD+")).toBe(false);
    expect(isCanonicalVaultId("too-short")).toBe(false);
    expect(isCanonicalVaultId(undefined)).toBe(false);
  });

  test("rejects a mismatched platform and scheme without exposing bytes", () => {
    const identifier = Buffer.from([1]);
    expect(() => frameDeviceIdentity(
      "linux",
      DEVICE_IDENTITY_SCHEMES.darwin,
      SYNTHETIC_VAULT_ID,
      identifier,
    )).toThrow("Invalid device identity scheme.");
    clearMutableBytes(identifier);
  });
});

describe("macOS machine identifier adapter", () => {
  test("uses a bounded native wait and accepts exactly 16 nonzero bytes", async () => {
    const candidate = Buffer.alloc(16, 7);
    const getHostUuid = vi.fn(() => candidate);
    const state = await readDarwinMachineIdentifier({ getHostUuid });

    expect(getHostUuid).toHaveBeenCalledExactlyOnceWith(DARWIN_HOST_UUID_TIMEOUT_SECONDS);
    expect(state.status).toBe("resolved");
    if (state.status === "resolved") clearMutableBytes(state.bytes);
  });

  const invalidCases: Array<[string, () => Buffer]> = [
    ["short result", () => Buffer.alloc(15, 1)],
    ["long result", () => Buffer.alloc(17, 1)],
    ["all-zero result", () => Buffer.alloc(16)],
  ];

  for (const [name, makeCandidate] of invalidCases) {
    test(`rejects ${name}`, async () => {
      const candidate = makeCandidate();
      const state = await readDarwinMachineIdentifier({ getHostUuid: () => candidate });
      expectUnavailable(state);
      expect(state.reason).toBe(DARWIN_IDENTITY_UNAVAILABLE_REASON);
      expect(candidate.every((byte) => byte === 0)).toBe(true);
    });
  }

  test("converts native failure to sanitized unavailability", async () => {
    const state = await readDarwinMachineIdentifier({
      getHostUuid: () => {
        throw new Error("native call failed");
      },
    });
    expectUnavailable(state);
    expect(state.reason).toBe(DARWIN_IDENTITY_UNAVAILABLE_REASON);
  });
});

describe("Windows machine identifier adapter", () => {
  test("pins the frozen defensive buffer cap", () => {
    expect(WINDOWS_SYSTEM_ID_MAX_BYTES).toBe(1024);
  });

  for (const source of ["Tpm", "Uefi", "Registry"] as const) {
    test(`accepts the ${source} source class`, async () => {
      const candidate = Buffer.alloc(24, 3);
      const state = await readWindowsMachineIdentifier({
        getSystemIdForPublisher: () => ({ source, id: candidate }),
      });
      expect(state.status).toBe("resolved");
      if (state.status === "resolved") clearMutableBytes(state.bytes);
    });
  }

  const invalidCases: Array<[string, () => { source: unknown; id: unknown }]> = [
    ["None source", () => ({ source: "None", id: Buffer.alloc(24, 1) })],
    ["future source", () => ({ source: "Future", id: Buffer.alloc(24, 1) })],
    ["numeric source", () => ({ source: 1, id: Buffer.alloc(24, 1) })],
    ["null identifier", () => ({ source: "Tpm", id: null })],
    ["empty identifier", () => ({ source: "Tpm", id: Buffer.alloc(0) })],
    [
      "oversized identifier",
      () => ({ source: "Tpm", id: Buffer.alloc(WINDOWS_SYSTEM_ID_MAX_BYTES + 1, 1) }),
    ],
  ];

  for (const [name, makeResult] of invalidCases) {
    test(`rejects ${name}`, async () => {
      const result = makeResult();
      const state = await readWindowsMachineIdentifier({
        getSystemIdForPublisher: () => result,
      });
      expectUnavailable(state);
      expect(state.reason).toBe(WINDOWS_IDENTITY_UNAVAILABLE_REASON);
      if (Buffer.isBuffer(result.id)) {
        expect(result.id.every((byte) => byte === 0)).toBe(true);
      }
    });
  }

  test("accepts an identifier exactly at the frozen cap", async () => {
    const candidate = Buffer.alloc(WINDOWS_SYSTEM_ID_MAX_BYTES, 2);
    const state = await readWindowsMachineIdentifier({
      getSystemIdForPublisher: () => ({ source: "Registry", id: candidate }),
    });
    expect(state.status).toBe("resolved");
    if (state.status === "resolved") clearMutableBytes(state.bytes);
  });

  test("converts API failure to sanitized unavailability", async () => {
    const state = await readWindowsMachineIdentifier({
      getSystemIdForPublisher: () => {
        throw new Error("WinRT call failed");
      },
    });
    expectUnavailable(state);
    expect(state.reason).toBe(WINDOWS_IDENTITY_UNAVAILABLE_REASON);
  });
});

describe("Linux machine identifier adapter", () => {
  test("strictly decodes displayed byte pairs before reduction", async () => {
    const contents = Buffer.from("0123456789abcdef0123456789abcdef\n", "ascii");
    const state = await readLinuxMachineIdentifier(async () => contents);
    expect(contents.every((byte) => byte === 0)).toBe(true);
    expect(state.status).toBe("resolved");
    if (state.status === "resolved") {
      expect(reduceDeviceIdentity(
        "linux",
        DEVICE_IDENTITY_SCHEMES.linux,
        SYNTHETIC_VAULT_ID,
        state.bytes,
      )).toBe("ae24ef3d753cc8f467b19e6496fce45b");
    }
  });

  const invalidCases: Array<[string, () => Buffer]> = [
    ["empty input", () => Buffer.alloc(0)],
    ["uninitialized marker", () => Buffer.from("uninitialized\n", "ascii")],
    ["all-zero value", () => Buffer.from(`${"0".repeat(32)}\n`, "ascii")],
    ["missing final line feed", () => Buffer.from("0123456789abcdef0123456789abcdef", "ascii")],
    ["carriage return", () => Buffer.from("0123456789abcdef0123456789abcdef\r\n", "ascii")],
    ["uppercase hex", () => Buffer.from("0123456789ABCDEF0123456789ABCDEF\n", "ascii")],
    ["non-hex byte", () => Buffer.from("g123456789abcdef0123456789abcdef\n", "ascii")],
    ["extra line", () => Buffer.from("0123456789abcdef0123456789abcdef\n\n", "ascii")],
    ["trailing byte", () => Buffer.from("0123456789abcdef0123456789abcdef\nx", "ascii")],
    ["oversized input", () => Buffer.alloc(34, 0x61)],
  ];

  for (const [name, makeContents] of invalidCases) {
    test(`rejects ${name}`, async () => {
      const contents = makeContents();
      const state = await readLinuxMachineIdentifier(async () => contents);
      expectUnavailable(state);
      expect(state.reason).toBe(LINUX_IDENTITY_UNAVAILABLE_REASON);
      expect(contents.every((byte) => byte === 0)).toBe(true);
    });
  }

  test("rejects an unreadable primitive", async () => {
    const state = await readLinuxMachineIdentifier(async () => {
      throw new Error("read failed");
    });
    expectUnavailable(state);
    expect(state.reason).toBe(LINUX_IDENTITY_UNAVAILABLE_REASON);
  });

  test("rejects a non-Buffer result and clears mutable bytes", async () => {
    const candidate = new Uint8Array(33).fill(1);
    const state = await readLinuxMachineIdentifier(async () => candidate);
    expectUnavailable(state);
    expect(candidate.every((byte) => byte === 0)).toBe(true);
  });
});

describe("device identity resolution", () => {
  test("selects only the current platform primitive and clears its bytes", async () => {
    const candidate = Buffer.alloc(16, 9);
    const darwin = vi.fn(async () => ({ status: "resolved" as const, bytes: candidate }));
    const win32 = vi.fn(async () => ({ status: "unavailable" as const, reason: "unused" }));
    const linux = vi.fn(async () => ({ status: "unavailable" as const, reason: "unused" }));

    const state = await resolveDeviceIdentity(SYNTHETIC_VAULT_ID, {
      platform: "darwin",
      darwin,
      win32,
      linux,
    });

    expect(state.status).toBe("resolved");
    if (state.status === "resolved") expect(state.value).toMatch(/^[0-9a-f]{32}$/);
    expect(darwin).toHaveBeenCalledTimes(1);
    expect(win32).not.toHaveBeenCalled();
    expect(linux).not.toHaveBeenCalled();
    expect(candidate.every((byte) => byte === 0)).toBe(true);
  });

  test("returns sanitized tri-state unavailability and never a value", async () => {
    const state = await resolveDeviceIdentity(SYNTHETIC_VAULT_ID, {
      platform: "win32",
      win32: async () => ({ status: "unavailable", reason: "boundary detail" }),
    });
    expectUnavailable(state);
    expect(state.reason).toBe(WINDOWS_IDENTITY_UNAVAILABLE_REASON);
  });

  test("rejects an invalid vault identity before reading a primitive", async () => {
    const linux = vi.fn(async () => ({
      status: "resolved" as const,
      bytes: Buffer.alloc(16, 1),
    }));
    const state = await resolveDeviceIdentity("invalid", { platform: "linux", linux });
    expectUnavailable(state);
    expect(state.reason).toBe(INVALID_VAULT_IDENTITY_REASON);
    expect(linux).not.toHaveBeenCalled();
  });

  test("rejects unsupported platforms without falling back", async () => {
    const darwin = vi.fn();
    const win32 = vi.fn();
    const linux = vi.fn();
    const state = await resolveDeviceIdentity(SYNTHETIC_VAULT_ID, {
      platform: "freebsd",
      darwin,
      win32,
      linux,
    });
    expectUnavailable(state);
    expect(state.reason).toBe(UNSUPPORTED_DEVICE_PLATFORM_REASON);
    expect(darwin).not.toHaveBeenCalled();
    expect(win32).not.toHaveBeenCalled();
    expect(linux).not.toHaveBeenCalled();
  });

  test("clears malformed resolved bytes on the unavailable path", async () => {
    const candidate = Buffer.alloc(0);
    const state = await resolveDeviceIdentity(SYNTHETIC_VAULT_ID, {
      platform: "linux",
      linux: async () => ({ status: "resolved", bytes: candidate }),
    });
    expectUnavailable(state);
    expect(state.reason).toBe(LINUX_IDENTITY_UNAVAILABLE_REASON);
    expect(candidate.every((byte) => byte === 0)).toBe(true);
  });
});
