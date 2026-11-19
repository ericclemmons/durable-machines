import { Data, Effect, Schema } from "effect";
import { installations } from "../domain/registry";
import { callDurableObject } from "durable-machines";
import type { ScmEvent } from "../domain/scm";
import type { SendResult } from "durable-machines/protocol";

// GitHub payloads, reduced to the fields Workers Builds reads.
const Repository = Schema.Struct({ full_name: Schema.String });
const Sender = Schema.Struct({ login: Schema.String });
const InstallationRef = Schema.Struct({ id: Schema.Number });

const GitHubPush = Schema.Struct({
  ref: Schema.String,
  after: Schema.String,
  deleted: Schema.Boolean,
  head_commit: Schema.NullOr(Schema.Struct({ message: Schema.String })),
  repository: Repository,
  sender: Sender,
  installation: InstallationRef,
});

const GitHubPullRequest = Schema.Struct({
  action: Schema.String,
  number: Schema.Number,
  pull_request: Schema.Struct({
    title: Schema.String,
    merged: Schema.Boolean,
    head: Schema.Struct({ ref: Schema.String, sha: Schema.String, repo: Schema.Struct({ full_name: Schema.String, fork: Schema.Boolean }) }),
  }),
  repository: Repository,
  sender: Sender,
  installation: InstallationRef,
});

const GitHubInstallation = Schema.Struct({
  action: Schema.String,
  installation: InstallationRef,
  sender: Sender,
});

export class InvalidSignature extends Data.TaggedError("InvalidSignature")<{ message: string }> {}
export class MalformedPayload extends Data.TaggedError("MalformedPayload")<{ message: string }> {}
export class UnsupportedEvent extends Data.TaggedError("UnsupportedEvent")<{ message: string }> {}
export class UnknownRepository extends Data.TaggedError("UnknownRepository")<{ message: string }> {}
export class InstallationUnavailable extends Data.TaggedError("InstallationUnavailable")<{ message: string }> {}

export type TraceStep = { step: string; ok: boolean; detail: string };
const INSTALLATION_ACTIONS = { created: "created", deleted: "deleted", suspend: "suspended", unsuspend: "unsuspended" } as const;
type InstallationAction = (typeof INSTALLATION_ACTIONS)[keyof typeof INSTALLATION_ACTIONS];

type Normalized = { kind: "scm"; event: ScmEvent } | { kind: "installation"; installationId: string; action: InstallationAction };

export type IngestResult = {
  ok: boolean;
  trace: TraceStep[];
  event?: ScmEvent;
  installationId?: string;
  result?: SendResult;
};

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const sign = async (secret: string, body: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
};

const verifySignature = (secret: string, body: string, signature: string | null) =>
  Effect.gen(function* () {
    if (!signature) return yield* new InvalidSignature({ message: "Missing X-Hub-Signature-256" });
    const expected = yield* Effect.promise(() => sign(secret, body));
    const a = new TextEncoder().encode(expected);
    const b = new TextEncoder().encode(signature);
    if (a.byteLength !== b.byteLength || !(crypto.subtle as unknown as { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean }).timingSafeEqual(a, b)) {
      return yield* new InvalidSignature({ message: "Signature does not match the webhook secret" });
    }
  });

const decode = <S extends Schema.Top>(schema: S, payload: unknown) =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(Effect.mapError((error) => new MalformedPayload({ message: String(error) }))) as Effect.Effect<
    S["Type"],
    MalformedPayload
  >;

