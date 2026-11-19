import { Schema } from "effect";
import { createAsyncLogic, setup } from "xstate";
import { standardSchemaValidator } from "xstate/validation";
import { OutboxFailed, Outcome, ScmEvent, std, Ticket } from "../domain/scm";

const Entitlements = Schema.Struct({
  plan: Schema.Literals(["free", "paid"]),
  maxConcurrentBuilds: Schema.Number,
  fetchedAt: Schema.Number,
});
type Entitlements = typeof Entitlements.Type;

const Running = Schema.Struct({
  ...Ticket.fields,
  phase: Schema.Literals(["dispatching", "running"]),
});

const Finished = Schema.Struct({ ...Ticket.fields, outcome: Outcome });

export const AccountInput = Schema.Struct({
  accountId: Schema.String,
  name: Schema.String,
  /** Connected repos → this account's projects for them. */
  repos: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});

const AccountContext = Schema.Struct({
  ...AccountInput.fields,
  /** Cached from the billing backend. `null` until the first fetch succeeds. */
  entitlements: Schema.NullOr(Entitlements),
  queue: Schema.Array(Ticket),
  running: Schema.Array(Running),
  finished: Schema.Array(Finished),
  routed: Schema.Number,
});
type AccountContext = typeof AccountContext.Type;

/** Messages an Account sends to its Projects. Delivered through the durable outbox. */
export type ToProject =
  | { type: "scm.event"; event: ScmEvent }
  | { type: "build.start"; buildId: string; at: number }
  | { type: "build.completed"; buildId: string; result: { outcome: "failed"; error: string; step: null } };

/** Starts the BuildWorkflow for a ticket. The Account DO provides the real implementation. */
export const dispatchBuild = createAsyncLogic<{ startedAt: number }, Ticket & { accountId: string }>({
  run: async () => {
    throw new Error("dispatchBuild is provided by the Account Durable Object");
  },
});

/** Reads the account's entitlements from the billing backend. Provided by the Account DO. */
export const fetchEntitlements = createAsyncLogic<Entitlements, { accountId: string }>({
  run: async () => {
    throw new Error("fetchEntitlements is provided by the Account Durable Object");
  },
});

const ENTITLEMENTS_TTL = 5 * 60_000;

const pickTicket = (t: Ticket): Ticket => ({
  buildId: t.buildId,
  buildNumber: t.buildNumber,
  projectId: t.projectId,
  branch: t.branch,
  sha: t.sha,
  message: t.message,
  environment: t.environment,
  commands: t.commands,
});

// Pure context updates, shared by the idle/busy states and the region-level
// fallback that applies while a dispatch is in flight.
const requested = (c: AccountContext, ticket: Ticket): AccountContext => ({ ...c, queue: [...c.queue, ticket] });
const finished = (c: AccountContext, buildId: string, outcome: Outcome): AccountContext => {
  const ticket = c.running.find((r) => r.buildId === buildId) ?? c.queue.find((t) => t.buildId === buildId);
  return {
    ...c,
    queue: c.queue.filter((t) => t.buildId !== buildId),
    running: c.running.filter((r) => r.buildId !== buildId),
    finished: ticket ? [...c.finished, { ...pickTicket(ticket), outcome }].slice(-10) : c.finished,
  };
};
const dispatchingTicket = (c: AccountContext) => c.running.find((r) => r.phase === "dispatching");
const slots = (c: AccountContext) => c.entitlements?.maxConcurrentBuilds ?? 0;

/**
 * Owns build concurrency for every Project in the account.
 * - `entitlements` keeps a cached copy of the billing backend's limits fresh.
 * - `scheduler` queues requests and dispatches them while slots are free.
 */
