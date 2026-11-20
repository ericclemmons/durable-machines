import { useAgent } from "agents/react";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AnyEvent, ClockFrame, ClockState, JournalEntry, MachineCommit, MachineReset, MachineView, SendResult } from "durable-machines/protocol";
import { formatValue } from "./graph";

// Every connected Durable Object's live view, keyed by "Class/name", so the
// events panel and system map can read all of them.
//
// A view arrives once, on connect. After that the object only sends
// `xstate.commit` frames (events + changed snapshots), which are applied here.
const views = new Map<string, MachineView>();
const senders = new Map<string, (event: AnyEvent) => Promise<SendResult>>();
const callers = new Map<string, (method: string, args: unknown[]) => Promise<unknown>>();
const connected = new Set<string>();
const listeners = new Set<() => void>();
const frames = { count: 0, bytes: 0 };
let version = 0;

const emit = () => {
  version++;
  for (const l of listeners) l();
};

const JOURNAL_LIMIT = 150;

// The order journal entries reached this page, across every object. Many entries share a
// millisecond, so comparing objects by this is closer to what happened than `at`.
const arrival = new Map<string, number>();
let arrivals = 0;
/** When this page received an object's journal entry, as a running count; undefined if it came with the first view. */
export const arrivalOf = (key: string, seq: number) => arrival.get(`${key}#${seq}`);
const forgetArrivals = (key: string) => {
  for (const k of arrival.keys()) if (k.startsWith(`${key}#`)) arrival.delete(k);
};

// What each object looked like right after a journal entry, captured as commits
// arrive. Entries from before the page loaded have no snapshot.
export type Snapshot = Pick<MachineView, "root" | "children">;
const snapshots = new Map<string, Snapshot>();
const SNAPSHOT_LIMIT = 3000;
function remember(key: string, seq: number, view: MachineView) {
  snapshots.set(`${key}#${seq}`, { root: view.root, children: view.children });
  const [oldest] = snapshots.keys();
  if (snapshots.size > SNAPSHOT_LIMIT && oldest !== undefined) snapshots.delete(oldest);
}
export const snapshotAfter = (key: string, seq: number) => snapshots.get(`${key}#${seq}`);

/** The object just before the commit that wrote entry `seq`, if the page saw it. */
export function snapshotBefore(key: string, seq: number) {
  const after = snapshotAfter(key, seq);
  if (!after) return undefined;
  for (let s = seq - 1; s >= Math.max(0, seq - 200); s--) {
    const snap = snapshotAfter(key, s);
    if (snap && snap !== after) return snap;
  }
  return undefined;
}

/** Servers from before the rename journal a message leaving the outbox as `delivered`; it is a `sent` entry. */
const normalize = (entries: ReadonlyArray<JournalEntry>): JournalEntry[] =>
  entries.map((e) => ((e.kind as string) === "delivered" ? { ...e, kind: "sent" } : e));

const normalizeView = (view: MachineView): MachineView => ({ ...view, journal: normalize(view.journal) });

/** A commit's entries the view doesn't have yet. A commit can race the full view on (re)connect. */
function fresh(view: MachineView, frame: MachineCommit) {
  const seen = new Set(view.journal.map((e) => e.seq));
  return normalize(frame.entries.filter((e) => !seen.has(e.seq)));
}

function apply(view: MachineView, frame: MachineCommit, entries: JournalEntry[]): MachineView {
  const byId = new Map([view.root, ...view.children].map((a) => [a.id, a]));
  for (const actor of frame.actors) byId.set(actor.id, actor);
  for (const id of frame.removed) byId.delete(id);
  const root = byId.get(view.machineId) ?? view.root;
  byId.delete(view.machineId);
  return {
    ...view,
    root,
    children: [...byId.values()],
    journal: [...view.journal, ...entries].slice(-JOURNAL_LIMIT),
    outbox: frame.outbox,
    deadLetters: frame.deadLetters,
  };
}

// The journal lives in DevTools: one console line per entry. Internal `xstate.*`
// events use console.debug, so they only show at the "Verbose" level.
const KIND_STYLE: Record<JournalEntry["kind"], string> = {
  transition: "color:#fdba74",
  restored: "color:#fcd34d",
  unhandled: "color:#71717a",
  rejected: "color:#f87171",
  sent: "color:#7dd3fc",
  duplicate: "color:#c4b5fd",
  retrying: "color:#fbbf24",
  "dead-letter": "color:#ef4444;font-weight:bold",
};

