// Probe: can a child actor live in another host (another Durable Object)?
// Run: node experiments/remote-probe.ts
import { deliverEvent, setup, terminateActor, type AnyActor } from "xstate";
import { createDurable, type DurableExecutionAdapter } from "xstate/durable";

const log = (...args: unknown[]) => console.log(...args);
const section = (title: string) => console.log(`\n== ${title}`);

const worker = setup({}).createMachine({
  id: "worker",
  context: ({ input }: { input: { job: string; replyTo?: unknown } }) => ({ job: input?.job ?? "?", pokes: 0, replyTo: input?.replyTo ?? null }),
  initial: "busy",
  states: {
    busy: { on: {
      "ask.parent": ({ parent }, enq) => enq.sendTo(parent as never, { type: "reply" } as never),
      "ask.replyTo": ({ context }, enq) => enq.sendTo(context.replyTo as never, { type: "reply" } as never),
      poke: ({ context }) => ({ context: { ...context, pokes: context.pokes + 1 } }), finish: { target: "done" } } },
    done: { type: "final" },
  },
  output: ({ context }) => ({ job: context.job, pokes: context.pokes }),
});

const parent = setup({ actors: { worker } }).createMachine({
  id: "parent",
  context: { ref: null as unknown, results: [] as unknown[], replies: 0 },
  initial: "idle",
  on: {
    reply: ({ context }) => ({ context: { ...context, replies: context.replies + 1 } }),
    // sendTo a serialized ref stored in context.
    "poke.ref": ({ context }, enq) => {
      enq.sendTo(context.ref as never, { type: "poke" } as never);
    },
    "poke.foreign": (_, enq) => {
      enq.sendTo({ "@actor": "elsewhere/thing" } as never, { type: "poke" } as never);
    },
  },
  states: {
    idle: {
      on: {
        start: ({ context }, enq) => {
          const ref = enq.spawn("worker", { id: "w1", input: { job: "build-1", replyTo: { "@actor": "parent" } } } as never);
          return { target: "running", context: { ...context, ref } };
        },
      },
    },
    running: {
      on: {
        poke: (_, enq) => enq.sendTo("w1" as never, { type: "poke" } as never),
        finish: (_, enq) => enq.sendTo("w1" as never, { type: "finish" } as never),
        "xstate.done.actor": ({ context, event }) => ({ target: "idle", context: { ...context, results: [...context.results, (event as { output: unknown }).output] } }),
      },
    },
  },
});

// ---------------------------------------------------------------- Host A
// Owns `parent`. Every send to a non-root target goes to Host B ("another DO").
type Wire = { to: string; event: { type: string } };
const toB: Wire[] = [];
const mailboxA: Array<{ type: string }> = [];
let started: string[] = [];

let stateA: any;
const adapterA = (): DurableExecutionAdapter<typeof parent> => ({
  executeAction: (a, _m, r) => a.exec(r),
  waitForEvent: () => new Promise(() => {}),
  spawnActor: (_source, actor) => log("A.spawnActor", actor.address, "src", (actor as { src?: unknown }).src),
  // Don't start the child here: Host B runs it.
  startActor: (actor) => {
    if (actor.address === "parent") return actor.start();
    started.push(actor.address);
    log("A.startActor (shipped to B)", actor.address, "input", JSON.stringify(actor.getSnapshot()?.input ?? (actor as any).options?.input));
  },
  sendEvent: (source, target, event) => {
    log("A.sendEvent", source?.address, "->", target.address ?? JSON.stringify(target), event.type);
    if (target.address === "parent") return void mailboxA.push(event);
    toB.push({ to: target.address, event });
  },
  stopActor: (actor) => log("A.stopActor", actor.address),
  terminateActor: (actor, termination) => {
    log("A.terminateActor", actor.address, termination.status);
    terminateActor(actor, termination);
  },
  deadLetter: (_s, target, event, reason, detail) => log("A.deadLetter", target?.address ?? detail?.targetId, event.type, reason),
});

let durableA = createDurable(parent, adapterA(), { captureRootEvents: false });
const stepA = async (event: { type: string }) => {
  let effects;
  [stateA, effects] = durableA.transition(stateA, event as never);
  await durableA.executeEffects(effects);
  while (mailboxA.length) {
    [stateA, effects] = durableA.transition(stateA, mailboxA.shift() as never);
    await durableA.executeEffects(effects);
  }
};

