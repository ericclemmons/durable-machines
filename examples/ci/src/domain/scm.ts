import { Schema } from "effect";

// The normalized SCM event every Durable Object speaks. The webhook Worker turns
// raw GitHub payloads into this shape; machines never see provider payloads.

export const PushEvent = Schema.Struct({
  kind: Schema.Literal("push"),
  deliveryId: Schema.String,
  installationId: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  message: Schema.String,
  author: Schema.String,
  deleted: Schema.Boolean,
  /** When the webhook Worker received it. Machines read time from events, never the clock. */
  receivedAt: Schema.Number,
});

export const PullRequestEvent = Schema.Struct({
  kind: Schema.Literal("pull_request"),
  deliveryId: Schema.String,
  installationId: Schema.String,
  repo: Schema.String,
  action: Schema.Literals(["opened", "reopened", "synchronize", "closed"]),
  number: Schema.Number,
  title: Schema.String,
  branch: Schema.String,
  /** The PR's head commit: the latest commit on the branch when the event fired. */
  sha: Schema.String,
  author: Schema.String,
  merged: Schema.Boolean,
  /** Head branch lives in a fork. Pushes to forks never reach us as `push` events. */
  fromFork: Schema.Boolean,
  receivedAt: Schema.Number,
});

export const ScmEvent = Schema.Union([PushEvent, PullRequestEvent]);
export type ScmEvent = typeof ScmEvent.Type;

export const BuildStep = Schema.Literals(["clone", "install", "build", "deploy"]);
export type BuildStep = typeof BuildStep.Type;

export const Outcome = Schema.Literals(["succeeded", "failed", "canceled", "superseded", "rejected", "skipped"]);
export type Outcome = typeof Outcome.Type;

/** Workers Builds settings for a project. The deploy commands may not be empty. */
export const ProjectSettings = Schema.Struct({
  rootDirectory: Schema.String,
  buildCommand: Schema.String,
  deployCommand: Schema.NonEmptyString,
  previewDeployCommand: Schema.NonEmptyString,
  /** Build non-production branches (with an open PR). */
  previewBuilds: Schema.Boolean,
});
export type ProjectSettings = typeof ProjectSettings.Type;

/** The commands a build runs, fixed when the build is requested. */
export const BuildCommands = Schema.Struct({ root: Schema.String, build: Schema.String, deploy: Schema.String });

export const Ticket = Schema.Struct({
  buildId: Schema.String,
  buildNumber: Schema.Number,
  projectId: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  message: Schema.String,
  environment: Schema.Literals(["production", "preview"]),
  commands: BuildCommands,
});
export type Ticket = typeof Ticket.Type;

/** A message the outbox could not deliver, handed back to the sender's machine. */
export const OutboxFailed = Schema.Struct({
  target: Schema.String,
  eventType: Schema.String,
  event: Schema.Unknown,
  reason: Schema.String,
});

/** Effect Schema → Standard Schema, so XState can validate at runtime. */
export const std = Schema.toStandardSchemaV1;
