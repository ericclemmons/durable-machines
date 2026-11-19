import { Schema } from "effect";
import { setup } from "xstate";
import { standardSchemaValidator } from "xstate/validation";
import { BuildStep, OutboxFailed, Outcome, ProjectSettings, ScmEvent, std, type Ticket } from "../domain/scm";
import { BuildCompleted, buildMachine } from "./build";

const ActiveBuild = Schema.Struct({
  buildId: Schema.String,
  buildNumber: Schema.Number,
  branch: Schema.String,
  sha: Schema.String,
  message: Schema.String,
  environment: Schema.Literals(["production", "preview"]),
  prNumber: Schema.NullOr(Schema.Number),
  fromFork: Schema.Boolean,
  phase: Schema.Literals(["awaiting_approval", "queued", "running"]),
});
type ActiveBuild = typeof ActiveBuild.Type;

const Settled = {
  outcome: Outcome,
  error: Schema.NullOr(Schema.String),
  step: Schema.NullOr(BuildStep),
  url: Schema.NullOr(Schema.String),
};
const FinishedBuild = Schema.Struct({ ...ActiveBuild.fields, ...Settled });

const Decision = Schema.Struct({
  deliveryId: Schema.String,
  summary: Schema.String,
  verdict: Schema.Literals(["build", "approval", "ignored"]),
  reason: Schema.String,
  buildId: Schema.NullOr(Schema.String),
});
type Decision = typeof Decision.Type;

const PullRequest = Schema.Struct({ number: Schema.Number, fromFork: Schema.Boolean, headSha: Schema.String });

export const ProjectInput = Schema.Struct({
  projectId: Schema.String,
  accountId: Schema.String,
  repo: Schema.String,
  productionBranch: Schema.String,
  /** Changes on every reset, so Workflow instance ids never collide. */
  generation: Schema.String,
});

const ProjectContext = Schema.Struct({
  ...ProjectInput.fields,
  /** Open PRs by head branch. A non-production push builds only while its branch has one. */
  openPullRequests: Schema.Record(Schema.String, PullRequest),
  settings: ProjectSettings,
  nextBuildNumber: Schema.Number,
  active: Schema.Array(ActiveBuild),
  history: Schema.Array(FinishedBuild),
  decisions: Schema.Array(Decision),
});
type ProjectContext = typeof ProjectContext.Type;

/** Messages a Project sends to its Account. Delivered through the durable outbox. */
export type ToAccount =
  | { type: "build.requested"; ticket: Ticket }
  | { type: "build.finished"; buildId: string; projectId: string; outcome: Outcome };

const keep = <T>(items: ReadonlyArray<T>, max: number) => items.slice(-max);

type Plan = {
  openPullRequests: ProjectContext["openPullRequests"];
  summary: string;
  reason: string;
  build: null | {
    environment: "production" | "preview";
    prNumber: number | null;
    fromFork: boolean;
    branch: string;
    sha: string;
    message: string;
  };
};

/**
 * Turns SCM events into builds:
 * - A push to the production branch builds.
 * - Any other push builds only while its branch has an open PR. Closing the PR stops that.
 * - Opening or reopening a PR builds its head commit, unless that commit already has a build.
 * - Fork PRs never send pushes. Their commits arrive as `pull_request.synchronize`,
 *   and every fork build waits for approval.
 */
function decide(context: ProjectContext, event: ScmEvent): Plan {
  const openPullRequests = { ...context.openPullRequests };
  const summary =
    event.kind === "push"
      ? `push ${event.branch}@${event.sha.slice(0, 7)}`
      : `pull_request.${event.action} #${event.number}${event.fromFork ? " (fork)" : ""} ${event.branch}@${event.sha.slice(0, 7)}`;
  const ignore = (reason: string): Plan => ({ openPullRequests, summary, reason, build: null });
  const build = (environment: "production" | "preview", prNumber: number | null, fromFork: boolean, reason: string): Plan =>
    environment === "preview" && !context.settings.previewBuilds
      ? ignore("Non-production branch builds are turned off in settings")
      : {
          openPullRequests,
          summary,
          reason,
          build: { environment, prNumber, fromFork, branch: event.branch, sha: event.sha, message: event.kind === "push" ? event.message : event.title },
        };
  const hasBuild = (sha: string) => context.active.some((b) => b.sha === sha);

  if (event.kind === "pull_request") {
    if (event.action === "closed") {
      delete openPullRequests[event.branch];
      return ignore(event.merged ? "PR merged; the push to the base branch builds it" : `PR closed; pushes to ${event.branch} stop building`);
    }
    openPullRequests[event.branch] = { number: event.number, fromFork: event.fromFork, headSha: event.sha };
    if (event.action === "synchronize" && !event.fromFork) return ignore("New commits build from the push event");
    if (hasBuild(event.sha)) return ignore(`Head commit ${event.sha.slice(0, 7)} already has a build`);
    if (event.fromFork) return build("preview", event.number, true, `Fork PR #${event.number}: needs approval`);
    return build("preview", event.number, false, `PR #${event.number} ${event.action}: builds head ${event.sha.slice(0, 7)}`);
  }

  if (event.deleted) return ignore("Branch deleted");
  if (event.branch === context.productionBranch) return build("production", null, false, "Production branch");
  const pr = openPullRequests[event.branch];
  if (pr === undefined) return ignore(`No open PR for ${event.branch}`);
  if (hasBuild(event.sha)) return ignore(`Commit ${event.sha.slice(0, 7)} already has a build`);
  openPullRequests[event.branch] = { ...pr, headSha: event.sha };
  return build("preview", pr.number, false, `Commit on PR #${pr.number}`);
}

