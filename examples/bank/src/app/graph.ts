import { objectLabelText } from "./ui";
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";

// Turns XState v6 JSON definitions (machineToJSON) into laid-out statecharts.
// ELK (Eclipse Layout Kernel) only does the layout; it knows nothing about XState.
// Function transitions are serialized as `@code`; their literal targets become
// dashed "guarded" edges. src/lib/graph-coverage.ts rejects computed targets,
// so every edge is visible; the journal comparison is only a safety net.

type Json = Record<string, unknown>;

export type ChartNode = {
  id: string;
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "atomic" | "compound" | "final" | "choice" | "any" | "machine" | "external";
  /** A region of a parallel state. */
  region: boolean;
  initial: boolean;
  description?: string;
  invoke?: string;
  timeout?: string;
  subtitle?: string;
  depth: number;
};

export type ChartEdge = {
  id: string;
  source: string;
  target: string;
  labels: string[];
  guarded: boolean;
  /** A message between Durable Objects, not a transition. */
  wire: boolean;
  points: Array<{ x: number; y: number }>;
  labelBoxes: Array<{ text: string; x: number; y: number; width: number; height: number }>;
};

export type Chart = { width: number; height: number; nodes: ChartNode[]; edges: ChartEdge[] };

const elk = new ELK();
const cache = new Map<string, Promise<Chart>>();

const isCode = (v: unknown): v is { "@code": string } => typeof v === "object" && v !== null && "@code" in v;

