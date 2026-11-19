import { Schema } from "effect";
import { setup } from "xstate";
import { standardSchemaValidator } from "xstate/validation";
import { Amount, OutboxFailed, std } from "./schema";

export const AccountInput = Schema.Struct({
  accountId: Schema.String,
  balance: Schema.Number,
  frozen: Schema.Boolean,
});

const Entry = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["deposit", "withdrawal", "sent", "received"]),
  amount: Schema.Number,
  counterparty: Schema.NullOr(Schema.String),
  status: Schema.Literals(["done", "pending", "refunded"]),
  at: Schema.Number,
});
type Entry = typeof Entry.Type;

const AccountContext = Schema.Struct({
  accountId: Schema.String,
  balance: Schema.Number,
  /** Money set aside for transfers that haven't settled, by transfer id. */
  holds: Schema.Record(Schema.String, Schema.Number),
  ledger: Schema.Array(Entry),
  /** Why the last request was refused, for the owner. */
  notice: Schema.NullOr(Schema.String),
});
type AccountContext = typeof AccountContext.Type;

type ToTransfer = { transferId: string; event: { type: string; [key: string]: unknown } };

const record = (context: AccountContext, entry: Entry): AccountContext => ({
  ...context,
  notice: null,
  ledger: [entry, ...context.ledger.filter((e) => e.id !== entry.id)].slice(0, 12),
});

const mark = (context: AccountContext, id: string, status: Entry["status"]): AccountContext => ({
  ...context,
  ledger: context.ledger.map((e) => (e.id === id ? { ...e, status } : e)),
});

const release = (context: AccountContext, transferId: string) => {
  const { [transferId]: _, ...holds } = context.holds;
  return holds;
};

/**
 * One bank account per visitor. It owns the balance, sets money aside when its
 * owner sends a transfer, and answers the Transfer that moves it. A frozen
 * account still settles its own transfers but bounces money sent to it.
 */
export const accountMachine = setup({
  validator: standardSchemaValidator(),
  actions: {
    toTransfer: (_message: ToTransfer) => {},
  },
  schemas: {
    input: std(AccountInput),
    context: std(AccountContext),
    events: {
      deposit: std(Schema.Struct({ amount: Amount, at: Schema.Number })),
      withdraw: std(Schema.Struct({ amount: Amount, at: Schema.Number })),
      "transfer.send": std(Schema.Struct({ transferId: Schema.String, to: Schema.String, amount: Amount, at: Schema.Number })),
      "transfer.credit": std(Schema.Struct({ transferId: Schema.String, from: Schema.String, amount: Schema.Number, at: Schema.Number })),
      "transfer.debit": std(Schema.Struct({ transferId: Schema.String })),
      "transfer.refund": std(Schema.Struct({ transferId: Schema.String })),
      freeze: std(Schema.Struct({})),
      unfreeze: std(Schema.Struct({})),
      "outbox.failed": std(OutboxFailed),
    },
  },
}).createMachine({
  id: "account",
  version: "1",
  context: ({ input }) => ({ accountId: input.accountId, balance: input.balance, holds: {}, ledger: [], notice: null }),
  initial: "opening",
  states: {
    opening: {
      type: "choice",
      choice: ({ context }) => (context.accountId === "bob" ? { target: "frozen" } : { target: "active" }),
    },
    active: {
      description: "Takes deposits, withdrawals and transfers",
      on: {
        deposit: ({ context, event }) => ({
          context: record({ ...context, balance: context.balance + event.amount }, { id: `d${event.at}`, kind: "deposit", amount: event.amount, counterparty: null, status: "done", at: event.at }),
        }),
        withdraw: ({ context, event }) =>
          context.balance < event.amount
            ? { context: { ...context, notice: `Not enough money: you have $${context.balance}` } }
            : {
                context: record(
                  { ...context, balance: context.balance - event.amount },
                  { id: `w${event.at}`, kind: "withdrawal", amount: event.amount, counterparty: null, status: "done", at: event.at },
                ),
              },
        "transfer.send": ({ context, event, actions }, enq) => {
          if (event.to === context.accountId) return { context: { ...context, notice: "You can't send money to yourself" } };
          if (context.balance < event.amount) return { context: { ...context, notice: `Not enough money: you have $${context.balance}` } };
          enq(actions.toTransfer, {
            transferId: event.transferId,
            event: { type: "transfer.start", from: context.accountId, to: event.to, amount: event.amount, at: event.at },
          });
          const held = { ...context, balance: context.balance - event.amount, holds: { ...context.holds, [event.transferId]: event.amount } };
          return { context: record(held, { id: event.transferId, kind: "sent", amount: event.amount, counterparty: event.to, status: "pending", at: event.at }) };
        },
        "transfer.credit": ({ context, event, actions }, enq) => {
          enq(actions.toTransfer, { transferId: event.transferId, event: { type: "transfer.credited" } });
          return {
            context: record(
              { ...context, balance: context.balance + event.amount },
              { id: event.transferId, kind: "received", amount: event.amount, counterparty: event.from, status: "done", at: event.at },
            ),
          };
        },
        freeze: { target: "frozen" },
      },
    },
    frozen: {
      description: "Frozen by its owner: money sent to it bounces",
      on: {
        "transfer.credit": ({ context, event, actions }, enq) => {
          enq(actions.toTransfer, { transferId: event.transferId, event: { type: "transfer.credit_failed", reason: "The account is frozen" } });
          return { context };
        },
        deposit: ({ context }) => ({ context: { ...context, notice: "Your account is frozen" } }),
        withdraw: ({ context }) => ({ context: { ...context, notice: "Your account is frozen" } }),
        "transfer.send": ({ context }) => ({ context: { ...context, notice: "Your account is frozen" } }),
        unfreeze: { target: "active" },
      },
    },
  },
  on: {
    // The Transfer settled: the money set aside is gone for good.
    "transfer.debit": ({ context, event, actions }, enq) => {
      enq(actions.toTransfer, { transferId: event.transferId, event: { type: "transfer.debited" } });
      return { context: mark({ ...context, holds: release(context, event.transferId) }, event.transferId, "done") };
    },
    // The Transfer failed: the money set aside comes back.
    "transfer.refund": ({ context, event, actions }, enq) => {
      enq(actions.toTransfer, { transferId: event.transferId, event: { type: "transfer.refunded" } });
      const amount = context.holds[event.transferId] ?? 0;
      return { context: mark({ ...context, balance: context.balance + amount, holds: release(context, event.transferId) }, event.transferId, "refunded") };
    },
    // A transfer that never started gives its money back.
    "outbox.failed": ({ context, event }) => {
      const [, transferId = ""] = event.target.split("/");
      const amount = event.eventType === "transfer.start" ? (context.holds[transferId] ?? 0) : 0;
      const next = { ...context, balance: context.balance + amount, holds: amount ? release(context, transferId) : context.holds };
      return { context: { ...(amount ? mark(next, transferId, "refunded") : next), notice: `Couldn't reach ${event.target}: ${event.reason}` } };
    },
  },
});
