import { Badge } from "@cloudflare/kumo";

const outcomeVariant: Record<string, "green" | "red" | "neutral" | "purple"> = {
  succeeded: "green",
  failed: "red",
  canceled: "neutral",
  superseded: "purple",
  rejected: "red",
  skipped: "neutral",
};

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge variant={outcomeVariant[outcome] ?? "neutral"}>{outcome}</Badge>;
}

export function EnvBadge({ env }: { env: string }) {
  return <Badge variant={env === "production" ? "orange" : "blue"}>{env === "production" ? "Production" : "Preview"}</Badge>;
}

export const shortSha = (sha: string) => sha.slice(0, 7);