/** Literal targets in a transition: `{ target }` objects, or `target: "x"` inside `@code`. */
function targetsOf(transition: unknown): { targets: string[]; guarded: boolean } {
  if (!transition) return { targets: [], guarded: false };
  if (isCode(transition)) {
    const found = [...transition["@code"].matchAll(/target:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    return { targets: [...new Set(found)], guarded: true };
  }
  if (Array.isArray(transition)) {
    return transition
      .map(targetsOf)
      .reduce((a, b) => ({ targets: [...a.targets, ...b.targets], guarded: a.guarded || b.guarded }), { targets: [], guarded: false });
  }
  const target = (transition as Json).target;
  if (typeof target === "string") return { targets: [target], guarded: false };
  if (Array.isArray(target)) return { targets: target.filter((t): t is string => typeof t === "string"), guarded: false };
  return { targets: [], guarded: false };
}

function resolve(source: string, target: string): string {
  if (target.startsWith(".")) return source === "" ? target.slice(1) : `${source}${target}`;
  const parent = source.includes(".") ? source.slice(0, source.lastIndexOf(".")) : "";
  return parent ? `${parent}.${target}` : target;
}

const textWidth = (text: string, size = 7) => Math.ceil(text.length * size);

function duration(ms: unknown) {
  const n = typeof ms === "string" && /^\d+$/.test(ms) ? Number(ms) : ms;
  if (typeof n !== "number") return typeof n === "string" ? n : undefined;
  return n >= 60_000 ? `${n / 60_000}m` : `${n / 1000}s`;
}

type Meta = Omit<ChartNode, "x" | "y" | "width" | "height">;
type RawEdge = { id: string; source: string; target: string; label: string; guarded: boolean; wire: boolean; hidden?: boolean };
type Raw = { nodes: Map<string, Meta>; edges: RawEdge[]; next: number };

const newRaw = (): Raw => ({ nodes: new Map(), edges: [], next: 0 });

/**
 * Walk one machine definition. Ids are `${prefix}${statePath}`, so several
 * machines can share one graph. Returns the ELK nodes for the root's states.
 */
function walk(definition: Json, prefix: string, raw: Raw, depth0 = 0): ElkNode[] {
  const any = `${prefix}__any`;
  const addEdges = (source: string, label: string, transition: unknown) => {
    const { targets, guarded } = targetsOf(transition);
    for (const t of targets) {
      raw.edges.push({ id: `e${raw.next++}`, source: source === "" ? any : prefix + source, target: prefix + resolve(source, t), label, guarded, wire: false });
    }
  };

  const build = (key: string, path: string, config: Json, depth: number, initial: boolean, region: boolean): ElkNode => {
    const states = (config.states ?? {}) as Record<string, Json>;
    const childKeys = Object.keys(states);
    const initialKey = typeof config.initial === "string" ? config.initial : (config.initial as Json | undefined)?.target;
    const type = config.type as string | undefined;
    const invoke = config.invoke as Json | Json[] | undefined;
    const invokeSrc = invoke
      ? [invoke]
          .flat()
          .map((i) => String(i.src))
          .join(", ")
      : undefined;
    const kind: ChartNode["kind"] = type === "final" ? "final" : type === "choice" ? "choice" : childKeys.length ? "compound" : "atomic";

    for (const [event, transition] of Object.entries((config.on ?? {}) as Json)) addEdges(path, event, transition);
    for (const [delay, transition] of Object.entries((config.after ?? {}) as Json)) addEdges(path, `after ${duration(delay)}`, transition);
    if (config.always) addEdges(path, "always", config.always);
    if (config.onDone) addEdges(path, "done", config.onDone);
    if (config.onTimeout) addEdges(path, `timeout ${duration(config.timeout) ?? ""}`.trim(), config.onTimeout);
    if (config.choice) addEdges(path, "", config.choice);
    for (const inv of invoke ? [invoke].flat() : []) {
      if (inv.onDone) addEdges(path, `done: ${inv.src}`, inv.onDone);
      if (inv.onError) addEdges(path, `error: ${inv.src}`, inv.onError);
    }

    const extra = [invokeSrc && `invoke ${invokeSrc}`, config.timeout !== undefined && `timeout ${duration(config.timeout)}`].filter(Boolean) as string[];
    const width = Math.max(96, textWidth(key, 8) + 28, ...extra.map((e) => textWidth(e, 6) + 24));
    const parallel = type === "parallel";
    const children = childKeys.map((k) => build(k, path ? `${path}.${k}` : k, states[k]!, depth + 1, !parallel && k === initialKey, parallel));
    // Stack parallel regions instead of placing them side by side: a layout-only edge between neighbours.
    if (parallel) {
      for (let i = 1; i < children.length; i++) {
        raw.edges.push({ id: `h${raw.next++}`, source: children[i - 1]!.id, target: children[i]!.id, label: "", guarded: false, wire: false, hidden: true });
      }
    }
    // ELK crashes on keys that are present but undefined, so omit them.
    const size = children.length
      ? { layoutOptions: { "elk.padding": `[top=${30 + extra.length * 13},left=14,bottom=14,right=14]` } }
      : { width: kind === "choice" ? Math.max(84, textWidth(key, 7) + 24) : width, height: 34 + extra.length * 13 };
    const id = prefix + path;
    if (path) {
      raw.nodes.set(id, {
        id,
        key,
        kind,
        region,
        initial,
        description: config.description as string | undefined,
        invoke: invokeSrc,
        timeout: config.timeout !== undefined ? duration(config.timeout) : undefined,
        depth,
      });
    }
    return { id, ...size, children };
  };

  const root = build(String(definition.id), "", definition, depth0, false, false);
  const children = root.children ?? [];
  if (raw.edges.some((e) => e.source === any)) {
    raw.nodes.set(any, { id: any, key: "any state", kind: "any", region: false, initial: false, depth: depth0 + 1 });
    children.unshift({ id: any, width: 108, height: 34 });
  }
  return children;
}

const LAYOUT = {
  "elk.algorithm": "layered",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.spacing.nodeNode": "22",
  "elk.spacing.edgeLabel": "4",
  "elk.layered.spacing.edgeNodeBetweenLayers": "18",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
  "elk.padding": "[top=8,left=8,bottom=8,right=8]",
};

async function run(raw: Raw, children: ElkNode[], direction: "RIGHT" | "DOWN"): Promise<Chart> {
  const known = new Set(raw.nodes.keys());
  // One edge per source → target pair, carrying every event that takes it.
  const merged = new Map<string, Omit<ChartEdge, "points" | "labelBoxes"> & { hidden?: boolean }>();
  for (const e of raw.edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    const key = `${e.source}→${e.target}`;
    const existing = merged.get(key);
    if (existing) {
      if (e.label && !existing.labels.includes(e.label)) existing.labels.push(e.label);
      existing.guarded ||= e.guarded;
    } else {
      merged.set(key, { id: e.id, source: e.source, target: e.target, labels: e.label ? [e.label] : [], guarded: e.guarded, wire: e.wire, hidden: e.hidden });
    }
  }
  const edges = [...merged.values()];
  const graph: ElkNode = {
    id: "__root",
    layoutOptions: { ...LAYOUT, "elk.direction": direction },
    children,
    edges: edges.map((e): ElkExtendedEdge => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
      labels: e.labels.map((text) => ({ text, width: textWidth(text, 6.2) + 10, height: 16 })),
    })),
  };
  const out = await elk.layout(graph);

  const abs = new Map<string, { x: number; y: number }>([["__root", { x: 0, y: 0 }]]);
  const nodes: ChartNode[] = [];
  const visit = (node: ElkNode, ox: number, oy: number) => {
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      abs.set(child.id, { x, y });
      const meta = raw.nodes.get(child.id);
      if (meta) nodes.push({ ...meta, x, y, width: child.width ?? 0, height: child.height ?? 0 });
      visit(child, x, y);
    }
  };
  visit(out, 0, 0);

  const hidden = new Set(edges.filter((e) => e.hidden).map((e) => e.id));
  const chartEdges: ChartEdge[] = (out.edges ?? [])
    .filter((edge) => !hidden.has(edge.id))
    .map((edge) => {
      const meta = edges.find((e) => e.id === edge.id)!;
      const container = (edge as ElkExtendedEdge & { container?: string }).container ?? "__root";
      const o = abs.get(container) ?? { x: 0, y: 0 };
      const points = (edge.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]).map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
      return {
        ...meta,
        points,
        labelBoxes: (edge.labels ?? []).map((l) => ({
          text: l.text ?? "",
          x: (l.x ?? 0) + o.x,
          y: (l.y ?? 0) + o.y,
          width: l.width ?? 0,
          height: l.height ?? 0,
        })),
      };
    });
  return { width: out.width ?? 0, height: out.height ?? 0, nodes, edges: chartEdges };
}

