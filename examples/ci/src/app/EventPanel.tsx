import { Badge, Loader, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, HourglassIcon, PauseCircleIcon, PushPinIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { JournalEntry } from "durable-machines/protocol";
import { formatValue } from "./graph";
import { setDockTab, setPinned, setSelectedNode, useAllViews, useClock, useInFlight, usePinned, useSending } from "./store";
import { JsonView, ObjectLabel } from "./ui";

// Only problems get colour; everything else is a quiet label.
const KIND: Record<JournalEntry["kind"], { text: string; className: string }> = {
  transition: { text: "", className: "" },
  restored: { text: "restored", className: "text-kumo-subtle" },
  unhandled: { text: "unhandled", className: "text-kumo-subtle" },
  rejected: { text: "rejected", className: "text-kumo-danger" },
  delivered: { text: "sent", className: "text-sky-700" },
  duplicate: { text: "duplicate", className: "text-purple-700" },
  retrying: { text: "retrying", className: "text-kumo-warning" },
  "dead-letter": { text: "dead letter", className: "text-kumo-danger font-medium" },
};

// Internal: xstate.* events, unhandled events and the restore entries written on every wake.
const isInternal = (e: JournalEntry) => e.event.type.startsWith("xstate.") || e.kind === "unhandled" || e.kind === "restored";

const buildLabel = (actor: string) => actor.replace(/^.*-(\d+)$/, "#$1");

/**
 * A transition as short lines: one per parallel region that changed, with the
 * shared path written once ("installed.active: no_token → token_valid").
 * A transition that stays put shows the state it stays in.
 */
function changeLines(from: unknown, to: unknown): string[] {
  const before = formatValue(from).split(", ").filter(Boolean);
  const after = formatValue(to).split(", ").filter(Boolean);
  const region = (path: string) => (before.length > 1 || after.length > 1 ? path.split(".")[0]! : "");
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

/**
 * Every object's journal, merged into one log, oldest first, kept scrolled to
 * the newest. Below the newest event is what's still to come: running builds,
 * messages on their way and hops waiting for the next press of play. Each
 * Click an event to see the system as it was right after it: the canvas zooms
 * to it, the dock shows what changed in the object's state, and the row shows
 * the event's payload. ↑ and ↓ select the previous and next event. Click it again to go back to live.
 * Internal entries are left out here; DevTools → Console has everything.
 */
export function EventPanel({ header, footer }: { header: ReactNode; footer: ReactNode }) {
  const views = useAllViews();
  const clock = useClock();
  const pinned = usePinned();
  const list = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);

  const rows = useMemo(
    () =>
      views
        .flatMap(([owner, v]) => v.journal.map((entry) => ({ owner, root: v.machineId, entry })))
        .filter(({ entry }) => !isInternal(entry))
        .sort((a, b) => a.entry.at - b.entry.at || a.entry.seq - b.entry.seq)
        .slice(-300),
    [views],
  );

  // Stay at the bottom, where the newest event and what's next are, unless you scrolled up to read.
  // New rows slide in and the list scrolls up smoothly.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [rows.length, clock.parked.length]);

  // With an event selected, ↑ and ↓ select the previous and next event instead of scrolling.
  useEffect(() => {
    if (!pinned) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=listbox], [role=combobox], [role=slider], [role=separator]")) return;
      const i = rows.findIndex(({ owner, entry }) => owner === pinned.owner && entry.seq === pinned.seq);
      const next = rows[i + (event.key === "ArrowUp" ? -1 : 1)];
      event.preventDefault();
      if (i < 0 || !next) return;
      setPinned({ owner: next.owner, seq: next.entry.seq, at: next.entry.at });
      const button = list.current?.querySelector<HTMLButtonElement>(`[data-event="${CSS.escape(`${next.owner}#${next.entry.seq}`)}"]`);
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pinned, rows]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col whitespace-normal">
      {header}
      <Status />
      <ol
        ref={list}
        className="flex min-h-0 flex-1 flex-col overflow-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {rows.length === 0 && (
          <li className="mt-auto px-4 py-3">
            <Text variant="secondary">No events yet. Pick a scenario and press play.</Text>
          </li>
        )}
        {rows.map(({ owner, root, entry: e }, i) => {
          const id = `${owner}#${e.seq}`;
          const point = { owner, seq: e.seq, at: e.at };
          const isPinned = pinned?.owner === owner && pinned.seq === e.seq;
          const kind = KIND[e.kind];
          const { type: _, ...payload } = e.event;
          return (
            <li key={id} className={`event-enter border-b border-kumo-hairline ${i === 0 ? "mt-auto border-t" : ""} ${isPinned ? "bg-purple-500/5" : ""}`}>
              <button
                onClick={() => {
                  setPinned(isPinned ? undefined : point);
                  if (!isPinned) {
                    setSelectedNode(undefined);
                    setDockTab("state");
                  }
                }}
                aria-pressed={isPinned}
                data-event={id}
                title={new Date(e.at).toLocaleTimeString([], { hour12: false })}
                className="grid w-full gap-1 px-4 py-2 text-left text-sm hover:bg-kumo-tint"
              >
                <Line owner={owner} build={e.actor !== root ? e.actor : undefined} type={e.event.type} pinned={isPinned} />
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
              </button>
            </li>
          );
        })}
        <Upcoming />
      </ol>
      {footer}
    </section>
  );
}

