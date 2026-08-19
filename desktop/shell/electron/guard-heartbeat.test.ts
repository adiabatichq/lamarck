import { afterEach, describe, expect, test, vi } from "vitest";
import { GuardHeartbeatMonitor, type GuardHeartbeatPeer } from "./guard-heartbeat";

class FakePeer implements GuardHeartbeatPeer {
  listener: ((message: unknown) => void) | null = null;
  messages: unknown[] = [];
  postError: Error | null = null;

  on(_event: "message", listener: (message: unknown) => void): void {
    this.listener = listener;
  }

  off(_event: "message", listener: (message: unknown) => void): void {
    if (this.listener === listener) this.listener = null;
  }

  postMessage(message: unknown): void {
    if (this.postError) throw this.postError;
    this.messages.push(message);
  }

  pong(nonce = 1): void {
    this.listener?.({ type: "pong", nonce });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Guard heartbeat monitor", () => {
  test("keeps a responsive current Guard attached", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const peer = new FakePeer();
    const onFailure = vi.fn();
    const monitor = new GuardHeartbeatMonitor({
      intervalMs: 5_000,
      timeoutMs: 30_000,
      isCurrent: (candidate) => candidate === peer,
      isExpectedStop: () => false,
      isQuitting: () => false,
      onFailure,
    });

    monitor.start(peer, 7);
    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      peer.pong();
      vi.advanceTimersByTime(5_000);
    }
    expect(onFailure).not.toHaveBeenCalled();
    expect(peer.messages.length).toBeGreaterThan(1);
    monitor.stop();
  });

  test("opens a fresh evidence window after resume", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const peer = new FakePeer();
    const onFailure = vi.fn();
    const monitor = new GuardHeartbeatMonitor({
      intervalMs: 5_000,
      timeoutMs: 30_000,
      isCurrent: () => true,
      isExpectedStop: () => false,
      isQuitting: () => false,
      onFailure,
    });

    monitor.start(peer, 3);
    monitor.suspend();
    vi.setSystemTime(3_601_000);
    monitor.resume();
    expect(onFailure).not.toHaveBeenCalled();
    expect(peer.messages).toHaveLength(2);
    monitor.stop();
  });

  test("treats a long parent monitoring gap as missing evidence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const peer = new FakePeer();
    const onFailure = vi.fn();
    const monitor = new GuardHeartbeatMonitor({
      intervalMs: 5_000,
      timeoutMs: 30_000,
      isCurrent: () => true,
      isExpectedStop: () => false,
      isQuitting: () => false,
      onFailure,
    });

    monitor.start(peer, 4);
    vi.setSystemTime(3_601_000);
    vi.advanceTimersByTime(5_000);
    expect(onFailure).not.toHaveBeenCalled();
    expect(peer.messages).toHaveLength(2);
    monitor.stop();
  });

  test("reports a genuinely unresponsive Guard once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const peer = new FakePeer();
    const onFailure = vi.fn();
    const monitor = new GuardHeartbeatMonitor({
      intervalMs: 5_000,
      timeoutMs: 30_000,
      isCurrent: () => true,
      isExpectedStop: () => false,
      isQuitting: () => false,
      onFailure,
    });

    monitor.start(peer, 9);
    vi.advanceTimersByTime(35_000);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(
      peer,
      9,
      "Guard utility became unresponsive and was terminated",
    );
    vi.advanceTimersByTime(60_000);
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
