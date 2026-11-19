import { DurableObject } from "cloudflare:workers";
import { Data, Effect, Schedule } from "effect";
import { createAsyncLogic, type EventFromLogic } from "xstate";
import { Chaos, type ChaosMode } from "../lib/chaos";
import { DurableMachine } from "durable-machines";
import type { ClockSettings, Envelope } from "durable-machines/protocol";
import { accounts, entitlements, projectsFor } from "../domain/registry";
import type { Ticket } from "../domain/scm";
import { accountMachine } from "../machines/account";

class DispatchError extends Data.TaggedError("DispatchError")<{ cause: unknown }> {}

/** Create the BuildWorkflow instance. Idempotent: a retry after eviction reuses the instance. */
const startWorkflow = (env: Env, ticket: Ticket & { accountId: string }) =>
  Effect.tryPromise({
    try: async () => {
      try {
        await env.BUILD_WORKFLOW.create({ id: ticket.buildId, params: ticket });
      } catch (error) {
        if (!String(error).includes("already exists")) throw error;
      }
      return { startedAt: Date.now() };
    },
    catch: (cause) => new DispatchError({ cause }),
  }).pipe(Effect.retry({ times: 3, schedule: Schedule.exponential("200 millis") }));

/** Stand-in for the billing backend: a slow network call. */
const readEntitlements = async (accountId: string) => {
  await scheduler.wait(400);
  const found = entitlements[accountId];
  if (!found) throw new Error(`No entitlements for ${accountId}`);
  return { ...found, fetchedAt: Date.now() };
};

export class Account extends DurableObject<Env> {
  #loadedOnce = false;
  readonly chaos = new Chaos();
  // Annotated: the actors read this.machine, which would make the type circular.
  readonly machine: DurableMachine<typeof accountMachine> = new DurableMachine(this, accountMachine, {
    actors: {
      dispatchBuild: createAsyncLogic({
        run: async ({ input }: { input: Ticket & { accountId: string } }) => {
          await this.machine.hold("BuildWorkflow", "create()");
          return Effect.runPromise(startWorkflow(this.env, input));
        },
      }),
      fetchEntitlements: createAsyncLogic({
        run: async ({ input }: { input: { accountId: string } }) => {
          // The first load happens when the Account boots (or resets), before any run: don't park it.
          if (this.#loadedOnce) await this.machine.hold("billing", "fetch entitlements");
          this.#loadedOnce = true;
          return readEntitlements(input.accountId);
        },
      }),
    },
    actions: {
      toProject: ({ projectId, event }) => this.machine.deliver("Project", projectId, event),
    },
    input: (name) => {
      const account = accounts[name];
      if (!account) throw new Error(`Unknown account ${name}`);
      const repos: Record<string, string[]> = {};
      for (const p of projectsFor(name)) (repos[p.repo.toLowerCase()] ??= []).push(p.id);
      return { accountId: account.id, name: account.name, repos };
    },
    park: (request) => this.env.Clock.getByName("global").park(request),
    clientEvents: ["entitlements.refresh"],
  });

  /** The one way in: other Workers and Durable Objects send typed events. */
  send(event: EventFromLogic<typeof accountMachine>, envelope?: Envelope) {
    this.chaos.check();
    return this.machine.send(event, envelope);
  }

  view() {
    return this.machine.view();
  }

  async reset() {
    this.#loadedOnce = false;
    await this.machine.reset();
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