/** Lay out one machine. */
export function layout(key: string, definition: unknown, direction: "RIGHT" | "DOWN" = "RIGHT"): Promise<Chart> {
  const cacheKey = `${key}:${direction}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const raw = newRaw();
  const promise = run(raw, walk(definition as Json, "", raw), direction);
  cache.set(cacheKey, promise);
  return promise;
}

export type SystemPart = {
  /** Unique id; state ids inside become `${id}/${statePath}`. */
  id: string;
  title: string;
  subtitle: string;
  /** A machine definition, or nothing for a plain box (Worker, Workflow). */
  definition?: unknown;
  direction?: "RIGHT" | "DOWN";
  /** Nested parts, e.g. the build machine a Project spawns. */
  children?: SystemPart[];
};

export type SystemWire = { source: string; target: string; events: string[] };

const shift = (chart: Pick<Chart, "nodes" | "edges">, dx: number, dy: number, depth = 0) => ({
  nodes: chart.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy, depth: n.depth + depth })),
  edges: chart.edges.map((e) => ({
    ...e,
    points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    labelBoxes: e.labelBoxes.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })),
  })),
});

/** One Durable Object box: its machine's chart, then any nested child machines below it. */
async function box(part: SystemPart, depth: number): Promise<Chart> {
  const header = 46;
  const nodes: ChartNode[] = [];
  const edges: ChartEdge[] = [];
  let y = header;
  let width = Math.max(150, textWidth(objectLabelText(part.title), 8.5) + 50, textWidth(part.subtitle, 6.2) + 30);
  if (part.definition) {
    const raw = newRaw();
    const chart = await run(raw, walk(part.definition as Json, `${part.id}/`, raw, depth + 1), part.direction ?? "DOWN");
    const placed = shift(chart, 16, y);
    nodes.push(...placed.nodes);
    edges.push(...placed.edges.map((e) => ({ ...e, id: `${part.id}:${e.id}` })));
    y += chart.height + 12;
    width = Math.max(width, chart.width + 32);
  }
  for (const child of part.children ?? []) {
    const inner = await box(child, depth + 1);
    const placed = shift(inner, 16, y);
    nodes.push(...placed.nodes);
    edges.push(...placed.edges);
    y += inner.height + 12;
    width = Math.max(width, inner.width + 32);
  }
  const plain = !part.definition && !part.children?.length;
  const height = plain ? 52 : y + 4;
  nodes.unshift({
    id: `part:${part.id}`,
    key: part.title,
    subtitle: part.subtitle,
    kind: plain ? "external" : "machine",
    region: false,
    initial: false,
    depth,
    x: 0,
    y: 0,
    width,
    height,
  });
  return { width, height, nodes, edges };
}

/**
 * Lay out a whole system: each Durable Object's machine is laid out on its own,
 * placed in a box, and the boxes are arranged with the messages between them.
 */
export function layoutSystem(key: string, parts: SystemPart[], wires: SystemWire[], direction: "RIGHT" | "DOWN" = "DOWN"): Promise<Chart> {
  const cacheKey = `system:${key}:${direction}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const boxes = await Promise.all(parts.map((p) => box(p, 0)));
    const graph: ElkNode = {
      id: "__system",
      layoutOptions: {
        ...LAYOUT,
        "elk.direction": direction,
        "elk.hierarchyHandling": "SEPARATE_CHILDREN",
        "elk.layered.spacing.nodeNodeBetweenLayers": "90",
        "elk.spacing.nodeNode": "40",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      },
      children: parts.map((p, i) => ({ id: `part:${p.id}`, width: boxes[i]!.width, height: boxes[i]!.height })),
      edges: wires.map((w, i) => ({
        id: `w${i}`,
        sources: [`part:${w.source}`],
        targets: [`part:${w.target}`],
        labels: w.events.map((text) => ({ text, width: textWidth(text, 6.2) + 10, height: 16 })),
      })),
    };
    const out = await elk.layout(graph);
    const nodes: ChartNode[] = [];
    const edges: ChartEdge[] = [];
    for (const [i, child] of (out.children ?? []).entries()) {
      const placed = shift(boxes[i]!, child.x ?? 0, child.y ?? 0);
      nodes.push(...placed.nodes);
      edges.push(...placed.edges);
    }
    for (const edge of out.edges ?? []) {
      const w = wires[Number(edge.id.slice(1))]!;
      edges.push({
        id: edge.id,
        source: `part:${w.source}`,
        target: `part:${w.target}`,
        labels: w.events,
        guarded: false,
        wire: true,
        points: (edge.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]),
        labelBoxes: (edge.labels ?? []).map((l) => ({ text: l.text ?? "", x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0, height: l.height ?? 0 })),
      });
    }
    return { width: out.width ?? 0, height: out.height ?? 0, nodes, edges };
  })();
  cache.set(cacheKey, promise);
  return promise;
}

