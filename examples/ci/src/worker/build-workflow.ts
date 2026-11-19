import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect } from "effect";
import type { BuildStep, Ticket } from "../domain/scm";
import { callDurableObject } from "durable-machines";
import type { AnyEvent } from "durable-machines/protocol";

type BuildParams = Ticket & { accountId: string };

const STEPS: ReadonlyArray<{ step: BuildStep; seconds: number }> = [
  { step: "clone", seconds: 2 },
  { step: "install", seconds: 3 },
  { step: "build", seconds: 4 },
  { step: "deploy", seconds: 2 },
];

/** Each step fails with this chance, so a run shows both outcomes. */
const STEP_FAILURE_RATE = 0.1;

const FAILURES: Record<BuildStep, string> = {
  clone: "fatal: could not read from remote repository",
  install: "npm ERR! code ERESOLVE: could not resolve dependencies",
  build: "Build command exited with code 1",
  deploy: "Upload to Workers failed: request timed out",
};

const commandFor = ({ commands, sha }: BuildParams, name: BuildStep) => {
  const cd = commands.root && commands.root !== "/" ? `cd ${commands.root.replace(/^\//, "")} && ` : "";
  if (name === "clone") return `git clone --depth 1 && git checkout ${sha.slice(0, 7)}`;
  if (name === "install") return `${cd}npm ci`;
  if (name === "build") return `${cd}${commands.build}`;
  return `${cd}${commands.deploy}`;
};

/**
 * Simulates a Workers Build. It reports `build.step` as each step starts and
 * exactly one `build.completed` at the end. Each step fails at random
 * (STEP_FAILURE_RATE); "[fail]" in a commit message always fails the build step. While the debugger clock is paused, each step waits
 * for "next" instead of its run time.
 */
export class BuildWorkflow extends WorkflowEntrypoint<Env, BuildParams> {
  async run(event: WorkflowEvent<BuildParams>, step: WorkflowStep) {
    const build = event.payload;
    // The message id is the Workflow step, so a retried step is deduplicated by the Project.
    const report = (name: string, message: AnyEvent) =>
      step.do(name, () =>
        Effect.runPromise(
          callDurableObject(
            () => this.env.Project.getByName(build.projectId),
            async (project) =>
              (await project.send(message as never, { messageId: `${event.instanceId}:${name}`, from: `BuildWorkflow/${event.instanceId}` })).ok,
          ),
        ),
      );

    let current: BuildStep | null = null;
    try {
      for (const { step: name, seconds } of STEPS) {
        // No build command: go straight from install to deploy.
        if (name === "build" && !build.commands.build) continue;
        current = name;
        await report(`report ${name}`, { type: "build.step", buildId: build.buildId, step: name, command: commandFor(build, name) });
        // The debugger clock: paused, the step waits for "next"; playing, it runs with the pace added.
        const after = name === "deploy" ? "build.completed" : "build.step";
        const clock = await step.do(`clock ${name}`, async () => {
          const { parked, pace } = await this.env.Clock.getByName("global").park({
            owner: `BuildWorkflow/${event.instanceId}`,
            token: `clock-${name}`,
            to: `Project/${build.projectId}`,
            eventType: after,
          });
          return { parked, pace };
        });
        if (clock.parked) await step.waitForEvent(`wait for next (${name})`, { type: `clock-${name}`, timeout: "1 hour" });
        else await step.sleep(`${name} running`, seconds * 1000 + clock.pace);
        // A coin flip per step. The result is the step's output, so a replay keeps it.
        const failed = await step.do(`${name} result`, async () => (name === "build" && /\[fail\]/i.test(build.message)) || Math.random() < STEP_FAILURE_RATE);
        if (failed) throw new NonRetryableError(FAILURES[name]);
      }
      const host = build.environment === "production" ? build.projectId : `${build.branch.replace(/[^a-z0-9]/gi, "-")}.${build.projectId}`;
      await report("report completed", {
        type: "build.completed",
        buildId: build.buildId,
        result: { outcome: "succeeded", url: `https://${host}.workers.dev`, at: Date.now() },
      });
    } catch (error) {
      await report("report completed", {
        type: "build.completed",
        buildId: build.buildId,
        result: {
          outcome: "failed",
          error: (error instanceof Error ? error.message : String(error)).replace(/^\w*Error: /, ""),
          step: current,
          at: Date.now(),
        },
      });
    }
  }
}
