import { Button } from "@cloudflare/kumo";
import { ArrowsOutIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ActorView, JournalEntry } from "durable-machines/protocol";
import { activeIds, layoutSystem, type Chart, type ChartEdge, type SystemPart, type SystemWire } from "./graph";
import { ChartSvg, type Box } from "./Statechart";
import { useAllViews, useClock, useSelectedBuilds, type Point } from "./store";
import { entryAt, stateAt } from "./timeline";
import type { ProjectContext, ProjectRecord } from "./types";
import { objectPurpose } from "./ui";

const HOT_MS = 2500;

/** The map part an address belongs to: "installation", "account", a project id, "worker" or "workflow". */
export function partOf(address: string, accountId: string) {
  if (address === "webhook") return "worker";
  if (address === "BuildWorkflow" || address.startsWith("BuildWorkflow/")) return "workflow";
  const [cls, name] = address.split("/");
  if (cls === "Installation") return "installation";
  if (cls === "Account") return name === accountId ? "account" : undefined;
  if (cls === "Project") return name;
  return undefined;
}

/**
 * Every machine in one picture: each Durable Object is a box with its own
 * statechart, the build machine sits inside the Project that spawns it, and
 * blue wires are the messages the outbox delivers between objects.
 *
 * `only` draws one object. `point` draws the system as it was right after that
 * journal entry, lighting only what that entry did. `zoomTo` zooms to some parts.
 */
