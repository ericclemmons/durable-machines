import { Badge, Button, Loader, Text } from "@cloudflare/kumo";
import { ArrowDownIcon, HourglassIcon, PauseCircleIcon, PushPinIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { JournalEntry, MachineView } from "durable-machines/protocol";
import { definitionOf, eventLabel, formatValue } from "./graph";
import { setPinned, setSelectedNode, startBefore, useAllViews, useClock, useInFlight, usePinned, useSending, useViewsVersion, type Busy } from "./store";
import { compareEntries } from "./timeline";
import { JsonView, ObjectLabel } from "./ui";

// Only problems get colour; everything else is a quiet label.
const KIND: Record<JournalEntry["kind"], { text: string; className: string }> = {
  transition: { text: "", className: "" },
  restored: { text: "restored", className: "text-kumo-subtle" },
  unhandled: { text: "unhandled", className: "text-kumo-subtle" },
  rejected: { text: "rejected", className: "text-kumo-danger" },
  sent: { text: "sent", className: "text-sky-700" },
  duplicate: { text: "duplicate", className: "text-purple-700" },
  retrying: { text: "retrying", className: "text-kumo-warning" },
  "dead-letter": { text: "dead letter", className: "text-kumo-danger font-medium" },
};

/**
 * A transition as short lines: one per parallel region that changed, with the
 * shared path written once ("installed.active: no_token → token_valid").
 * A transition that stays put shows the state it stays in.
 */
function changeLines(from: unknown, to: unknown): string[] {
  const before = formatValue(from).split(", ").filter(Boolean);
  const after = formatValue(to).split(", ").filter(Boolean);
  const region = (path: string) => {
    const [head = ""] = path.split(".");
    return before.length > 1 || after.length > 1 ? head : "";
  };
  const regions = [...new Set([...before, ...after].map(region))];
  const lines = regions.flatMap((r) => {
    const a = before.find((p) => region(p) === r);
    const b = after.find((p) => region(p) === r);
    if (a === b) return [];
    if (!a || !b) return [`${a ?? "∅"} → ${b ?? "∅"}`];
    const x = a.split(".");
    const y = b.split(".");
    let common = 0;
    while (common < Math.min(x.length, y.length) - 1 && x[common] === y[common]) common++;
    const prefix = common ? `${x.slice(0, common).join(".")}: ` : "";
    return [`${prefix}${x.slice(common).join(".")} → ${y.slice(common).join(".")}`];
  });
  return lines.length ? lines : after;
}

/** Something still running inside an object, listed below the newest event: a build's steps, say. */
export type Running = { key: string; owner: string; actor?: string; value: unknown };

export type EventPanelProps = {
  header?: ReactNode;
  footer?: ReactNode;
  /** What to say before the first event. */
  emptyText?: string;
  /** A child actor's name on a row, after its object ("build #3"). */
  actorLabel?: (actor: string) => string;
  /** What's still running, listed with the messages on their way. */
  running?: (views: Array<[string, MachineView]>) => Running[];
  /** Views still working beyond their outbox, for the status line. */
  busy?: Busy;
  /** The status line while the app is sending (`setSending(true)`). */
  sendingText?: string;
};

/**
 * Every object's journal, merged into one log, oldest first, kept scrolled to
 * the newest, with a Start row before the first event. Below the newest event is
 * what's still to come: what's running, messages on their way and hops waiting
 * for the next press of play. Click an event to see the system as it was right
 * after it: the canvas zooms to it, the dock shows what changed in the object's
 * state, and the row shows the event's payload. ↑ and ↓ step through the events.
 * Click it again to go back to live. Every entry shows; there are no filters.
 */
export function EventPanel({
  header,
  footer,
  emptyText = "No events yet.",
  actorLabel = (actor) => actor,
  running,
  busy,
  sendingText = "Sending…",
}: EventPanelProps) {
  const views = useAllViews();
  const version = useViewsVersion();
  const clock = useClock();
  const pinned = usePinned();
  const list = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const { rows, skipped, start, byOwner } = useMemo(() => {
    const all = views
      .flatMap(([owner, v]) => v.journal.map((entry) => ({ owner, root: v.machineId, entry })))
      .sort((a, b) => compareEntries(a.owner, a.entry, b.owner, b.entry));
    // The start: just before the first entry.
    const [first] = all;
    return {
      rows: all.slice(-300),
      skipped: Math.max(0, all.length - 300),
      start: first && startBefore({ owner: first.owner, seq: first.entry.seq, at: first.entry.at }),
      byOwner: new Map(views),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const atStart = Boolean(pinned?.next);

  // Row -1 is the start.
  const pin = (i: number) => {
    const row = rows[i];
    if (i === -1 && start) setPinned(start);
    else if (row) setPinned({ owner: row.owner, seq: row.entry.seq, at: row.entry.at });
    else return;
    setSelectedNode(undefined);
    const button = list.current?.querySelector<HTMLButtonElement>(`[data-row="${i}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  // ↑/↓: the previous or next event.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const current = atStart ? -1 : pinned ? rows.findIndex((r) => r.owner === pinned.owner && r.entry.seq === pinned.seq) : -2;
    if (current === -2) return pin(e.key === "ArrowUp" ? rows.length - 1 : start ? -1 : 0);
    pin(Math.max(start ? -1 : 0, Math.min(rows.length - 1, current + (e.key === "ArrowUp" ? -1 : 1))));
  };

  // Stay at the bottom, where the newest event and what's next are, unless you scrolled up to read.
  // New rows slide in and the list scrolls up smoothly. Scrolled up, a button counts the new ones.
  const [unseen, setUnseen] = useState(0);
  const seen = useRef(rows.length);
  const toBottom = () => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  useLayoutEffect(() => {
    const added = rows.length - seen.current;
    seen.current = rows.length;
    if (atBottom.current) toBottom();
    else if (added > 0) setUnseen((n) => n + added);
  }, [rows.length, clock.parked.length]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col whitespace-normal">
      {header}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ol
          ref={list}
          onKeyDown={onKeyDown}
          aria-label="Events. Use the up and down arrow keys to move between them."
          className="flex min-h-0 flex-1 flex-col overflow-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (atBottom.current) setUnseen(0);
          }}
        >
          {rows.length === 0 && (
            <li className="px-4 py-3">
              <Text variant="secondary">{emptyText}</Text>
            </li>
          )}
          {start && rows.length > 0 && skipped === 0 && (
            <li className={`border-b border-kumo-hairline ${atStart ? "bg-purple-500/5" : ""}`}>
              <button
                data-row={-1}
                onClick={() => setPinned(atStart ? undefined : start)}
                aria-pressed={atStart}
                className="flex w-full items-start gap-3 px-4 py-2 text-left text-sm hover:bg-kumo-tint"
              >
                <Step n={0} />
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="flex h-5 items-center gap-1.5 leading-none">
                    Start
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      {atStart && <PushPinIcon aria-label="Pinned" className="text-purple-600" weight="fill" />}
                    </span>
                  </span>
                  <span className="text-xs text-kumo-subtle">Every object as it was before the first event</span>
                </span>
              </button>
            </li>
          )}
          {rows.map(({ owner, root, entry: e }, i) => {
            const id = `${owner}#${e.seq}`;
            const point = { owner, seq: e.seq, at: e.at };
            const isPinned = !atStart && pinned?.owner === owner && pinned.seq === e.seq;
            const kind = KIND[e.kind] ?? { text: e.kind, className: "text-kumo-subtle" };
            const { type: _, ...payload } = e.event;
            return (
              <li key={id} className={`event-enter border-b border-kumo-hairline ${isPinned ? "bg-purple-500/5" : ""}`}>
                <button
                  data-row={i}
                  onClick={() => {
                    setPinned(isPinned ? undefined : point);
                    if (!isPinned) setSelectedNode(undefined);
                  }}
                  aria-pressed={isPinned}
                  title={new Date(e.at).toLocaleTimeString([], { hour12: false })}
                  className="flex w-full items-start gap-3 px-4 py-2 text-left text-sm hover:bg-kumo-tint"
                >
                  <Step n={skipped + i + 1} />
                  <span className="grid min-w-0 flex-1 gap-1">
                    <Line
                      owner={owner}
                      actor={e.actor !== root ? actorLabel(e.actor) : undefined}
                      type={eventLabel(e.event, definitionOf(byOwner.get(owner), e.actor))}
                      pinned={isPinned}
                    />
                    <span className="flex min-w-0 items-start gap-1.5 text-xs text-kumo-subtle">
                      {kind.text && <span className={`shrink-0 ${kind.className}`}>{kind.text}</span>}
                      {e.kind === "transition" ? (
                        <span className="grid min-w-0">
                          {changeLines(e.from, e.to).map((line) => (
                            <code key={line} className="truncate font-mono" title={line}>
                              {line}
                            </code>
                          ))}
                        </span>
                      ) : e.target ? (
                        <span className="flex min-w-0 items-center gap-1">
                          → <ObjectLabel address={e.target} />
                        </span>
                      ) : null}
                      {e.detail && <span className="truncate">{e.detail}</span>}
                    </span>
                    {isPinned && (Object.keys(payload).length > 0 || e.source !== "external") && (
                      <span className="grid gap-0.5 rounded-md bg-kumo-recessed px-2 py-1.5">
                        {e.source !== "external" && <span className="font-mono text-[11px] text-kumo-subtle">from {e.source}</span>}
                        {Object.keys(payload).length > 0 && <JsonView value={payload} className="max-h-48" />}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          <Upcoming running={running} actorLabel={actorLabel} />
        </ol>
        {unseen > 0 && (
          <Button variant="primary" size="sm" icon={ArrowDownIcon} onClick={toBottom} className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-md">
            {unseen} new {unseen === 1 ? "event" : "events"}
          </Button>
        )}
      </div>
      <Status busy={busy} sendingText={sendingText} />
      {footer}
    </section>
  );
}

/** The event's place in the run, in a narrow column on the left. */
function Step({ n }: { n: number }) {
  return <span className="flex h-5 w-6 shrink-0 items-center justify-end font-mono text-xs leading-none tabular-nums text-kumo-inactive">{n}</span>;
}

/** First line of a row: who, then the event type on the right. */
function Line({ owner, actor, type, pinned }: { owner: string; actor?: string; type?: string; pinned?: boolean }) {
  return (
    <span className="flex h-5 min-w-0 items-center gap-1.5 leading-none">
      <ObjectLabel address={owner} className="min-w-0" />
      {actor && <span className="shrink-0 truncate text-kumo-subtle">› {actor}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {pinned && <PushPinIcon aria-label="Pinned" className="text-purple-600" weight="fill" />}
        {type && (
          <Badge variant="secondary">
            <span className="font-mono text-[11px] font-normal">{type}</span>
          </Badge>
        )}
      </span>
    </span>
  );
}

/** Whether the system is still working, in one line. Nothing moving: no line at all. */
function Status({ busy, sendingText }: { busy?: Busy; sendingText: string }) {
  const clock = useClock();
  const inFlight = useInFlight(busy);
  const sending = useSending();
  const [head] = clock.parked;
  const [icon, text]: [ReactNode?, string?] = sending
    ? [<Loader size="sm" />, sendingText]
    : head && !clock.playing
      ? [<PauseCircleIcon className="text-kumo-brand" size={16} weight="fill" />, `Paused · ${clock.parked.length} waiting. Press ▶ to go on.`]
      : inFlight
        ? [<Loader size="sm" />, clock.playing ? "Playing…" : "Working…"]
        : [];
  if (!icon) return null;
  return (
    <div className="flex items-center gap-2 border-t border-kumo-line bg-kumo-elevated px-4 py-2 text-xs text-kumo-default" aria-live="polite">
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      {text}
    </div>
  );
}

/** What is still to come, below the newest event: what's running, messages on their way, then hops waiting, the next one first. */
function Upcoming({ running, actorLabel }: { running: EventPanelProps["running"]; actorLabel: (actor: string) => string }) {
  const views = useAllViews();
  const clock = useClock();
  const parkedTokens = new Set(clock.parked.map((p) => p.token));
  const moving = views.flatMap(([owner, v]) => v.outbox.filter((o) => !parkedTokens.has(o.id)).map((o) => ({ owner, item: o })));
  return (
    <>
      {moving.map(({ owner, item }) => (
        <li key={`${owner}|${item.id}`} className="border-b border-dashed border-kumo-line">
          <div className="grid gap-0.5 py-2 pr-4 pl-13 text-sm">
            <Line owner={owner} type={item.event.type} />
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
              <Loader size={12} />
              <span>on its way →</span>
              <ObjectLabel address={item.to} />
              {item.attempts > 0 && <span className="text-kumo-warning">attempt {item.attempts + 1}</span>}
            </span>
          </div>
        </li>
      ))}
      {(running?.(views) ?? []).map((r) => (
        <li key={r.key} className="border-b border-dashed border-kumo-line">
          <div className="grid gap-0.5 py-2 pr-4 pl-13 text-sm">
            <Line owner={r.owner} actor={r.actor && actorLabel(r.actor)} />
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
              {clock.playing ? <Loader size={12} /> : <HourglassIcon aria-hidden />}
              <code className="font-mono">{formatValue(r.value)}</code>
            </span>
          </div>
        </li>
      ))}
      {clock.parked.map((p, i) => {
        const next = i === 0;
        return (
          <li key={`${p.owner}|${p.token}`} className={`border-b border-dashed border-kumo-line ${next ? "bg-kumo-brand/5" : "opacity-70"}`}>
            <div className="grid gap-0.5 py-2 pr-4 pl-13 text-sm">
              <Line owner={p.owner} type={p.eventType} />
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
                {next ? <span className="font-medium text-kumo-brand">Next</span> : <HourglassIcon aria-label="Waiting" />}
                <span>→</span>
                <ObjectLabel address={p.to} />
              </span>
            </div>
          </li>
        );
      })}
    </>
  );
}
