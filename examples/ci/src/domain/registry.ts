// Seed data standing in for the Workers Builds control plane: GitHub App
// installations, the repos they cover, which Cloudflare accounts connected
// which repo to which project, and the billing backend's entitlements.

export type Plan = "free" | "paid";

export type AccountRecord = { id: string; name: string };
export type ProjectRecord = {
  id: string;
  accountId: string;
  repo: string;
  productionBranch: string;
};
export type InstallationRecord = { id: string; owner: string; repos: string[] };
export type Entitlements = { plan: Plan; maxConcurrentBuilds: number };

export const accounts: Record<string, AccountRecord> = {
  "free-account": { id: "free-account", name: "Free Account" },
  "paid-account": { id: "paid-account", name: "Paid Account" },
};

export const projects: Record<string, ProjectRecord> = {
  "free-web": { id: "free-web", accountId: "free-account", repo: "acme/web", productionBranch: "main" },
  "free-docs": { id: "free-docs", accountId: "free-account", repo: "acme/docs", productionBranch: "main" },
  "paid-app": { id: "paid-app", accountId: "paid-account", repo: "acme/app", productionBranch: "production" },
  // The same repo connected by a second account: the installation fans out to both.
  "paid-docs": { id: "paid-docs", accountId: "paid-account", repo: "acme/docs", productionBranch: "main" },
};

/** One GitHub App installation on the `acme` org. */
export const installations: Record<string, InstallationRecord> = {
  "1001": { id: "1001", owner: "acme", repos: ["acme/web", "acme/docs", "acme/app"] },
};

/** What the billing backend returns. The Account DO caches it; it never changes here. */
export const entitlements: Record<string, Entitlements> = {
  "free-account": { plan: "free", maxConcurrentBuilds: 1 },
  "paid-account": { plan: "paid", maxConcurrentBuilds: 6 },
};

export const projectsFor = (accountId: string) =>
  Object.values(projects).filter((p) => p.accountId === accountId);

export const installationForRepo = (repo: string) =>
  Object.values(installations).find((i) => i.repos.some((r) => r.toLowerCase() === repo.toLowerCase()));

/** Every project connected to a repo, across accounts. */
export const projectsForRepo = (repo: string) =>
  Object.values(projects).filter((p) => p.repo.toLowerCase() === repo.toLowerCase());