const withPhase = (context: ProjectContext, buildId: string, phase: ActiveBuild["phase"]) => ({
  ...context,
  active: context.active.map((b) => (b.buildId === buildId ? { ...b, phase } : b)),
});

const ticketFor = (context: ProjectContext, b: ActiveBuild): Ticket => ({
  buildId: b.buildId,
  buildNumber: b.buildNumber,
  projectId: context.projectId,
  branch: b.branch,
  sha: b.sha,
  message: b.message,
  environment: b.environment,
  commands: {
    root: context.settings.rootDirectory,
    build: context.settings.buildCommand,
    deploy: b.environment === "production" ? context.settings.deployCommand : context.settings.previewDeployCommand,
  },
});

export const projectMachine = setup({
  validator: standardSchemaValidator(),
  actors: { build: buildMachine },
  actions: {
    toAccount: (_message: ToAccount) => {},
    terminateWorkflow: (_buildId: string) => {},
  },
  schemas: {
    input: std(ProjectInput),
    context: std(ProjectContext),
    events: {
      "scm.event": std(Schema.Struct({ event: ScmEvent })),
      "build.approve": std(Schema.Struct({ buildId: Schema.String })),
      "build.reject": std(Schema.Struct({ buildId: Schema.String })),
      "build.cancel": std(Schema.Struct({ buildId: Schema.String })),
      "build.start": std(Schema.Struct({ buildId: Schema.String, at: Schema.Number })),
      "build.step": std(Schema.Struct({ buildId: Schema.String, step: BuildStep, command: Schema.String })),
      "settings.update": std(Schema.Struct({ settings: ProjectSettings })),
      "build.completed": std(Schema.Struct({ buildId: Schema.String, result: BuildCompleted })),
      "build.settled": std(Schema.Struct({ buildId: Schema.String, ...Settled })),
      "outbox.failed": std(OutboxFailed),
    },
  },
}).createMachine({
  id: "project",
  version: "2",
  context: ({ input }) => ({
    ...input,
    openPullRequests: {},
    settings: {
      rootDirectory: "/",
      buildCommand: "npm run build",
      deployCommand: "npx wrangler deploy",
      previewDeployCommand: "npx wrangler versions upload",
      previewBuilds: true,
    },
    nextBuildNumber: 1,
    active: [],
    history: [],
    decisions: [],
  }),
  initial: "idle",
  on: {
    // Applies to builds requested from now on; queued builds keep their commands.
    "settings.update": ({ context, event }) => ({ context: { ...context, settings: event.settings } }),

    "scm.event": ({ context, event, children, actions }, enq) => {
      const plan = decide(context, event.event);
      const record = (d: Omit<Decision, "deliveryId" | "summary">) =>
        keep([...context.decisions, { deliveryId: event.event.deliveryId, summary: plan.summary, ...d }], 12);

      if (!plan.build) {
        return {
          target: ".sync",
          context: {
            ...context,
            openPullRequests: plan.openPullRequests,
            decisions: record({ verdict: "ignored", reason: plan.reason, buildId: null }),
          },
        };
      }

      const buildNumber = context.nextBuildNumber;
      const buildId = `${context.projectId}-${context.generation}-${buildNumber}`;
      const requiresApproval = plan.build.fromFork;
      const active: ActiveBuild = { buildId, buildNumber, ...plan.build, phase: requiresApproval ? "awaiting_approval" : "queued" };
      const superseded = context.active.filter((b) => b.phase !== "running" && b.branch === active.branch);
      for (const old of superseded) enq.sendTo(children[old.buildId], { type: "build.supersede", by: buildId });

      enq.spawn("build", {
        id: buildId,
        input: {
          buildId,
          buildNumber,
          branch: active.branch,
          sha: active.sha,
          message: active.message,
          environment: active.environment,
          prNumber: active.prNumber,
          requiresApproval,
          projectId: context.projectId,
          accountId: context.accountId,
        },
      });
      // Builds awaiting approval do not hold a place in the Account's queue.
      if (!requiresApproval) enq(actions.toAccount, { type: "build.requested", ticket: ticketFor(context, active) });

      return {
        target: ".sync",
        context: {
          ...context,
          openPullRequests: plan.openPullRequests,
          nextBuildNumber: buildNumber + 1,
          active: [...context.active, active],
          decisions: record({
            verdict: requiresApproval ? "approval" : "build",
            reason: superseded.length ? `${plan.reason}; supersedes ${superseded.map((b) => `#${b.buildNumber}`).join(", ")}` : plan.reason,
            buildId,
          }),
        },
      };
    },

    "build.approve": ({ context, event, children, actions }, enq) => {
      const build = context.active.find((b) => b.buildId === event.buildId);
      if (build?.phase !== "awaiting_approval") return;
      enq.sendTo(children[build.buildId], { type: "build.approve", by: "maintainer" });
      enq(actions.toAccount, { type: "build.requested", ticket: ticketFor(context, build) });
      return { target: ".sync", context: withPhase(context, build.buildId, "queued") };
    },

    "build.reject": ({ context, event, children }, enq) => {
      const build = context.active.find((b) => b.buildId === event.buildId);
      if (build?.phase !== "awaiting_approval") return;
      enq.sendTo(children[build.buildId], { type: "build.reject", by: "maintainer" });
    },

    "build.start": ({ context, event, children, actions }, enq) => {
      const build = context.active.find((b) => b.buildId === event.buildId);
      if (build?.phase !== "queued") {
        // The Account granted a slot to a build that settled meanwhile.
        enq(actions.terminateWorkflow, event.buildId);
        enq(actions.toAccount, { type: "build.finished", buildId: event.buildId, projectId: context.projectId, outcome: "skipped" });
        return {};
      }
      enq.sendTo(children[event.buildId], { type: "build.started", at: event.at });
      return { target: ".sync", context: withPhase(context, event.buildId, "running") };
    },

    "build.step": ({ event, children }, enq) => {
      // A build that was canceled or superseded is gone; its Workflow may still report.
      const child = children[event.buildId];
      if (child) enq.sendTo(child, { type: "build.step", step: event.step, command: event.command });
    },
    "build.completed": ({ event, children }, enq) => {
      // A build that was canceled or superseded is gone; its Workflow may still report.
      const child = children[event.buildId];
      if (child) enq.sendTo(child, { type: "build.completed", ...event.result });
    },
    "build.cancel": ({ context, event, children, actions }, enq) => {
      const build = context.active.find((b) => b.buildId === event.buildId);
      if (!build) return;
      if (build.phase === "running") enq(actions.terminateWorkflow, event.buildId);
      enq.sendTo(children[event.buildId], { type: "build.cancel", reason: "Canceled from the dashboard" });
    },

    "build.settled": ({ context, event, children, actions }, enq) => {
      const build = context.active.find((b) => b.buildId === event.buildId);
      if (!build) return;
      // Only builds that were sent to the Account need to give their slot or queue place back.
      if (build.phase !== "awaiting_approval") {
        enq(actions.toAccount, { type: "build.finished", buildId: event.buildId, projectId: context.projectId, outcome: event.outcome });
      }
      const child = children[event.buildId];
      if (child) enq.stop(child);
      return {
        target: ".sync",
        context: {
          ...context,
          active: context.active.filter((b) => b.buildId !== event.buildId),
          history: keep([...context.history, { ...build, outcome: event.outcome, error: event.error, step: event.step, url: event.url }], 8),
        },
      };
    },

    // The Account never got the request: fail the build instead of leaving it queued forever.
    "outbox.failed": ({ context, event, children }, enq) => {
      if (event.eventType !== "build.requested") return;
      const { ticket } = event.event as Extract<ToAccount, { type: "build.requested" }>;
      const build = context.active.find((b) => b.buildId === ticket.buildId);
      if (!build) return;
      enq.sendTo(children[build.buildId], { type: "build.cancel", reason: `Could not reach the Account: ${event.reason}` });
    },
  },
  states: {
    sync: {
      type: "choice",
      choice: ({ context }) => {
        if (context.active.some((b) => b.phase === "running")) return { target: "building" };
        if (context.active.some((b) => b.phase === "queued")) return { target: "queued" };
        if (context.active.length > 0) return { target: "awaiting_approval" };
        return { target: "idle" };
      },
    },
    idle: { description: "No pending or running builds" },
    awaiting_approval: { description: "Only fork builds that wait for a maintainer" },
    queued: { description: "Builds wait for an Account concurrency slot" },
    building: { description: "At least one BuildWorkflow is running" },
  },
});