const normalize = (kind: string | null, deliveryId: string, payload: unknown) =>
  Effect.gen(function* () {
    if (kind === "push") {
      const push = yield* decode(GitHubPush, payload);
      if (!push.ref.startsWith("refs/heads/")) return yield* new UnsupportedEvent({ message: `Tag push ${push.ref}` });
      const event: ScmEvent = {
        kind: "push",
        deliveryId,
        installationId: String(push.installation.id),
        repo: push.repository.full_name,
        branch: push.ref.slice("refs/heads/".length),
        sha: push.after,
        message: push.head_commit?.message ?? "",
        author: push.sender.login,
        deleted: push.deleted,
      };
      return { kind: "scm", event } satisfies Normalized;
    }
    if (kind === "pull_request") {
      const pr = yield* decode(GitHubPullRequest, payload);
      if (!["opened", "reopened", "synchronize", "closed"].includes(pr.action)) {
        return yield* new UnsupportedEvent({ message: `pull_request.${pr.action} does not affect builds` });
      }
      const event: ScmEvent = {
        kind: "pull_request",
        deliveryId,
        installationId: String(pr.installation.id),
        repo: pr.repository.full_name,
        action: pr.action as "opened" | "reopened" | "synchronize" | "closed",
        number: pr.number,
        title: pr.pull_request.title,
        branch: pr.pull_request.head.ref,
        sha: pr.pull_request.head.sha,
        author: pr.sender.login,
        merged: pr.pull_request.merged,
        fromFork: pr.pull_request.head.repo.fork && pr.pull_request.head.repo.full_name !== pr.repository.full_name,
      };
      return { kind: "scm", event } satisfies Normalized;
    }
    if (kind === "installation") {
      const inst = yield* decode(GitHubInstallation, payload);
      const action = Object.hasOwn(INSTALLATION_ACTIONS, inst.action) ? INSTALLATION_ACTIONS[inst.action as keyof typeof INSTALLATION_ACTIONS] : undefined;
      if (!action) return yield* new UnsupportedEvent({ message: `installation.${inst.action} does not affect builds` });
      return { kind: "installation", installationId: String(inst.installation.id), action } satisfies Normalized;
    }
    return yield* new UnsupportedEvent({ message: `Event "${kind ?? "none"}" is not handled` });
  });

/**
 * The webhook pipeline: verify → decode → normalize → route to the Account DO.
 * Every step lands in a trace so the dashboard can show where an event stopped.
 */
export const ingest = (env: Env, request: Request) =>
  Effect.gen(function* () {
    const trace: TraceStep[] = [];
    const ok = (step: string, detail: string) => trace.push({ step, ok: true, detail });
    const body = yield* Effect.promise(() => request.text());
    const deliveryId = request.headers.get("x-github-delivery") ?? crypto.randomUUID();

    const pipeline = Effect.gen(function* () {
      yield* verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256"));
      ok("Verify signature", "HMAC SHA-256 matches");

      const payload = yield* Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: () => new MalformedPayload({ message: "Body is not JSON" }),
      });
      const normalized = yield* normalize(request.headers.get("x-github-event"), deliveryId, payload);
      const installationId = normalized.kind === "scm" ? normalized.event.installationId : normalized.installationId;
      ok(
        "Decode payload",
        normalized.kind === "installation"
          ? `installation.${normalized.action}`
          : normalized.event.kind === "push"
            ? `push to ${normalized.event.branch}`
            : `pull_request.${normalized.event.action} #${normalized.event.number}${normalized.event.fromFork ? " from a fork" : ""}`,
      );

      const installation = installations[installationId];
      if (!installation) return yield* new UnknownRepository({ message: `Installation ${installationId} is not known to Workers Builds` });
      if (normalized.kind === "scm" && !installation.repos.some((r) => r.toLowerCase() === normalized.event.repo.toLowerCase())) {
        return yield* new UnknownRepository({ message: `${normalized.event.repo} is not in installation ${installationId}` });
      }
      ok("Resolve installation", `installation ${installationId} (${installation.owner})`);

      const message =
        normalized.kind === "scm" ? ({ type: "scm.event", event: normalized.event } as const) : ({ type: `installation.${normalized.action}` } as const);
      // GitHub's delivery id is the message id: a redelivered webhook is deduplicated.
      const result = yield* callDurableObject(
        () => env.Installation.getByName(installationId),
        (stub) => stub.send(message as never, { messageId: deliveryId, from: "webhook" }),
      ).pipe(Effect.mapError((e) => new InstallationUnavailable({ message: `${e.kind}: ${e.message}` })));
      if (!result.ok) return yield* new InstallationUnavailable({ message: result.error });
      ok(
        "Send to Installation DO",
        `Installation/${installationId} accepted ${message.type}${"duplicate" in result && result.duplicate ? " (duplicate delivery, ignored)" : ""}`,
      );

      return { ok: true, trace, event: normalized.kind === "scm" ? normalized.event : undefined, installationId, result } satisfies IngestResult;
    });

    return yield* pipeline.pipe(
      Effect.catch((error) => {
        trace.push({ step: error._tag, ok: false, detail: error.message });
        return Effect.succeed({ ok: false, trace } satisfies IngestResult);
      }),
    );
  });

export const statusFor = (result: IngestResult) => {
  if (result.ok) return 202;
  const last = result.trace.at(-1)?.step;
  if (last === "InvalidSignature") return 401;
  if (last === "MalformedPayload") return 400;
  if (last === "UnknownRepository") return 404;
  if (last === "UnsupportedEvent") return 202;
  return 503;
};
