import { useEffect, useMemo, useRef, useState } from "react";
import type { JournalEntry, MachineView } from "durable-machines/protocol";
import { activeIds, definitionOf, eventLabel, layoutSystem, type Chart, type ChartEdge, type SystemPart, type SystemWire } from "./graph";
import { ChartSvg, type Box } from "./Statechart";
import { useAllViews, useClock, useViewsVersion, type Point } from "./store";
import { entryAt } from "./timeline";
import { ZoomFrame } from "./ZoomFrame";

const HOT_MS = 2500;

/** The map part an object address belongs to ("Account/alice" → "account"), or undefined if the map doesn't draw it. */
export type PartOf = (address: string) => string | undefined;
/** The part whose statechart an entry moves: usually its object's part; a child actor can have its own box. */
export type ActorPart = (owner: string, entry: JournalEntry) => string | undefined;
/** One part's state at a point: its machine's value, and whether it reached a final state. */
export type PartState = { part: string; value: unknown; done?: boolean };

/** Every hop the journals and outboxes show between two drawn parts, one wire per direction. */
export function wiresFromJournals(views: ReadonlyMap<string, MachineView>, partOf: PartOf): SystemWire[] {
  const wires = new Map<string, Set<string>>();
  const add = (from: string | undefined, to: string | undefined, type: string) => {
    if (!from || !to || from === to) return;
    const k = `${from}→${to}`;
    wires.set(k, (wires.get(k) ?? new Set()).add(type));
  };
  for (const [owner, v] of views) {
    for (const e of v.journal) {
      if (e.event.type.startsWith("xstate.")) continue;
      if (e.kind === "sent" && e.target) add(partOf(owner), partOf(e.target), e.event.type);
      if (e.kind === "transition" && e.actor === v.machineId) add(partOf(e.source), partOf(owner), e.event.type);
    }
    for (const o of v.outbox) add(partOf(owner), partOf(o.to), o.event.type);
  }
  return [...wires].map(([k, types]) => {
    const [source = "", target = ""] = k.split("→");
    return { source, target, events: [...types].sort() };
  });
}

/** Ids with no descendant in the list: the active leaf states. */
const leaves = (ids: string[]) => ids.filter((id) => !ids.some((o) => o.startsWith(`${id}.`)));

/**
 * What the map zooms to for one event: the states its transition left and entered and its
 * label, with the wire it came in on and its sender; or the wire a message left on.
 */
export function focusOf(views: ReadonlyMap<string, MachineView>, at: Point, partOf: PartOf, actorPart?: ActorPart): string[] | undefined {
  const view = views.get(at.owner);
  const e = entryAt(view, at);
  if (!e) return undefined;
  const own = partOf(at.owner);
  if (e.kind === "sent") {
    const to = e.target && partOf(e.target);
    return own && to ? [`wire:${own}→${to}`] : undefined;
  }
  const prefix = actorPart ? actorPart(at.owner, e) : own;
  if (!prefix) return undefined;
  if (e.kind !== "transition") return [prefix];
  const before = leaves(activeIds(e.from));
  const after = leaves(activeIds(e.to));
  const changed = [...after.filter((id) => !before.includes(id)), ...before.filter((id) => !after.includes(id))];
  const from = partOf(e.source);
  const sender = from && own && from !== own ? [`path:${from}→${own}|${e.event.type}`] : [];
  return [...(changed.length ? changed : after).map((id) => `${prefix}/${id}`), `edge:${prefix}|${eventLabel(e.event, definitionOf(view, e.actor))}`, ...sender];
}

const pointKey = (point: Point | undefined) => (point ? `${point.owner}#${point.seq}${point.next ? "^" : ""}` : "live");

const partKey = (p: SystemPart): string => `${p.id}${p.definition ? "" : "!"}${p.children?.length ? `(${p.children.map(partKey).join("+")})` : ""}`;

/**
 * Every machine in one picture: each Durable Object is a box with its own
 * statechart, and blue wires are the messages the outbox sends between
 * objects. The app says what to draw (`parts`, `wires`) and how objects map to
 * parts; nothing here knows the domain.
 *
 * `point` draws the system as it was right after that journal entry, lighting
 * only what that entry did. The canvas moves to a new point first, then draws it.
 * `zoomTo` zooms to parts, states ("part/state"), wires ("wire:a→b"), labels
 * ("edge:part|event") or the wire a message came in on, with a small sender ("path:a→b|event").
 */
