import { RpcTarget } from "cloudflare:workers";
import { LifecycleCapability } from "agents/lifecycle";
import type { ClockFrame, ClockSettings, ClockState, ParkRequest, ParkResult, Parked } from "./protocol.ts";

const STORAGE_KEY = "clock";

export type ClockOptions = {
  /** Let one parked hop run. Resolves false when its owner no longer waits for it (stale). */
  release: (item: Parked) => Promise<boolean>;
  /** Tell every object the new mode and speed, so they know whether to park. */
  configure: (settings: ClockSettings) => Promise<void>;
  broadcast?: (frame: string) => void;
};

/**
 * A debugger clock for the whole system, in one Durable Object.
 *
 * While playing, every hop runs after `pace` ms. While paused, hops park here
 * in arrival order instead: outbox messages, the Account's Workflow dispatch,
 * and each BuildWorkflow step. `next()` releases the oldest one, so you can
 * step through the system one frame at a time.
 */
export class Clock extends LifecycleCapability {
  readonly #options: ClockOptions;
  // Paused by default: a scenario steps unless you press play.
  #state: ClockState = { playing: false, pace: 500, parked: [] };

  constructor(options: ClockOptions) {
    super("clock");
    this.#options = options;
  }

  override onStart(): void {
    this.#state = this.lifecycle.storage.kv.get<ClockState>(STORAGE_KEY) ?? this.#state;
  }

  // SyncedState: clients get the state on connect, then `clock` frames.
  get(): ClockState {
    return this.#state;
  }

  set(): void {
    throw new Error("Use play, pause, next or setPace.");
  }

  /** Called by an object about to run a hop. Paused: the hop waits for `next()`. */
  park(request: ParkRequest): ParkResult {
    const { playing, pace } = this.#state;
    if (playing) return { parked: false, pace };
    if (!this.#state.parked.some((p) => p.owner === request.owner && p.token === request.token)) {
      this.#save({ parked: [...this.#state.parked, { ...request, at: Date.now() }] });
    }
    return { parked: true, pace };
  }

  /** Release the oldest parked hop. Skips hops whose owner stopped waiting. */
  async next(): Promise<Parked | undefined> {
    for (;;) {
      const [head, ...rest] = this.#state.parked;
      if (!head) return undefined;
      this.#save({ parked: rest });
      if (await this.#options.release(head).catch(() => false)) return head;
    }
  }

  /**
   * Run hops until the next one would reach a different object. A run of
   * Workflow steps into one Project counts as one machine, for example.
   */
  async nextMachine(): Promise<Parked | undefined> {
    const first = await this.next();
    if (!first) return undefined;
    for (let i = 0; i < 50; i++) {
      const head = await this.#awaitParked();
      if (!head || head.to !== first.to) break;
      await this.next();
    }
    return first;
  }

  /** The hop a release just caused may take a moment to park. */
  async #awaitParked(): Promise<Parked | undefined> {
    for (let waited = 0; waited < 2_000 && !this.#state.parked.length; waited += 100) await scheduler.wait(100);
    return this.#state.parked[0];
  }

  async play(): Promise<void> {
    this.#save({ playing: true });
    await this.#options.configure(this.#settings());
    const parked = this.#state.parked;
    this.#save({ parked: [] });
    for (const item of parked) await this.#options.release(item).catch(() => false);
  }

  async pause(): Promise<void> {
    this.#save({ playing: false });
    await this.#options.configure(this.#settings());
  }

  async setPace(ms: number): Promise<void> {
    this.#save({ pace: Math.max(0, Math.min(10_000, ms)) });
    await this.#options.configure(this.#settings());
  }

  /** Forget parked hops after a reset; the objects that parked them are gone. */
  clear(): void {
    this.#save({ parked: [] });
  }

  #settings(): ClockSettings {
    return { playing: this.#state.playing, pace: this.#state.pace };
  }

  #save(patch: Partial<ClockState>) {
    this.#state = { ...this.#state, ...patch };
    this.lifecycle.storage.kv.put(STORAGE_KEY, this.#state);
    this.#options.broadcast?.(JSON.stringify({ type: "clock", state: this.#state } satisfies ClockFrame));
  }
}

/** What WebSocket clients may call. */
export class ClockCallables extends RpcTarget {
  readonly #clock: Clock;

  constructor(clock: Clock) {
    super();
    this.#clock = clock;
  }

  next() {
    return this.#clock.next();
  }

  nextMachine() {
    return this.#clock.nextMachine();
  }

  play() {
    return this.#clock.play();
  }

  pause() {
    return this.#clock.pause();
  }

  setPace(ms: number) {
    return this.#clock.setPace(ms);
  }
}
