// Probe: createDurable with a fake host. Run: node experiments/local-probe.ts
import { createAsyncLogic, deliverEvent, setup, type AnyActor, type TimerKey } from "xstate";
import { createDurable } from "xstate/durable";

const log = (...args: unknown[]) => console.log(...args);

const child = setup({}).createMachine({
  id: "child",
  initial: "waiting",
  states: {
    waiting: {
      after: { 50: { target: "done" } },
      on: { poke: { target: "done" } },
    },
    done: { type: "final", entry: ({ parent }, enq) => enq.sendTo(parent as never, { type: "child.settled" } as never) },
  },
});

const parent = setup({
  actors: { child, work: createAsyncLogic({ run: async () => { await new Promise((r) => setTimeout(r, 10)); return 42; } }) },
  actions: { notify: (_: { n: number }) => {} },
}).createMachine({
  id: "parent",
  context: { n: 0, settled: 0 },
  initial: "idle",
  on: {
    "child.settled": ({ context }) => ({ context: { ...context, settled: context.settled + 1 } }),
  },
  states: {
    idle: {
      on: {
        go: ({ context, actions }, enq) => {
          enq.spawn("child", { id: "c1" });
          enq(actions.notify, { n: context.n });
          return { target: "working", context: { ...context, n: context.n + 1 } };
        },
      },
    },
    working: {
      invoke: { src: "work", onDone: { target: "waiting" } },
    },
    waiting: { after: { 30: { target: "idle" } } },
  },
});

const timers = new Map<string, { address: string; timer: TimerKey; dueAt: number }>();
const mailbox: Array<{ event: { type: string }; source?: string }> = [];
const inspected: string[] = [];

let state: any;
const durable = createDurable(
  parent,
  {
    executeAction: (action, meta, runtime) => {
      log("executeAction", action.type, (action as any).params ?? (action as any).args, meta.id);
      return action.exec(runtime);
    },
    waitForEvent: () => new Promise(() => {}),
    enqueueRootEvent: (source, event) => {
      log("enqueueRootEvent", event.type, source?.address);
      mailbox.push({ event, source: source?.address });
    },
    scheduleTimer: (source, timer, delay) => {
      const key = `${source.address}:${JSON.stringify(timer)}`;
      if (!timers.has(key)) timers.set(key, { address: source.address, timer, dueAt: Date.now() + delay });
      log("scheduleTimer", key, delay);
    },
    cancelTimer: (source, timer) => {
      log("cancelTimer", `${source.address}:${JSON.stringify(timer)}`);
      timers.delete(`${source.address}:${JSON.stringify(timer)}`);
    },
    cancelAllTimers: (source) => {
      log("cancelAllTimers", source.address);
      for (const [k, t] of timers) if (t.address === source.address) timers.delete(k);
    },
    deadLetter: (_s, target, event, reason) => log("deadLetter", target?.address, event.type, reason),
  },
  {
    captureRootEvents: false,
    inspect: (e: any) => {
      if (e.type === "@xstate.transition") inspected.push(`${e.actorRef.address} ${e.event.type} -> ${JSON.stringify(e.snapshot?.value ?? e.snapshot?.status)}`);
      if (e.type === "@xstate.actor") inspected.push(`actor ${e.actorRef.address} id=${e.actorRef.id}`);
    },
  },
);

async function step(event: { type: string }) {
  let effects;
  [state, effects] = durable.transition(state, event as never);
  await durable.executeEffects(effects);
}

async function fireDue() {
  for (const [key, t] of [...timers]) {
    if (t.dueAt > Date.now()) continue;
    timers.delete(key);
    const event = { type: "xstate.timer", ...t.timer } as never;
    if (t.address === durable.rootAddress) {
      log("fire root", key);
      await step(event);
    } else {
      const ref = durable.getActorRef(state, t.address);
      log("fire child", key, Boolean(ref));
      if (ref) deliverEvent(ref as AnyActor, ref as AnyActor, event);
    }
  }
}

async function drain() {
  while (mailbox.length) await step(mailbox.shift()!.event);
}

{
  let effects;
  [state, effects] = durable.initialTransition();
  await durable.executeEffects(effects);
}
await step({ type: "go" });
log("value", state.value, "children", Object.keys(state.children));
log("actorRef snapshot current?", durable.getActorRef(state)?.getSnapshot() === state);
await new Promise((r) => setTimeout(r, 20));
await drain();
log("after work", state.value);
const unhandledBefore = state;
await step({ type: "nope" });
log("unhandled returns same object?", unhandledBefore === state);
await new Promise((r) => setTimeout(r, 35));
await fireDue();
log("mid checkpoint (child timer pending)", JSON.stringify(durable.checkpoint(state)));
await new Promise((r) => setTimeout(r, 30));
await fireDue();
await drain();
log("after timers", state.value, state.context, "children", Object.keys(state.children));
const cp = durable.checkpoint(state);
log("checkpoint", JSON.stringify(cp));

// Restore on a fresh execution mid-flight.
const again = createDurable(parent, {
  executeAction: (a, _m, r) => a.exec(r),
  waitForEvent: () => new Promise(() => {}),
  enqueueRootEvent: (_s, e) => log("restored enqueue", e.type),
  scheduleTimer: (s, t, d) => log("restored scheduleTimer", s.address, JSON.stringify(t), d),
});
const mid = durable.checkpoint(state);
log("mid checkpoint timers", JSON.stringify(mid.snapshot), "nextIndex", mid.nextTransitionIndex);
const [restored, restoreEffects] = again.restore(JSON.parse(JSON.stringify(mid)));
log("restore effects", restoreEffects.map((e) => e.id + " " + JSON.stringify(e.descriptor)));
await again.executeEffects(restoreEffects);
log("restored value", restored.value, "nextIndex", again.nextTransitionIndex);
await new Promise((r) => setTimeout(r, 20));
// Restore with a pending child timer and a pending root timer: deadlines must be kept.
{
  const d = createDurable(parent, { executeAction: (a, _m, r) => a.exec(r), waitForEvent: () => new Promise(() => {}), enqueueRootEvent: () => {}, scheduleTimer: () => {} }, { captureRootEvents: false });
  let [s, e] = d.initialTransition();
  await d.executeEffects(e);
  [s, e] = d.transition(s, { type: "go" } as never);
  await d.executeEffects(e);
  const saved = JSON.parse(JSON.stringify(d.checkpoint(s)));
  await new Promise((r) => setTimeout(r, 20));
  const r = createDurable(parent, {
    executeAction: (a, _m, rt) => a.exec(rt),
    waitForEvent: () => new Promise(() => {}),
    enqueueRootEvent: (_s, ev) => log("restore#2 enqueue", ev.type),
    scheduleTimer: (src, t, delay) => log("restore#2 scheduleTimer", src.address, JSON.stringify(t), "remaining", delay),
    startActor: (a) => { log("restore#2 startActor", a.address); a.start(); },
  }, { captureRootEvents: false });
  const [rs, re] = r.restore(saved);
  log("restore#2 effects", re.map((x) => JSON.stringify(x.descriptor)));
  await r.executeEffects(re);
  log("restore#2 value", rs.value, Object.keys(rs.children));
  await new Promise((r2) => setTimeout(r2, 30));
}
log("inspect log:\n " + inspected.join("\n "));
process.exit(0);
