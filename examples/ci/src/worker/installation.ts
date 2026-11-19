import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import type { EventFromLogic } from "xstate";
import { DurableMachine, MachineCallables } from "durable-machines";
import type { ClockSettings, Envelope } from "durable-machines/protocol";
import { installations, projectsForRepo } from "../domain/registry";
import { installationMachine } from "../machines/installation";

export class Installation extends DurableObject<Env> {
  readonly machine: DurableMachine<typeof installationMachine> = new DurableMachine({
    logic: installationMachine.provide({
      actions: {
        toAccount: ({ accountId, event }) => this.machine.deliver("Account", accountId, { type: "scm.event", event }),
      },
    }),
    input: (name) => {
      const installation = installations[name];
      if (!installation) throw new Error(`Unknown installation ${name}`);
      const repos: Record<string, string[]> = {};
      for (const repo of installation.repos) {
        repos[repo.toLowerCase()] = [...new Set(projectsForRepo(repo).map((p) => p.accountId))];
      }
      return { installationId: installation.id, owner: installation.owner, repos, installed: true };
    },
    env: this.env,
    park: (request) => this.env.Clock.getByName("global").park(request),
    broadcast: (frame) => {
      for (const connection of this.webSockets.getConnections()) connection.send(frame);
    },
  });
  readonly webSockets: WebSockets = new WebSockets({
    state: this.machine,
    callables: new MachineCallables(this.machine as never),
  });
  readonly lifecycle = Lifecycle.install(this).use(this.machine).use(this.webSockets);

  async send(event: EventFromLogic<typeof installationMachine>, envelope?: Envelope) {
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

  async setClock(settings: ClockSettings) {
    await this.lifecycle.start();
    await this.machine.setClock(settings);
  }

  async release(token: string) {
    await this.lifecycle.start();
    return this.machine.release(token);
  }
}
