import type { JournalEntry, MachineView } from "durable-machines/protocol";
import { snapshotAfter, type Point, type Snapshot } from "./store";

/** Did `entry` (in `owner`'s journal) happen at or before `point`? Same object: by seq. Others: by time. */
export const isAtOrBefore = (owner: string, entry: JournalEntry, point: Point) => (owner === point.owner ? entry.seq <= point.seq : entry.at <= point.at);

/**
 * An object as it was at `point`. Exact when the page saw that commit arrive;
 * otherwise each actor's value comes from the journal's from/to and the context is the live one.
 */
export function stateAt(owner: string, view: MachineView, point: Point | undefined): Snapshot & { exact: boolean } {
  if (!point) return { root: view.root, children: view.children, exact: true };
  const last = view.journal.findLast((e) => isAtOrBefore(owner, e, point));
  const snap = last && snapshotAfter(owner, last.seq);
  if (snap) return { ...snap, exact: true };
  const moves = view.journal.filter((e) => e.kind === "transition" || e.kind === "restored");
  const valueOf = (actor: string, live: unknown) => {
    const own = moves.filter((e) => e.actor === actor);
    const before = own.findLast((e) => isAtOrBefore(owner, e, point));
    if (before) return before.to;
    const after = own.find((e) => !isAtOrBefore(owner, e, point));
    return after ? after.from : live;
  };
  return {
    root: { ...view.root, value: valueOf(view.machineId, view.root.value) },
    children: view.children.map((c) => ({ ...c, value: valueOf(c.id, c.value) })),
    exact: false,
  };
}

/** The journal entry a point refers to. */
export const entryAt = (view: MachineView | undefined, point: Point | undefined) => (point && view ? view.journal.find((e) => e.seq === point.seq) : undefined);