export const accountMachine = setup({
  validator: standardSchemaValidator(),
  actors: { dispatchBuild, fetchEntitlements },
  actions: {
    toProject: (_message: { projectId: string; event: ToProject }) => {},
  },
  schemas: {
    input: std(AccountInput),
    context: std(AccountContext),
    events: {
      "scm.event": std(Schema.Struct({ event: ScmEvent })),
      "build.requested": std(Schema.Struct({ ticket: Ticket })),
      "build.finished": std(Schema.Struct({ buildId: Schema.String, projectId: Schema.String, outcome: Outcome })),
      "entitlements.refresh": std(Schema.Struct({})),
      "outbox.failed": std(OutboxFailed),
    },
    internalEvents: {
      "entitlements.loaded": std(Schema.Struct({})),
    },
  },
}).createMachine({
  id: "account",
  version: "2",
  context: ({ input }) => ({
    ...input,
    entitlements: null,
    queue: [],
    running: [],
    finished: [],
    routed: 0,
  }),
  type: "parallel",
  on: {
    "scm.event": ({ context, event, actions }, enq) => {
      for (const projectId of context.repos[event.event.repo.toLowerCase()] ?? []) {
        enq(actions.toProject, { projectId, event: { type: "scm.event", event: event.event } });
      }
      return { context: { ...context, routed: context.routed + 1 } };
    },
  },
  states: {
    entitlements: {
      initial: "loading",
      states: {
        loading: {
          description: "First fetch from the billing backend",
          invoke: {
            src: "fetchEntitlements",
            input: ({ context }) => ({ accountId: context.accountId }),
            onDone: ({ context, event }, enq) => {
              enq.raise({ type: "entitlements.loaded" });
              return { target: "fresh", context: { ...context, entitlements: event.output } };
            },
            onError: { target: "unavailable" },
          },
        },
        fresh: {
          description: "Cached copy is within its TTL",
          after: { [ENTITLEMENTS_TTL]: { target: "refreshing" } },
          on: { "entitlements.refresh": { target: "refreshing" } },
        },
        refreshing: {
          description: "Re-fetching; builds keep using the cached copy",
          invoke: {
            src: "fetchEntitlements",
            input: ({ context }) => ({ accountId: context.accountId }),
            onDone: ({ context, event }, enq) => {
              enq.raise({ type: "entitlements.loaded" });
              return { target: "fresh", context: { ...context, entitlements: event.output } };
            },
            onError: { target: "stale" },
          },
        },
        stale: {
          description: "Backend failed; still using the cached copy",
          after: { 10_000: { target: "refreshing" } },
        },
        unavailable: {
          description: "No entitlements yet, so nothing dispatches",
          after: { 5_000: { target: "loading" } },
        },
      },
    },
    scheduler: {
      initial: "ready",
      on: {
        // While a dispatch is in flight, record changes. Scheduling resumes when it settles.
        "build.requested": ({ context, event }) => ({ context: requested(context, event.ticket) }),
        "build.finished": ({ context, event }) => ({ context: finished(context, event.buildId, event.outcome) }),
        // A Project never got its start signal: give the slot back.
        "outbox.failed": ({ context, event }) =>
          event.eventType === "build.start"
            ? { context: finished(context, (event.event as { buildId: string }).buildId, "failed") }
            : undefined,
      },
      states: {
        ready: {
          initial: "idle",
          on: {
            "build.requested": ({ context, event }) => ({ target: "scheduling", context: requested(context, event.ticket) }),
            "build.finished": ({ context, event }) => ({ target: "scheduling", context: finished(context, event.buildId, event.outcome) }),
            "entitlements.loaded": { target: "scheduling" },
            "outbox.failed": ({ context, event }) =>
              event.eventType === "build.start"
                ? { target: "scheduling", context: finished(context, (event.event as { buildId: string }).buildId, "failed") }
                : undefined,
          },
          states: {
            idle: { description: "No builds running or queued" },
            building: { description: "Builds running, slots available" },
            saturated: { description: "Every slot is in use; builds wait in the queue" },
            blocked: { description: "Builds wait for entitlements" },
          },
        },
        scheduling: {
          type: "choice",
          description: "The build loop: start the next queued build if a slot is free",
          choice: ({ context }) => {
            const [next, ...rest] = context.queue;
            if (next && context.running.length < slots(context)) {
              return {
                target: "dispatching",
                context: { ...context, queue: rest, running: [...context.running, { ...next, phase: "dispatching" as const }] },
              };
            }
            if (!context.entitlements && context.queue.length > 0) return { target: "ready.blocked" };
            if (context.running.length === 0) return { target: "ready.idle" };
            if (context.queue.length > 0) return { target: "ready.saturated" };
            return { target: "ready.building" };
          },
        },
        dispatching: {
          description: "Creating the BuildWorkflow instance",
          invoke: {
            src: "dispatchBuild",
            input: ({ context }) => ({ ...pickTicket(dispatchingTicket(context)!), accountId: context.accountId }),
            onDone: ({ context, event, actions }, enq) => {
              const ticket = dispatchingTicket(context);
              if (!ticket) return { target: "scheduling" };
              enq(actions.toProject, {
                projectId: ticket.projectId,
                event: { type: "build.start", buildId: ticket.buildId, at: event.output.startedAt },
              });
              return {
                target: "scheduling",
                context: {
                  ...context,
                  running: context.running.map((r) => (r.buildId === ticket.buildId ? { ...r, phase: "running" as const } : r)),
                },
              };
            },
            onError: ({ context, event, actions }, enq) => {
              const ticket = dispatchingTicket(context);
              if (!ticket) return { target: "scheduling" };
              enq(actions.toProject, {
                projectId: ticket.projectId,
                event: {
                  type: "build.completed",
                  buildId: ticket.buildId,
                  result: { outcome: "failed", error: `Dispatch failed: ${String(event.error)}`, step: null },
                },
              });
              return { target: "scheduling", context: finished(context, ticket.buildId, "failed") };
            },
          },
        },
      },
    },
  },
});
