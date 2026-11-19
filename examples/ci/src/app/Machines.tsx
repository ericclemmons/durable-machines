import { Badge, Button, Tabs, Text, Tooltip } from "@cloudflare/kumo";
import { CodeHighlighted } from "@cloudflare/kumo/code";
import { CaretDownIcon, CaretUpIcon, InfoIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Deployments } from "./Deployments";
import { activeIds, formatValue } from "./graph";
import {
  sendTo,
  snapshotBefore,
  setDockTab,
  setPinned,
  setSelectedNode,
  useAllViews,
  useClock,
  useDockTab,
  useInspected,
  usePinned,
  useSelectedBuilds,
  useSelectedNode,
  type Point,
  type Snapshot,
} from "./store";
import { partOf, SystemMap } from "./SystemMap";
import { entryAt, stateAt } from "./timeline";
import type { ProjectContext, ProjectRecord } from "./types";
import { highlightJson, Notice, ObjectLabel, type NoticeValue } from "./ui";
import { lineDiff } from "./diff";

/** Ids with no descendant in the list: the active leaf states. */
const leaves = (ids: string[]) => ids.filter((id) => !ids.some((o) => o.startsWith(`${id}.`)));

/** The part a diagram node id belongs to: "part:free-web:build" and "free-web:build/queued" are both "free-web". */
const partOfNode = (id: string) => (id.startsWith("part:") ? id.slice(5) : id.slice(0, id.indexOf("/"))).replace(/:build$/, "");

/**
 * Every machine the run reached, on one canvas, with a dock below it for the
 * Deployments table and an object's state. The view follows the newest event,
 * or the next waiting hop while paused. Hover an event to see the system as
 * it was right after it, and click to pin that moment. Click a state or an
 * object to zoom to it and show its state.
 */
export function Machines({ accountId, installationId, projects }: { accountId: string; installationId: string; projects: ProjectRecord[] }) {
  const views = new Map(useAllViews());
  const inspected = useInspected();
  const pinned = usePinned();
  const selected = useSelectedNode();
  const clock = useClock();

  // Newest event that isn't internal.
  let latest: Point | undefined;
  for (const [owner, v] of views)
    for (const e of v.journal)
      if (!e.event.type.startsWith("xstate.") && e.kind !== "unhandled" && e.kind !== "restored" && (!latest || e.at > latest.at))
        latest = { owner, seq: e.seq, at: e.at };

  const ownerOf = (p: string | undefined) =>
    p === "installation"
      ? `Installation/${installationId}`
      : p === "account"
        ? `Account/${accountId}`
        : p && projects.some((x) => x.id === p)
          ? `Project/${p}`
          : undefined;
  const wire = (from: string, to: string | undefined) => {
    const a = partOf(from, accountId);
    const b = to && partOf(to, accountId);
    return a && b ? [`wire:${a}→${b}`] : undefined;
  };
  // An event's focus: the states its transition left and entered and its label, or the wire a message took.
  const focusOf = (at: Point): string[] | undefined => {
    const view = views.get(at.owner);
    const e = entryAt(view, at);
    if (!e) return undefined;
    if (e.kind === "delivered") return wire(at.owner, e.target);
    const p = partOf(at.owner, accountId);
    if (!p) return undefined;
    const prefix = at.owner.startsWith("Project/") && e.actor !== view?.machineId ? `${p}:build` : p;
    if (e.kind !== "transition") return [prefix];
    const before = leaves(activeIds(e.from));
    const after = leaves(activeIds(e.to));
    const changed = [...after.filter((id) => !before.includes(id)), ...before.filter((id) => !after.includes(id))];
    return [...(changed.length ? changed : after).map((id) => `${prefix}/${id}`), `edge:${prefix}|${e.event.type}`];
  };

  // Most specific first: the event you hover or pinned, the node you clicked, the next waiting hop, the newest event.
  const [head] = clock.parked;
  const focus = inspected ? focusOf(inspected) : selected ? [selected] : head ? wire(head.owner, head.to) : latest && focusOf(latest);

  // The state the dock shows: the object you clicked, else the one whose event you hover, else the newest event's.
  const known = (owner: string | undefined) => (owner && views.has(owner) ? owner : undefined);
  const owner = known(selected && ownerOf(partOfNode(selected))) ?? known(inspected?.owner) ?? known(latest?.owner) ?? `Installation/${installationId}`;
  const at = inspected ? entryAt(views.get(inspected.owner), inspected) : undefined;

  return (
    <section className="flex h-screen min-h-0 min-w-0 flex-1 flex-col bg-kumo-base">
      <div className="relative min-h-0 flex-1">
        <SystemMap
          accountId={accountId}
          installationId={installationId}
          projects={projects}
          point={inspected}
          zoomTo={focus}
          onSelect={(id) => {
            setSelectedNode(id);
            setDockTab("state");
          }}
          onBackground={() => setSelectedNode(undefined)}
        />
        {inspected && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg bg-kumo-base/95 px-2 py-1 text-sm shadow-xs ring ring-kumo-line">
            <Badge variant="purple">As of {new Date(inspected.at).toLocaleTimeString([], { hour12: false })}</Badge>
            <ObjectLabel address={inspected.owner} />
            <code className="font-mono text-[0.9em] text-kumo-strong">{at?.event.type}</code>
            {pinned && (
              <Button variant="ghost" size="xs" onClick={() => setPinned(undefined)}>
                Back to live
              </Button>
            )}
          </div>
        )}
        <div className="absolute bottom-2 left-2 z-10">
          <Tooltip
            content={
              <span>
                <span className="text-orange-300">Orange</span>: active state and the transition just taken. <span className="text-sky-300">Blue</span>:
                messages between objects, animated while on their way, dashed and still while waiting. Click a state to zoom to it; scroll to zoom, drag to pan.
              </span>
            }
            render={<Button variant="secondary" shape="square" size="sm" icon={InfoIcon} aria-label="How to read the diagram" />}
          />
        </div>
      </div>
      <Dock owner={owner} point={inspected} projects={projects} />
    </section>
  );
}

