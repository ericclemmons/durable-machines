import { registerObjects } from "@durable-machines/inspector";
import { BuildingsIcon, CloudIcon, FlowArrowIcon, GithubLogoIcon, PackageIcon } from "@phosphor-icons/react";

/** Ids that end in a number show as that number: "free-web-3" → "3". */
const id = (name: string) => name.replace(/^.*-(\d+)$/, "$1");

registerObjects({
  Installation: { icon: GithubLogoIcon, name: "GitHub App Installation", purpose: "Tracks the App on the org and fans GitHub events out to accounts", id },
  Account: { icon: BuildingsIcon, name: "Account", purpose: "Caches entitlements and grants build concurrency", id },
  Project: { icon: PackageIcon, name: "Project", purpose: "Tracks branches and PRs, and spawns a build machine per build", id },
  BuildWorkflow: { icon: FlowArrowIcon, name: "Build Workflow", purpose: "Cloudflare Workflow that runs the build's steps", id },
  "Webhook Worker": { icon: CloudIcon, name: "Webhook Worker", purpose: "Verifies and decodes GitHub webhooks (Effect)" },
});
