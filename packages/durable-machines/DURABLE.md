# DurableMachine as the Durable Object host for `createDurable`

Prototype. `DurableMachine` drives XState's experimental `xstate/durable`
(`xstate@6.0.0-beta.3`) instead of `createActor` / `restoreActor`. The public API
from `main` (`new DurableMachine(host, logic, options)`) is unchanged except for the
`actor` getter (see [API](#api)).

```ts
export class Account extends DurableObject<Env> {
  readonly machine = new DurableMachine(this, accountMachine, {
    input: (accountId) => ({ accountId, balance: 100, frozen: false }),
    actions: { toTransfer: ({ transferId, event }) => this.machine.deliver("Transfer", transferId, event) },
    pace: 700,
  });
}
```

The constructor still provides `actions`, `actors`, `guards` and `delays` to
`logic.provide()`, reads bindings from `host.env`, installs
`Lifecycle.install(host).use(this).use(this.webSockets)`, and broadcasts commits to
`machine.webSockets`. `createDurable` runs on the provided logic.

## Loop

```
boot (onStart, reset, failed turn)
  restore(checkpoint) | initialTransition(input)  ->  executeEffects(effects)
per turn (send, wake job, dead letter, child reported up)
  transition(state, event) -> executeEffects(effects)
  drain the mailbox (events children sent to the root) the same way
  checkpoint(state) + inbox ids + outbox jobs + wake job  in one transactionSync
  broadcast xstate.commit
```

`state` stays in memory while the object lives. `restore()` runs only on boot.
Turns run one at a time (`#exclusive`), because `executeEffects` calls must not overlap.
`createDurable` runs with `captureRootEvents: false`: every event a child sends to
the root goes to `enqueueRootEvent`, into one FIFO mailbox that the turn drains before
it commits. An event that arrives between turns (an invoked promise settles) starts a
turn of its own.

## Adapter mapping

| `createDurable` operation | Durable Object primitive |
| --- | --- |
| `executeAction` | Runs the action body in place. `deliver()` inside it only records the message. |
| `enqueueRootEvent` | In-memory mailbox, drained in the same turn. |
| `scheduleTimer` | `Map<"${address}:${JSON.stringify(timer)}", { address, timer, at }>`, saved with the checkpoint. A key already in the map keeps its deadline (restore must not extend it). |
| `cancelTimer` / `cancelAllTimers` | Delete from the map. |
| (wake) | One Lifecycle job `xstate-wake` at the earliest `at`. When it runs, each due timer becomes `{ type: "xstate.timer", ...timer }`: `transition()` for the root, `deliverEvent(ref, ref, event)` for a child found with `getActorRef(state, address)`. A child that is gone is skipped. |
| `deadLetter` | Journaled as `rejected`; the reason and schema issues are returned by `send()`. The `unhandled` entry inspection reports for the same event is dropped. |
| `deliver()` (host API) | Recorded, then `lifecycle.jobs.push` inside the turn's `transactionSync` (rows insert synchronously). |
| `inspect` option | Same `JournalEntry` records and `ActorView`s as before. Actors are keyed by address. A timer firing is journaled as the event it delivers (`xstate.after`, `xstate.timeout.state`). |
| `startActor`, `stopActor`, `terminateActor`, `sendEvent`, `runLogic` | Not implemented: local behavior. Children are co-located and embedded in the checkpoint. |

## Atomicity

Adapter operations return synchronously, which `createDurable` treats as accepted.
Nothing reaches storage until the turn's effects and mailbox settle. Then a single
`transactionSync` writes the checkpoint, journal, inbox ids, timer map, outbox jobs
and the wake job. A snapshot and the messages it produced commit together or not at all.

If a turn throws (an action throws, `executeEffects` rejects, the transaction fails),
recorded intents are discarded and the object reboots from the last committed
checkpoint. The previous execution's live children are stopped and its adapter is
fenced off by a generation counter, so a late completion cannot leak into the new one.

## Call diff

Baseline: `923bdaa` (`main` after [PR #1](https://github.com/ericclemmons/durable-machines/pull/1)). Implemented in [PR #2](https://github.com/ericclemmons/durable-machines/pull/2), not merged.

```diff
 new DurableMachine(host, logic, options)
   #logic = logic.provide({ actions, actors, guards, delays }); #env = host.env
   Lifecycle.install(host).use(this).use(this.webSockets)
 DurableObject.send(event, envelope) -> DurableMachine.send(event, envelope)
   await start(); await lifecycle.ready()
-  storage.transactionSync(() => actor.send(event); #persist())   // createActor, sync
+  #exclusive(() => #transact(() => #step(event)))
+    #step: durable.transition(state, event) -> await durable.executeEffects(effects)
+      executeAction -> action.exec(runtime) -> deliver() -> #outgoing.push(intent)
+      scheduleTimer/cancelTimer -> #timers map
+      enqueueRootEvent -> #mailbox.push
+      deadLetter -> #onRejected -> journal "rejected", #rejection
+    #settle: #step(mailbox.shift()) until empty
+    #save: transactionSync(kv.put(checkpoint, timers, journal, inbox) + jobs.push(outbox) + jobs.push(xstate-wake))
+    on throw: #boot() from storage, rethrow
   #commit() -> #broadcast(xstate.commit) -> webSockets.getConnections()[].send
 view() -> await start() -> #view()
 onStart
-  #boot: restoreActor(logic, snapshot).start() | createActor(logic, { input }).start()
+  #boot: createDurable(logic, #adapter(live), { captureRootEvents: false, inspect })
+         restore(checkpoint) | initialTransition(input) -> executeEffects(effects)
 onJob("wake")
-  #persist() -> nextTimerDeadline(snapshot) -> jobs.push(xstate-wake)   // timers ran on setTimeout
+  #fireTimers: due timers -> #step(xstate.timer) | deliverEvent(childRef, childRef, xstate.timer)
 onJob("deliver") / onJobError -> #deadLetter
-  transactionSync(actor.send(outbox.failed))
+  #exclusive(() => #transact(() => #step(outbox.failed)))
```

## Verified

- After rebasing on `main`: `pnpm check`, `pnpm --filter durable-machines build`, and
  `cf build` in `examples/bank` and `examples/ci`: pass.
- `examples/bank` with `cf dev`: reset, deposit $60, send $10 to alice and $150 to bob.
  The $10 transfer completed. The $150 one waited in `review` and left on `xstate.after`
  12.01 s later, then bob (frozen) bounced it and it was refunded. Balance 150 (100 + 60 − 10),
  no holds, no dead letters. The `/bank/` page loads with no errors.
- `examples/ci` with `cf dev`: a push to `acme/web` ends with `build.settled` on
  `Project/free-web` and a delivered `build.finished`.
- Earlier, on the old API, with `vite dev` end to end: push → Installation → Account → Project → BuildWorkflow →
  build child → `build.settled` → `build.finished` back to the Account. Fan-out to two
  accounts. Outbox `delivered` and `retrying` (chaos `retryable`) entries.
- Root `after` timer through the wake job (TTL set to 4 s for the test, then reverted):
  `fresh → refreshing → fresh`, re-armed each time.
- Child `timeout` through the wake job (5 min set to 3 s, then reverted):
  `running.installing → failed` on `xstate.timeout.state`, then `build.settled` to the parent.
- Restore after local eviction in the middle of a build: the object restored with
  the child in `running.cloning` and kept going.
- WebSocket: `MachineView` on connect, `xstate.commit` frames after, RPC `send`
  returns `invalidEvent: buildId: Missing key` for a bad client event.
- [`experiments/rejection-probe.ts`](experiments/rejection-probe.ts): a schema-invalid event returns the same
  snapshot plus one `@xstate.deadLetter` effect; the adapter gets the issues.
- [`experiments/local-probe.ts`](experiments/local-probe.ts): restoring a checkpoint with a pending child timer
  calls `scheduleTimer` with the remaining delay; an in-flight async child restarts.

Not verified end to end: `outbox.failed` after retries run out, and the debugger clock
while paused (code paths unchanged).

## Remote children (another Durable Object)

[`experiments/remote-probe.ts`](experiments/remote-probe.ts), two fake hosts. Result: **partly**.

Works:

- `startActor(actor)` that does not call `actor.start()` keeps a spawned child inert on
  host A. `actor.address` (`parent/w1`), `src` and input are available to ship it.
- With an adapter `sendEvent`, `enq.sendTo("w1")` reaches `sendEvent(parent, parent/w1, event)`.
- `checkpoint(state, { embedChildren: false })` writes `children.w1 = { address, remote: true, src }`
  and the context ref as `{ "@actor": "parent/w1" }`.
- `restore()` of that checkpoint starts nothing, `getActorRef(state, "parent/w1")` returns a
  handle (`getSnapshot()` is `{ status: "active" }` only), the context ref resolves to the
  same handle, and sends to it go through `sendEvent`.
- `enq.sendTo({ "@actor": "elsewhere/thing" })` with an adapter `sendEvent` reaches
  `sendEvent` with the serialized ref itself as `target` (no `.address`), so a host can
  route any address. Without `sendEvent` it is a `missingTarget` dead letter.
- Child → parent: on host B the child is a root, so `enq.sendTo(parent)` is a
  `missingTarget` dead letter. Passing `replyTo: { "@actor": "parent" }` in the input
  works: B's `sendEvent` gets the serialized ref and the host forwards it.
- Completion: a host-built `{ type: "xstate.done.actor", actorId: "w1", output }` (no
  `sessionId`) passed to A's `transition()` is accepted and removes the child.

Missing:

- `terminateActor(handle, termination)` throws (`actor._terminate is not a function`).
  There is no supported way to complete a remote handle; the docs say not to build
  completion events by hand, but that is the only path that works.
- Host B cannot root an execution at `parent/w1`; its root address is the machine id
  (`worker`). The host has to map addresses both ways.
- `embedChildren` applies to the whole tree, so one checkpoint cannot embed local children
  (the Project's builds) and reference remote ones. The default embedded checkpoint of
  a child started elsewhere embeds a stale local copy.
- Until the first restore, the child on host A is a real unstarted actor, not a handle:
  its `getSnapshot()` is its initial state.
- `incarnation` tokens have no API; a host would edit persisted JSON to stamp them.
- Not tried: `stopActor` on a handle when the parent exits the state, `xstate.error.actor`.

## API

- `actor` is now a read-only facade `{ id, getSnapshot() }`, deprecated. There is no live
  root actor to send to. Use `snapshot` (new) or `send()`.
- `onStart`, `onJobError` are async.
- Storage: `xstate:actor` now holds `{ checkpoint, timers, journal, seq, inbox, deadLetters }`.
  The old `{ snapshot, ... }` shape still restores (as a bare snapshot).
- Machines must be pure. `examples/ci` now reads time from `ScmEvent.receivedAt`,
  `build.step.at`, and the Account worker stamps `at` on a failed dispatch when it sends it.

## Open questions

- Actions with external effects (`terminateWorkflow`, `hold`) run during
  `executeEffects`, before the commit. A failed commit cannot undo them. Same as before.
- `machineId` / `machineVersion` are not checked on restore, and `executionId` is not pinned.
  Neither matters while nothing is journaled by effect id.
- A root that reaches `status: "error"` is persisted as is; nothing alerts.
- Is a remote child worth it here? The Project's build children work co-located. A remote
  build child would need the address mapping, a completion API and per-child placement
  that `xstate/durable` does not have yet.
