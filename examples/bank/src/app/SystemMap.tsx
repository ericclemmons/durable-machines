import { useEffect, useMemo, useState } from "react";
import type { JournalEntry, MachineView } from "durable-machines/protocol";
import { activeIds, layoutSystem, type Chart, type ChartEdge, type SystemPart, type SystemWire } from "./graph";
import { ChartSvg, type Box } from "./Statechart";
import { useAllViews, type Point } from "./store";
import { entryAt, stateAt } from "./timeline";
import { objectPurpose } from "./ui";
import { ZoomFrame } from "./ZoomFrame";

const HOT_MS = 2500;
const WORKER = "Worker";

/** A part id for an object address. Node ids are `${part}/${state}`, so a part id has no "/". */
export const partId = (address: string) => address.replace("/", "~");
export const addressOf = (part: string) => part.replace("~", "/");

/**
 * Every object you're connected to, in one picture. Nothing here knows the
 * domain: each object is a box with its machine's statechart, and the wires
 * are the messages the journals and outboxes show going between them.
 *
 * `point` draws the system as it was right after that journal entry, lighting
 * only what that entry did. `zoomTo` zooms to parts, states, wires or labels.
 */
export function SystemMap({
  keys,
  me,
  point,
  zoomTo,
  onSelect,
  onBackground,
}: {
  /** Objects to draw ("Account/1.2.3.4"), in order. */
  keys: string[];
  /** Your own object, labelled "You". */
  me?: string;
  point?: Point;
  zoomTo?: string[];
  onSelect?: (nodeId: string) => void;
  onBackground?: () => void;
}) {
  const all = new Map(useAllViews());
  const shown = keys.flatMap((k) => {
    const v = all.get(k);
    return v ? [[k, v] as const] : [];
  });
  const views = new Map<string, MachineView>(shown);
  const [chart, setChart] = useState<Chart>();
  const [now, setNow] = useState(Date.now());

  const known = (address: string) => (views.has(address) ? address : address === "external" ? WORKER : undefined);

  // Wires: every hop a journal or outbox shows between two drawn objects.
  const wireMap = new Map<string, Set<string>>();
  const addWire = (from: string | undefined, to: string | undefined, type: string) => {
    if (!from || !to || from === to) return;
    const k = `${from}→${to}`;
    wireMap.set(k, (wireMap.get(k) ?? new Set()).add(type));
  };
  for (const [owner, v] of views) {
    for (const e of v.journal) {
      if (e.event.type.startsWith("xstate.")) continue;
      if (e.kind === "delivered" && e.target) addWire(owner, known(e.target), e.event.type);
      if (e.kind === "transition" && e.actor === v.machineId) addWire(known(e.source), owner, e.event.type);
    }
    for (const o of v.outbox) addWire(owner, known(o.to), o.event.type);
  }
  const wires: SystemWire[] = [...wireMap].map(([k, types]) => {
    const [source, target] = k.split("→") as [string, string];
    return { source: partId(source), target: partId(target), events: [...types].sort() };
  });
  const withWorker = wires.some((w) => w.source === WORKER);

  const parts: SystemPart[] = [
    ...(withWorker ? [{ id: WORKER, title: WORKER, subtitle: "Takes your commands" }] : []),
    ...shown.map(([key, v]) => ({
      id: partId(key),
      title: key,
      subtitle: `${key === me ? "You · " : ""}${objectPurpose(key) ?? ""}`,
      definition: v.definitions[v.machineId],
    })),
  ];
  const layoutKey = `${parts.map((p) => p.id).join(",")}|${wires.map((w) => `${w.source}>${w.target}:${w.events.join("+")}`).join(",")}`;

  useEffect(() => {
    if (!parts.length) return;
    let live = true;
    layoutSystem(layoutKey, parts, wires, "RIGHT").then((laid) => live && setChart(laid));
    return () => {
      live = false;
    };
    // The key covers parts and wires; definitions never change after connect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const entries = useMemo(() => {
    const out: Array<{ owner: string; entry: JournalEntry }> = [];
    for (const [k, v] of views) for (const entry of v.journal) out.push({ owner: k, entry });
    return out;
  }, [all]);
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

  if (!chart) return <div className="h-full min-h-60 animate-pulse bg-kumo-elevated" />;

  const pointEntry = point ? entryAt(views.get(point.owner), point) : undefined;

  const active = new Set<string>();
  const done = new Set<string>();
  for (const [key, v] of views) {
    const state = stateAt(key, v, point);
    for (const id of activeIds(state.root.value)) active.add(`${partId(key)}/${id}`);
    if (state.root.status === "done") done.add(partId(key));
  }

  const recent = point ? (pointEntry ? [{ owner: point.owner, entry: pointEntry }] : []) : entries.filter((e) => now - e.entry.at < HOT_MS);
  const hotInner = new Set<string>();
  const hotWire = new Set<string>();
  for (const { owner, entry } of recent) {
    const own = partId(owner);
    if (entry.kind === "transition") {
      hotInner.add(`${own}|${entry.event.type}`);
      const from = known(entry.source);
      if (from && from !== owner) hotWire.add(`${partId(from)}→${own}|${entry.event.type}`);
    }
    if (entry.kind === "delivered" && entry.target) {
      const to = known(entry.target);
      if (to) hotWire.add(`${own}→${partId(to)}|${entry.event.type}`);
    }
  }
  const moving = new Set<string>();
  if (!point)
    for (const [owner, v] of views)
      for (const o of v.outbox) {
        const to = known(o.to);
        if (to) moving.add(`${partId(owner)}→${partId(to)}|${o.event.type}`);
      }

  const partFor = (id: string) => (id.startsWith("part:") ? id.slice(5) : id.slice(0, id.indexOf("/")));
  const wireKey = (edge: ChartEdge, text: string) => `${partFor(edge.source)}→${partFor(edge.target)}|${text}`;
  const hot = (edge: ChartEdge, text: string) =>
    edge.wire ? hotWire.has(wireKey(edge, text)) : hotInner.has(`${partFor(edge.source)}|${text}`) && active.has(edge.target);
  const pending = (edge: ChartEdge, text: string) => (edge.wire && moving.has(wireKey(edge, text)) ? ("moving" as const) : false);

  const boxes = (zoomTo ?? []).flatMap((id): Box[] => {
    if (id.startsWith("wire:")) {
      const [from, to] = id.slice(5).split("→");
      return chart.edges.filter((e) => e.wire && partFor(e.source) === from && partFor(e.target) === to).flatMap((e) => e.labelBoxes);
    }
    if (id.startsWith("edge:")) {
      const [owner, type] = id.slice(5).split("|") as [string, string];
      return chart.edges
        .filter((e) => !e.wire && partFor(e.source) === owner && e.labels.includes(type) && active.has(e.target))
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
    <ZoomFrame chart={chart} target={target} focusKey={`${layoutKey}|${zoomTo?.join(",") ?? ""}`} onBackground={onBackground}>
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
