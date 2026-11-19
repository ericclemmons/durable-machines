// Demo-only fault injection, so the dashboard can show how the outbox reacts to
// the Durable Object errors described in the error-handling guide.

export type ChaosMode = "overloaded" | "retryable";

export class Chaos {
  #mode: ChaosMode | undefined;
  #until = 0;

  set(mode: ChaosMode | null, seconds: number) {
    this.#mode = mode ?? undefined;
    this.#until = Date.now() + seconds * 1000;
  }

  get active(): { mode: ChaosMode; until: number } | null {
    return this.#mode && Date.now() < this.#until ? { mode: this.#mode, until: this.#until } : null;
  }

  /** Throw the way the runtime does: an Error with `.overloaded` or `.retryable` set. */
  check() {
    const active = this.active;
    if (!active) return;
    const error = new Error(
      active.mode === "overloaded" ? "Durable Object is overloaded. Too many requests queued." : "Network connection lost.",
    ) as Error & { overloaded?: boolean; retryable?: boolean };
    if (active.mode === "overloaded") error.overloaded = true;
    else error.retryable = true;
    throw error;
  }
}
