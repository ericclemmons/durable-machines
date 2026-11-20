import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import type { EventFromLogic } from "xstate";
import { DurableMachine } from "durable-machines";
import type { Envelope } from "durable-machines/protocol";
import { accountMachine } from "../machines/account";
import { bankMachine } from "../machines/bank";
import { TransferStart, transferMachine } from "../machines/transfer";

/** Each hop between objects waits this long, so you can watch it travel. */
const PACE = 700;
const OPENING_BALANCE = 100;
const decodeStart = Schema.decodeUnknownSync(TransferStart);

/** One account per visitor, named by IP. Visitors only watch it over WebSocket; changes go through the Worker. */
export class Account extends DurableObject<Env> {
  readonly machine = new DurableMachine(this, accountMachine, {
    input: (accountId) => ({ accountId, balance: OPENING_BALANCE, frozen: false }),
    actions: { toTransfer: ({ transferId, event }) => this.machine.deliver("Transfer", transferId, event) },
    pace: PACE,
  });

  send(event: EventFromLogic<typeof accountMachine>, envelope?: Envelope) {
    return this.machine.send(event, envelope);
  }

  view() {
    return this.machine.view();
  }

  reset() {
    return this.machine.reset();
  }
}

/** One per transfer: the saga that moves money between two Accounts. */
export class Transfer extends DurableObject<Env> {
  readonly machine = new DurableMachine(this, transferMachine, {
    createdBy: { event: "transfer.start", input: (event, transferId) => ({ transferId, ...decodeStart(event) }) },
    actions: {
      toAccount: ({ accountId, event }) => this.machine.deliver("Account", accountId, event),
      toBank: (event) => this.machine.deliver("Bank", "global", event),
    },
    pace: PACE,
  });

  send(event: EventFromLogic<typeof transferMachine> | ({ type: "transfer.start" } & typeof TransferStart.Type), envelope?: Envelope) {
    return event.type === "transfer.start" ? this.machine.create(event, envelope) : this.machine.send(event, envelope);
  }

  view() {
    return this.machine.view();
  }
}

/** The clearing house, shared by every visitor. */
export class Bank extends DurableObject<Env> {
  readonly machine = new DurableMachine(this, bankMachine, {
    actions: { toTransfer: ({ transferId, event }) => this.machine.deliver("Transfer", transferId, event) },
    pace: PACE,
    journalSize: 60,
  });

  send(event: EventFromLogic<typeof bankMachine>, envelope?: Envelope) {
    return this.machine.send(event, envelope);
  }

  view() {
    return this.machine.view();
  }
}