export function SystemMap({
  parts,
  wires,
  partOf,
  actorPart,
  statesAt,
  extraHot,
  ready = true,
  direction = "DOWN",
  emptyText = "No machine has run yet.",
  point: goalPoint,
  zoomTo,
  onSelect,
  onBackground,
}: {
  parts: SystemPart[];
  wires: SystemWire[];
  partOf: PartOf;
  actorPart?: ActorPart;
  /** Each part's state as of a point, or live. */
  statesAt: (point: Point | undefined) => PartState[];
  /** Wires an entry lights besides its own hop, as "from→to|label". */
  extraHot?: (owner: string, entry: JournalEntry) => string[];
  /** False until the views the parts need have arrived. */
  ready?: boolean;
  direction?: "RIGHT" | "DOWN";
  emptyText?: string;
  point?: Point;
  zoomTo?: string[];
  /** Clicked a state or a part: its node id. */
  onSelect?: (nodeId: string) => void;
  onBackground?: () => void;
}) {
  const views = new Map(useAllViews());
  const version = useViewsVersion();
  const clock = useClock();
  const goalKey = pointKey(goalPoint);
  const [drawn, setDrawn] = useState({ key: goalKey, point: goalPoint });
  const point = drawn.key === goalKey ? goalPoint : drawn.point;
  const settle = useRef(() => {});
  settle.current = () => setDrawn((d) => (d.key === goalKey ? d : { key: goalKey, point: goalPoint }));
  const [chart, setChart] = useState<Chart>();
  const [now, setNow] = useState(Date.now());

  const key = `${direction}|${parts.map(partKey).join(",")}|${wires.map((w) => `${w.source}>${w.target}:${w.events.join("+")}`).join(",")}`;
  useEffect(() => {
    if (!ready) return;
    if (!parts.length) return setChart({ width: 0, height: 0, nodes: [], edges: [] });
    let live = true;
    void layoutSystem(key, parts, wires, direction).then((laid) => live && setChart(laid));
    return () => {
      live = false;
    };
    // Definitions never change after connect; the key covers the topology.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  const entries = useMemo(() => {
    const all: Array<{ owner: string; entry: JournalEntry }> = [];
    for (const [k, v] of views) for (const entry of v.journal) all.push({ owner: k, entry });
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const latest = Math.max(0, ...entries.map((e) => e.entry.at));

  useEffect(() => {
    if (point || Date.now() - latest > HOT_MS) return;
    const timer = setInterval(() => setNow(Date.now()), 400);
    const stop = setTimeout(() => clearInterval(timer), HOT_MS + 500);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [latest, point]);

  if (!ready || !chart) return <div className="h-full min-h-60 animate-pulse rounded-lg bg-kumo-elevated" />;
  if (!chart.nodes.length) return <div className="grid h-full min-h-60 place-items-center text-sm text-kumo-subtle">{emptyText}</div>;

  const inner = actorPart ?? ((owner: string) => partOf(owner));
  const pointEntry = point && !point.next ? entryAt(views.get(point.owner), point) : undefined;

  const activeIn = (states: PartState[]) => {
    const ids = new Set<string>();
    for (const s of states) for (const id of activeIds(s.value)) ids.add(`${s.part}/${id}`);
    return ids;
  };
  const states = statesAt(point);
  const active = activeIn(states);
  const done = new Set(states.filter((s) => s.done).map((s) => s.part));
  const goalActive = drawn.key === goalKey ? active : activeIn(statesAt(goalPoint));

  // What happened: at a point, only that entry; live, the last few seconds.
  const recent = point ? (pointEntry ? [{ owner: point.owner, entry: pointEntry }] : []) : entries.filter((e) => now - e.entry.at < HOT_MS);
  const hotInner = new Set<string>();
  const hotWire = new Set<string>();
  for (const { owner, entry } of recent) {
    const own = partOf(owner);
    if (!own) continue;
    if (entry.kind === "transition") {
      const machine = inner(owner, entry);
      if (machine) hotInner.add(`${machine}|${eventLabel(entry.event, definitionOf(views.get(owner), entry.actor))}`);
      const from = partOf(entry.source);
      if (from && from !== own) hotWire.add(`${from}→${own}|${entry.event.type}`);
    }
    if (entry.kind === "sent" && entry.target) {
      const to = partOf(entry.target);
      if (to) hotWire.add(`${own}→${to}|${entry.event.type}`);
    }
    for (const k of extraHot?.(owner, entry) ?? []) hotWire.add(k);
  }
  // Live only. Messages on their way move along their wire; hops parked by the paused clock wait, still.
  const inFlight = new Map<string, "moving" | "waiting">();
  if (!point) {
    const mark = (k: string, state: "moving" | "waiting") => inFlight.get(k) !== "moving" && inFlight.set(k, state);
    const parkedTokens = new Set(clock.parked.map((p) => p.token));
    for (const [owner, v] of views) {
      const from = partOf(owner);
      for (const item of v.outbox) {
        const to = partOf(item.to);
        if (from && to) mark(`${from}→${to}|${item.event.type}`, parkedTokens.has(item.id) ? "waiting" : "moving");
      }
    }
    for (const item of clock.parked) {
      const from = partOf(item.owner);
      const to = partOf(item.to);
      if (from && to && !item.token.startsWith("msg:")) mark(`${from}→${to}|${item.eventType}`, "waiting");
    }
  }
  const partFor = (id: string) => (id.startsWith("part:") ? id.slice(5) : id.slice(0, id.indexOf("/")));
  const wireKey = (edge: ChartEdge, text: string) => `${partFor(edge.source)}→${partFor(edge.target)}|${text}`;
  const hot = (edge: ChartEdge, text: string) =>
    edge.wire ? hotWire.has(wireKey(edge, text)) : hotInner.has(`${partFor(edge.source)}|${text}`) && active.has(edge.target);
  const pending = (edge: ChartEdge, text: string) => (edge.wire && inFlight.get(wireKey(edge, text))) || false;

  const boxes = (zoomTo ?? []).flatMap((id): Box[] => {
    if (id.startsWith("path:")) {
      const [route = "", type = ""] = id.slice(5).split("|");
      const [from, to] = route.split("→");
      const along = chart.edges
        .filter((e) => e.wire && partFor(e.source) === from && partFor(e.target) === to && e.labels.includes(type))
        .flatMap((e) => e.points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })));
      const sender = chart.nodes.filter((n) => n.id === `part:${from}` && n.kind === "external");
      return [...along, ...sender];
    }
    if (id.startsWith("wire:")) {
      const [from, to] = id.slice(5).split("→");
      return chart.edges.filter((e) => e.wire && partFor(e.source) === from && partFor(e.target) === to).flatMap((e) => e.labelBoxes);
    }
    if (id.startsWith("edge:")) {
      const [owner = "", type = ""] = id.slice(5).split("|");
      return chart.edges
        .filter((e) => !e.wire && partFor(e.source) === owner && e.labels.includes(type) && goalActive.has(e.target))
        .flatMap((e) => e.labelBoxes.filter((b) => b.text === type));
    }
    return chart.nodes.filter((n) => n.id === (id.includes("/") ? id : `part:${id}`));
  });
  const target = boxes.length
    ? (() => {
        const x = Math.min(...boxes.map((b) => b.x));
        const y = Math.min(...boxes.map((b) => b.y));
        return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
      })()
    : undefined;

  return (
    <ZoomFrame
      chart={chart}
      target={target}
      focusKey={`${key}|${zoomTo?.join(",") ?? ""}`}
      settleKey={goalKey}
      onSettle={() => settle.current()}
      onBackground={onBackground}
    >
      {(view) => (
        <ChartSvg
          chart={chart}
          label="System statechart"
          active={active}
          done={(id) => done.has(partFor(id))}
          hot={hot}
          pending={pending}
          pulse={point ? `${point.owner}#${point.seq}` : latest}
          view={view}
          onNodeClick={onSelect && ((n) => onSelect(n.id))}
        />
      )}
    </ZoomFrame>
  );
}
