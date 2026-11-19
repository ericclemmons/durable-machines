import { DurableObject } from "cloudflare:workers";
import type { EventFromLogic } from "xstate";
import { Chaos, type ChaosMode } from "../lib/chaos";
import { DurableMachine } from "durable-machines";
import type { ClockSettings, Envelope } from "durable-machines/protocol";
import { projects } from "../domain/registry";
import { buildMachine } from "../machines/build";
import { projectMachine } from "../machines/project";

export class Project extends DurableObject<Env> {
  readonly chaos = new Chaos();
  // Annotated: toAccount reads this.machine.snapshot, which would make the type circular.
  readonly machine: DurableMachine<typeof projectMachine> = new DurableMachine(this, projectMachine, {
    actions: {
      toAccount: (message) => this.machine.deliver("Account", this.machine.snapshot.context.accountId, message),
      terminateWorkflow: (buildId) => {
        this.ctx.waitUntil(
          this.env.BUILD_WORKFLOW.get(buildId)
            .then((instance) => instance.terminate())
            .catch(() => {}),
        );
      },
    },
    input: (name) => {
      const project = projects[name];
      if (!project) throw new Error(`Unknown project ${name}`);
      return {
        projectId: project.id,
        accountId: project.accountId,
        repo: project.repo,
        productionBranch: project.productionBranch,
        generation: Date.now().toString(36),
      };
    },
    park: (request) => this.env.Clock.getByName("global").park(request),
    children: { build: buildMachine },
    clientEvents: ["build.cancel", "build.approve", "build.reject", "settings.update"],
  });

  send(event: EventFromLogic<typeof projectMachine>, envelope?: Envelope) {
    this.chaos.check();
    return this.machine.send(event, envelope);
  }

  view() {
    return this.machine.view();
  }

  reset() {
    return this.machine.reset();
  }

  setChaos(mode: ChaosMode | null, seconds: number) {
    this.chaos.set(mode, seconds);
  }

  setClock(settings: ClockSettings) {
    return this.machine.setClock(settings);
  }

  release(token: string) {
    return this.machine.release(token);
  }
}
