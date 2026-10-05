import { expect, test, vi } from "vitest";
import { CapsuleJobWorker } from "./job-worker";

test("lost completion replies retry reporting without starting a job twice", async () => {
  let claimed = false, completions = 0; const runJob = vi.fn(async () => {});
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer host-secret");
    if (String(url).endsWith("heartbeat")) return Response.json({ cancel: [] });
    if (String(url).endsWith("claim")) { const job = claimed ? null : { runId: "a", appId: "notes", jobId: "inbox" }; claimed = true; return Response.json({ job }); }
    if (++completions === 1) throw new Error("completion response lost"); return Response.json({ ok: true });
  });
  const worker = new CapsuleJobWorker({ jobAvailability: async () => true, runJob }, "host-secret", fetch);
  worker.start("http://isolated-core");
  try { await vi.waitFor(() => expect(completions).toBe(2)); expect(runJob).toHaveBeenCalledOnce(); }
  finally { await worker.stop(); }
});
test("lost claim replies are not retried as executions", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {}); let claimed = false, heartbeats = 0; const runJob = vi.fn();
  const fetch: typeof globalThis.fetch = async url => {
    if (String(url).endsWith("heartbeat")) { heartbeats++; return Response.json({ cancel: [] }); }
    if (!claimed) { claimed = true; throw new Error("claim reply lost"); } return Response.json({ job: null });
  };
  const worker = new CapsuleJobWorker({ jobAvailability: async () => true, runJob }, "secret", fetch); worker.start("http://isolated-core");
  try { await vi.waitFor(() => expect(heartbeats).toBeGreaterThan(1)); expect(runJob).not.toHaveBeenCalled(); }
  finally { await worker.stop(); warning.mockRestore(); }
});
test("Core cancellation and Host teardown each stop only the corresponding owned work", async () => {
  let claim = 0, cancel = false; const signals = new Map<string, AbortSignal>();
  const runJob = vi.fn(async (id: string, _app: string, _job: string, signal: AbortSignal) => {
    signals.set(id, signal); await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const fetch: typeof globalThis.fetch = async url => {
    if (String(url).endsWith("heartbeat")) return Response.json({ cancel: cancel ? ["a"] : [] });
    if (String(url).endsWith("claim")) return Response.json({ job: claim < 2 ? { runId: ["a", "b"][claim++], appId: "notes", jobId: "inbox" } : null });
    return Response.json({ ok: true });
  };
  const worker = new CapsuleJobWorker({ jobAvailability: async () => true, runJob }, "secret", fetch); worker.start("http://isolated-core");
  try { await vi.waitFor(() => expect(signals.size).toBe(2)); cancel = true; await vi.waitFor(() => expect(signals.get("a")!.aborted).toBe(true)); expect(signals.get("b")!.aborted).toBe(false); }
  finally { await worker.stop(); } expect(signals.get("b")!.aborted).toBe(true);
});
