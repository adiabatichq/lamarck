import { expect, test } from "vitest";
import { CapsuleDiagnostics, DIAGNOSTIC_BYTES, DIAGNOSTIC_RUNS, DIAGNOSTIC_APP_RUNS, DIAGNOSTIC_RETENTION_MS } from "./diagnostics";

test("heavy output retains a copied bounded suffix and completed run identity", () => {
  const logs = new CapsuleDiagnostics([]);
  logs.begin("notes", "job", "inbox", "run-a");
  logs.bind("run-a", "a".repeat(40), []);
  const chunk = Buffer.alloc(16 * DIAGNOSTIC_BYTES, "a");
  logs.append("run-a", chunk); chunk.fill("b");
  for (let n = 0; n < 100; n++) logs.append("run-a", Buffer.alloc(4096, "z"));
  logs.finish("run-a", new Error("exit 7"));
  const [run] = logs.read("notes", "run-a");
  expect(run).toMatchObject({ appId: "notes", kind: "job", workloadId: "inbox", executionId: "run-a", failure: "exit 7", version: "a".repeat(40) });
  expect(run.endedAt).not.toBeNull();
  expect(Buffer.byteLength(run.output)).toBe(DIAGNOSTIC_BYTES);
  expect(run.output).toBe("z".repeat(DIAGNOSTIC_BYTES));
  expect(run.droppedBytes).toBe(chunk.length + 100 * 4096 - DIAGNOSTIC_BYTES);
  expect(() => logs.read("other", "run-a")).toThrow("unavailable");
  expect(logs.read("other")).toEqual([]);
});

test("redacts private authority across chunk and retained-buffer edges", () => {
  const logs = new CapsuleDiagnostics(["host-secret-123456"]);
  logs.begin("notes", "service", "watcher", "instance-a");
  logs.bind("instance-a", "a".repeat(40), ["private-channel-12345"]);
  logs.append("instance-a", Buffer.from("stdout host-secret-"));
  expect(logs.read("notes")[0].output).not.toContain("host-secret-");
  logs.append("instance-a", Buffer.from("123456 private-channel-12345\n"));
  expect(logs.read("notes")[0].output).toBe("stdout [redacted] [redacted]\n");
  logs.finish("instance-a", new Error("host-secret-123456 private-channel-12345"));
  expect(logs.read("notes")[0].failure).toBe("[redacted] [redacted]");
  logs.begin("notes", "job", "inbox", "run-b");
  logs.append("run-b", Buffer.from("host-secret-123456" + "z".repeat(DIAGNOSTIC_BYTES - 8)));
  expect(logs.read("notes", "run-b")[0].output).not.toContain("t-123456");
});

test("bounds per-App and aggregate runs and expires completed evidence", () => {
  let now = 100;
  const logs = new CapsuleDiagnostics([], () => now);
  for (let n = 0; n < 20; n++) { logs.begin("notes", "job", "inbox", `run-${n}`); logs.finish(`run-${n}`); }
  expect(logs.read("notes")).toHaveLength(DIAGNOSTIC_APP_RUNS);
  for (let n = 0; n < DIAGNOSTIC_RUNS; n++) { logs.begin(`app-${n}`, "job", "inbox", `other-${n}`); logs.finish(`other-${n}`); }
  expect(logs.read("notes")).toEqual([]);
  now += DIAGNOSTIC_RETENTION_MS;
  expect(logs.read("app-63")).toEqual([]);
});

test("formatting cannot reconstruct a redacted credential and public authority labels remain readable", () => {
  const logs = new CapsuleDiagnostics(["host-secret-123456"]);
  logs.begin("notes", "job", "inbox", "run-a");
  logs.bind("run-a", "a".repeat(40), ["activation_" + "a".repeat(32)]);
  logs.append("run-a", Buffer.from("host-\x1b[31msecret-123456\x1b[0m"));
  logs.finish("run-a", new Error("Core returned a different App activation"));
  expect(logs.read("notes")[0]).toMatchObject({ output: "[redacted]", failure: "Core returned a different App activation" });
});
