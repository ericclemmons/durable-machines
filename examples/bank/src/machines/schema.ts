import { Schema } from "effect";

export const std = Schema.toStandardSchemaV1;

/** Whole dollars. Keeps the demo's numbers readable. */
export const Amount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));

/** Sent back into a machine when one of its outbox messages can't be delivered. */
export const OutboxFailed = Schema.Struct({
  target: Schema.String,
  eventType: Schema.String,
  event: Schema.Unknown,
  reason: Schema.String,
});

/** Transfers at or above this amount wait for review before they clear. */
export const REVIEW_THRESHOLD = 100;
/** How long a transfer waits in review before it's approved automatically. */
export const REVIEW_MS = 12_000;
/** How long the Bank takes to clear one transfer. It clears one at a time. */
export const CLEARING_MS = 2_500;
