import { Data, Effect, Schedule } from "effect";

// Calls into another Durable Object, following
// https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
// - `.retryable` errors are transient: retry with jittered exponential backoff.
// - `.overloaded` errors must not be retried right away; the caller backs off.
// - A stub that threw may stay broken, so every attempt gets a fresh one.

export type FailureKind = "overloaded" | "retryable" | "remote" | "unknown";

export class DurableObjectCallError extends Data.TaggedError("DurableObjectCallError")<{
  kind: FailureKind;
  message: string;
}> {}

export const classify = (error: unknown): FailureKind => {
  const e = error as { overloaded?: boolean; retryable?: boolean; remote?: boolean } | null;
  if (e?.overloaded) return "overloaded";
  if (e?.retryable) return "retryable";
  if (e?.remote) return "remote";
  return "unknown";
};

/**
 * Run `call` against a fresh stub from `getStub` on every attempt. Retries only
 * transient failures. Safe because every receiver deduplicates by message id.
 */
export const callDurableObject = <Stub, A>(
  getStub: () => Stub,
  call: (stub: Stub) => Promise<A>,
  { attempts = 3 }: { attempts?: number } = {},
) =>
  Effect.tryPromise({
    try: () => call(getStub()),
    catch: (error) =>
      new DurableObjectCallError({ kind: classify(error), message: error instanceof Error ? error.message : String(error) }),
  }).pipe(
    Effect.retry({
      times: attempts - 1,
      schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
      while: (error) => error.kind === "retryable",
    }),
  );