function logEntries(key: string, rootId: string, entries: ReadonlyArray<JournalEntry>) {
  for (const e of entries) {
    const internal = (e.event.type.startsWith("xstate.") && e.kind !== "restored") || e.kind === "unhandled";
    const method =
      e.kind === "dead-letter" || e.kind === "rejected" ? console.error : e.kind === "retrying" ? console.warn : internal ? console.debug : console.log;
    const actor = e.actor === rootId ? "" : ` › ${e.actor}`;
    const move = e.kind === "transition" || e.kind === "restored" ? `${formatValue(e.from) || "∅"} → ${formatValue(e.to)}` : e.target ? `→ ${e.target}` : "";
    const from = e.source !== "external" && e.kind === "transition" ? ` (from ${e.source})` : "";
    method(
      `%c${key}${actor}%c ${e.kind} %c${e.event.type}%c ${move}${from}${e.detail ? ` · ${e.detail}` : ""}`,
      "color:#a1a1aa",
      KIND_STYLE[e.kind] ?? "",
      "font-weight:bold",
      "color:inherit",
      e.event,
    );
  }
}

export const viewStore = {
  set(key: string, raw: MachineView) {
    const view = normalizeView(raw);
    views.set(key, view);
    forgetArrivals(key);
    const last = view.journal.at(-1);
    if (last) remember(key, last.seq, view);
    emit();
  },
  commit(key: string, frame: MachineCommit) {
    const view = views.get(key);
    if (!view) return;
    const entries = fresh(view, frame);
    logEntries(key, view.machineId, entries);
    const next = apply(view, frame, entries);
    views.set(key, next);
    for (const entry of entries) {
      remember(key, entry.seq, next);
      arrival.set(`${key}#${entry.seq}`, ++arrivals);
    }
    emit();
  },
  delete(key: string) {
    views.delete(key);
    emit();
  },
  get: (key: string) => views.get(key),
  all: () => [...views.entries()],
  frames: () => ({ ...frames }),
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** A JSON frame with a string `type`. The objects send only frame types the app knows. */
export function parseFrame<T extends { type: string }>(data: string): T | undefined {
  const frame: unknown = JSON.parse(data);
  return typeof frame === "object" && frame !== null && "type" in frame && typeof frame.type === "string" ? (frame as T) : undefined;
}

export function useAllViews() {
  useSyncExternalStore(viewStore.subscribe, () => version);
  return viewStore.all();
}

/** Changes whenever any view does: a cheap dependency for derived state. */
export const useViewsVersion = () => useSyncExternalStore(viewStore.subscribe, () => version);

/**
 * Connect to one Durable Object over its WebSocket. Nothing polls.
 * Mount once per object; read it anywhere with `useView`. `onFrame` gets the frames
 * that aren't the machine's own (`xstate.commit`, `xstate.reset`).
 */
export function useMachine(agent: string, name: string, onFrame?: (frame: { type: string }) => void) {
  const key = `${agent}/${name}`;
  const connection = useAgent<MachineView>({
    agent,
    name,
    onStateUpdate: (view) => {
      // An object nothing has created yet has no state; its first view arrives as a reset frame.
      if (!view) return;
      console.info(`%c${key}%c connected · ${formatValue(view.root.value)}`, "color:#a1a1aa", "color:#34d399", view);
      viewStore.set(key, view);
    },
    onMessage: (message: MessageEvent) => {
      if (typeof message.data !== "string") return;
      const frame = parseFrame<MachineCommit | MachineReset | { type: string }>(message.data);
      if (!frame) return;
      frames.count++;
      frames.bytes += message.data.length;
      if (frame.type === "xstate.commit") viewStore.commit(key, frame as MachineCommit);
      else if (frame.type === "xstate.reset") viewStore.set(key, (frame as MachineReset).view);
      else onFrame?.(frame);
    },
  });
  const send = useCallback((event: AnyEvent) => connection.call("send", [event]) as Promise<SendResult>, [connection]);
  useEffect(() => {
    senders.set(key, send);
    callers.set(key, (method, args) => connection.call(method, args));
    if (connection.identified) connected.add(key);
    else connected.delete(key);
    emit();
  }, [key, send, connection, connection.identified]);
  useEffect(
    () => () => {
      senders.delete(key);
      callers.delete(key);
      connected.delete(key);
      viewStore.delete(key);
    },
    [key],
  );
  return connection;
}

/** Read a connected object's live view, and send it client-allowed events. */
export function useView(agent: string, name: string) {
  const key = `${agent}/${name}`;
  useSyncExternalStore(viewStore.subscribe, () => version);
  const send = useCallback((event: AnyEvent): Promise<SendResult> => sendTo(key, event), [key]);
  return { key, view: views.get(key), send, connected: connected.has(key) };
}

/** Send a client-allowed event to a connected object by key ("Project/free-web"). */
export const sendTo = (key: string, event: AnyEvent): Promise<SendResult> =>
  senders.get(key)?.(event) ?? Promise.resolve({ ok: false, error: "Not connected" });

/** Call one of a connected object's client callables by key ("Project/free-web"). */
export const callOn = (key: string, method: string, args: unknown[]): Promise<unknown> =>
  callers.get(key)?.(method, args) ?? Promise.reject(new Error(`${key} is not connected`));

type ClockMethod = "next" | "nextMachine" | "play" | "pause" | "setPace";

// The debugger clock: one connection, shared by the controls and the System map. Without a
// Clock connection (see `useClockConnection`), the clock always plays and nothing parks.
let clockState: ClockState = { playing: true, pace: 0, parked: [] };
let clockCall: ((method: ClockMethod, args?: unknown[]) => Promise<unknown>) | undefined;
const clockListeners = new Set<() => void>();
const setClock = (state: ClockState) => {
  clockState = state;
  for (const l of clockListeners) l();
};

/** Mount once, if the app has a debugger clock. */
export function useClockConnection(agent = "Clock", name = "global") {
  const connection = useAgent<ClockState>({
    agent,
    name,
    onStateUpdate: setClock,
    onMessage: (message: MessageEvent) => {
      if (typeof message.data !== "string") return;
      const frame = parseFrame<ClockFrame>(message.data);
      if (frame?.type === "clock") setClock(frame.state);
    },
  });
  useEffect(() => {
    clockCall = (method, args = []) => connection.call(method, args);
    return () => {
      clockCall = undefined;
    };
  }, [connection]);
}

export function useClock() {
  const state = useSyncExternalStore(
    (l) => {
      clockListeners.add(l);
      return () => clockListeners.delete(l);
    },
    () => clockState,
  );
  const call = useCallback((method: ClockMethod, args?: unknown[]) => clockCall?.(method, args), []);
  return { ...state, call };
}

/**
 * Resolve once `done` holds for the live views and clock. It's checked on every
 * commit and clock frame the page already receives; nothing polls.
 */
export function waitUntil(done: (views: ReadonlyMap<string, MachineView>, clock: ClockState) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!done(views, clockState)) return;
      listeners.delete(check);
      clockListeners.delete(check);
      resolve();
    };
    listeners.add(check);
    clockListeners.add(check);
    check();
  });
}