const DOCK_MIN = 120;

/** Below the canvas, like a terminal: the Deployments table, or an object's state. Drag its top edge to resize. */
function Dock({ owner, point, projects }: { owner: string; point?: Point; projects: ProjectRecord[] }) {
  const tab = useDockTab();
  const [open, setOpen] = useState(() => localStorage.getItem("dock:open") !== "closed");
  const [height, setHeight] = useState(() => Number(localStorage.getItem("dock:height")) || 300);
  useEffect(() => localStorage.setItem("dock:open", open ? "open" : "closed"), [open]);
  useEffect(() => localStorage.setItem("dock:height", String(height)), [height]);
  const drag = useRef<{ y: number; height: number }>(undefined);
  const clamp = (h: number) => Math.round(Math.min(window.innerHeight - 160, Math.max(DOCK_MIN, h)));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, height };
  };
  const onPointerMove = (e: ReactPointerEvent) => drag.current && setHeight(clamp(drag.current.height + drag.current.y - e.clientY));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp") setHeight((h) => clamp(h + 24));
    if (e.key === "ArrowDown") setHeight((h) => clamp(h - 24));
  };

  const state = useObjectState(owner, point);
  const showTab = (value: "deployments" | "state") => {
    setDockTab(value);
    setOpen(true);
  };

  return (
    <div className="relative flex shrink-0 flex-col border-t border-kumo-line bg-kumo-base" style={open ? { height } : undefined}>
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the dock"
          aria-valuenow={height}
          tabIndex={0}
          className="absolute inset-x-0 -top-1.5 z-20 h-3 cursor-row-resize after:absolute after:inset-x-0 after:top-1.5 after:h-0.5 hover:after:bg-kumo-brand focus-visible:after:bg-kumo-brand"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = undefined)}
          onKeyDown={onKeyDown}
        />
      )}
      <div className="flex min-w-0 items-center gap-2 border-b border-kumo-line px-2">
        <Button
          variant="ghost"
          shape="square"
          size="xs"
          icon={open ? CaretDownIcon : CaretUpIcon}
          aria-label={open ? "Hide the dock" : "Show the dock"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        />
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={(v) => showTab(v as "deployments" | "state")}
          tabs={[
            { value: "deployments", label: "Deployments" },
            {
              value: "state",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  State <ObjectLabel address={owner} className="font-normal text-kumo-subtle" />
                </span>
              ),
            },
          ]}
        />
        {tab === "state" && (
          <span className="ml-auto flex min-w-0 items-center gap-2">
            <Badge variant="orange">
              <span className="truncate font-mono text-[0.9em]">{formatValue(state.value)}</span>
            </Badge>
            {state.isProject && (
              <Button variant="secondary-destructive" size="xs" onClick={() => void state.command({ type: "build.approve", buildId: 42 })}>
                Send invalid event
              </Button>
            )}
          </span>
        )}
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === "deployments" ? (
            <Deployments projects={projects} />
          ) : (
            <div className="grid gap-2 p-3">
              <Notice value={state.notice} />
              {!state.exact && (
                <Text size="xs" variant="secondary">
                  This event is from before the page loaded: state values are as of the event, context is live.
                </Text>
              )}
              {state.before ? (
                <JsonDiff before={state.before} after={state.json} />
              ) : (
                <div className="text-xs">
                  <CodeHighlighted code={JSON.stringify(state.json, null, 2)} lang="json" showCopyButton />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** An object's state, live or as of a point, and a way to send it an event. */
function useObjectState(owner: string, point?: Point) {
  const views = new Map(useAllViews());
  const selectedBuilds = useSelectedBuilds();
  const [notice, setNotice] = useState<NoticeValue>();
  useEffect(() => setNotice(undefined), [owner]);
  const view = views.get(owner);
  const command = async (event: { type: string; [k: string]: unknown }) => {
    const result = await sendTo(owner, event);
    setNotice(result.ok ? { ok: true, text: `${event.type} accepted → ${formatValue(result.value)}` } : { ok: false, text: result.error });
  };
  const isProject = owner.startsWith("Project/");
  if (!view) return { value: undefined, json: {}, before: undefined, exact: true, isProject, notice, command };
  const state = stateAt(owner, view, point);
  const ctx = state.root.context as unknown as ProjectContext;
  const pointEntry = point?.owner === owner ? entryAt(view, point) : undefined;
  const build = isProject
    ? (state.children.find((c) => c.id === pointEntry?.actor) ??
      state.children.find((c) => c.id === selectedBuilds[owner.split("/")[1]!]) ??
      state.children.find((c) => c.id === ctx.active?.at(-1)?.buildId) ??
      state.children.at(-1))
    : undefined;
  const buildId = build?.id ?? (pointEntry && pointEntry.actor !== view.machineId ? pointEntry.actor : undefined);
  const jsonOf = (snap: Snapshot, live: boolean) => {
    const child = buildId ? snap.children.find((c) => c.id === buildId) : undefined;
    return {
      value: snap.root.value,
      context: snap.root.context,
      ...(child ? { [`build ${child.id.replace(/^.*-(\d+)$/, "#$1")}`]: { status: child.status, value: child.value, context: child.context } } : {}),
      ...(live && view.outbox.length ? { outbox: view.outbox.map((o) => ({ to: o.to, type: o.event.type, attempts: o.attempts })) } : {}),
    };
  };
  const json = jsonOf(state, !point);
  // At an event of this object: the state just before it, to show what it changed.
  const prior = pointEntry && state.exact ? snapshotBefore(owner, pointEntry.seq) : undefined;
  const before = prior ? jsonOf(prior, false) : undefined;
  return { value: state.root.value, json, before, exact: state.exact, isProject, notice, command };
}

/** The state as JSON, with what the event changed: removed lines in red, added lines in green. Scrolls to the first change. */
function JsonDiff({ before, after }: { before: unknown; after: unknown }) {
  const lines = lineDiff(JSON.stringify(before, null, 2).split("\n"), JSON.stringify(after, null, 2).split("\n"));
  const changed = lines.filter((l) => l.op !== " ").length;
  const first = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(after);
  useEffect(() => first.current?.scrollIntoView({ block: "center", behavior: "smooth" }), [key]);
  let marked = false;
  return (
    <div className="grid gap-1">
      <Text size="xs" variant="secondary">
        {changed
          ? `What this event changed: ${lines.filter((l) => l.op === "-").length} lines removed, ${lines.filter((l) => l.op === "+").length} added.`
          : "This event changed nothing in the state."}
      </Text>
      <pre className="overflow-auto rounded-lg bg-kumo-elevated py-2 font-mono text-xs leading-5 ring ring-kumo-line">
        {lines.map((l, i) => {
          const ref = l.op !== " " && !marked ? ((marked = true), first) : undefined;
          return (
            <div key={i} ref={ref} className={`px-3 ${l.op === "+" ? "bg-emerald-500/15" : l.op === "-" ? "bg-red-500/15 text-kumo-subtle" : ""}`}>
              <span className={`mr-2 inline-block w-3 select-none ${l.op === "+" ? "text-emerald-700" : l.op === "-" ? "text-red-700" : "text-kumo-inactive"}`}>
                {l.op}
              </span>
              {highlightJson(l.text)}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
