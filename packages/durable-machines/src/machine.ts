import { RpcTarget, type DurableObject } from "cloudflare:workers";
import {
  Lifecycle,
  LifecycleCapability,
  type DurableObjectCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { Effect, Exit, Predicate } from "effect";
import {
  deliverEvent,
  machineToJSON,
  stopActor,
  type Actor,
  type AnyActor,
  type AnyStateMachine,
  type DeadLetterDetail,
  type EventFromLogic,
  type InputFrom,
  type SnapshotFrom,
  type StateMachine,
  type TimerKey,
} from "xstate";
import { createDurable, type DurableCheckpoint, type DurableExecution, type DurableExecutionAdapter, type DurableSnapshot } from "xstate/durable";
import { callDurableObject, restartIfNameless } from "./do-call.ts";
import { formatCoverage, graphCoverage } from "./graph-coverage.ts";
import type {
  ActorView,
  AnyEvent,
  Envelope,
  HistoryRequest,
  JournalEntry,
  MachineCommit,
  MachineReset,
  ClockSettings,
  MachineView,
  OutboxItem,
  ParkRequest,
  ParkResult,
  SendResult,
} from "./protocol.ts";

const STORAGE_KEY = "xstate:actor";
const INPUT_KEY = "xstate:input";
const CLOCK_KEY = "xstate:clock";
const WAKE_JOB = "xstate-wake";
const PRUNE_JOB = "xstate-prune-journal";
// A parked outbox job waits this far out until the clock releases it.
const PARKED_FOR = 365 * 24 * 3600_000;
const DAY = 24 * 3600_000;
const INBOX_SIZE = 500;
const OVERLOAD_LIMIT = 8;

/** A logical timer the adapter accepted, with the absolute deadline it accepted. */
type Timer = { address: string; timer: TimerKey; at: number };
type Saved = {
  checkpoint: DurableCheckpoint;
  timers: Record<string, Timer>;
  /** Only in objects saved before the journal had its own table. */
  journal?: JournalEntry[];
  seq: number;
  inbox: string[];
  deadLetters: number;
};
// Written by the createActor core: a bare persisted snapshot, timers inside it.
type Legacy = Omit<Saved, "checkpoint" | "timers"> & { snapshot: unknown };
type Delivery = { binding: string; name: string; event: AnyEvent; envelope: Envelope };
type Outgoing = { id: string; delivery: Delivery; time: number; parked: boolean };
type Receiver = { send(event: AnyEvent, envelope?: Envelope): Promise<SendResult> };

const isReceivers = (value: unknown): value is { getByName(name: string): Receiver } =>
  Predicate.hasProperty(value, "getByName") && typeof value.getByName === "function";

/** The actors a machine declares in `setup({ actors })`, by key. */
type ActorsOf<TLogic> =
  TLogic extends StateMachine<any, any, any, any, any, any, any, any, any, any, any, infer TActors, any, any, any, any> ? TActors : never;

/** What `machine.provide()` takes: `actions`, `actors`, `guards` and `delays`. */
// `Parameters<>` collapses provide()'s generic actor map to `{}`, so actors are mapped from the machine instead.
type Implementations<TLogic extends AnyStateMachine> = Omit<NonNullable<Parameters<TLogic["provide"]>[0]>, "actors"> & {
  /** Implementations of the actors declared in `setup({ actors })`, with the same input and output types. */
  actors?: { [K in keyof ActorsOf<TLogic>]?: ActorsOf<TLogic>[K] };
};

type CreatedBy<TLogic extends AnyStateMachine> = { event: string; input: (event: AnyEvent, name: string) => InputFrom<TLogic> };

type Creation<TLogic extends AnyStateMachine> =
  | {
      /**
       * Input for a fresh actor. It gets the object's name, so `getByName("order-42")`
       * starts an order machine for order 42. Called once, the first time the object
       * starts; after that the actor is restored from storage.
       */
      input?: (name: string) => InputFrom<TLogic>;
      createdBy?: never;
    }
  | {
      input?: never;
      /**
       * For objects another object creates, such as one per order: there is no actor
       * until `event` arrives. Its input comes from that event and is saved. Other
       * events are rejected until then, and `reset()` makes the object wait again.
       * The event itself isn't sent to the machine: it starts it.
       */
      createdBy: CreatedBy<TLogic>;
    };

export type DurableMachineOptions<TLogic extends AnyStateMachine> = Implementations<TLogic> &
  Creation<TLogic> & {
    /** Machines of spawned children, so clients can draw them. */
    children?: Record<string, AnyStateMachine>;
    /** Event types WebSocket clients may send. Defaults to none: clients only watch. */
    clientEvents?: ReadonlyArray<EventFromLogic<TLogic>["type"]>;
    /** How many recent journal entries clients get. Defaults to 120. Every entry stays in the `xstate_journal` table; read it with `history()`. */
    journalSize?: number;
    /** Delete journal entries older than this many days, once a day. Defaults to keeping every entry. */
    journalRetentionDays?: number;
    /** Delay, in ms, before each outbox message is sent, so people can watch it travel. Defaults to 0. */
    pace?: number;
    /** The debugger clock. While it is paused, hops park there until released. */
    park?: (request: ParkRequest) => Promise<ParkResult>;
  };

/**
 * A Lifecycle capability that turns a Durable Object into one durable XState actor.
 * It is the Durable Object host adapter for XState's `createDurable`.
 *
 * - Drives the pure loop: `restore()` on wake, then `transition()` + `executeEffects()`
 *   per event. Adapter operations only record intents; one SQLite transaction then
 *   writes the checkpoint, journal entries, inbox ids, outbox jobs and the timer wake job.
 * - Appends every journal entry to the `xstate_journal` table; `history()` pages through it.
 * - `after` and `timeout` timers are `scheduleTimer` calls, kept as absolute
 *   deadlines and woken by one Lifecycle job at the earliest.
 * - `deliver()` is a transactional outbox: the message is queued as a Lifecycle job
 *   in the same SQLite transaction as the snapshot that produced it, and journaled as
 *   `sent` right after the transition that queued it. Receivers deduplicate by
 *   message id, so retries are effectively once.
 * - Delivery follows the Durable Object error guidance: fresh stub per attempt,
 *   backoff on `.retryable`, no hammering on `.overloaded`. A message that cannot
 *   be delivered goes back into the machine as `outbox.failed`.
 * - Implements `SyncedState`: a client gets the full view once on connect, then
 *   only `xstate.commit` frames with the processed events and changed snapshots.
 */
export class DurableMachine<TLogic extends AnyStateMachine> extends LifecycleCapability {
  readonly #options: DurableMachineOptions<TLogic>;
  readonly #logic: TLogic;
  readonly #env: Record<string, unknown>;
  readonly #host: Lifecycle;
  /** Serves `/agents/*` WebSocket connections: clients get the view on connect, then commits. */
  readonly webSockets: WebSockets;
  readonly #definitions: Record<string, unknown>;
  #durable: DurableExecution<TLogic> | undefined;
  #state: DurableSnapshot<TLogic> | undefined;
  #generation = 0;
  #timers = new Map<string, Timer>();
  #mailbox: Array<{ event: AnyEvent; source: string | undefined }> = [];
  #outgoing: Outgoing[] = [];
  #turn: Promise<unknown> = Promise.resolve();
  #inTurn = false;
  #kicked = false;
  /** Saved entries, the most recent `journalSize`. */
  #journal: JournalEntry[] = [];
  /** Entries since the last save. */
  #fresh: JournalEntry[] = [];
  /** The last entry of the root transition whose actions are running: `sent` entries go after it. */
  #anchor: JournalEntry | undefined;
  #acting = false;
  /** The input from `createdBy`'s event, saved with the first checkpoint. */
  #creating: { input: unknown } | undefined;
  #seq = 0;
  #inbox: string[] = [];
  #deadLetters = 0;
  #names = new Map<string, string>();
  #lastSnapshot = new Map<string, unknown>();
  #unhandled = new WeakMap<object, JournalEntry>();
  #pending: Promise<unknown>[] = [];
  #rejection: string | undefined;
  #source: string | undefined;
  #wakeAt: number | undefined;
  #restoring = false;
  #sentSeq = 0;
  #prints = new Map<string, string>();
  #overloads = new Map<string, number>();
  #clock: ClockSettings = { playing: true, pace: 0 };
  #holds = new Map<string, () => void>();

  /**
   * Run `logic` in the Durable Object `host`. Call it from a field initializer:
   *
   * ```ts
   * readonly machine = new DurableMachine(this, orderMachine, { input: (id) => ({ orderId: id }) });
   * ```
   *
   * `actions`, `actors`, `guards` and `delays` are passed to `logic.provide()`.
   * The machine installs the object's Lifecycle and WebSocket handling itself.
   */
  constructor(host: DurableObject<object>, logic: TLogic, options: DurableMachineOptions<TLogic> = {} as DurableMachineOptions<TLogic>) {
    super("xstate");
    if (options.input && options.createdBy) throw new Error("Pass either input or createdBy, not both");
    const { actions, actors, guards, delays } = options as { actions?: unknown; actors?: unknown; guards?: unknown; delays?: unknown };
    this.#options = options;
    this.#logic = (actions || actors || guards || delays ? logic.provide({ actions, actors, guards, delays } as never) : logic) as TLogic;
    const { env, ctx } = host as unknown as { env: Record<string, unknown>; ctx: DurableObjectState };
    this.#env = env;
    this.#clock = { playing: true, pace: options.pace ?? 0 };
    this.webSockets = new WebSockets({ state: this, callables: new MachineCallables(this) });
    this.#host = Lifecycle.install(restartIfNameless(host, ctx)).use(this).use(this.webSockets);
    this.#definitions = Object.fromEntries(
      [[logic.id, logic] as const, ...Object.entries(options.children ?? {})].map(([key, machine]) => [key, machineToJSON(machine)]),
    );
    // A machine with a hidden edge would draw a diagram that lies. Refuse to run it.
    const problems = Object.entries(this.#definitions).map(([id, json]) => formatCoverage(id, graphCoverage(json))).filter(Boolean);
    if (problems.length) throw new Error(`Machine graph is incomplete:\n${problems.join("\n")}`);
  }

  override async onStart(): Promise<void> {
    await this.#exclusive(async () => {
      await this.#boot();
      this.#save();
      this.#markSent();
    });
    await this.#drain();
  }

  /** Add another Lifecycle capability to the object. Call it before the object starts. */
  use(capability: DurableObjectCapability): this {
    this.#host.use(capability);
    return this;
  }

  /** Start the object. Every method here calls it; RPC calls bypass `fetch`, so this is how the object wakes. */
  start(): Promise<void> {
    return this.#host.start();
  }

  /** The current snapshot. Read-only: change it with `send()`. */
  get snapshot(): SnapshotFrom<TLogic> {
    if (!this.#state) throw new Error(this.#durable ? `${this.#self} hasn't been created yet` : "DurableMachine has not started");
    return this.#state as SnapshotFrom<TLogic>;
  }

  /** @deprecated Read `snapshot`. There is no live root actor; the host drives pure transitions. */
  get actor(): Pick<Actor<TLogic>, "id" | "getSnapshot"> {
    return { id: this.#logic.id, getSnapshot: () => this.snapshot };
  }

  #broadcast(frame: string) {
    for (const connection of this.webSockets.getConnections()) connection.send(frame);
  }

  get #self() {
    return `${this.lifecycle.className}/${this.lifecycle.name}`;
  }

  /**
   * Send an event, wait for it to commit, and report whether the machine accepted it.
   * Messages from other objects carry an envelope; a repeated message id is acknowledged
   * without being processed again. With `createdBy`, its event creates the actor instead.
   */
  send(event: EventFromLogic<TLogic>, envelope?: Envelope): Promise<SendResult> {
    return this.#send(event, envelope);
  }

  /** Create the actor from its `createdBy` event. Repeats are acknowledged without effect. */
  async create(event: AnyEvent, envelope?: Envelope): Promise<SendResult> {
    const createdBy = this.#options.createdBy;
    if (createdBy?.event !== event.type) return { ok: false, error: `${this.lifecycle.className} isn't created by "${event.type}"` };
    return this.#send(event, envelope);
  }

  async #send(event: AnyEvent, envelope?: Envelope): Promise<SendResult> {
    await this.start();
    await this.lifecycle.ready();
    const createdBy = this.#options.createdBy;
    if (createdBy && event.type === createdBy.event) return this.#create(createdBy, event, envelope);
    const result = await this.#exclusive(async (): Promise<SendResult> => {
      if (!this.#state) return { ok: false, error: `${this.#self} hasn't been created yet` };
      if (envelope && this.#inbox.includes(envelope.messageId)) {
        this.#record({ kind: "duplicate", actor: this.#logic.id, event, from: null, to: null, source: envelope.from });
        this.#save();
        this.#commit();
        return { ok: true, value: this.#value(), duplicate: true };
      }
      this.#rejection = undefined;
      await this.#transact(async () => {
        await this.#step(event, envelope?.from);
        if (envelope) this.#inbox = [...this.#inbox, envelope.messageId].slice(-INBOX_SIZE);
      });
      if (this.#rejection) return { ok: false, error: this.#rejection };
      return { ok: true, value: this.#value() };
    });
    await this.#drain();
    return result;
  }

  async #create(createdBy: CreatedBy<TLogic>, event: AnyEvent, envelope?: Envelope): Promise<SendResult> {
    const result = await this.#exclusive(async (): Promise<SendResult> => {
      if (this.#state) return { ok: true, value: this.#value(), duplicate: true };
      this.#creating = { input: toJSON(createdBy.input(event, this.lifecycle.name)) };
      this.#source = envelope?.from;
      try {
        await this.#boot();
        if (envelope) this.#inbox = [envelope.messageId];
        this.#save();
      } catch (error) {
        this.#creating = undefined;
        await this.#boot();
        throw error;
      } finally {
        this.#creating = undefined;
        this.#source = undefined;
      }
      // Clients that connected before the object existed get their first view now.
      this.#broadcast(JSON.stringify({ type: "xstate.reset", view: this.#view() } satisfies MachineReset));
      this.#markSent();
      return { ok: true, value: this.#value() };
    });
    await this.#drain();
    return result;
  }

  /** Send from a WebSocket client. Only `clientEvents` are allowed. */
  async sendFromClient(event: AnyEvent): Promise<SendResult> {
    if (!this.#options.clientEvents?.includes(event.type)) {
      return { ok: false, error: `Clients may not send "${event.type}"` };
    }
    return this.#send(event);
  }

  /**
   * Queue an event for the actor in another Durable Object (`env[binding]`,
   * addressed by name). Call it from action implementations: it only records the
   * message, which is written in the same transaction as the transition.
   */
  deliver(binding: string, name: string, event: AnyEvent): void {
    const messageId = crypto.randomUUID();
    const { playing, pace } = this.#clock;
    const delivery = { binding, name, event: toJSON(event), envelope: { messageId, from: this.#self } };
    this.#outgoing.push({ id: `msg:${messageId}`, delivery, time: Date.now() + (playing ? pace : PARKED_FOR), parked: !playing });
    this.#recordSent(delivery.event, `${binding}/${name}`);
    if (!this.#inTurn) this.#kick();
  }

  /**
   * Wait before a hop that isn't an outbox message (a Workflow dispatch, a
   * billing call): `pace` ms while the clock plays, or until released while it
   * is paused. Not durable: after eviction the invoked actor restarts and holds again.
   */
  async hold(to: string, eventType: string): Promise<void> {
    if (this.#clock.playing) return scheduler.wait(this.#clock.pace);
    const token = `hold:${crypto.randomUUID()}`;
    const released = new Promise<void>((resolve) => this.#holds.set(token, resolve));
    await this.#park({ token, to, eventType });
    return released;
  }

  /** Delay, in ms, the clock adds to every hop while playing. */
  get pace(): number {
    return this.#clock.pace;
  }

  /** Called by the clock. Resuming play releases everything this object parked. */
  async setClock(settings: ClockSettings): Promise<void> {
    await this.start();
    this.#clock = settings;
    this.lifecycle.storage.kv.put(CLOCK_KEY, settings);
    if (!settings.playing) return;
    for (const resume of this.#holds.values()) resume();
    this.#holds.clear();
    for (const job of this.#parkedJobs()) await this.lifecycle.jobs.reschedule(job.id, Date.now() + settings.pace);
    this.#commit();
  }

  /** Let one parked hop run now. False when nothing here waits for it. */
  async release(token: string): Promise<boolean> {
    await this.start();
    const resume = this.#holds.get(token);
    if (resume) {
      this.#holds.delete(token);
      resume();
      return true;
    }
    const released = await this.lifecycle.jobs.reschedule(token, Date.now());
    if (released) this.#commit();
    return released;
  }

  async #park(request: Omit<ParkRequest, "owner">) {
    const result = await this.#options.park?.({ ...request, owner: this.#self }).catch(() => undefined);
    // No clock, or it resumed play meanwhile: run now.
    if (!result?.parked) await this.release(request.token);
  }

  #parkedJobs() {
    return this.lifecycle.jobs.list().filter((job) => job.fn === "deliver" && job.time > Date.now() + PARKED_FOR / 2);
  }

  /** Discard the actor and its whole journal, then start a fresh one. With `createdBy`, wait to be created again. */
  async reset(): Promise<void> {
    await this.start();
    await this.lifecycle.ready();
    await this.#exclusive(async () => {
      for (const job of this.lifecycle.jobs.list()) await this.lifecycle.jobs.cancel(job.id);
      this.lifecycle.storage.kv.delete(STORAGE_KEY);
      this.lifecycle.storage.kv.delete(INPUT_KEY);
      this.lifecycle.storage.sql.exec("DELETE FROM xstate_journal");
      this.#wakeAt = undefined;
      await this.#boot();
      this.#save();
    });
    await this.#drain();
    if (!this.#state) return;
    this.#broadcast(JSON.stringify({ type: "xstate.reset", view: this.#view() } satisfies MachineReset));
    this.#markSent();
  }

  /** Everything a client draws: definitions, snapshots, journal and outbox. */
  async view(): Promise<MachineView> {
    await this.start();
    if (!this.#state) throw new Error(`${this.#self} hasn't been created yet`);
    return this.#view();
  }

  /** Journal entries before `before` (a `seq`), oldest first, up to `limit` (default 200, at most 1000). */
  async history({ before, limit = 200 }: HistoryRequest = {}): Promise<JournalEntry[]> {
    await this.start();
    return this.lifecycle.storage.sql
      .exec<{ entry: string }>(
        "SELECT entry FROM xstate_journal WHERE seq < ? ORDER BY seq DESC LIMIT ?",
        before ?? Number.MAX_SAFE_INTEGER,
        Math.min(Math.max(1, limit), 1000),
      )
      .toArray()
      .map((row) => JSON.parse(row.entry) as JournalEntry)
      .reverse();
  }

  // SyncedState: the full view goes to each client once, on connect.
  get(): MachineView | undefined {
    if (!this.#state) return undefined;
    return this.#view();
  }

  set(): void {
    throw new Error("Machine state is read-only. Send an event instead.");
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn === "prune-journal") {
      const days = this.#options.journalRetentionDays;
      if (days === undefined) return;
      this.lifecycle.storage.sql.exec("DELETE FROM xstate_journal WHERE at < ?", Date.now() - days * DAY);
      return { rescheduleAt: Date.now() + DAY };
    }
    if (job.fn === "wake") {
      this.#wakeAt = undefined;
      await this.#exclusive(() => this.#transact(() => this.#fireTimers()));
      await this.#drain();
      return;
    }
    if (job.fn !== "deliver") return;

    const delivery = job.payload as Delivery;
    const { binding, name, event, envelope } = delivery;
    const target = `${binding}/${name}`;
    const namespace = this.#env[binding];
    if (!isReceivers(namespace)) return this.#deadLetter(delivery, `Unknown binding ${binding}`, job.id);

    const exit = await Effect.runPromiseExit(
      callDurableObject(
        () => namespace.getByName(name),
        (stub) => stub.send(event, envelope),
      ),
    );

    const actor = this.#logic.id;
    if (Exit.isSuccess(exit)) {
      this.#overloads.delete(job.id);
      const result = exit.value;
      if (!result.ok) return this.#deadLetter(delivery, `Rejected by ${target}: ${result.error}`, job.id);
      // Journaled as `sent` with the transition that queued it; the receiver journals its arrival.
      await this.#exclusive(async () => this.#commit(job.id));
      return;
    }

    const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error;
    if (error?.kind === "overloaded") {
      // Retrying an overloaded object makes it worse: back off, off the retry budget.
      const count = (this.#overloads.get(job.id) ?? 0) + 1;
      this.#overloads.set(job.id, count);
      if (count > OVERLOAD_LIMIT) return this.#deadLetter(delivery, `${target} stayed overloaded`, job.id);
      const delay = Math.min(60_000, 1_000 * 2 ** count) * (0.5 + Math.random() / 2);
      await this.#exclusive(async () => {
        this.#record({ kind: "retrying", actor, event, from: null, to: null, source: this.#self, target, detail: `Overloaded; retry in ${Math.round(delay)} ms` });
        this.#save();
        this.#commit();
      });
      return { rescheduleAt: Date.now() + delay };
    }
    await this.#exclusive(async () => {
      this.#record({ kind: "retrying", actor, event, from: null, to: null, source: this.#self, target, detail: error?.message ?? "Delivery failed" });
      this.#save();
      this.#commit();
    });
    // Lifecycle retries with backoff, then calls onJobError.
    throw new Error(error?.message ?? "Delivery failed");
  }

  async onJobError({ job }: LifecycleJobContext, error: unknown): Promise<LifecycleJobOutcome> {
    if (job.fn !== "deliver") return;
    return this.#deadLetter(job.payload as Delivery, `Gave up: ${error instanceof Error ? error.message : String(error)}`, job.id);
  }

  /** Journal the failure, then hand it to the machine so the domain can compensate. */
  async #deadLetter({ binding, name, event }: Delivery, reason: string, jobId?: string): Promise<undefined> {
    const target = `${binding}/${name}`;
    await this.#exclusive(async () => {
      this.#deadLetters++;
      this.#record({ kind: "dead-letter", actor: this.#logic.id, event, from: null, to: null, source: this.#self, target, detail: reason });
      await this.#transact(() => this.#step({ type: "outbox.failed", target, eventType: event.type, event, reason }, "outbox"), jobId);
    });
    await this.#drain();
    return undefined;
  }

  // One turn at a time: `executeEffects` calls must not overlap.
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#turn.then(async () => {
      this.#inTurn = true;
      try {
        const result = await fn();
        // Work that arrived while this turn waited on its last batch.
        if (this.#mailbox.length || this.#outgoing.length) this.#kick();
        return result;
      } finally {
        this.#inTurn = false;
      }
    });
    this.#turn = run.catch(() => {});
    return run;
  }

  /** Commit work that arrived outside a turn: a live child moved, or a child reported up. */
  #kick() {
    if (this.#kicked) return;
    this.#kicked = true;
    this.#exclusive(async () => {
      this.#kicked = false;
      if (this.#state) await this.#transact(async () => {});
    })
      .then(() => this.#drain())
      .catch((error: unknown) => console.error("DurableMachine: turn failed", error));
  }

  /**
   * Run a turn: process the events, then everything the children reported up,
   * and commit the result in one transaction. A failed turn commits nothing and
   * reboots from the last checkpoint.
   */
  async #transact(body: () => Promise<void>, settled?: string) {
    try {
      await body();
      await this.#settle();
      this.#save();
    } catch (error) {
      await this.#boot();
      throw error;
    }
    this.#commit(settled);
  }

  async #step(event: AnyEvent, source?: string) {
    const durable = this.#durable!;
    this.#source = source;
    this.#anchor = undefined;
    try {
      const [state, effects] = durable.transition(this.#state as SnapshotFrom<TLogic>, event as EventFromLogic<TLogic>);
      this.#state = state;
      await durable.executeEffects(effects);
    } finally {
      this.#source = undefined;
      this.#anchor = undefined;
    }
  }

  async #settle() {
    for (let next = this.#mailbox.shift(); next; next = this.#mailbox.shift()) await this.#step(next.event, next.source);
  }

  async #fireTimers() {
    const durable = this.#durable!;
    const due = [...this.#timers].filter(([, t]) => t.at <= Date.now()).sort(([, a], [, b]) => a.at - b.at);
    for (const [key, { address, timer }] of due) {
      // An earlier firing may have canceled it.
      if (!this.#timers.delete(key)) continue;
      const event = { type: "xstate.timer", ...timer } as AnyEvent;
      const owner = this.#names.get(address) ?? address;
      if (address === durable.rootAddress) {
        await this.#step(event, owner);
        continue;
      }
      const ref = durable.getActorRef(this.#state as SnapshotFrom<TLogic>, address);
      // The child is gone: its timer is stale.
      if (!ref) continue;
      this.#source = owner;
      try {
        deliverEvent(ref, ref, event);
      } finally {
        this.#source = undefined;
      }
      await this.#settle();
    }
  }

  async #boot() {
    const generation = ++this.#generation;
    this.#retire();
    const live = () => generation === this.#generation;
    const { kv, sql } = this.lifecycle.storage;
    sql.exec("CREATE TABLE IF NOT EXISTS xstate_journal (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, entry TEXT NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS xstate_journal_at ON xstate_journal (at)");
    const saved = kv.get<Saved | Legacy>(STORAGE_KEY);
    // Objects saved before the table carried the journal inline: move it over once.
    for (const e of saved?.journal ?? []) sql.exec("INSERT OR IGNORE INTO xstate_journal (seq, at, entry) VALUES (?, ?, ?)", e.seq, e.at, JSON.stringify(e));
    if (this.#options.journalRetentionDays !== undefined && !this.lifecycle.jobs.get(PRUNE_JOB)) {
      this.#pending.push(this.lifecycle.jobs.push({ id: PRUNE_JOB, fn: "prune-journal", time: Date.now() + DAY }));
    }
    this.#names.clear();
    this.#lastSnapshot.clear();
    this.#mailbox = [];
    this.#outgoing = [];
    this.#timers = new Map(Object.entries(saved && "timers" in saved ? saved.timers : {}));
    this.#wakeAt = this.lifecycle.jobs.get(WAKE_JOB)?.time;
    this.#journal = sql
      .exec<{ entry: string }>("SELECT entry FROM xstate_journal ORDER BY seq DESC LIMIT ?", this.#options.journalSize ?? 120)
      .toArray()
      .map((row) => JSON.parse(row.entry) as JournalEntry)
      .reverse();
    this.#fresh = [];
    this.#seq = Math.max(saved?.seq ?? 0, this.#journal.at(-1)?.seq ?? 0);
    this.#inbox = saved?.inbox ?? [];
    this.#deadLetters = saved?.deadLetters ?? 0;
    this.#clock = kv.get<ClockSettings>(CLOCK_KEY) ?? this.#clock;
    const logic = this.#logic;
    const durable = createDurable(logic, this.#adapter(live), {
      captureRootEvents: false,
      inspect: (event) => live() && this.#onInspect(event as unknown as InspectionLike),
    });
    this.#durable = durable;
    const { createdBy } = this.#options;
    const input = saved ? undefined : createdBy ? (this.#creating ?? kv.get<{ input: unknown }>(INPUT_KEY))?.input : this.#options.input?.(this.lifecycle.name);
    this.#state = undefined;
    // Created by an event that hasn't arrived yet.
    if (!saved && createdBy && input === undefined) return;
    this.#restoring = Boolean(saved);
    try {
      const [state, effects] = saved
        ? durable.restore("checkpoint" in saved ? saved.checkpoint : (saved.snapshot as never))
        : (durable.initialTransition as (input: unknown) => ReturnType<typeof durable.restore>).call(durable, input);
      this.#state = state;
      this.#lastSnapshot.set(durable.rootAddress, state);
      if (saved) {
        const { value, status } = state as { value?: unknown; status: string };
        this.#record({ kind: "restored", actor: logic.id, event: { type: "xstate.init" }, from: null, to: value ?? status, source: "external" });
      }
      await durable.executeEffects(effects);
    } finally {
      this.#restoring = false;
      this.#anchor = undefined;
    }
    await this.#settle();
  }

  /** Stop the previous execution's live children so nothing they do lands in this one. */
  #retire() {
    const children = (this.#state as { children?: Record<string, AnyActor | undefined> } | undefined)?.children;
    for (const child of Object.values(children ?? {})) {
      try {
        if (child) stopActor(child);
      } catch {}
    }
  }

  /** The Durable Object side of `createDurable`. Every operation records an intent and returns: accepted. */
  #adapter(live: () => boolean): DurableExecutionAdapter<TLogic> {
    const keyOf = (source: AnyActor, timer: TimerKey) => `${source.address}:${JSON.stringify(timer)}`;
    return {
      // Root actions only: `deliver()` inside one journals `sent` after the root's transition.
      executeAction: (action, _metadata, runtime) => {
        this.#acting = true;
        try {
          return action.exec(runtime);
        } finally {
          this.#acting = false;
        }
      },
      // The host drives the loop and never parks in it.
      waitForEvent: () => new Promise(() => {}),
      enqueueRootEvent: (source, event) => {
        if (!live()) return;
        this.#mailbox.push({ event, source: source && (this.#names.get(source.address) ?? source.id) });
        if (!this.#inTurn) this.#kick();
      },
      scheduleTimer: (source, timer, delay) => {
        if (!live()) return;
        const key = keyOf(source, timer);
        // A restored timer keeps the deadline already accepted.
        if (!this.#timers.has(key)) this.#timers.set(key, { address: source.address, timer, at: Date.now() + delay });
      },
      cancelTimer: (source, timer) => {
        if (live()) this.#timers.delete(keyOf(source, timer));
      },
      cancelAllTimers: (source) => {
        if (!live()) return;
        for (const [key, { address }] of this.#timers) if (address === source.address) this.#timers.delete(key);
      },
      deadLetter: (source, target, event, reason, detail) => {
        if (live()) this.#onRejected(source, target, event as AnyEvent, reason, detail);
      },
    };
  }

  #nameOf(ref: RefLike) {
    return this.#names.get(ref.address) ?? (ref.address === this.#durable?.rootAddress ? this.#logic.id : ref.id);
  }

  #onInspect(event: InspectionLike) {
    const ref = event.actorRef;
    if (event.type === "@xstate.actor") {
      this.#names.set(ref.address, ref.address === this.#durable?.rootAddress ? this.#logic.id : ref.id);
      return;
    }
    if (event.type !== "@xstate.transition" || !event.event || !event.snapshot) return;
    // Only machines are journaled; invoked promises show up through their parent's done/error events.
    if (!("value" in (event.snapshot as object))) return;
    const actor = this.#nameOf(ref);
    const previous = this.#lastSnapshot.get(ref.address) as { value?: unknown; status?: unknown } | undefined;
    this.#lastSnapshot.set(ref.address, event.snapshot);
    const valueOf = (s: { value?: unknown; status?: unknown } | undefined) => (s ? (s.value ?? s.status) : null);
    // A timer firing journals the event it delivers (`xstate.after`, `xstate.timeout.state`).
    const fired = event.event.type === "xstate.timer" ? (event.event as { event?: AnyEvent }).event : undefined;
    const journaled = fired ?? event.event;
    const type = journaled.type;
    const unhandled = previous === event.snapshot;
    if (type === "xstate.snapshot.actor" || (unhandled && type.startsWith("xstate."))) return;
    const entry = this.#record({
      kind: this.#restoring && type === "xstate.init" ? "restored" : unhandled ? "unhandled" : "transition",
      actor,
      event: journaled,
      from: valueOf(previous),
      to: valueOf(event.snapshot),
      source: event.sourceRef ? this.#nameOf(event.sourceRef) : (this.#source ?? "external"),
    });
    if (ref.address === this.#durable?.rootAddress) this.#anchor = entry;
    if (unhandled) this.#unhandled.set(event.event, entry);
    // A live child moved outside a turn: commit it.
    if (!this.#inTurn) this.#kick();
  }

  #onRejected(source: AnyActor | undefined, target: AnyActor | undefined, event: AnyEvent, reason: string, detail?: DeadLetterDetail) {
    const issues = detail?.issues
      ?.map((issue) => {
        const path = issue.path?.map((p) => String(typeof p === "object" ? p.key : p)).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    this.#rejection = `${reason}${issues ? `: ${issues}` : ""}`;
    // A rejected event leaves the snapshot unchanged, which inspection reports as unhandled.
    const unhandled = this.#unhandled.get(event);
    const index = unhandled ? this.#fresh.indexOf(unhandled) : -1;
    if (index >= 0) this.#fresh.splice(index, 1);
    this.#record({
      kind: "rejected",
      actor: target ? this.#nameOf(target) : (detail?.targetId ?? this.#logic.id),
      event,
      from: null,
      to: null,
      source: source ? this.#nameOf(source) : (this.#source ?? "external"),
      detail: this.#rejection,
    });
  }

  #record(entry: Omit<JournalEntry, "seq" | "at">) {
    const recorded = { ...entry, event: toJSON(entry.event), seq: ++this.#seq, at: Date.now() };
    this.#fresh.push(recorded);
    return recorded;
  }

  /** A message the running root action queued: right after the transition, before what its other effects caused. */
  #recordSent(event: AnyEvent, target: string) {
    const entry = this.#record({ kind: "sent", actor: this.#logic.id, event, from: null, to: null, source: this.#self, target });
    const anchor = this.#acting ? this.#anchor : undefined;
    const at = anchor ? this.#fresh.indexOf(anchor) : -1;
    if (!anchor || at < 0) return;
    this.#fresh.pop();
    this.#fresh.splice(at + 1, 0, entry);
    this.#anchor = entry;
    // Unsaved entries can still be renumbered, so `seq` keeps journal order.
    let seq = anchor.seq;
    for (const e of this.#fresh.slice(at + 1)) e.seq = ++seq;
  }

  /** Checkpoint, journal entries, inbox, outbox jobs and the wake job, in one SQLite transaction. */
  #save() {
    if (!this.#durable || !this.#state) return;
    const checkpoint = this.#durable.checkpoint(this.#state as SnapshotFrom<TLogic>);
    const { kv, sql } = this.lifecycle.storage;
    this.lifecycle.storage.transactionSync(() => {
      kv.put(STORAGE_KEY, {
        checkpoint,
        timers: Object.fromEntries(this.#timers),
        seq: this.#seq,
        inbox: this.#inbox,
        deadLetters: this.#deadLetters,
      } satisfies Saved);
      if (this.#creating) kv.put(INPUT_KEY, this.#creating);
      for (const e of this.#fresh) sql.exec("INSERT OR REPLACE INTO xstate_journal (seq, at, entry) VALUES (?, ?, ?)", e.seq, e.at, JSON.stringify(e));
      for (const { id, delivery, time, parked } of this.#outgoing.splice(0)) {
        const push = this.lifecycle.jobs.push({
          id,
          fn: "deliver",
          time,
          payload: delivery,
          retry: { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 10_000 },
        });
        // The row is inserted synchronously; a rejection here means it was not.
        this.#pending.push(push.catch((error: unknown) => this.#deadLetter(delivery, `Outbox write failed: ${String(error)}`)));
        if (parked) {
          this.#pending.push(this.#park({ token: id, to: `${delivery.binding}/${delivery.name}`, eventType: delivery.event.type }));
        }
      }
      this.#armWake();
    });
    this.#journal.push(...this.#fresh.splice(0));
    const max = this.#options.journalSize ?? 120;
    if (this.#journal.length > max) this.#journal.splice(0, this.#journal.length - max);
  }

  /**
   * Push what changed since the last frame: new journal entries and changed actors.
   * `settled`: a job that just finished; Lifecycle deletes its row only after onJob returns,
   * so the frame goes out even with nothing else new, for clients to drop it from the outbox.
   */
  #commit(settled?: string) {
    if (!this.#state) return;
    const entries = this.#journal.filter((e) => e.seq > this.#sentSeq);
    const actors = this.#actors();
    const changed = actors.filter((a) => this.#prints.get(a.id) !== JSON.stringify(a));
    const live = new Set(actors.map((a) => a.id));
    const removed = [...this.#prints.keys()].filter((id) => !live.has(id));
    if (!entries.length && !changed.length && !removed.length && settled === undefined) return;
    this.#markSent(actors);
    this.#broadcast(
      JSON.stringify({
        type: "xstate.commit",
        entries,
        actors: changed,
        removed,
        outbox: this.#outbox().filter((o) => o.id !== settled),
        deadLetters: this.#deadLetters,
      } satisfies MachineCommit),
    );
  }

  #markSent(actors = this.#actors()) {
    // Entries not saved yet go out with the next commit.
    const [unsaved] = this.#fresh;
    this.#sentSeq = unsaved ? unsaved.seq - 1 : this.#seq;
    this.#prints = new Map(actors.map((a) => [a.id, JSON.stringify(a)]));
  }

  #armWake() {
    let due: number | undefined;
    for (const { at } of this.#timers.values()) due = due === undefined ? at : Math.min(due, at);
    if (due === this.#wakeAt) return;
    this.#wakeAt = due;
    this.#pending.push(
      due === undefined
        ? this.lifecycle.jobs.cancel(WAKE_JOB)
        : this.lifecycle.jobs.push({ id: WAKE_JOB, fn: "wake", time: due }),
    );
  }

  async #drain() {
    while (this.#pending.length) await Promise.all(this.#pending.splice(0));
  }

  #value() {
    return (this.#state as { value?: unknown }).value;
  }

  #actors(): ActorView[] {
    if (!this.#state) return [];
    const persisted = toJSON(this.#durable!.checkpoint(this.#state as SnapshotFrom<TLogic>).snapshot) as unknown as PersistedLike;
    const root: ActorView = {
      id: this.#logic.id,
      src: this.#logic.id,
      value: persisted.value,
      status: persisted.status,
      context: persisted.context ?? {},
    };
    const children = Object.entries(persisted.children ?? {}).map(([id, child]) => ({
      id,
      src: child.src ?? id,
      value: child.snapshot?.value ?? null,
      status: child.snapshot?.status ?? "active",
      context: child.snapshot?.context ?? {},
    }));
    return [root, ...children];
  }

  #outbox(): OutboxItem[] {
    return this.lifecycle.jobs
      .list()
      .filter((job) => job.fn === "deliver")
      .map((job) => {
        const { binding, name, event } = job.payload as Delivery;
        return { id: job.id, to: `${binding}/${name}`, event, due: job.time, attempts: this.#overloads.get(job.id) ?? 0 };
      });
  }

  #view(): MachineView {
    const [root, ...children] = this.#actors();
    return {
      name: this.lifecycle.name,
      className: this.lifecycle.className,
      machineId: this.#logic.id,
      definitions: this.#definitions,
      root: root!,
      children,
      journal: this.#journal,
      outbox: this.#outbox(),
      deadLetters: this.#deadLetters,
    };
  }
}

/** What MachineCallables needs: neither method depends on the machine's types. */
type ClientSurface = Pick<DurableMachine<AnyStateMachine>, "sendFromClient" | "history">;

/** The client-callable surface: WebSocket clients may send allowed events and page back through the journal. */
export class MachineCallables extends RpcTarget {
  readonly #machine: ClientSurface;

  constructor(machine: ClientSurface) {
    super();
    this.#machine = machine;
  }

  send(event: AnyEvent): Promise<SendResult> {
    return this.#machine.sendFromClient(event);
  }

  /** Entries older than the ones the client has, for scrolling back through the whole history. */
  history(request?: HistoryRequest): Promise<JournalEntry[]> {
    return this.#machine.history(request);
  }
}

type RefLike = { id: string; address: string };

type InspectionLike = {
  type: string;
  actorRef: RefLike;
  event?: AnyEvent;
  snapshot?: unknown;
  sourceRef?: RefLike;
};

type PersistedLike = {
  value: unknown;
  status: string;
  context?: Record<string, unknown>;
  children?: Record<string, { src?: string; snapshot?: PersistedLike }>;
};

function toJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}
