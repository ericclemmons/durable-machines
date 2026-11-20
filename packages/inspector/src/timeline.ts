import type { JournalEntry, MachineView } from "durable-machines/protocol";
import { arrivalOf, snapshotAfter, type Point, type Snapshot } from "./store";

/**
 * One order for every object's journal entries, shared by the Events list and time travel.
 * Same object: by seq. Others: by time, then (for entries in the same millisecond) by the
 * order the page received them.
 */
type At = Pick<JournalEntry, "seq" | "at">;
export const compareEntries = (ownerA: string, a: At, ownerB: string, b: At) => {
  if (ownerA === ownerB) return a.seq - b.seq;
  if (a.at !== b.at) return a.at - b.at;
  return (arrivalOf(ownerA, a.seq) ?? 0) - (arrivalOf(ownerB, b.seq) ?? 0) || ownerA.localeCompare(ownerB);
};

/** Did `entry` (in `owner`'s journal) happen at or before `point`? */
export const isAtOrBefore = (owner: string, entry: JournalEntry, point: Point) =>
  owner === point.owner ? entry.seq <= point.seq : compareEntries(owner, entry, point.owner, point) <= 0;

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

/**
 * Had `owner` been created by `point`? Its first journal entry is its creation. A journal that
 * no longer starts at seq 1 was trimmed, so the object is older than what the page has.
 */
export function existedAt(owner: string, view: MachineView, point: Point | undefined) {
  const [first] = view.journal;
  if (!point || !first || first.seq > 1) return true;
  return isAtOrBefore(owner, first, point);
}