/** Active state ids for a state value: `{ ready: "idle" }` → `ready`, `ready.idle`. */
export function activeIds(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix ? `${prefix}.${value}` : value];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => {
      const id = prefix ? `${prefix}.${k}` : k;
      return [id, ...activeIds(v, id)];
    });
  }
  return [];
}

export const formatValue = (value: unknown): string =>
  typeof value === "string"
    ? value
    : activeIds(value)
        .filter((id, _, all) => !all.some((o) => o.startsWith(`${id}.`)))
        .join(", ");

/**
 * Transitions the journal saw that no drawn edge explains: the diagram has
 * drifted from the machine (usually a computed target in a transition function).
 */
export function missingEdges(chart: Chart, entries: ReadonlyArray<{ event: { type: string }; from: unknown; to: unknown }>, prefix = "") {
  const missing = new Map<string, string>();
  for (const e of entries) {
    if (e.from === null || e.event.type.startsWith("xstate.")) continue;
    const from = new Set(activeIds(e.from).map((id) => prefix + id));
    const to = new Set(activeIds(e.to).map((id) => prefix + id));
    const entered = [...to].filter((id) => !from.has(id));
    if (!entered.length) continue;
    const explained = chart.edges.some(
      (edge) => edge.labels.includes(e.event.type) && (to.has(edge.target) || chart.nodes.some((n) => n.id === edge.target && n.kind === "choice")),
    );
    if (!explained) missing.set(`${e.event.type}:${entered.join(",")}`, `${e.event.type} → ${formatValue(e.to)}`);
  }
  return [...missing.values()];
}
