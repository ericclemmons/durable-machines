import type { AccountRecord, InstallationRecord, ProjectRecord } from "../domain/registry";

export type { AccountRecord, InstallationRecord, ProjectRecord };

export type Environment = "production" | "preview";
export type Outcome = "succeeded" | "failed" | "canceled" | "superseded" | "rejected" | "skipped";

export type Ticket = {
  buildId: string;
  buildNumber: number;
  projectId: string;
  branch: string;
  sha: string;
  message: string;
  environment: Environment;
  commands: { root: string; build: string; deploy: string };
};

export type ProjectSettings = {
  rootDirectory: string;
  buildCommand: string;
  deployCommand: string;
  previewDeployCommand: string;
  previewBuilds: boolean;
};

export type AccountContext = {
  accountId: string;
  name: string;
  repos: Record<string, string[]>;
  entitlements: { plan: "free" | "paid"; maxConcurrentBuilds: number; fetchedAt: number } | null;
  queue: Ticket[];
  running: Array<Ticket & { phase: "dispatching" | "running" }>;
  finished: Array<Ticket & { outcome: Outcome }>;
  routed: number;
};

export type ActiveBuild = {
  buildId: string;
  buildNumber: number;
  branch: string;
  sha: string;
  message: string;
  environment: Environment;
  prNumber: number | null;
  fromFork: boolean;
  phase: "awaiting_approval" | "queued" | "running";
};

export type ProjectContext = {
  projectId: string;
  accountId: string;
  repo: string;
  productionBranch: string;
  openPullRequests: Record<string, { number: number; fromFork: boolean; headSha: string }>;
  settings: ProjectSettings;
  active: ActiveBuild[];
  history: Array<ActiveBuild & { outcome: Outcome; error: string | null; step: string | null; url: string | null }>;
  decisions: Array<{ deliveryId: string; summary: string; verdict: "build" | "approval" | "ignored"; reason: string; buildId: string | null }>;
};

export type BuildContext = {
  buildId: string;
  startedAt: number | null;
  finishedAt: number | null;
  step: string | null;
  command: string | null;
  error: string | null;
  url: string | null;
};

export type InstallationContext = {
  installationId: string;
  owner: string;
  repos: Record<string, string[]>;
  routes: Array<{ deliveryId: string; repo: string; summary: string; accounts: string[]; dropped: string | null }>;
};

export type Topology = {
  accounts: Record<string, AccountRecord>;
  projects: Record<string, ProjectRecord>;
  installations: Record<string, InstallationRecord>;
};
