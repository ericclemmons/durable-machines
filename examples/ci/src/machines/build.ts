import { Schema } from "effect";
import { setup } from "xstate";
import { standardSchemaValidator } from "xstate/validation";
import { BuildStep, Outcome, std } from "../domain/scm";

export const BuildInput = Schema.Struct({
  buildId: Schema.String,
  buildNumber: Schema.Number,
  projectId: Schema.String,
  accountId: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  message: Schema.String,
  environment: Schema.Literals(["production", "preview"]),
  prNumber: Schema.NullOr(Schema.Number),
  /** Fork PRs wait for a maintainer before they use a build slot. */
  requiresApproval: Schema.Boolean,
});
export type BuildInput = typeof BuildInput.Type;

const BuildContext = Schema.Struct({
  ...BuildInput.fields,
  step: Schema.NullOr(BuildStep),
  /** The command the current step runs. */
  command: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

/** The one terminal report from a BuildWorkflow. */
export const BuildCompleted = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("succeeded"), url: Schema.String, at: Schema.Number }),
  Schema.Struct({ outcome: Schema.Literal("failed"), error: Schema.String, step: Schema.NullOr(BuildStep), at: Schema.Number }),
]);

/**
 * One build, spawned by its Project. Commands (approve, reject, cancel,
 * supersede) come from people and the Project. Facts (started, step,
 * completed) come from the Account and the BuildWorkflow. Every path ends
 * in a final state, which tells the Project with `build.settled`.
 */
export const buildMachine = setup({
  validator: standardSchemaValidator(),
  schemas: {
    input: std(BuildInput),
    context: std(BuildContext),
    events: {
      "build.approve": std(Schema.Struct({ by: Schema.String })),
      "build.reject": std(Schema.Struct({ by: Schema.String })),
      "build.started": std(Schema.Struct({ at: Schema.Number })),
      "build.step": std(Schema.Struct({ step: BuildStep, command: Schema.String })),
      "build.completed": std(BuildCompleted),
      "build.cancel": std(Schema.Struct({ reason: Schema.String })),
      "build.supersede": std(Schema.Struct({ by: Schema.String })),
    },
  },
}).createMachine({
  id: "build",
  version: "3",
  context: ({ input }) => ({ ...input, step: null, command: null, startedAt: null, finishedAt: null, url: null, error: null }),
  initial: "pending",
  states: {
    pending: {
      type: "choice",
      choice: ({ context }) => (context.requiresApproval ? { target: "awaiting_approval" } : { target: "queued" }),
    },
    awaiting_approval: {
      description: "Fork PR: a maintainer must approve before it can run",
      on: {
        "build.approve": { target: "queued" },
        "build.reject": ({ context, event }) => ({ target: "rejected", context: { ...context, error: `Rejected by ${event.by}` } }),
        "build.supersede": ({ context, event }) => ({ target: "superseded", context: { ...context, error: `Superseded by ${event.by}` } }),
        "build.cancel": ({ context, event }) => ({ target: "canceled", context: { ...context, error: event.reason } }),
      },
    },
    queued: {
      description: "Waiting for the Account to grant a concurrency slot",
      on: {
        "build.started": ({ context, event }) => ({ target: "running", context: { ...context, startedAt: event.at } }),
        // The Workflow and the Account report on separate paths, so the first step can beat build.started.
        "build.step": ({ context, event }) =>
          event.step === "clone"
            ? { target: "running.cloning", context: { ...context, step: event.step, command: event.command, startedAt: context.startedAt ?? Date.now() } }
            : undefined,
        "build.supersede": ({ context, event }) => ({ target: "superseded", context: { ...context, error: `Superseded by ${event.by}` } }),
        "build.cancel": ({ context, event }) => ({ target: "canceled", context: { ...context, error: event.reason } }),
        "build.completed": ({ context, event }) =>
          event.outcome === "failed"
            ? { target: "failed", context: { ...context, error: event.error, finishedAt: event.at } }
            : undefined,
      },
    },
    running: {
      description: "BuildWorkflow is executing. Each step reports back.",
      initial: "cloning",
      timeout: 5 * 60_000,
      onTimeout: ({ context }) => ({ target: "failed", context: { ...context, error: "Timed out after 5 minutes" } }),
      // Steps run in order: clone → install → build → deploy. Each step only
      // accepts a later one, so a step can be skipped but never repeated or run
      // backwards. Skips leave room for a deploy-only path (for example
      // when a project has no install or build step).
      states: {
        cloning: {
          on: {
            "build.step": ({ context, event }) => {
              const next = { ...context, step: event.step, command: event.command };
              // build.started already entered cloning; record the clone command.
              if (event.step === "clone") return { context: next };
              if (event.step === "install") return { target: "installing", context: next };
              if (event.step === "build") return { target: "building", context: next };
              if (event.step === "deploy") return { target: "deploying", context: next };
            },
          },
        },
        installing: {
          on: {
            "build.step": ({ context, event }) => {
              const next = { ...context, step: event.step, command: event.command };
              if (event.step === "build") return { target: "building", context: next };
              if (event.step === "deploy") return { target: "deploying", context: next };
            },
          },
        },
        building: {
          on: {
            "build.step": ({ context, event }) =>
              event.step === "deploy" ? { target: "deploying", context: { ...context, step: event.step, command: event.command } } : undefined,
          },
        },
        deploying: {},
      },
      on: {
        // Arrives after the first step when the Workflow reported first; keep the Account's start time.
        "build.started": ({ context, event }) => ({ context: { ...context, startedAt: event.at } }),
        "build.completed": ({ context, event }) =>
          event.outcome === "succeeded"
            ? { target: "succeeded", context: { ...context, url: event.url, finishedAt: event.at } }
            : { target: "failed", context: { ...context, error: event.error, step: event.step, finishedAt: event.at } },
        "build.cancel": ({ context, event }) => ({ target: "canceled", context: { ...context, error: event.reason } }),
      },
    },
    succeeded: { type: "final", entry: settle("succeeded") },
    failed: { type: "final", entry: settle("failed") },
    canceled: { type: "final", entry: settle("canceled") },
    superseded: { type: "final", entry: settle("superseded") },
    rejected: { type: "final", entry: settle("rejected") },
  },
});

/** Tell the parent Project that this build reached a final state. */
function settle(outcome: Outcome) {
  return (
    { context, parent }: { context: { buildId: string; error: string | null; step: BuildStep | null; url: string | null }; parent?: unknown },
    enq: { sendTo: (target: never, event: never) => void },
  ) => {
    const { buildId, error, step, url } = context;
    enq.sendTo(parent as never, { type: "build.settled", buildId, outcome, error, step, url } as never);
  };
}
