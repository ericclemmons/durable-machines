# XState v6 on Durable Objects: Workers Builds demo

Each Durable Object runs one durable XState v6 actor. A dashboard shows every
machine live, with no polling: a client loads the definitions and current state
once, then receives only events.

```sh
pnpm install      # from the repository root
pnpm dev           # http://localhost:5173
pnpm check         # tsc + graph coverage check
pnpm run deploy    # cf deploy, to durable-machines-ci on workers.dev
```

Deploys use [`cf`](https://developers.cloudflare.com/cf/) and [`cloudflare.config.ts`](cloudflare.config.ts), not Wrangler. The app is served at `/` of its own Worker, so the docs can embed it in an iframe.

The UI uses the [Kumo](https://kumo-ui.com) design system (`@cloudflare/kumo`) and its colour tokens.

The page has two parts:

- **Left: Workers Builds and Events**, a Kumo `Sidebar` you can resize by dragging its edge and hide (the choice is remembered). Its foot holds the scenario controls on one row: **Scenario**, **▶**, **Speed** and a **⚙ Settings** popover (repository, Free or Paid account, the GitHub event's branch, PR number and title, and the repository's Project build settings).
- **Right: the state machine canvas**, edge to edge, with a dock below it like a terminal. The dock has two tabs: **Deployments** (the Workers Builds table: status and step progress, project, commit, start time, approve/reject/cancel; click a row to focus that build) and **State** (an object's state as JSON). Drag the dock's top edge to resize it, or use the arrow keys on it.

**The canvas** shows every machine the run has reached: an object appears once it handles an event or a hop to it is waiting, the build machine once a build is spawned, BuildWorkflow once one is created. There's no toolbar. The view follows the newest event, or the next waiting hop while paused. Clicking an event zooms to the states it left and entered and its transition label, or to the wire a message took. Hovering does nothing. Click a state or an object to zoom to it and show its state in the dock; click the background to let go. Scroll to zoom and drag to pan. Zooming to something shows it at about 1× (1 to 1.1×), where state names and transition labels are about the size of the events list text, with a 900 ms ease-in-out. It doesn't move when the target is already in view and readable.

**Time travel:** click an event to see the system as it was right after it, and click it again or **Back to live** to return. The dock switches to **State**, which shows what the event changed in the object's state as a line diff of its JSON (removed lines red, added lines green), scrolled to the first change. Only that event's transition and wire light up, including a build's final transition. The State JSON is exact for events the page saw arrive (it keeps a snapshot per commit); for older ones, state values come from the journal and the context is the live one.

Objects are named by kind with their id after it, such as "GitHub App Installation DO #1001", "Account DO", "Project DO" and "Build Workflow", each with its own icon. On the map, each object's header shows its purpose underneath.

**Every run starts with a reset**, and build settings you saved are applied again. Scenarios that need earlier state include it: "Push to the PR branch" opens the PR first, "Redeliver a webhook" pushes first, and so on. A reset doesn't park the Account's first billing call, so a run starts at the webhook.

**Events** read oldest first and stay scrolled to the bottom. A status line says whether the system is working (spinner), paused with hops waiting, or idle. Below the newest event is what's still to come: running builds, messages on their way, then hops waiting for the clock (the next one marked). Each row names the object, with the event type as a badge on the right. A transition shows one line per parallel region that changed (`installed.active: no_token → token_valid`), and a clicked event shows its payload, highlighted. New rows slide in and the list scrolls smoothly. Internal `xstate.*` entries are only in DevTools → Console. On the map, a hop waiting for you is a dashed, still wire; a message on its way is animated.

**Speed** sets how ▶ behaves:

- **Manual**: each press of ▶ runs one hop (an outbox message, the Account's Workflow dispatch or billing call, or one BuildWorkflow step).
- **Instant** to **4 s**: ▶ plays every hop after that delay and becomes ⏸. Play pauses itself once nothing has moved for 1.5 s. Only the tab that pressed ▶ does this, since another tab may watch a different account.
- When nothing is moving, or you picked a different scenario than the one running, ▶ resets and starts the selected scenario. There's no step back.

The clock is one Durable Object ([`src/worker/clock.ts`](src/worker/clock.ts), capability in [`packages/durable-machines/src/clock.ts`](../../packages/durable-machines/src/clock.ts)). A paused outbox message is a Lifecycle job parked a year out; Next reschedules it to now. A paused Workflow step waits with `step.waitForEvent`, and Next sends the event. `/api/clock` (`{"action":"pause"|"play"|"next"|"nextMachine","pace":ms}`) drives it from scripts.

## What it models

```
GitHub ──POST /webhooks/github──▶ Worker (Effect pipeline: verify HMAC → decode → resolve installation)
                                    │ callDurableObject → send(scm.event, { messageId: X-GitHub-Delivery })
                                    ▼
                               Installation DO (installationMachine: not_installed | installed.{active.{no_token|token_valid|token_expired} | suspended} | uninstalled; repo → accounts)
                                    │ outbox: scm.event, to every account that connected the repo
                                    ▼
                               Account DO  (accountMachine, parallel:
                                 │  ▲        entitlements: cached from billing, refreshed every 5m
                                 │  │        scheduler:    queue + concurrency slots; free = 1, paid = 6)
                                 │  │ outbox: build.requested / build.finished
                                 ▼  │ outbox: scm.event, build.start
                               Project DO  (projectMachine: open PRs, build/ignore decision, fork approval, supersede)
                                 │ spawns one child actor per build (buildMachine)
                                 ▼
                               BuildWorkflow ── build.step …, then one build.completed ──▶ Project DO
```

Build rules (`decide()` in [`src/machines/project.ts`](src/machines/project.ts)):

- A push to the production branch builds.
- Any other push builds only while its branch has an open PR. Closing the PR stops that.
- Opening or reopening a PR builds its head commit (the latest commit on the branch), unless that commit already has a build.
- Fork PRs send no pushes; their commits arrive as `pull_request.synchronize`. Every fork build starts in `awaiting_approval` and becomes a normal queued build after `build.approve`.
- A newer commit on the same branch supersedes builds that are not running yet.

Every build ends in a final state (`succeeded`, `failed`, `canceled`, `superseded`, `rejected`) and tells its Project with `build.settled`. The Project then tells the Account, which frees the slot and runs its scheduling loop again.

## The reusable part: `DurableMachine`

[`packages/durable-machines/src/machine.ts`](../../packages/durable-machines/src/machine.ts) is a Lifecycle capability, like `State` or `Scheduler` from `agents`. It installs the object's Lifecycle and WebSocket handling itself, and every method starts the object, so RPC methods are one-liners. Host code never touches `ctx.storage`, SQL, or Durable Object errors:

```ts
export class Account extends DurableObject<Env> {
  readonly machine = new DurableMachine(this, accountMachine, {
    actions: { toProject: ({ projectId, event }) => this.machine.deliver("Project", projectId, event) },
    input: (name) => ({ accountId: name, ... }),
    clientEvents: ["entitlements.refresh"],
  });

  send(event: EventFromLogic<typeof accountMachine>, envelope?: Envelope) {
    return this.machine.send(event, envelope);
  }
}
```

| Concern | How |
| --- | --- |
| Persistence | XState's `createDurable` ([`DURABLE.md`](../../packages/durable-machines/DURABLE.md)): `transition()` + `executeEffects()` per event, `checkpoint()` after it, `restore()` on wake. Spawned children are persisted inside the checkpoint. Transitions are pure, so machines read time from events (`receivedAt`, `at`), never `Date.now()`. |
| Timers (`after`, `timeout`) | The adapter's `scheduleTimer` keeps each timer's absolute deadline. One Lifecycle job wakes the object at the earliest one and feeds `xstate.timer` to the root or the child that owns it. |
| Outbox | `deliver(binding, name, event)` records the message. After the transition's effects settle, one `transactionSync` writes the checkpoint, the inbox ids, the outbox jobs and the wake job, so the snapshot and its outgoing messages commit together. |
| Inbox | Every message carries `{ messageId, from }`. The receiver keeps the last 500 ids and acknowledges repeats without processing them, so retries are effectively once. |
| Durable Object errors | [`packages/durable-machines/src/do-call.ts`](../../packages/durable-machines/src/do-call.ts) follows the [error-handling guide](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/): a fresh stub per attempt, jittered retry on `.retryable`, and on `.overloaded` the job is rescheduled with exponential backoff instead of retried. Other failures use Lifecycle's retries. |
| Dead letters | A message that can't be delivered (gave up, rejected by the receiver, or the outbox write failed) is journaled and sent back into the sender's machine as `outbox.failed`. The Project cancels a build whose request never reached the Account; the Account frees a slot whose `build.start` never reached the Project. |
| Validation | Effect Schemas through `Schema.toStandardSchemaV1` and `standardSchemaValidator()`. Rejected events are reported to the caller and journaled. |
| Live UI | `SyncedState` sends the full view (definitions + snapshots) once on connect. After that, each commit sends one `xstate.commit` frame with the new journal entries and changed actors. |
| Client commands | `MachineCallables` lets WebSocket clients send only the `clientEvents` you allow. |

The same `do-call.ts` is used by the webhook Worker and the BuildWorkflow. The Worker uses the GitHub delivery id as the message id, so a redelivered webhook is deduplicated. Workflow reports use `${instanceId}:${stepName}`, so a retried step is deduplicated.

## Visualizing

- The diagrams are drawn by this app, not by Stately: [`src/app/graph.ts`](src/app/graph.ts) reads each `machineToJSON` definition, lays it out with ELK (a generic graph layout engine), and [`src/app/Statechart.tsx`](src/app/Statechart.tsx) renders SVG.
- **System map** ([`src/app/SystemMap.tsx`](src/app/SystemMap.tsx)) shows every machine at once: each Durable Object is a box with its statechart, the build machine sits inside its Project, and blue wires are outbox messages. Recent transitions and deliveries light up. The same component draws one object's tab (`only`), the system at a past event (`point`) and the zoom (`zoomTo`).
- **Ordered build steps**: `running` goes clone → install → build → deploy. Each step state only accepts a later step, so steps can be skipped but never repeated or reversed. With no build command, BuildWorkflow skips `build` and the chart shows `installing → deploying`. Each step fails at random 10% of the time (`STEP_FAILURE_RATE` in [`src/worker/build-workflow.ts`](src/worker/build-workflow.ts)), with a step-specific error; the result is a Workflow step's output, so a replay keeps it. `[fail]` in a commit message always fails the build step. The same skip edges leave room for a deploy-only path.
- **Graph coverage**: [`packages/durable-machines/src/graph-coverage.ts`](../../packages/durable-machines/src/graph-coverage.ts) rejects transition functions whose destinations can't be read from the definition (computed or shorthand targets, or returning a helper's result). `pnpm check:graph` fails on them, and `DurableMachine` refuses to run such a machine, so a diagram can't silently miss an edge. This implements the "strict graph extraction" that `xstate/docs/transition-functions.md` proposes but XState doesn't ship yet. The journal comparison ("⚠ Diagram missed a transition") stays as a safety net.
- The diagrams are deterministic: the same definition always gives the same layout. No AI is involved.

## Useful endpoints

- `POST /api/simulate`: build and sign a GitHub payload, then run it through the real webhook pipeline. `{ replay: { githubEvent, deliveryId, payload } }` redelivers an earlier one.
- `POST /webhooks/github`: the real webhook. The secret is `GITHUB_WEBHOOK_SECRET` in `cloudflare.config.ts`.
- `POST /api/chaos { target: "Project/free-web", mode: "overloaded" | "retryable" | null, seconds }`: make a DO throw the runtime's errors, to watch the outbox recover.
- `GET /api/view/{installation|account|project}/:name`: a DO's current view, as JSON.
- `POST /api/reset`: reset every DO.

## Known limits

- XState v6 is beta. `xstate/validation` and inspection events are marked experimental.
- `xstate/durable` is experimental and may change in a minor release.
- `@xstate/effect` is not used. It needs `createEffectActor` and an async `send`; this capability drives pure transitions instead.
- The graph coverage check reads function source text. It covers the forms these machines use; a new form can slip through until the check learns it.
- Project settings (build, deploy and preview commands, root directory, preview builds) are stored in the Project machine. Builds keep the commands they were requested with.
- Old snapshots may not restore into changed machines. After changing a machine, reset the demo.
