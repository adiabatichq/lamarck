export type CoreRuntimePhase = "starting" | "ready" | "failed";

export interface CoreRuntimeState {
  generation: number;
  phase: CoreRuntimePhase;
  error: string | null;
}

/**
 * Publishes one monotonic Host runtime generation. Async work may settle after
 * a retry or workspace switch, but it cannot overwrite the newer generation.
 */
export class CoreRuntimeStateController {
  #state: CoreRuntimeState = Object.freeze({
    generation: 0,
    phase: "starting",
    error: null,
  });

  constructor(
    private readonly onChange: (state: CoreRuntimeState) => void = () => {},
  ) {}

  snapshot(): CoreRuntimeState {
    return this.#state;
  }

  begin(): number {
    this.#publish({
      generation: this.#state.generation + 1,
      phase: "starting",
      error: null,
    });
    return this.#state.generation;
  }

  ready(generation: number): boolean {
    if (
      generation !== this.#state.generation
      || this.#state.phase !== "starting"
    ) return false;
    this.#publish({ generation, phase: "ready", error: null });
    return true;
  }

  fail(generation: number, error: string): boolean {
    if (generation !== this.#state.generation) return false;
    this.#publish({ generation, phase: "failed", error });
    return true;
  }

  #publish(state: CoreRuntimeState): void {
    this.#state = Object.freeze({ ...state });
    this.onChange(this.#state);
  }
}
