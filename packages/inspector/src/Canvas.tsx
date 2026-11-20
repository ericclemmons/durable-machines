import { Badge, Button, Text, Tooltip } from "@cloudflare/kumo";
import { CodeHighlighted } from "@cloudflare/kumo/code";
import { CaretDownIcon, CaretUpIcon, InfoIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { definitionOf, eventLabel, isInternalEntry } from "./graph";
import { setPinned, setSelectedNode, snapshotBefore, useAllViews, useInspected, usePinned, useSelectedNode, type Point, type Snapshot } from "./store";
import { focusOf, SystemMap } from "./SystemMap";
import { entryAt, existedAt, stateAt } from "./timeline";
import { JsonDiff, ObjectLabel } from "./ui";

/** The part a diagram node id belongs to: "part:account" and "account/active" are both "account". */
export const partOfNode = (id: string) => (id.startsWith("part:") ? id.slice(5) : id.slice(0, id.indexOf("/")));

type MapProps = Omit<ComponentProps<typeof SystemMap>, "point" | "zoomTo" | "onSelect" | "onBackground">;

/**
 * The system map, as of the event you clicked or live, with what it shows in a
 * badge and a dock below it. The canvas frames the clicked event (at the start,
 * the first one, so stepping to it animates in place), else the node you clicked,
 * else the whole system: it refits as machines appear.
 */
export function Canvas({ dock, ...map }: MapProps & { dock?: ReactNode }) {
  const views = new Map(useAllViews());
  const inspected = useInspected();
  const pinned = usePinned();
  const selected = useSelectedNode();
  const focus = inspected ? focusOf(views, inspected.next ?? inspected, map.partOf, map.actorPart) : selected ? [selected] : undefined;
  const at = inspected && !inspected.next ? entryAt(views.get(inspected.owner), inspected) : undefined;

  return (
    <section className="flex h-screen min-h-0 min-w-0 flex-1 flex-col bg-kumo-base">
      <div className="relative min-h-0 flex-1">
        <SystemMap {...map} point={inspected} zoomTo={focus} onSelect={setSelectedNode} onBackground={() => setSelectedNode(undefined)} />
        {inspected && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg bg-kumo-base/95 px-2 py-1 text-sm shadow-xs ring ring-kumo-line">
            <Badge variant="purple">As of {new Date(inspected.at).toLocaleTimeString([], { hour12: false })}</Badge>
            {inspected.next ? (
              <span>Before the first event</span>
            ) : (
              <>
                <ObjectLabel address={inspected.owner} />
                <code className="font-mono text-[0.9em] text-kumo-strong">{at && eventLabel(at.event, definitionOf(views.get(inspected.owner), at.actor))}</code>
              </>
            )}
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
      {dock}
    </section>
  );
}

/**
 * The object the dock shows: the one whose node you clicked, else the one whose event
 * you clicked, else the newest event's, else `fallback`. `ownerOfPart` maps a part id to its object.
 */
export function useDockOwner(ownerOfPart: (part: string) => string | undefined, fallback: string) {
  const views = new Map(useAllViews());
  const inspected = useInspected();
  const selected = useSelectedNode();
  let latest: { owner: string; at: number } | undefined;
  for (const [owner, v] of views) {
    const last = v.journal.findLast((e) => !isInternalEntry(e));
    if (last && (!latest || last.at > latest.at)) latest = { owner, at: last.at };
  }
  const known = (owner: string | undefined) => (owner && views.has(owner) ? owner : undefined);
  return known(selected && ownerOfPart(partOfNode(selected))) ?? known(inspected?.owner) ?? known(latest?.owner) ?? fallback;
}

const DOCK_MIN = 120;

export type DockSection = { label: ReactNode; actions?: ReactNode; body: ReactNode; grow?: number };

/** Below the canvas, like a terminal: sections side by side. Drag its top edge to resize. */
export function Dock({ sections }: { sections: DockSection[] }) {
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
      <div className="flex min-h-0 flex-1">
        {sections.map((s, i) => (
          <section key={i} className={`flex min-h-0 min-w-0 flex-col ${i > 0 ? "border-l border-kumo-line" : ""}`} style={{ flex: s.grow ?? 1 }}>
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-kumo-line px-2">
              {i === 0 && (
                <Button
                  variant="ghost"
                  shape="square"
                  size="xs"
                  icon={open ? CaretDownIcon : CaretUpIcon}
                  aria-label={open ? "Hide the dock" : "Show the dock"}
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                />
              )}
              {s.label}
              {s.actions && <span className="ml-auto flex min-w-0 items-center gap-2">{s.actions}</span>}
            </div>
            {open && <div className="min-h-0 flex-1 overflow-auto">{s.body}</div>}
          </section>
        ))}
      </div>
    </div>
  );
}

/** An object's state, live or as of a point, with the state just before the event it shows to diff against. */
export function useObjectState(owner: string, point: Point | undefined, extra?: (snapshot: Snapshot) => Record<string, unknown>) {
  const views = new Map(useAllViews());
  const view = views.get(owner);
  if (!view) return { value: undefined, json: {}, before: undefined, exact: true, missing: false };
  if (!existedAt(owner, view, point)) return { value: undefined, json: {}, before: undefined, exact: true, missing: true };
  const state = stateAt(owner, view, point);
  const pointEntry = point?.owner === owner && !point.next ? entryAt(view, point) : undefined;
  const jsonOf = (snap: Snapshot, live: boolean) => ({
    value: snap.root.value,
    status: snap.root.status,
    context: snap.root.context,
    ...extra?.(snap),
    ...(live && view.outbox.length ? { outbox: view.outbox.map((o) => ({ to: o.to, type: o.event.type, attempts: o.attempts })) } : {}),
  });
  const json = jsonOf(state, !point);
  // At an event of this object: the state just before it, to show what it changed.
  const prior = pointEntry && state.exact ? snapshotBefore(owner, pointEntry.seq) : undefined;
  return { value: state.root.value, json, before: prior ? jsonOf(prior, false) : undefined, exact: state.exact, missing: false };
}

/** The body of a State section: the JSON, or what the event changed in it. */
export function StateBody({ state, children }: { state: ReturnType<typeof useObjectState>; children?: ReactNode }) {
  return (
    <div className="grid content-start gap-2 p-3">
      {children}
      {!state.exact && (
        <Text size="xs" variant="secondary">
          This event is from before the page loaded: state values are as of the event, context is live.
        </Text>
      )}
      {state.missing ? (
        <Text size="sm" variant="secondary">
          Not created yet at this point.
        </Text>
      ) : state.before ? (
        <JsonDiff before={state.before} after={state.json} />
      ) : (
        <div className="text-xs">
          <CodeHighlighted code={JSON.stringify(state.json, null, 2)} lang="json" showCopyButton />
        </div>
      )}
    </div>
  );
}