/** A small external store: one value, many readers. */
export function cell<T>(initial: T) {
  let value = initial;
  const ls = new Set<() => void>();
  const set = (next: T) => {
    if (Object.is(next, value)) return;
    value = next;
    for (const l of ls) l();
  };
  const use = () =>
    useSyncExternalStore(
      (l) => {
        ls.add(l);
        return () => ls.delete(l);
      },
      () => value,
    );
  return { set, use, get: () => value };
}

/**
 * A point in an object's history: one journal entry. `next` marks the start: the
 * moment just before that event, so the system shows as it was before anything happened.
 */
export type Point = { owner: string; seq: number; at: number; next?: Point };

/** The moment just before `first`. */
export const startBefore = (first: Point): Point => ({ owner: first.owner, seq: first.seq - 1, at: first.at - 1, next: first });

// The event under the pointer in the events panel, and the one clicked to pin it.
const hovered = cell<Point | undefined>(undefined);
const pinned = cell<Point | undefined>(undefined);
export const setHovered = hovered.set;
export const setPinned = pinned.set;
export const usePinned = pinned.use;
/** The point the diagrams show: hovered, else pinned, else live (undefined). */
export function useInspected(): Point | undefined {
  const h = hovered.use();
  const p = pinned.use();
  return h ?? p;
}

/** The diagram node you clicked ("part:account", "free-web:build/running.cloning"): zoomed to, and its object's state shown. */
const selectedNode = cell<string | undefined>(undefined);
export const setSelectedNode = selectedNode.set;
export const useSelectedNode = selectedNode.use;

// The app is sending something the system will react to (a command, a scenario's webhooks).
const sending = cell(false);
export const setSending = sending.set;
export const useSending = sending.use;

/** Is a view still working, beyond its outbox? The app knows: a dispatch, a running build. */
export type Busy = (key: string, view: MachineView) => boolean;

/** Something is still moving: something being sent, a parked or queued message, or a view `busy` says is working. */
export function useInFlight(busy?: Busy) {
  const all = useAllViews();
  const clock = useClock();
  const isSending = sending.use();
  if (isSending || clock.parked.length) return true;
  return all.some(([key, v]) => v.outbox.length > 0 || Boolean(busy?.(key, v)));
}