// ---------------------------------------------------------------- Host B
// Runs `worker` as its own durable root, addressed by A's logical address.
const workers = new Map<string, { durable: ReturnType<typeof createDurable<typeof worker>>; state: any }>();
const startOnB = async (address: string, input: unknown) => {
  const durable = createDurable(worker, {
    executeAction: (a, _m, r) => a.exec(r),
    waitForEvent: () => new Promise(() => {}),
    // B's root is inert; its completion is the host's to forward.
    terminateActor: (actor, t) => log("B.terminateActor", actor.address, t.status),
    sendEvent: (source, target, event) => {
      log("B.sendEvent", source?.address, "->", target.address ?? JSON.stringify(target), event.type);
      if ((target as { "@actor"?: string })["@actor"] === "parent") mailboxA.push(event);
    },
    deadLetter: (_s, target, event, reason, detail) => log("B.deadLetter", target?.address ?? detail?.targetId, event.type, reason),
  });
  const [state, effects] = durable.initialTransition(input as never);
  await durable.executeEffects(effects);
  workers.set(address, { durable, state });
};
const deliverOnB = async () => {
  while (toB.length) {
    const { to, event } = toB.shift()!;
    const w = workers.get(to);
    if (!w) {
      log("B: no worker at", to, "for", event.type);
      continue;
    }
    let effects;
    [w.state, effects] = w.durable.transition(w.state, event as never);
    await w.durable.executeEffects(effects);
    log("B:", to, event.type, "->", JSON.stringify(w.state.value), "status", w.state.status);
    if (w.state.status === "done") {
      // Completion crosses back to A: resolve A's handle and terminate it there.
      const handle = durableA.getActorRef(stateA, to);
      log("B -> A completion; handle on A?", Boolean(handle), handle && (handle as any).getSnapshot?.());
      if (handle) {
        try {
          terminateActor(handle as AnyActor, { status: "done", output: w.state.output, error: undefined });
        } catch (error) {
          log("terminateActor(handle) threw:", (error as Error).message);
        }
        // What works: a completion event built from the address-only child id.
        // No sessionId, so the remote handle defers staleness to the host.
        await stepA({ type: "xstate.done.actor", actorId: to.split("/").pop(), output: w.state.output } as never);
      }
    }
  }
};

section("1. spawn on A, start is intercepted");
{
  let effects;
  [stateA, effects] = durableA.initialTransition();
  await durableA.executeEffects(effects);
}
await stepA({ type: "start" });
log("A value", stateA.value, "children", Object.keys(stateA.children), "child status on A", stateA.children.w1?.getSnapshot().status);
for (const address of started) await startOnB(address, { job: "build-1", replyTo: { "@actor": "parent" } });
started = [];

section("2. send to the child: does it reach sendEvent?");
await stepA({ type: "poke" });
await deliverOnB();

section("3. checkpoint with embedChildren: false");
const cp = durableA.checkpoint(stateA, { embedChildren: false });
log(JSON.stringify(cp.snapshot));

section("4. restore A from the address-only checkpoint");
durableA = createDurable(parent, adapterA(), { captureRootEvents: false });
const [restored, effects] = durableA.restore(JSON.parse(JSON.stringify(cp)));
stateA = restored;
log("restore effects", effects.map((e) => `${e.id} ${JSON.stringify(e.descriptor)}`));
await durableA.executeEffects(effects);
const handle = durableA.getActorRef(stateA, "parent/w1") as any;
log("handle", handle?.address, "status", handle?.getSnapshot?.()?.status, "keys", handle && Object.keys(handle.getSnapshot?.() ?? {}));
log("context.ref restored to handle?", stateA.context.ref === handle, JSON.stringify(stateA.context.ref));

section("5. send to the remote handle after restore");
await stepA({ type: "poke" });
log("enq.sendTo(context.ref):");
await stepA({ type: "poke.ref" });
log("enq.sendTo({ '@actor': 'elsewhere/thing' }):");
await stepA({ type: "poke.foreign" });
await deliverOnB();

section("5b. child on B talks to its parent on A");
toB.push({ to: "parent/w1", event: { type: "ask.parent" } });
toB.push({ to: "parent/w1", event: { type: "ask.replyTo" } });
await deliverOnB();
while (mailboxA.length) await stepA(mailboxA.shift()!);
log("A replies", stateA.context.replies);

section("6. finish: completion travels B -> A via terminateActor on the handle");
await stepA({ type: "finish" });
await deliverOnB();
log("A value", stateA.value, "results", JSON.stringify(stateA.context.results), "children", Object.keys(stateA.children));

section("7. checkpoint with embedded children while child is remote-started");
await stepA({ type: "start" } as never).catch((e) => log("start again failed:", e.message));
for (const address of started) await startOnB(address, {});
try {
  log(JSON.stringify(durableA.checkpoint(stateA).snapshot.children));
} catch (error) {
  log("embedded checkpoint threw:", (error as Error).message);
}
process.exit(0);
