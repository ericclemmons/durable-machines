import { Data, Effect, Predicate, Schedule } from "effect";

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

const flagged = (error: unknown, flag: "overloaded" | "retryable" | "remote" | "durableObjectReset") =>
  Predicate.hasProperty(error, flag) && Boolean(error[flag]);

export const classify = (error: unknown): FailureKind => {
  if (flagged(error, "overloaded")) return "overloaded";
  if (flagged(error, "retryable") || flagged(error, "durableObjectReset")) return "retryable";
  // A copy loaded by ID; restartIfNameless ends it, so the next attempt reaches a named one.
  if (String(error).includes("could not determine its Durable Object name")) return "retryable";
  if (flagged(error, "remote")) return "remote";
  return "unknown";
};

/**
 * An object first loaded by ID (the dashboard's Data Studio, the Query API, or the
 * local explorer) has no `ctx.id.name`, and named callers reuse that copy until it
 * is evicted, so every Lifecycle startup fails (workerd#8537). End that copy once
 * the call that loaded it has finished; the next call by name starts a named one.
 * `DurableMachine` does this itself. Use it as `Lifecycle.install(restartIfNameless(this, this.ctx))`.
 */
export const restartIfNameless = <Host>(host: Host, ctx: DurableObjectState): Host => {
  if (ctx.id.name === undefined) setTimeout(() => ctx.abort("Loaded by ID without a name; restarting"), 0);
  return host;
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
