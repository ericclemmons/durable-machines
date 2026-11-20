import { useEffect, useId, useState } from "react";
import type { JournalEntry } from "durable-machines/protocol";
import { activeIds, formatValue, layout, missingEdges, type Chart, type ChartEdge, type ChartNode } from "./graph";
import { ObjectLabel } from "./ui";

const roundedPath = (points: ChartEdge["points"]) => {
  if (points.length < 2) return "";
  const r = 6;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    const next = points[i + 1]!;
    const d1 = Math.min(r, Math.hypot(p.x - prev.x, p.y - prev.y) / 2);
    const d2 = Math.min(r, Math.hypot(next.x - p.x, next.y - p.y) / 2);
    const a = { x: p.x - Math.sign(p.x - prev.x) * d1, y: p.y - Math.sign(p.y - prev.y) * d1 };
    const b = { x: p.x + Math.sign(next.x - p.x) * d2, y: p.y + Math.sign(next.y - p.y) * d2 };
    d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`;
  }
  const last = points.at(-1)!;
  return `${d} L ${last.x} ${last.y}`;
};

const finalFill = (key: string) => (key === "succeeded" || key === "completed" ? "fill-emerald-500" : key === "failed" || key === "rejected" ? "fill-red-500" : "fill-neutral-600");

export type ChartSvgProps = {
  chart: Chart;
  label: string;
  /** Active state ids. */
  active: Set<string>;
  /** Ids of machines (or the single root) that reached a final state. */
  done?: (nodeId: string) => boolean;
  /** Is this edge's label `text` the one that just fired? */
  hot?: (edge: ChartEdge, text: string) => boolean;
  /** Is a message with this label waiting in an outbox (in flight)? */
  /** "moving": a message on its way (animated). "waiting": parked until Next (still). */
  pending?: (edge: ChartEdge, text: string) => "moving" | "waiting" | false;
  /** Changes to replay edge highlights. */
  pulse?: number | string;
  maxHeight?: number | string;
  /** Draw at this multiple of the layout size (still capped by the container). */
  scale?: number;
  /** Fill the parent box, keeping the aspect ratio. */
  fill?: boolean;
  selected?: string;
  onNodeClick?: (node: ChartNode) => void;
  className?: string;
  /** Show only this region of the chart (zoom and pan). Implies `fill`. */
  view?: Box;
};

export type Box = { x: number; y: number; width: number; height: number };

/** Draws a laid-out chart: one machine, or a whole system of machines. */
export function ChartSvg({
  chart,
  label,
  active,
  done = () => false,
  hot = () => false,
  pending = () => false,
  pulse,
  maxHeight = 420,
  scale = 1,
  fill = false,
  selected,
  onNodeClick,
  className = "",
  view,
}: ChartSvgProps) {
  if (view) fill = true;
  const click = (n: ChartNode) =>
    onNodeClick
      ? {
          onClick: (e: { stopPropagation(): void }) => {
            e.stopPropagation();
            onNodeClick(n);
          },
          style: { cursor: "pointer" },
        }
      : {};
  const ring = (n: ChartNode) =>
    selected === n.id && (
      <rect
        x={n.x - 5}
        y={n.y - 5}
        width={n.width + 10}
        height={n.height + 10}
        rx={14}
        fill="none"
        className="stroke-sky-600"
        strokeWidth={2}
        strokeDasharray="4 3"
      />
    );
  const marker = useId().replace(/:/g, "");
  const containers = chart.nodes.filter((n) => n.kind === "compound" || n.kind === "machine");
  const leaves = chart.nodes.filter((n) => n.kind !== "compound" && n.kind !== "machine");

  return (
    <svg
      viewBox={view ? `${view.x} ${view.y} ${view.width} ${view.height}` : `0 0 ${chart.width} ${chart.height}`}
      width={fill ? "100%" : chart.width * scale}
      style={fill ? { width: "100%", height: "100%" } : { maxWidth: "100%", maxHeight, height: "auto" }}
      className={`mx-auto block ${className}`}
      role="img"
      aria-label={label}
    >
      <defs>
        {[
          ["a", "var(--color-neutral-500)"],
          ["hot", "var(--color-orange-500)"],
          ["wire", "var(--color-sky-500)"],
        ].map(([id, fill]) => (
          <marker key={id} id={`${marker}-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill }} />
          </marker>
        ))}
      </defs>

      {containers.map((n) => {
        const on = active.has(n.id);
        if (n.kind === "machine") {
          return (
            <g key={n.id} {...click(n)}>
              {ring(n)}
              <rect x={n.x} y={n.y} width={n.width} height={n.height} rx={16} className="fill-kumo-base stroke-sky-500/40" strokeWidth={1.5} />
              {n.key.includes("/") ? (
                <foreignObject x={n.x + 12} y={n.y + 6} width={Math.max(40, n.width - 24)} height={20}>
                  <ObjectLabel address={n.key} spread className="text-[14px] leading-5 font-semibold text-kumo-strong" />
                </foreignObject>
              ) : (
                <text x={n.x + 14} y={n.y + 20} className="fill-neutral-900 text-[14px] font-semibold">
                  {n.key}
                </text>
              )}
              <text x={n.x + 14} y={n.y + 36} className="fill-neutral-500 text-[11px]">
                {n.subtitle}
              </text>
            </g>
          );
        }
        return (
          <g key={n.id} {...click(n)}>
            {ring(n)}
            <rect
              x={n.x}
              y={n.y}
              width={n.width}
              height={n.height}
              rx={12}
              className={`state-fill ${on ? "state-on fill-orange-500/5 stroke-orange-500/70" : "fill-kumo-elevated stroke-neutral-300"}`}
              strokeWidth={1.5}
              strokeDasharray={n.region ? "6 4" : undefined}
            >
              {n.description && <title>{n.description}</title>}
            </rect>
            <text x={n.x + 12} y={n.y + 19} className={`state-fill text-[12px] font-semibold ${on ? "state-on fill-orange-700" : "fill-neutral-700"}`}>
              {n.region ? "∥ " : n.initial ? "● " : ""}
              {n.key}
            </text>
            {n.invoke && (
              <text x={n.x + 12} y={n.y + 33} className="fill-sky-600 font-mono text-[10px]">
                invoke {n.invoke}
              </text>
            )}
          </g>
        );
      })}

      {chart.edges.map((e) => {
        const lit = e.labels.some((t) => hot(e, t));
        const states = lit ? [] : e.labels.map((t) => pending(e, t));
        const waiting = states.includes("moving") ? "moving" : states.includes("waiting") ? "waiting" : false;
        const stroke = lit
          ? "stroke-orange-600 edge-hot"
          : waiting === "moving"
            ? "stroke-sky-700 edge-flow"
            : waiting === "waiting"
              ? "stroke-sky-700"
              : e.wire
                ? "stroke-sky-500/60"
                : "stroke-neutral-400";
        return (
          <g key={`${e.id}-${lit ? pulse : 0}`}>
            <path
              d={roundedPath(e.points)}
              fill="none"
              strokeWidth={lit || waiting ? 2.4 : e.wire ? 1.8 : 1.2}
              strokeDasharray={waiting ? "7 5" : e.guarded ? "5 4" : undefined}
              className={stroke}
              markerEnd={`url(#${marker}-${lit ? "hot" : e.wire ? "wire" : "a"})`}
            />
            {e.labelBoxes.map((box) => {
              const on = hot(e, box.text);
              const queued = on ? false : pending(e, box.text);
              return (
                <g key={box.text}>
                  <rect
                    x={box.x}
                    y={box.y}
                    width={box.width}
                    height={box.height}
                    rx={4}
                    strokeWidth={queued === "waiting" ? 1.5 : 0}
                    strokeDasharray={queued === "waiting" ? "3 2" : undefined}
                    className={
                      on
                        ? "fill-orange-500"
                        : queued === "moving"
                          ? "node-glow fill-sky-600"
                          : queued === "waiting"
                            ? "fill-sky-100 stroke-sky-700"
                            : e.wire
                              ? "fill-sky-50"
                              : "fill-kumo-recessed"
                    }
                  />
                  <text
                    x={box.x + box.width / 2}
                    y={box.y + 11.5}
                    textAnchor="middle"
                    className={`font-mono text-[10px] ${on || queued === "moving" ? "fill-kumo-base font-semibold" : queued === "waiting" ? "fill-sky-800 font-semibold" : e.wire ? "fill-sky-700" : "fill-neutral-700"}`}
                  >
                    {box.text}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}

      {leaves.map((n) => {
        const on = active.has(n.id);
        const final = n.kind === "final";
        if (n.kind === "external") {
          return (
            <g key={n.id} {...click(n)}>
              {ring(n)}
              <rect x={n.x} y={n.y} width={n.width} height={n.height} rx={12} className="fill-kumo-elevated stroke-sky-500/50" strokeWidth={1.5} />
              <foreignObject x={n.x + 4} y={n.y + 9} width={n.width - 8} height={18}>
                <div className="flex justify-center text-[13px] leading-[18px] font-semibold text-kumo-strong">
                  <ObjectLabel address={n.key} />
                </div>
              </foreignObject>
              <text x={n.x + n.width / 2} y={n.y + 38} textAnchor="middle" className="fill-sky-600/80 font-mono text-[10px]">
                {n.subtitle}
              </text>
            </g>
          );
        }
        const fill = on ? (final && done(n.id) ? finalFill(n.key) : "fill-orange-500") : "fill-kumo-elevated";
        return (
          <g key={n.id} {...click(n)}>
            {ring(n)}
            {on && (
              <g className="state-enter" style={{ transformOrigin: `${n.x + n.width / 2}px ${n.y + n.height / 2}px` }}>
                <rect
                  x={n.x - 3}
                  y={n.y - 3}
                  width={n.width + 6}
                  height={n.height + 6}
                  rx={n.kind === "choice" ? 6 : 13}
                  className="node-glow fill-orange-500/20"
                />
              </g>
            )}
            <rect
              x={n.x}
              y={n.y}
              width={n.width}
              height={n.height}
              rx={n.kind === "choice" ? 4 : 10}
              className={`state-fill ${on ? "state-on" : ""} ${fill} ${n.kind === "any" ? "stroke-neutral-500" : on ? "stroke-orange-700" : "stroke-neutral-400"}`}
              strokeWidth={final ? 3 : 1.5}
              strokeDasharray={n.kind === "any" ? "4 3" : undefined}
            >
              {n.description && <title>{n.description}</title>}
            </rect>
            {final && (
              <rect
                x={n.x + 3}
                y={n.y + 3}
                width={n.width - 6}
                height={n.height - 6}
                rx={7}
                fill="none"
                className={on ? "stroke-neutral-50/40" : "stroke-neutral-300"}
              />
            )}
            <text
              x={n.x + n.width / 2}
              y={n.y + 21}
              textAnchor="middle"
              className={`state-fill text-[12px] ${on ? "state-on fill-kumo-base font-semibold" : n.kind === "any" ? "fill-neutral-600 italic" : "fill-neutral-800"}`}
            >
              {n.kind === "choice" ? "◇ " : n.initial ? "● " : ""}
              {n.key}
            </text>
            {(n.invoke || n.timeout) && (
              <text
                x={n.x + n.width / 2}
                y={n.y + 34}
                textAnchor="middle"
                className={`state-fill font-mono text-[10px] ${on ? "state-on fill-kumo-elevated" : n.invoke ? "fill-sky-600" : "fill-amber-600"}`}
              >
                {n.invoke ? `invoke ${n.invoke}` : `timeout ${n.timeout}`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

type Props = {
  /** Cache key for the layout, usually the machine id. */
  chartKey: string;
  definition: unknown;
  value: unknown;
  /** Highlights edges labelled with this event type. */
  lastEvent?: string;
  /** Changes when the last event changes, to replay the highlight. */
  pulse?: number;
  status?: string;
  maxHeight?: number | string;
  scale?: number;
  direction?: "RIGHT" | "DOWN";
  /** This actor's journal entries, to detect transitions the diagram can't show. */
  journal?: ReadonlyArray<JournalEntry>;
};

const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

/** Click a state to see what it does: its transitions, invoke, timeout, and when it was last entered. */
function StateInspector({
  chart,
  node,
  active,
  journal,
  onClose,
}: {
  chart: Chart;
  node: ChartNode;
  active: boolean;
  journal: ReadonlyArray<JournalEntry>;
  onClose: () => void;
}) {
  const name = (id: string) => chart.nodes.find((n) => n.id === id)?.key ?? id;
  const outgoing = chart.edges.filter((e) => e.source === node.id);
  const incoming = chart.edges.filter((e) => e.target === node.id);
  const entered = [...journal].reverse().find((j) => activeIds(j.to).includes(node.id) && !activeIds(j.from).includes(node.id));
  return (
    <div
      className="absolute right-2 top-2 z-10 w-72 rounded-lg border border-sky-500/40 bg-kumo-base/90 p-3 text-xs shadow-xl backdrop-blur"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-kumo-tint px-1.5 py-0.5 font-mono text-[10px] uppercase text-kumo-subtle">{node.region ? "region" : node.kind}</span>
        <span className="font-mono font-semibold text-kumo-strong">{node.id}</span>
        <button onClick={onClose} className="ml-auto text-kumo-subtle hover:text-kumo-default" aria-label="Close">
          ✕
        </button>
      </div>
      {node.description && <p className="mt-1.5 text-kumo-default">{node.description}</p>}
      <p className="mt-1.5 text-kumo-subtle">
        {active ? <span className="text-orange-700">Active now</span> : "Not active"}
        {entered && (
          <>
            {" "}
            · entered {ago(entered.at)} via <span className="font-mono text-kumo-default">{entered.event.type}</span>
          </>
        )}
      </p>
      {(node.invoke || node.timeout) && (
        <p className="mt-1 font-mono text-[11px]">
          {node.invoke && <span className="text-sky-600">invoke {node.invoke} </span>}
          {node.timeout && <span className="text-amber-600">timeout {node.timeout}</span>}
        </p>
      )}
      {outgoing.length > 0 && (
        <div className="mt-2">
          <h4 className="text-[10px] uppercase tracking-wide text-kumo-subtle">Handles</h4>
          <ul className="mt-0.5 flex flex-col gap-0.5 font-mono text-[11px]">
            {outgoing.flatMap((e) =>
              (e.labels.length ? e.labels : ["(always)"]).map((l) => (
                <li key={`${e.id}${l}`}>
                  <span className="text-kumo-default">{l}</span>{" "}
                  <span className="text-kumo-subtle">
                    → {name(e.target)}
                    {e.guarded ? " (conditional)" : ""}
                  </span>
                </li>
              )),
            )}
          </ul>
        </div>
      )}
      {incoming.length > 0 && (
        <div className="mt-2">
          <h4 className="text-[10px] uppercase tracking-wide text-kumo-subtle">Reached from</h4>
          <p className="font-mono text-[11px] text-kumo-subtle">{[...new Set(incoming.map((e) => name(e.source)))].join(", ")}</p>
        </div>
      )}
    </div>
  );
}

export function Statechart({ chartKey, definition, value, lastEvent, pulse, status, maxHeight = 420, scale = 1, direction = "RIGHT", journal = [] }: Props) {
  const [chart, setChart] = useState<Chart>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<string>();

  useEffect(() => {
    let live = true;
    layout(chartKey, definition, direction).then(
      (c) => live && setChart(c),
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [chartKey, definition, direction]);

  if (error) return <pre className="rounded-lg bg-red-500/10 p-2 text-xs text-red-700">Layout failed: {error}</pre>;
  if (!chart) return <div className="h-24 animate-pulse rounded-lg bg-kumo-elevated" />;

  const active = new Set(activeIds(value));
  const missing = missingEdges(
    chart,
    journal.filter((j) => j.kind === "transition"),
  );
  const node = chart.nodes.find((n) => n.id === picked);

  return (
    <div
      className="relative rounded-lg border border-kumo-line bg-[radial-gradient(circle_at_1px_1px,var(--color-kumo-line)_1px,transparent_0)] p-1 [background-size:16px_16px]"
      onClick={() => setPicked(undefined)}
    >
      <ChartSvg
        chart={chart}
        label={`Statechart for ${chartKey}`}
        active={active}
        done={() => status === "done"}
        hot={(e, text) => text === lastEvent && (active.has(e.target) || chart.nodes.some((n) => n.id === e.target && n.kind === "choice"))}
        pulse={pulse}
        maxHeight={maxHeight}
        scale={scale}
        selected={picked}
        onNodeClick={(n) => setPicked(n.id)}
      />
      {node && <StateInspector chart={chart} node={node} active={active.has(node.id)} journal={journal} onClose={() => setPicked(undefined)} />}
      <p className="px-2 font-mono text-[10px] text-kumo-inactive">{formatValue(value)} · click a state to inspect it</p>
      {missing.length > 0 && (
        <p
          className="px-2 pb-1 text-[11px] text-amber-700"
          title="Should be impossible: the graph coverage check rejects machines with hidden edges. Seeing this means the check missed a form."
        >
          ⚠ Diagram missed a transition: {missing.slice(0, 3).join(" · ")}
        </p>
      )}
    </div>
  );
}
