import { DurableObject } from "cloudflare:workers";
import type { EventFromLogic } from "xstate";
import { DurableMachine } from "durable-machines";
import type { ClockSettings, Envelope } from "durable-machines/protocol";
import { installations, projectsForRepo } from "../domain/registry";
import { installationMachine } from "../machines/installation";

export class Installation extends DurableObject<Env> {
  // Annotated: park reads this.env, whose Installation binding is typed from this class.
  readonly machine: DurableMachine<typeof installationMachine> = new DurableMachine(this, installationMachine, {
    actions: {
      toAccount: ({ accountId, event }) => this.machine.deliver("Account", accountId, { type: "scm.event", event }),
    },
    input: (name) => {
      const installation = installations[name];
      if (!installation) throw new Error(`Unknown installation ${name}`);
      const repos: Record<string, string[]> = {};
      for (const repo of installation.repos) {
        repos[repo.toLowerCase()] = [...new Set(projectsForRepo(repo).map((p) => p.accountId))];
      }
      return { installationId: installation.id, owner: installation.owner, repos, installed: true };
    },
    park: (request) => this.env.Clock.getByName("global").park(request),
  });

  send(event: EventFromLogic<typeof installationMachine>, envelope?: Envelope) {
    return this.machine.send(event, envelope);
  }

  view() {
    return this.machine.view();
  }

  reset() {
    return this.machine.reset();
  }

  setClock(settings: ClockSettings) {
    return this.machine.setClock(settings);
  }

  release(token: string) {
    return this.machine.release(token);
  }
}