/** First line of a row: who, then the event type on the right. */
function Line({ owner, build, type, pinned, extra }: { owner: string; build?: string; type: string; pinned?: boolean; extra?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ObjectLabel address={owner} className="min-w-0" />
      {build && <span className="shrink-0 text-kumo-subtle">› build {buildLabel(build)}</span>}
      {extra}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {pinned && <PushPinIcon aria-label="Pinned" className="text-purple-600" weight="fill" />}
        <Badge variant="secondary">
          <span className="font-mono text-[11px] font-normal">{type}</span>
        </Badge>
      </span>
    </span>
  );
}

/** Whether the system is still working, in one line. */
function Status() {
  const clock = useClock();
  const inFlight = useInFlight();
  const sending = useSending();
  const [head] = clock.parked;
  const [icon, text] = sending
    ? [<Loader size="sm" />, "Resetting and sending the scenario's webhooks…"]
    : head && !clock.playing
      ? [<PauseCircleIcon className="text-kumo-brand" size={16} weight="fill" />, `Paused · ${clock.parked.length} waiting. Press ▶ to go on.`]
      : inFlight
        ? [<Loader size="sm" />, clock.playing ? "Playing…" : "Working…"]
        : [<CheckCircleIcon className="text-kumo-success" size={16} weight="fill" />, "Idle. Nothing is moving."];
  return (
    <div className="flex items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-4 py-2 text-xs text-kumo-default" aria-live="polite">
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      {text}
    </div>
  );
}

/** What is still to come, below the newest event: running builds, messages on their way, then hops waiting, the next one first. */
function Upcoming() {
  const views = useAllViews();
  const clock = useClock();
  const parkedTokens = new Set(clock.parked.map((p) => p.token));
  const moving = views.flatMap(([owner, v]) => v.outbox.filter((o) => !parkedTokens.has(o.id)).map((o) => ({ owner, item: o })));
  const running = views.flatMap(([owner, v]) =>
    v.children.filter((c) => c.status === "active" && typeof c.value === "object" && c.value && "running" in c.value).map((c) => ({ owner, child: c })),
  );
  const waiting = clock.parked;
  return (
    <>
      {moving.map(({ owner, item }) => (
        <li key={`${owner}|${item.id}`} className="border-b border-dashed border-kumo-line">
          <div className="grid gap-0.5 px-4 py-2 text-sm">
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
      {running.map(({ owner, child }) => (
        <li key={`${owner}|${child.id}`} className="border-b border-dashed border-kumo-line">
          <div className="grid gap-0.5 px-4 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-1.5">
              <ObjectLabel address={owner} className="min-w-0" />
              <span className="shrink-0 text-kumo-subtle">› build {buildLabel(child.id)}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
              {clock.playing ? <Loader size={12} /> : <HourglassIcon aria-hidden />}
              <code className="font-mono">{formatValue(child.value)}</code>
            </span>
          </div>
        </li>
      ))}
      {waiting.map((p, i) => {
        const next = i === 0;
        return (
          <li key={`${p.owner}|${p.token}`} className={`border-b border-dashed border-kumo-line ${next ? "bg-kumo-brand/5" : "opacity-70"}`}>
            <div className="grid gap-0.5 px-4 py-2 text-sm">
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
