import { Schema } from "effect";
import { setup } from "xstate";
import { standardSchemaValidator } from "xstate/validation";
import { CLEARING_MS, OutboxFailed, std } from "./schema";

const Waiting = Schema.Struct({ transferId: Schema.String, amount: Schema.Number });

const BankContext = Schema.Struct({
  /** Transfers waiting to clear, oldest first. The first one is clearing. */
  queue: Schema.Array(Waiting),
  /** Accounts that visited, newest first, so visitors can pay each other. */
  accounts: Schema.Array(Schema.String),
  completed: Schema.Number,
  refunded: Schema.Number,
  volume: Schema.Number,
});
type BankContext = typeof BankContext.Type;

const seen = (context: BankContext, accountId: string) => [accountId, ...context.accounts.filter((a) => a !== accountId)].slice(0, 40);

/**
 * The one clearing house every transfer goes through, shared by every visitor.
 * It clears one transfer at a time, so when it's busy your transfer waits
 * behind everyone else's.
 */
export const bankMachine = setup({
  validator: standardSchemaValidator(),
  actions: {
    toTransfer: (_message: { transferId: string; event: { type: string } }) => {},
  },
  schemas: {
    context: std(BankContext),
    events: {
      "clear.request": std(Waiting),
      "transfer.settled": std(Schema.Struct({ transferId: Schema.String, amount: Schema.Number, outcome: Schema.Literals(["completed", "refunded"]) })),
      "account.seen": std(Schema.Struct({ accountId: Schema.String })),
      "outbox.failed": std(OutboxFailed),
    },
  },
}).createMachine({
  id: "bank",
  version: "1",
  context: { queue: [], accounts: ["alice", "bob"], completed: 0, refunded: 0, volume: 0 },
  initial: "idle",
  states: {
    idle: {
      description: "Nothing to clear",
      on: {
        "clear.request": ({ context, event }) => ({ target: "clearing", context: { ...context, queue: [event] } }),
      },
    },
    clearing: {
      description: `Clears the first transfer in the queue, ${CLEARING_MS / 1000}s each`,
      after: {
        [CLEARING_MS]: ({ context, actions }, enq) => {
          const [head, ...rest] = context.queue;
          if (head) enq(actions.toTransfer, { transferId: head.transferId, event: { type: "transfer.cleared" } });
          return rest.length ? { target: "clearing", reenter: true, context: { ...context, queue: rest } } : { target: "idle", context: { ...context, queue: rest } };
        },
      },
      on: {
        "clear.request": ({ context, event }) => ({ context: { ...context, queue: [...context.queue, event] } }),
      },
    },
  },
  on: {
    "account.seen": ({ context, event }) => ({ context: { ...context, accounts: seen(context, event.accountId) } }),
    "transfer.settled": ({ context, event }) => ({
      context: {
        ...context,
        completed: context.completed + (event.outcome === "completed" ? 1 : 0),
        refunded: context.refunded + (event.outcome === "refunded" ? 1 : 0),
        volume: context.volume + (event.outcome === "completed" ? event.amount : 0),
      },
    }),
    "outbox.failed": ({ context }) => ({ context }),
  },
});
