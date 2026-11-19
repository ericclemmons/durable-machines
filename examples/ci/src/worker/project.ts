import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import type { EventFromLogic } from "xstate";
import { Chaos, type ChaosMode } from "../lib/chaos";
import { DurableMachine, MachineCallables } from "durable-machines";
import type { ClockSettings, Envelope } from "durable-machines/protocol";
import { projects } from "../domain/registry";
import { buildMachine } from "../machines/build";
import { projectMachine } from "../machines/project";

export class Project extends DurableObject<Env> {
  readonly chaos = new Chaos();
  readonly machine: DurableMachine<typeof projectMachine> = new DurableMachine({
    logic: projectMachine.provide({
      actions: {
        toAccount: (message) => this.machine.deliver("Account", this.machine.actor.getSnapshot().context.accountId, message),
        terminateWorkflow: (buildId) => {
          this.ctx.waitUntil(
            this.env.BUILD_WORKFLOW.get(buildId)
              .then((instance) => instance.terminate())
              .catch(() => {}),
          );
        },
      },
    }),
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
    env: this.env,
    park: (request) => this.env.Clock.getByName("global").park(request),
    children: { build: buildMachine },
    clientEvents: ["build.cancel", "build.approve", "build.reject", "settings.update"],
    broadcast: (frame) => {
      for (const connection of this.webSockets.getConnections()) connection.send(frame);
    },
  });
  readonly webSockets: WebSockets = new WebSockets({
    state: this.machine,
    callables: new MachineCallables(this.machine as never),
  });
  readonly lifecycle = Lifecycle.install(this).use(this.machine).use(this.webSockets);

  async send(event: EventFromLogic<typeof projectMachine>, envelope?: Envelope) {
    this.chaos.check();
    await this.lifecycle.start();
    return this.machine.send(event, envelope);
  }

  async view() {
    await this.lifecycle.start();
    return this.machine.get();
  }

  async reset() {
    await this.lifecycle.start();
    await this.machine.reset();
  }

  setChaos(mode: ChaosMode | null, seconds: number) {
    this.chaos.set(mode, seconds);
  }

  async setClock(settings: ClockSettings) {
    await this.lifecycle.start();
    await this.machine.setClock(settings);
  }

  async release(token: string) {
    await this.lifecycle.start();
    return this.machine.release(token);
  }
}
