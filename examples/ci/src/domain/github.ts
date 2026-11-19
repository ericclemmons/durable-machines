// Builds realistic GitHub webhook payloads for the dashboard's simulator.

export type Simulation = {
  repo: string;
  scenario:
    | "push"
    | "pr_opened"
    | "pr_synchronize"
    | "pr_closed"
    | "pr_merged"
    | "branch_deleted"
    | "fork_pr_opened"
    | "fork_pr_synchronize"
    | "installation_suspend"
    | "installation_unsuspend"
    | "installation_created"
    | "installation_deleted";
  branch: string;
  message: string;
  prNumber: number;
  installationId?: number;
  /** Sign with the wrong secret, to show the pipeline rejecting it. */
  tamper?: boolean;
};

export const INSTALLATION_ID = 1001;

const randomSha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function githubPayload(sim: Simulation): { event: string; payload: unknown } {
  const repository = { full_name: sim.repo, name: sim.repo.split("/")[1], private: false, fork: false };
  const sender = { login: "octocat" };
  const installation = { id: sim.installationId ?? INSTALLATION_ID };
  const sha = randomSha();

  if (
    sim.scenario === "installation_created" ||
    sim.scenario === "installation_deleted" ||
    sim.scenario === "installation_suspend" ||
    sim.scenario === "installation_unsuspend"
  ) {
    return { event: "installation", payload: { action: sim.scenario.slice("installation_".length), installation, sender } };
  }

  if (sim.scenario === "push" || sim.scenario === "branch_deleted") {
    const deleted = sim.scenario === "branch_deleted";
    return {
      event: "push",
      payload: {
        ref: `refs/heads/${sim.branch}`,
        before: randomSha(),
        after: deleted ? "0".repeat(40) : sha,
        created: false,
        deleted,
        forced: false,
        head_commit: deleted ? null : { id: sha, message: sim.message, timestamp: new Date().toISOString() },
        repository,
        sender,
        installation,
      },
    };
  }

  const fork = sim.scenario.startsWith("fork_");
  const action = {
    pr_opened: "opened",
    pr_synchronize: "synchronize",
    pr_closed: "closed",
    pr_merged: "closed",
    fork_pr_opened: "opened",
    fork_pr_synchronize: "synchronize",
  }[sim.scenario];
  const headRepo = fork ? { full_name: `contributor/${sim.repo.split("/")[1]}`, fork: true } : { full_name: sim.repo, fork: false };
  return {
    event: "pull_request",
    payload: {
      action,
      number: sim.prNumber,
      pull_request: {
        number: sim.prNumber,
        title: sim.message,
        state: action === "closed" ? "closed" : "open",
        merged: sim.scenario === "pr_merged",
        head: { ref: sim.branch, sha, repo: headRepo },
        base: { ref: "main", repo: { full_name: sim.repo } },
      },
      repository,
      sender: fork ? { login: "contributor" } : sender,
      installation,
    },
  };
}
