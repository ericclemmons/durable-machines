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
const connected = new Set<string>();
const listeners = new Set<() => void>();
const frames = { count: 0, bytes: 0 };
let version = 0;

const emit = () => {
  version++;
  for (const l of listeners) l();
};

const JOURNAL_LIMIT = 150;

// What each object looked like right after a journal entry, captured as commits
// arrive. Entries from before the page loaded have no snapshot.
export type Snapshot = Pick<MachineView, "root" | "children">;
const snapshots = new Map<string, Snapshot>();
const SNAPSHOT_LIMIT = 3000;
function remember(key: string, seq: number, view: MachineView) {
  snapshots.set(`${key}#${seq}`, { root: view.root, children: view.children });
  if (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
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

function apply(view: MachineView, frame: MachineCommit): MachineView {
  const byId = new Map([view.root, ...view.children].map((a) => [a.id, a]));
  for (const actor of frame.actors) byId.set(actor.id, actor);
  for (const id of frame.removed) byId.delete(id);
  const root = byId.get(view.machineId) ?? view.root;
  byId.delete(view.machineId);
  return {
    ...view,
    root,
    children: [...byId.values()],
    journal: [...view.journal, ...frame.entries].slice(-JOURNAL_LIMIT),
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
  delivered: "color:#7dd3fc",
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
      KIND_STYLE[e.kind],
      "font-weight:bold",
      "color:inherit",
      e.event,
    );
  }
}

export const viewStore = {
  set(key: string, view: MachineView) {
    views.set(key, view);
    const last = view.journal.at(-1);
    if (last) remember(key, last.seq, view);
    emit();
  },
  commit(key: string, frame: MachineCommit) {
    const view = views.get(key);
    if (!view) return;
    const next = apply(view, frame);
    views.set(key, next);
    for (const entry of frame.entries) remember(key, entry.seq, next);
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

export function useAllViews() {
  useSyncExternalStore(viewStore.subscribe, () => version);
  return viewStore.all();
}

export type MachineKind = "Installation" | "Account" | "Project";

/**
 * Connect to one Durable Object over its WebSocket. Nothing polls.
 * Mount once per object (see `Connections` in App); read it anywhere with `useView`.
 */
export function useMachine(agent: MachineKind, name: string) {
  const key = `${agent}/${name}`;
  const connection = useAgent<MachineView>({
    agent,
    name,
    onStateUpdate: (view) => {
      console.info(`%c${key}%c connected · ${formatValue(view.root.value)}`, "color:#a1a1aa", "color:#34d399", view);
      viewStore.set(key, view);
    },
    onMessage: (message: MessageEvent) => {
      if (typeof message.data !== "string") return;
      const frame = JSON.parse(message.data) as MachineCommit | MachineReset;
      frames.count++;
      frames.bytes += message.data.length;
      if (frame.type === "xstate.commit") {
        const view = views.get(key);
        if (view) logEntries(key, view.machineId, frame.entries);
        viewStore.commit(key, frame);
      } else if (frame.type === "xstate.reset") viewStore.set(key, frame.view);
    },
  });
  const send = useCallback((event: AnyEvent) => connection.call("send", [event]) as Promise<SendResult>, [connection]);
  useEffect(() => {
    senders.set(key, send);
    if (connection.identified) connected.add(key);
    else connected.delete(key);
    emit();
  }, [key, send, connection.identified]);
  useEffect(
    () => () => {
      senders.delete(key);
      connected.delete(key);
      viewStore.delete(key);
    },
    [key],
  );
}

/** Read a connected object's live view, and send it client-allowed events. */
export function useView(agent: MachineKind, name: string) {
  const key = `${agent}/${name}`;
  useSyncExternalStore(viewStore.subscribe, () => version);
  const send = useCallback(
    (event: AnyEvent): Promise<SendResult> => senders.get(key)?.(event) ?? Promise.resolve({ ok: false, error: "Not connected" }),
    [key],
  );
  return { key, view: views.get(key), send, connected: connected.has(key) };
}

// The debugger clock: one connection, shared by the toolbar and the System map.
let clockState: ClockState = { playing: false, pace: 500, parked: [] };
let clockCall: ((method: "next" | "nextMachine" | "play" | "pause" | "setPace", args?: unknown[]) => Promise<unknown>) | undefined;
const clockListeners = new Set<() => void>();
const setClock = (state: ClockState) => {
  clockState = state;
  for (const l of clockListeners) l();
};

/** Mount once (see `Connections` in App). */
export function useClockConnection() {
  const connection = useAgent<ClockState>({
    agent: "Clock",
    name: "global",
    onStateUpdate: setClock,
    onMessage: (message: MessageEvent) => {
      if (typeof message.data !== "string") return;
      const frame = JSON.parse(message.data) as ClockFrame;
      if (frame.type === "clock") setClock(frame.state);
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
  const call = useCallback((method: "next" | "nextMachine" | "play" | "pause" | "setPace", args?: unknown[]) => clockCall?.(method, args), []);
  return { ...state, call };
}

// The build each Project's diagram focuses on. The Deployments table sets it.
let selectedBuilds: Readonly<Record<string, string>> = {};
const selectionListeners = new Set<() => void>();

export function selectBuild(projectId: string, buildId: string) {
  selectedBuilds = { ...selectedBuilds, [projectId]: buildId };
  for (const l of selectionListeners) l();
}

export function useSelectedBuilds(): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    (l) => {
      selectionListeners.add(l);
      return () => selectionListeners.delete(l);
    },
    () => selectedBuilds,
  );
}

/** Send a client-allowed event to a connected object by key ("Project/free-web"). */
export const sendTo = (key: string, event: AnyEvent): Promise<SendResult> =>
  senders.get(key)?.(event) ?? Promise.resolve({ ok: false, error: "Not connected" });

/** A small external store: one value, many readers. */
function cell<T>(initial: T) {
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

/** A point in an object's history: one journal entry. */
export type Point = { owner: string; seq: number; at: number };

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

/** Which tab the dock under the diagram shows. */
const dockTab = cell<"deployments" | "state">("deployments");
export const setDockTab = dockTab.set;
export const useDockTab = dockTab.use;

// The Simulator is resetting the system or posting a scenario's webhooks.
const sending = cell(false);
export const setSending = sending.set;
export const useSending = sending.use;

/** Something is still moving: a webhook being sent, a parked or queued message, a dispatch, or a running build. */
export function useInFlight() {
  const views = useAllViews();
  const clock = useClock();
  const isSending = sending.use();
  if (isSending || clock.parked.length) return true;
  return views.some(
    ([key, v]) =>
      v.outbox.length > 0 ||
      (key.startsWith("Account/") && JSON.stringify(v.root.value).includes("dispatching")) ||
      v.children.some((c) => c.status === "active" && c.value !== "awaiting_approval"),
  );
}
