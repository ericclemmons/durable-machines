// What a DurableMachine syncs to clients. Client-safe: no Worker or XState runtime imports.
//
// On connect a client gets one MachineView (definitions + current snapshots).
// After that it only receives MachineCommit frames: the events that were
// processed and the snapshots of the actors they changed.

export type AnyEvent = { type: string; [key: string]: unknown };

export type JournalEntry = {
  seq: number;
  at: number;
  /** Actor inside this Durable Object: the root machine id, or a child id. */
  actor: string;
  kind: "transition" | "restored" | "unhandled" | "rejected" | "duplicate" | "delivered" | "retrying" | "dead-letter";
  event: AnyEvent;
  from: unknown;
  to: unknown;
  /** Who sent the event: a child id, another Durable Object, or `external`. */
  source: string;
  /** For outbox entries: the receiving Durable Object (`Class/name`). */
  target?: string;
  detail?: string;
};

export type ActorView = {
  id: string;
  src: string;
  value: unknown;
  status: string;
  context: Record<string, unknown>;
};

export type OutboxItem = { id: string; to: string; event: AnyEvent; due: number; attempts: number };

export type MachineView = {
  name: string;
  className: string;
  machineId: string;
  /** XState v6 JSON definitions, keyed by machine id / actor src. Sent once, on connect. */
  definitions: Record<string, unknown>;
  root: ActorView;
  children: ActorView[];
  journal: JournalEntry[];
  outbox: OutboxItem[];
  deadLetters: number;
};

export type MachineCommit = {
  type: "xstate.commit";
  /** New journal entries since the last frame: the events, in order. */
  entries: JournalEntry[];
  /** Actors whose snapshot changed. */
  actors: ActorView[];
  /** Child actors that stopped and were removed. */
  removed: string[];
  outbox: OutboxItem[];
  deadLetters: number;
};

/** Sent after a reset: the client replaces its view. */
export type MachineReset = { type: "xstate.reset"; view: MachineView };

export type SendResult = { ok: true; value: unknown; duplicate?: boolean } | { ok: false; error: string };

/** A hop waiting for the debugger clock. `token` is what the owner needs to resume it. */
export type ParkRequest = {
  owner: string;
  token: string;
  /** Where the hop goes and what it carries, for the UI. */
  to: string;
  eventType: string;
};
export type Parked = ParkRequest & { at: number };
export type ParkResult = { parked: boolean; pace: number };
export type ClockSettings = { playing: boolean; pace: number };
export type ClockState = ClockSettings & { parked: Parked[] };
export type ClockFrame = { type: "clock"; state: ClockState };

/** Metadata the outbox attaches to every cross-object message. */
export type Envelope = { messageId: string; from: string };
