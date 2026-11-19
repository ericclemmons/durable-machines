import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import type { EventFromLogic } from "xstate";
import { DurableMachine, MachineCallables } from "durable-machines";
import type { Envelope } from "durable-machines/protocol";
import { accountMachine } from "../machines/account";
import { bankMachine } from "../machines/bank";
import { transferMachine } from "../machines/transfer";

/** Each hop between objects waits this long, so you can watch it travel. */
const PACE = 700;
const OPENING_BALANCE = 100;

/** One account per visitor, named by IP. Visitors only watch it over WebSocket; changes go through the Worker. */
export class Account extends DurableObject<Env> {
  readonly machine: DurableMachine<typeof accountMachine> = new DurableMachine({
    logic: accountMachine.provide({
      actions: { toTransfer: ({ transferId, event }) => this.machine.deliver("Transfer", transferId, event) },
    }),
    input: (accountId) => ({ accountId, balance: OPENING_BALANCE, frozen: false }),
    env: this.env,
    pace: PACE,
    broadcast: (frame) => {
      for (const connection of this.webSockets.getConnections()) connection.send(frame);
    },
  });
  readonly webSockets: WebSockets = new WebSockets({ state: this.machine, callables: new MachineCallables(this.machine as never) });
  readonly lifecycle = Lifecycle.install(this).use(this.machine).use(this.webSockets);

  async send(event: EventFromLogic<typeof accountMachine>, envelope?: Envelope) {
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
}

/** One per transfer: the saga that moves money between two Accounts. */
export class Transfer extends DurableObject<Env> {
  readonly machine: DurableMachine<typeof transferMachine> = new DurableMachine({
    logic: transferMachine.provide({
      actions: {
        toAccount: ({ accountId, event }) => this.machine.deliver("Account", accountId, event),
        toBank: (event) => this.machine.deliver("Bank", "global", event),
      },
    }),
    input: (transferId) => ({ transferId }),
    env: this.env,
    pace: PACE,
    broadcast: (frame) => {
      for (const connection of this.webSockets.getConnections()) connection.send(frame);
    },
  });
  readonly webSockets: WebSockets = new WebSockets({ state: this.machine, callables: new MachineCallables(this.machine as never) });
  readonly lifecycle = Lifecycle.install(this).use(this.machine).use(this.webSockets);

  async send(event: EventFromLogic<typeof transferMachine>, envelope?: Envelope) {
    await this.lifecycle.start();
    return this.machine.send(event, envelope);
  }

  async view() {
    await this.lifecycle.start();
    return this.machine.get();
  }
}

/** The clearing house, shared by every visitor. */
export class Bank extends DurableObject<Env> {
  readonly machine: DurableMachine<typeof bankMachine> = new DurableMachine({
    logic: bankMachine.provide({
      actions: { toTransfer: ({ transferId, event }) => this.machine.deliver("Transfer", transferId, event) },
    }),
    input: () => undefined as never,
    env: this.env,
    pace: PACE,
    journalSize: 60,
    broadcast: (frame) => {
      for (const connection of this.webSockets.getConnections()) connection.send(frame);
    },
  });
  readonly webSockets: WebSockets = new WebSockets({ state: this.machine, callables: new MachineCallables(this.machine as never) });
  readonly lifecycle = Lifecycle.install(this).use(this.machine).use(this.webSockets);

  async send(event: EventFromLogic<typeof bankMachine>, envelope?: Envelope) {
    await this.lifecycle.start();
    return this.machine.send(event, envelope);
  }

  async view() {
    await this.lifecycle.start();
    return this.machine.get();
  }
}
