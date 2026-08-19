export interface GuardHeartbeatPeer {
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  postMessage(message: unknown): void;
}

export interface GuardHeartbeatOptions<Peer extends GuardHeartbeatPeer> {
  intervalMs: number;
  timeoutMs: number;
  isCurrent(peer: Peer): boolean;
  isExpectedStop(peer: Peer): boolean;
  isQuitting(): boolean;
  onFailure(peer: Peer, generation: number, reason: string): void;
  now?(): number;
}

/** Monitors only the Guard attached to the current Supervisor session. */
export class GuardHeartbeatMonitor<Peer extends GuardHeartbeatPeer> {
  #timer: NodeJS.Timeout | null = null;
  #peer: Peer | null = null;
  #generation = 0;
  #listener: ((message: unknown) => void) | null = null;
  #lastPongAt = 0;
  #lastTickAt = 0;
  #nonce = 0;
  #suspended = false;
  readonly #now: () => number;

  constructor(private readonly options: GuardHeartbeatOptions<Peer>) {
    this.#now = options.now ?? Date.now;
  }

  start(peer: Peer, generation: number): void {
    this.stop();
    const now = this.#now();
    this.#peer = peer;
    this.#generation = generation;
    this.#lastPongAt = now;
    this.#lastTickAt = now;
    this.#listener = (message: unknown) => {
      const candidate = message as { type?: unknown; nonce?: unknown } | null;
      if (candidate?.type === "pong" && Number.isSafeInteger(candidate.nonce)) {
        this.#lastPongAt = this.#now();
      }
    };
    peer.on("message", this.#listener);
    this.#ping();
    if (this.#peer === peer) {
      this.#timer = setInterval(() => this.#ping(), this.options.intervalMs);
    }
  }

  stop(peer?: Peer): void {
    if (peer && this.#peer !== peer) return;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#peer && this.#listener) {
      this.#peer.off("message", this.#listener);
    }
    this.#timer = null;
    this.#peer = null;
    this.#listener = null;
  }

  suspend(): void {
    this.#suspended = true;
  }

  resume(): void {
    this.#suspended = false;
    if (!this.#peer) return;
    this.#lastPongAt = this.#now();
    this.#ping();
  }

  #ping(): void {
    const peer = this.#peer;
    if (!peer) return;
    if (
      !this.options.isCurrent(peer)
      || this.options.isExpectedStop(peer)
      || this.options.isQuitting()
    ) {
      this.stop(peer);
      return;
    }

    const now = this.#now();
    const monitoringGap = now - this.#lastTickAt;
    this.#lastTickAt = now;
    // A suspended monitor has no liveness evidence. Dark wake or a blocked
    // parent event loop can also create a gap without a delivered resume event.
    if (this.#suspended || monitoringGap > this.options.timeoutMs) {
      this.#suspended = false;
      this.#lastPongAt = now;
    }
    if (now - this.#lastPongAt > this.options.timeoutMs) {
      const generation = this.#generation;
      this.stop(peer);
      this.options.onFailure(
        peer,
        generation,
        "Guard utility became unresponsive and was terminated",
      );
      return;
    }

    try {
      peer.postMessage({ type: "ping", nonce: ++this.#nonce });
    } catch (error) {
      const generation = this.#generation;
      this.stop(peer);
      this.options.onFailure(
        peer,
        generation,
        `Guard utility heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