export function SystemMap({
  accountId,
  installationId,
  projects,
  only,
  point,
  zoomTo,
  onSelect,
  onBackground,
}: {
  accountId: string;
  installationId: string;
  projects: ProjectRecord[];
  only?: string;
  point?: Point;
  zoomTo?: string[];
  /** Clicked a state or a part: its node id. */
  onSelect?: (nodeId: string) => void;
  onBackground?: () => void;
}) {
  const views = new Map(useAllViews());
  const installation = views.get(`Installation/${installationId}`);
  const account = views.get(`Account/${accountId}`);
  const projectViews = projects.map((p) => [p, views.get(`Project/${p.id}`)] as const);
  const ready = installation && account && projectViews.every(([, v]) => v);
  const [chart, setChart] = useState<Chart>();
  const clock = useClock();
  const selectedBuilds = useSelectedBuilds();
  const [now, setNow] = useState(Date.now());

  // Only machines that took part in this run appear: an object once it handled an
  // event, the build machine once a build was spawned, the Workflow once one was created.
  const took = (v: typeof installation) =>
    Boolean(v?.journal.some((e) => e.kind !== "restored" && e.kind !== "unhandled" && !e.event.type.startsWith("xstate.")));
  const spawned = (v: typeof installation) => Boolean(v && (v.children.length || v.journal.some((e) => e.actor !== v.machineId)));
  const present = new Set<string>();
  if (took(installation)) present.add("installation");
  if (took(account)) present.add("account");
  for (const [p, v] of projectViews) {
    if (took(v) || only === p.id) present.add(p.id);
    if (spawned(v)) present.add(`${p.id}:build`);
  }
  if (only === "installation" || only === "account") present.add(only);
  // A hop on its way, or waiting for Next, brings its receiver in, so its wire has somewhere to go.
  for (const address of [...clock.parked.map((p) => p.to), ...[...views.values()].flatMap((v) => v.outbox.map((o) => o.to))]) {
    const to = partOf(address, accountId);
    if (to && to !== "workflow") present.add(to);
  }
  if (present.size) present.add("worker");
  if (
    account?.journal.some((e) => e.event.type.startsWith("xstate.done.actor") && JSON.stringify(e.from).includes("dispatching")) ||
    clock.parked.some((p) => p.to === "BuildWorkflow") ||
    projectViews.some(([, v]) => v?.journal.some((e) => e.source.startsWith("BuildWorkflow")))
  )
    present.add("workflow");
  const presentKey = [...present].sort().join(",");

  const key = `${accountId}:${projects.map((p) => p.id).join(",")}:${only ?? "all"}:${presentKey}`;
  useEffect(() => {
    if (!ready) return;
    let parts: SystemPart[] = [
      { id: "worker", title: "Webhook Worker", subtitle: "Verifies and decodes webhooks" },
      {
        id: "installation",
        title: `Installation/${installationId}`,
        subtitle: objectPurpose("Installation")!,
        definition: installation.definitions.installation,
        direction: "RIGHT",
      },
      { id: "account", title: `Account/${accountId}`, subtitle: objectPurpose("Account")!, definition: account.definitions.account },
      ...projectViews.map(([p, v]) => ({
        id: p.id,
        title: `Project/${p.id}`,
        subtitle: `${objectPurpose("Project")} · ${p.repo}`,
        definition: v!.definitions.project,
        children: present.has(`${p.id}:build`)
          ? [
              {
                id: `${p.id}:build`,
                title: "Build machine",
                subtitle: "A child actor of the Project, one per build",
                definition: v!.definitions.build,
                direction: "RIGHT" as const,
              },
            ]
          : [],
      })),
      { id: "workflow", title: "BuildWorkflow", subtitle: "Runs the steps" },
    ];
    let wires: SystemWire[] = [
      { source: "worker", target: "installation", events: ["scm.event"] },
      { source: "installation", target: "account", events: ["scm.event"] },
      { source: "account", target: "workflow", events: ["create()"] },
      ...projects.flatMap((p) => [
        { source: "account", target: p.id, events: ["scm.event", "build.start"] },
        { source: p.id, target: "account", events: ["build.requested", "build.finished"] },
        { source: "workflow", target: p.id, events: ["build.step", "build.completed"] },
      ]),
    ];
    parts = parts.filter((p) => (only ? p.id === only : present.has(p.id)));
    wires = only ? [] : wires.filter((w) => present.has(w.source) && present.has(w.target));
    if (!parts.length) return setChart({ width: 0, height: 0, nodes: [], edges: [] } as unknown as Chart);
    let live = true;
    layoutSystem(key, parts, wires, "DOWN").then((laid) => live && setChart(laid));
    return () => {
      live = false;
    };
    // Definitions never change after connect; the key covers the topology.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, Boolean(ready)]);

  const entries = useMemo(() => {
    const all: Array<{ owner: string; entry: JournalEntry }> = [];
    for (const [k, v] of views) for (const entry of v.journal) all.push({ owner: k, entry });
    return all;
  }, [views]);
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
  if (!chart.nodes.length)
    return (
      <div className="grid h-full min-h-60 place-items-center text-sm text-kumo-subtle">
        No machine has run yet. Machines appear here as the scenario reaches them.
      </div>
    );

  const part = (address: string) => partOf(address, accountId);
  const pointEntry = point ? entryAt(views.get(point.owner), point) : undefined;

  // Active states as of the point (or now), prefixed by the part that owns them.
  const active = new Set<string>();
  const add = (prefix: string, value: unknown) => activeIds(value).forEach((id) => active.add(`${prefix}/${id}`));
  const done = new Set<string>();
  add("installation", stateAt(`Installation/${installationId}`, installation, point).root.value);
  add("account", stateAt(`Account/${accountId}`, account, point).root.value);
  for (const [p, v] of projectViews) {
    const owner = `Project/${p.id}`;
    const state = stateAt(owner, v!, point);
    add(p.id, state.root.value);
    const ctx = state.root.context as unknown as ProjectContext;
    const pick = (id: string | undefined) => (id ? state.children.find((c) => c.id === id) : undefined);
    const child: ActorView | undefined =
      (point?.owner === owner && pointEntry && pick(pointEntry.actor)) ||
      pick(selectedBuilds[p.id]) ||
      pick(ctx.active.at(-1)?.buildId) ||
      state.children.at(-1);
    // At a build's own event, show where that event took it. A build that reached a final
    // state is gone from the snapshot, so its value comes from the entry.
    const atBuild = point?.owner === owner && pointEntry?.kind === "transition" && pointEntry.actor !== v!.machineId ? pointEntry : undefined;
    if (atBuild) {
      add(`${p.id}:build`, atBuild.to);
      if (!pick(atBuild.actor) || pick(atBuild.actor)?.status === "done") done.add(`${p.id}:build`);
    } else {
      if (child) add(`${p.id}:build`, child.value);
      if (child?.status === "done") done.add(`${p.id}:build`);
    }
  }

  // What happened: at a point, only that entry; live, the last few seconds.
  const recent = point ? (pointEntry ? [{ owner: point.owner, entry: pointEntry }] : []) : entries.filter((e) => now - e.entry.at < HOT_MS);
  const hotInner = new Set<string>();
  const hotWire = new Set<string>();
  for (const { owner, entry } of recent) {
    const ownerPart = part(owner);
    if (!ownerPart) continue;
    if (entry.kind === "transition") {
      const isBuild = owner.startsWith("Project/") && entry.actor !== "project";
      hotInner.add(`${isBuild ? `${ownerPart}:build` : ownerPart}|${entry.event.type}`);
      const from = part(entry.source);
      if (from && from !== ownerPart) hotWire.add(`${from}→${ownerPart}|${entry.event.type}`);
    }
    if (entry.kind === "delivered" && entry.target) {
      const to = part(entry.target);
      if (to) hotWire.add(`${ownerPart}→${to}|${entry.event.type}`);
    }
    if (entry.kind === "transition" && entry.event.type === "xstate.done.actor" && ownerPart === "account") hotWire.add("account→workflow|create()");
  }
  // Live only. Messages on their way move along their wire; hops parked by the paused clock wait, still.
  const inFlight = new Map<string, "moving" | "waiting">();
  if (!point) {
    const mark = (key: string, state: "moving" | "waiting") => inFlight.get(key) !== "moving" && inFlight.set(key, state);
    const parkedTokens = new Set(clock.parked.map((p) => p.token));
    for (const [owner, v] of views) {
      const from = part(owner);
      for (const item of v.outbox) {
        const to = part(item.to);
        if (from && to) mark(`${from}→${to}|${item.event.type}`, parkedTokens.has(item.id) ? "waiting" : "moving");
      }
    }
    for (const item of clock.parked) {
      const from = part(item.owner);
      const to = part(item.to);
      if (from && to && !item.token.startsWith("msg:")) mark(`${from}→${to}|${item.eventType}`, "waiting");
    }
  }
  const partFor = (id: string) => (id.startsWith("part:") ? id.slice(5) : id.slice(0, id.indexOf("/")));
  const wireKey = (edge: ChartEdge, text: string) => `${partFor(edge.source)}→${partFor(edge.target)}|${text}`;
  const hot = (edge: ChartEdge, text: string) =>
    edge.wire ? hotWire.has(wireKey(edge, text)) : hotInner.has(`${partFor(edge.source)}|${text}`) && active.has(edge.target);
  const pending = (edge: ChartEdge, text: string) => (edge.wire && inFlight.get(wireKey(edge, text))) || false;

  // Zoom targets: a part id ("account"), a state node id ("free-web:build/running.building"),
  // a wire ("wire:account→free-web") or a transition label ("edge:free-web:build|build.step").
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
    <ZoomFrame chart={chart} target={target} focusKey={`${key}|${zoomTo?.join(",") ?? ""}`} onBackground={onBackground}>
      {(view) => (
        <ChartSvg
          chart={chart}
          label={only ? `Statechart for ${only}` : "System statechart"}
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

const PAD = 24;

const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** Most the frame magnifies when it zooms to a part. */
const MAX_SCALE = 1.1;
/** At 1×, state names are 12px and transition labels 10px, about the size of the events list. */
const READABLE_SCALE = 1;
const TWEEN_MS = 900;

const scaleOf = (view: Box, size: { width: number }) => size.width / view.width;

/**
 * Grow `box` by a margin, to the frame's aspect ratio, centred. A zoom target
 * is magnified between READABLE_SCALE and MAX_SCALE, even if that crops it.
 */
function framed(box: Box, size: { width: number; height: number }, readable = false): Box {
  const b = { x: box.x - PAD, y: box.y - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 };
  const aspect = size.width / Math.max(1, size.height);
  let width = Math.max(b.width, b.height * aspect);
  if (readable) width = Math.min(Math.max(width, size.width / MAX_SCALE), size.width / READABLE_SCALE);
  const height = width / aspect;
  return { x: b.x + b.width / 2 - width / 2, y: b.y + b.height / 2 - height / 2, width, height };
}

/**
 * Fills its parent. Animates to `target` (or the whole chart) when the focus
 * changes. Scroll to zoom, drag to pan.
 */
function ZoomFrame({
  chart,
  target,
  focusKey,
  onBackground,
  children,
}: {
  chart: Chart;
  target?: Box;
  focusKey: string;
  onBackground?: () => void;
  children: (view: Box) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [goal, setGoal] = useState<{ box: Box; instant: boolean }>();
  const [shown, setShown] = useState<Box>();
  const shownRef = useRef<Box>(undefined);
  shownRef.current = shown;
  const drag = useRef<{ x: number; y: number; box: Box; moved: boolean }>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const whole = { x: 0, y: 0, width: chart.width, height: chart.height };

  // A new layout (machines appeared) or a new frame size: frame the focus afresh.
  useEffect(() => {
    setGoal({ box: target ? framed(target, size, true) : framed(whole, size), instant: !shownRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, size.width, size.height]);

  // A new focus: move only if it isn't already in view and readable.
  useEffect(() => {
    const current = shownRef.current;
    if (current && target && contains(current, target) && scaleOf(current, size) >= READABLE_SCALE) return;
    setGoal({ box: target ? framed(target, size, true) : framed(whole, size), instant: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const setManual = (box: Box) => setGoal({ box, instant: true });

  // Tween the shown box toward the goal.
  const goalKey = goal ? `${goal.box.x}|${goal.box.y}|${goal.box.width}|${goal.box.height}` : "";
  useEffect(() => {
    if (!goal) return;
    const from = shownRef.current;
    if (goal.instant || !from) return setShown(goal.box);
    const to = goal.box;
    const start = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / TWEEN_MS);
      // Ease in and out.
      const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      setShown({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        width: from.width + (to.width - from.width) * e,
        height: from.height + (to.height - from.height) * e,
      });
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalKey]);

  const view = shown ?? goal?.box ?? framed(whole, size);
  const zoom = (factor: number, cx = size.width / 2, cy = size.height / 2) => {
    const px = view.x + (cx / size.width) * view.width;
    const py = view.y + (cy / size.height) * view.height;
    const width = Math.min(chart.width * 4, Math.max(120, view.width * factor));
    const height = width * (view.height / view.width);
    setManual({ x: px - (cx / size.width) * width, y: py - (cy / size.height) * height, width, height });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoom(Math.exp(e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, box: view, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const k = d.box.width / size.width;
    setManual({ ...d.box, x: d.box.x - dx * k, y: d.box.y - dy * k });
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[radial-gradient(circle_at_1px_1px,var(--color-kumo-line)_1px,transparent_0)] [background-size:16px_16px]">
      <div
        ref={ref}
        className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setTimeout(() => (drag.current = undefined))}
        onPointerLeave={() => (drag.current = undefined)}
        onClickCapture={(e) => drag.current?.moved && e.stopPropagation()}
        onClick={(e) => (e.target === e.currentTarget || (e.target as Element).tagName === "svg" ? onBackground?.() : undefined)}
      >
        {children(view)}
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1 rounded-lg bg-kumo-base/90 p-0.5 shadow-xs ring ring-kumo-line">
        <Button variant="ghost" shape="square" size="sm" icon={MagnifyingGlassPlusIcon} aria-label="Zoom in" onClick={() => zoom(1 / 1.4)} />
        <Button variant="ghost" shape="square" size="sm" icon={MagnifyingGlassMinusIcon} aria-label="Zoom out" onClick={() => zoom(1.4)} />
        <Button variant="ghost" shape="square" size="sm" icon={ArrowsOutIcon} aria-label="Fit" onClick={() => setManual(framed(whole, size))} />
      </div>
    </div>
  );
}
