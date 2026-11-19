import { RpcTarget, type DurableObject } from "cloudflare:workers";
import {
  Lifecycle,
  LifecycleCapability,
  type DurableObjectCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { Effect, Exit } from "effect";
import {
  createActor,
  machineToJSON,
  type Actor,
  type AnyStateMachine,
  type EventFromLogic,
  type InputFrom,
} from "xstate";
import { restoreActor } from "xstate/persist";
import { callDurableObject } from "./do-call.ts";
import { formatCoverage, graphCoverage } from "./graph-coverage.ts";
import type {
  ActorView,
  AnyEvent,
  Envelope,
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
const CLOCK_KEY = "xstate:clock";
// A parked outbox job waits this far out until the clock releases it.
const PARKED_FOR = 365 * 24 * 3600_000;
const INBOX_SIZE = 500;
const OVERLOAD_LIMIT = 8;

type Saved = { snapshot: unknown; journal: JournalEntry[]; seq: number; inbox: string[]; deadLetters: number };
type Delivery = { binding: string; name: string; event: AnyEvent; envelope: Envelope };
type Receiver = { send(event: AnyEvent, envelope?: Envelope): Promise<SendResult> };

/** What `machine.provide()` takes: `actions`, `actors`, `guards` and `delays`. */
type Implementations<TLogic extends AnyStateMachine> = NonNullable<Parameters<TLogic["provide"]>[0]>;

export type DurableMachineOptions<TLogic extends AnyStateMachine> = Implementations<TLogic> & {
  /**
   * Input for a fresh actor. It gets the object's name, so `getByName("order-42")`
   * starts an order machine for order 42. Called once, the first time the object
   * starts; after that the actor is restored from storage.
   */
  input?: (name: string) => InputFrom<TLogic>;
  /** Machines of spawned children, so clients can draw them. */
  children?: Record<string, AnyStateMachine>;
  /** Event types WebSocket clients may send. Defaults to none: clients only watch. */
  clientEvents?: ReadonlyArray<EventFromLogic<TLogic>["type"]>;
  /** How many journal entries to keep. Defaults to 120. */
  journalSize?: number;
  /** Delay, in ms, before each outbox message is sent, so people can watch it travel. Defaults to 0. */
  pace?: number;
  /** The debugger clock. While it is paused, hops park there until released. */
  park?: (request: ParkRequest) => Promise<ParkResult>;
};

/**
 * A Lifecycle capability that turns a Durable Object into one durable XState actor.
 *
 * - Restores the actor from storage on wake and persists after every transition.
 * - Wakes the object with a Lifecycle job when an `after` or `timeout` timer is due.
 * - `deliver()` is a transactional outbox: the message is queued as a Lifecycle job
 *   in the same SQLite transaction as the snapshot that produced it. Receivers
 *   deduplicate by message id, so retries are effectively once.
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
  #actor: Actor<TLogic> | undefined;
  #journal: JournalEntry[] = [];
  #seq = 0;
  #inbox: string[] = [];
  #deadLetters = 0;
  #names = new Map<string, string>();
  #lastSnapshot = new Map<string, unknown>();
  #pending: Promise<unknown>[] = [];
  #rejection: string | undefined;
  #source: string | undefined;
  #persistQueued = false;
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
    const { actions, actors, guards, delays } = options as { actions?: unknown; actors?: unknown; guards?: unknown; delays?: unknown };
    this.#options = options;
    this.#logic = (actions || actors || guards || delays ? logic.provide({ actions, actors, guards, delays } as never) : logic) as TLogic;
    this.#env = (host as unknown as { env: Record<string, unknown> }).env;
    this.#clock = { playing: true, pace: options.pace ?? 0 };
    this.webSockets = new WebSockets({ state: this, callables: new MachineCallables(this as never) });
    this.#host = Lifecycle.install(host).use(this).use(this.webSockets);
    this.#definitions = Object.fromEntries(
      [[logic.id, logic] as const, ...Object.entries((options.children ?? {}) as Record<string, AnyStateMachine>)].map(
        ([key, machine]) => [key, machineToJSON(machine)],
      ),
    );
    // A machine with a hidden edge would draw a diagram that lies. Refuse to run it.
    const problems = Object.entries(this.#definitions).map(([id, json]) => formatCoverage(id, graphCoverage(json))).filter(Boolean);
    if (problems.length) throw new Error(`Machine graph is incomplete:\n${problems.join("\n")}`);
  }

  override onStart(): void {
    this.#boot();
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

  /** The running actor. Prefer `send()`, which also persists and reports rejections. */
  get actor(): Actor<TLogic> {
    if (!this.#actor) throw new Error("DurableMachine has not started");
    return this.#actor;
  }

  /** The root actor's current snapshot. */
  get snapshot(): ReturnType<Actor<TLogic>["getSnapshot"]> {
    return this.actor.getSnapshot();
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
   * without being processed again.
   */
  async send(event: EventFromLogic<TLogic>, envelope?: Envelope): Promise<SendResult> {
    await this.start();
    await this.lifecycle.ready();
    if (envelope && this.#inbox.includes(envelope.messageId)) {
      this.#record({ kind: "duplicate", actor: this.actor.id, event, from: null, to: null, source: envelope.from });
      this.#commit();
      return { ok: true, value: this.#value(), duplicate: true };
    }
    this.#rejection = undefined;
    // Snapshot, journal, inbox and every outbox job the transition queued land in
    // one SQLite transaction, so a message is never lost or sent without its state.
    this.lifecycle.storage.transactionSync(() => {
      this.#source = envelope?.from;
      try {
        this.actor.send(event as never);
      } finally {
        this.#source = undefined;
      }
      if (envelope) this.#inbox = [...this.#inbox, envelope.messageId].slice(-INBOX_SIZE);
      this.#persist();
    });
    const rejection = this.#rejection;
    this.#commit();
    await this.#drain();
    if (rejection) return { ok: false, error: rejection };
    return { ok: true, value: this.#value() };
  }

  /** Send from a WebSocket client. Only `clientEvents` are allowed. */
  async sendFromClient(event: AnyEvent): Promise<SendResult> {
    if (!this.#options.clientEvents?.includes(event.type)) {
      return { ok: false, error: `Clients may not send "${event.type}"` };
    }
    return this.send(event as EventFromLogic<TLogic>);
  }

  /**
   * Queue an event for the actor in another Durable Object (`env[binding]`,
   * addressed by name). Call it from action implementations, so it is written
   * in the same transaction as the transition.
   */
  deliver(binding: string, name: string, event: AnyEvent): void {
    const messageId = crypto.randomUUID();
    const id = `msg:${messageId}`;
    const delivery: Delivery = { binding, name, event: toJSON(event), envelope: { messageId, from: this.#self } };
    const { playing, pace } = this.#clock;
    const push = this.lifecycle.jobs.push({
      id,
      fn: "deliver",
      time: Date.now() + (playing ? pace : PARKED_FOR),
      payload: delivery,
      retry: { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 10_000 },
    });
    // The row is inserted synchronously; a rejection here means it was not.
    this.#pending.push(push.catch((error: unknown) => this.#deadLetter(delivery, `Outbox write failed: ${String(error)}`)));
    if (!playing) this.#pending.push(this.#park({ token: id, to: `${binding}/${name}`, eventType: event.type }));
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
    for (const token of this.#holds.keys()) this.release(token);
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

  /** Discard the actor and its history, then start a fresh one. */
  async reset(): Promise<void> {
    await this.start();
    await this.lifecycle.ready();
    this.#actor?.stop();
    for (const job of this.lifecycle.jobs.list()) await this.lifecycle.jobs.cancel(job.id);
    this.lifecycle.storage.kv.delete(STORAGE_KEY);
    this.#wakeAt = undefined;
    this.#boot();
    await this.#drain();
    this.#broadcast(JSON.stringify({ type: "xstate.reset", view: this.#view() } satisfies MachineReset));
    this.#markSent();
  }

  /** Everything a client draws: definitions, snapshots, journal and outbox. */
  async view(): Promise<MachineView> {
    await this.start();
    return this.#view();
  }

  // SyncedState: the full view goes to each client once, on connect.
  get(): MachineView | undefined {
    if (!this.#actor) return undefined;
    return this.#view();
  }

  set(): void {
    throw new Error("Machine state is read-only. Send an event instead.");
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn === "wake") {
      // Restoring the actor on startup already re-armed due timers.
      this.#wakeAt = undefined;
      this.#persist();
      this.#commit();
      return;
    }
    if (job.fn !== "deliver") return;

    const delivery = job.payload as Delivery;
    const { binding, name, event, envelope } = delivery;
    const target = `${binding}/${name}`;
    const namespace = this.#env[binding] as DurableObjectNamespace | undefined;
    if (!namespace) return this.#deadLetter(delivery, `Unknown binding ${binding}`, job.id);

    const exit = await Effect.runPromiseExit(
      callDurableObject(
        () => namespace.getByName(name) as unknown as Receiver,
        (stub) => stub.send(event, envelope),
      ),
    );

    if (Exit.isSuccess(exit)) {
      this.#overloads.delete(job.id);
      const result = exit.value;
      if (!result.ok) return this.#deadLetter(delivery, `Rejected by ${target}: ${result.error}`, job.id);
      this.#record({
        kind: "delivered",
        actor: this.actor.id,
        event,
        from: null,
        to: null,
        source: this.#self,
        target,
        detail: result.duplicate ? "Duplicate; the receiver already had it" : undefined,
      });
      this.#persist();
      this.#commit(job.id);
      return;
    }

    const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error;
    if (error?.kind === "overloaded") {
      // Retrying an overloaded object makes it worse: back off, off the retry budget.
      const count = (this.#overloads.get(job.id) ?? 0) + 1;
      this.#overloads.set(job.id, count);
      if (count > OVERLOAD_LIMIT) return this.#deadLetter(delivery, `${target} stayed overloaded`, job.id);
      const delay = Math.min(60_000, 1_000 * 2 ** count) * (0.5 + Math.random() / 2);
      this.#record({ kind: "retrying", actor: this.actor.id, event, from: null, to: null, source: this.#self, target, detail: `Overloaded; retry in ${Math.round(delay)} ms` });
      this.#persist();
      this.#commit();
      return { rescheduleAt: Date.now() + delay };
    }
    this.#record({ kind: "retrying", actor: this.actor.id, event, from: null, to: null, source: this.#self, target, detail: error?.message ?? "Delivery failed" });
    this.#persist();
    this.#commit();
    // Lifecycle retries with backoff, then calls onJobError.
    throw new Error(error?.message ?? "Delivery failed");
  }

  onJobError({ job }: LifecycleJobContext, error: unknown): LifecycleJobOutcome {
    if (job.fn !== "deliver") return;
    this.#deadLetter(job.payload as Delivery, `Gave up: ${error instanceof Error ? error.message : String(error)}`, job.id);
  }

  /** Journal the failure, then hand it to the machine so the domain can compensate. */
  #deadLetter({ binding, name, event }: Delivery, reason: string, jobId?: string): undefined {
    const target = `${binding}/${name}`;
    this.#deadLetters++;
    this.#record({ kind: "dead-letter", actor: this.actor.id, event, from: null, to: null, source: this.#self, target, detail: reason });
    this.lifecycle.storage.transactionSync(() => {
      this.#source = "outbox";
      try {
        this.actor.send({ type: "outbox.failed", target, eventType: event.type, event, reason } as never);
      } finally {
        this.#source = undefined;
      }
      this.#persist();
    });
    this.#commit(jobId);
    return undefined;
  }

  #boot() {
    const saved = this.lifecycle.storage.kv.get<Saved>(STORAGE_KEY);
    const options = {
      inspect: (event: unknown) => this.#onInspect(event as InspectionLike),
      onRejectedEvent: (rejection: RejectionLike) => this.#onRejected(rejection),
    };
    this.#names.clear();
    this.#lastSnapshot.clear();
    this.#journal = saved?.journal ?? [];
    this.#seq = saved?.seq ?? 0;
    this.#inbox = saved?.inbox ?? [];
    this.#deadLetters = saved?.deadLetters ?? 0;
    this.#clock = this.lifecycle.storage.kv.get<ClockSettings>(CLOCK_KEY) ?? this.#clock;
    const logic = this.#logic;
    this.#actor = (
      saved
        ? restoreActor(logic, saved.snapshot as never, options as never)
        : createActor(logic, { ...options, input: this.#options.input?.(this.lifecycle.name) } as never)
    ) as Actor<TLogic>;
    this.#restoring = Boolean(saved);
    this.#actor.start();
    this.#restoring = false;
    this.#persist();
    this.#markSent();
  }

  #onInspect(event: InspectionLike) {
    const ref = event.actorRef;
    if (event.type === "@xstate.actor") {
      this.#names.set(ref.sessionId, ref === (this.#actor as unknown) ? ref.id : (event.id ?? ref.id));
      return;
    }
    if (event.type !== "@xstate.transition" || !event.event || !event.snapshot) return;
    // Only machines are journaled; invoked promises show up through their parent's done/error events.
    if (!("value" in (event.snapshot as object))) return;
    const actor = this.#names.get(ref.sessionId) ?? ref.id;
    const previous = this.#lastSnapshot.get(ref.sessionId) as { value?: unknown; status?: unknown } | undefined;
    this.#lastSnapshot.set(ref.sessionId, event.snapshot);
    const valueOf = (s: { value?: unknown; status?: unknown } | undefined) => (s ? (s.value ?? s.status) : null);
    const type = event.event.type;
    const unhandled = previous === event.snapshot;
    if (type === "xstate.snapshot.actor" || (unhandled && type.startsWith("xstate."))) return;
    this.#record({
      kind: this.#restoring && type === "xstate.init" ? "restored" : unhandled ? "unhandled" : "transition",
      actor,
      event: event.event,
      from: valueOf(previous),
      to: valueOf(event.snapshot),
      source: event.sourceRef
        ? (this.#names.get(event.sourceRef.sessionId) ?? event.sourceRef.id)
        : (this.#source ?? "external"),
    });
    this.#queuePersist();
  }

  #onRejected(rejection: RejectionLike) {
    const issues = rejection.issues
      ?.map((issue) => {
        const path = issue.path?.map((p) => String(typeof p === "object" ? p.key : p)).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    this.#rejection = `${rejection.reason}${issues ? `: ${issues}` : ""}`;
    this.#record({
      kind: "rejected",
      actor: rejection.targetRef?.id ?? this.actor.id,
      event: rejection.event,
      from: null,
      to: null,
      source: this.#source ?? "external",
      detail: this.#rejection,
    });
    this.#queuePersist();
  }

  #record(entry: Omit<JournalEntry, "seq" | "at">) {
    this.#journal.push({ ...entry, event: toJSON(entry.event), seq: ++this.#seq, at: Date.now() });
    const max = this.#options.journalSize ?? 120;
    if (this.#journal.length > max) this.#journal.splice(0, this.#journal.length - max);
  }

  // Timer-driven transitions (no send() call) persist and broadcast on the next microtask.
  #queuePersist() {
    if (this.#persistQueued) return;
    this.#persistQueued = true;
    queueMicrotask(() => {
      this.#persistQueued = false;
      this.#persist();
      this.#commit();
    });
  }

  #persist() {
    if (!this.#actor) return;
    const snapshot = this.#actor.getPersistedSnapshot();
    this.lifecycle.storage.kv.put(STORAGE_KEY, {
      snapshot,
      journal: this.#journal,
      seq: this.#seq,
      inbox: this.#inbox,
      deadLetters: this.#deadLetters,
    } satisfies Saved);
    this.#armWake(snapshot);
  }

  /** Push what changed since the last frame: new journal entries and changed actors. */
  /** `settled`: a job that just finished; Lifecycle deletes its row only after onJob returns. */
  #commit(settled?: string) {
    if (!this.#actor) return;
    const entries = this.#journal.filter((e) => e.seq > this.#sentSeq);
    const actors = this.#actors();
    const changed = actors.filter((a) => this.#prints.get(a.id) !== JSON.stringify(a));
    const live = new Set(actors.map((a) => a.id));
    const removed = [...this.#prints.keys()].filter((id) => !live.has(id));
    if (!entries.length && !changed.length && !removed.length) return;
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
    this.#sentSeq = this.#seq;
    this.#prints = new Map(actors.map((a) => [a.id, JSON.stringify(a)]));
  }

  #armWake(snapshot: unknown) {
    const due = nextTimerDeadline(snapshot);
    if (due === this.#wakeAt) return;
    this.#wakeAt = due;
    this.#pending.push(
      due === undefined
        ? this.lifecycle.jobs.cancel("xstate-wake")
        : this.lifecycle.jobs.push({ id: "xstate-wake", fn: "wake", time: due }),
    );
  }

  async #drain() {
    while (this.#pending.length) await Promise.all(this.#pending.splice(0));
  }

  #value() {
    return (this.actor.getSnapshot() as { value?: unknown }).value;
  }

  #actors(): ActorView[] {
    const persisted = toJSON(this.actor.getPersistedSnapshot()) as unknown as PersistedLike;
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

/** The client-callable surface: WebSocket clients may send allowed events. */
export class MachineCallables extends RpcTarget {
  readonly #machine: DurableMachine<AnyStateMachine>;

  constructor(machine: DurableMachine<AnyStateMachine>) {
    super();
    this.#machine = machine;
  }

  send(event: AnyEvent): Promise<SendResult> {
    return this.#machine.sendFromClient(event);
  }
}

type RefLike = { id: string; sessionId: string };

type InspectionLike = {
  type: string;
  actorRef: RefLike;
  id?: string;
  event?: AnyEvent;
  snapshot?: unknown;
  sourceRef?: RefLike;
};

type RejectionLike = {
  event: AnyEvent;
  reason: string;
  targetRef?: RefLike;
  issues?: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }>;
};

type PersistedLike = {
  value: unknown;
  status: string;
  context?: Record<string, unknown>;
  timers?: Array<{ delay: number; scheduledAt?: number }>;
  children?: Record<string, { src?: string; snapshot?: PersistedLike }>;
};

function nextTimerDeadline(snapshot: unknown): number | undefined {
  let due: number | undefined;
  const visit = (s: PersistedLike | undefined) => {
    for (const timer of s?.timers ?? []) {
      const at = (timer.scheduledAt ?? Date.now()) + timer.delay;
      due = due === undefined ? at : Math.min(due, at);
    }
    for (const child of Object.values(s?.children ?? {})) visit(child.snapshot);
  };
  visit(snapshot as PersistedLike);
  return due;
}

function toJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}
