import { Schema } from "effect";
import { setup } from "xstate";
import { standardSchemaValidator } from "xstate/validation";
import { OutboxFailed, REVIEW_MS, REVIEW_THRESHOLD, std } from "./schema";

/** The sender's Account creates a Transfer with this event. */
export const TransferStart = Schema.Struct({ from: Schema.String, to: Schema.String, amount: Schema.Number, at: Schema.Number });

const TransferContext = Schema.Struct({
  transferId: Schema.String,
  from: Schema.String,
  to: Schema.String,
  amount: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  reason: Schema.NullOr(Schema.String),
});

type Message = { type: string; [key: string]: unknown };

/**
 * One transfer between two accounts, as a saga. The sender's account creates it
 * with `transfer.start` once it has set the money aside. Large transfers wait for review, then every transfer waits its
 * turn at the Bank's clearing house, credits the receiver and settles with the
 * sender. If the receiver bounces it, the sender is refunded instead.
 */
export const transferMachine = setup({
  validator: standardSchemaValidator(),
  actions: {
    toAccount: (_message: { accountId: string; event: Message }) => {},
    toBank: (_event: Message) => {},
  },
  schemas: {
    input: std(Schema.Struct({ transferId: Schema.String, ...TransferStart.fields })),
    context: std(TransferContext),
    events: {
      "transfer.cleared": std(Schema.Struct({})),
      "transfer.credited": std(Schema.Struct({})),
      "transfer.credit_failed": std(Schema.Struct({ reason: Schema.String })),
      "transfer.debited": std(Schema.Struct({})),
      "transfer.refunded": std(Schema.Struct({})),
      "outbox.failed": std(OutboxFailed),
    },
  },
}).createMachine({
  id: "transfer",
  version: "1",
  context: ({ input }) => ({ transferId: input.transferId, from: input.from, to: input.to, amount: input.amount, startedAt: input.at, reason: null }),
  initial: "requested",
  states: {
    requested: {
      type: "choice",
      choice: ({ context }) => (context.amount >= REVIEW_THRESHOLD ? { target: "review" } : { target: "clearing" }),
    },
    review: {
      description: `$${REVIEW_THRESHOLD} or more: held for review, approved after ${REVIEW_MS / 1000}s`,
      after: { [REVIEW_MS]: { target: "clearing" } },
    },
    clearing: {
      description: "Waiting its turn at the Bank's clearing house",
      entry: ({ context, actions }, enq) => enq(actions.toBank, { type: "clear.request", transferId: context.transferId, amount: context.amount }),
      on: { "transfer.cleared": { target: "crediting" } },
    },
    crediting: {
      description: "Paying the receiver",
      entry: ({ context, actions }, enq) =>
        enq(actions.toAccount, {
          accountId: context.to,
          event: { type: "transfer.credit", transferId: context.transferId, from: context.from, amount: context.amount, at: context.startedAt ?? 0 },
        }),
      on: {
        "transfer.credited": { target: "settling" },
        "transfer.credit_failed": ({ context, event }) => ({ target: "refunding", context: { ...context, reason: event.reason } }),
      },
    },
    settling: {
      description: "Taking the money set aside from the sender",
      entry: ({ context, actions }, enq) => enq(actions.toAccount, { accountId: context.from, event: { type: "transfer.debit", transferId: context.transferId } }),
      on: { "transfer.debited": { target: "completed" } },
    },
    refunding: {
      description: "Giving the money set aside back to the sender",
      entry: ({ context, actions }, enq) => enq(actions.toAccount, { accountId: context.from, event: { type: "transfer.refund", transferId: context.transferId } }),
      on: { "transfer.refunded": { target: "refunded" } },
    },
    completed: {
      type: "final",
      entry: ({ context, actions }, enq) => enq(actions.toBank, { type: "transfer.settled", transferId: context.transferId, amount: context.amount, outcome: "completed" }),
    },
    refunded: {
      type: "final",
      entry: ({ context, actions }, enq) => enq(actions.toBank, { type: "transfer.settled", transferId: context.transferId, amount: context.amount, outcome: "refunded" }),
    },
  },
  on: {
    // The receiver couldn't be reached at all: refund the sender.
    "outbox.failed": ({ context, event }) =>
      event.eventType === "transfer.credit" ? { target: ".refunding", context: { ...context, reason: event.reason } } : { context: { ...context, reason: event.reason } },
  },
});
