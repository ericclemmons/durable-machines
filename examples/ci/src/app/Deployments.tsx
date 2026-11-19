import { Badge, Button, Table, Text } from "@cloudflare/kumo";
import { GitBranchIcon, XIcon } from "@phosphor-icons/react";
import { activeIds } from "./graph";
import { selectBuild, sendTo, setDockTab, setSelectedNode, useAllViews } from "./store";
import type { BuildContext, ProjectContext, ProjectRecord } from "./types";
import { EnvBadge, ObjectLabel, OutcomeBadge, shortSha } from "./ui";

const STEPS = ["cloning", "installing", "building", "deploying"] as const;
const STEP_LABEL: Record<(typeof STEPS)[number], string> = { cloning: "Clone", installing: "Install", building: "Build", deploying: "Deploy" };

function Progress({ value }: { value: unknown }) {
  const ids = activeIds(value);
  const current = STEPS.findIndex((s) => ids.includes(`running.${s}`) || ids.includes(s));
  return (
    <span className="inline-flex items-center gap-2" aria-label={current >= 0 ? `Running: ${STEP_LABEL[STEPS[current]!]}` : "Queued"}>
      <Badge variant="neutral" appearance="dot">
        {current >= 0 ? STEP_LABEL[STEPS[current]!] : "Queued"}
      </Badge>
      <span className="flex gap-0.5">
        {STEPS.map((step, i) => (
          <span key={step} className={`h-1.5 w-4 rounded-full ${i < current ? "bg-sky-600" : i === current ? "animate-pulse bg-sky-500" : "bg-kumo-tint"}`} />
        ))}
      </span>
    </span>
  );
}

const ago = (at: number | null | undefined) => {
  if (!at) return "—";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

type Row = {
  projectId: string;
  buildId: string;
  buildNumber: number;
  branch: string;
  sha: string;
  message: string;
  environment: string;
  fromFork: boolean;
  status: "awaiting_approval" | "active" | string;
  value?: unknown;
  error?: string | null;
  startedAt?: number | null;
};

/**
 * What the Workers Builds dashboard shows: every build of this account's
 * projects, newest first. Click a row to focus its build machine.
 */
export function Deployments({ projects }: { projects: ProjectRecord[] }) {
  const views = useAllViews();
  const rows: Row[] = [];
  for (const p of projects) {
    const view = views.find(([key]) => key === `Project/${p.id}`)?.[1];
    if (!view) continue;
    const ctx = view.root.context as unknown as ProjectContext;
    for (const b of ctx.active) {
      const child = view.children.find((c) => c.id === b.buildId);
      const build = child?.context as unknown as BuildContext | undefined;
      rows.push({ ...b, projectId: p.id, status: b.phase === "awaiting_approval" ? "awaiting_approval" : "active", value: child?.value, startedAt: build?.startedAt });
    }
    for (const b of ctx.history) rows.push({ ...b, projectId: p.id, status: b.outcome, error: b.error });
  }
  rows.sort((a, b) => Number(b.status === "active" || b.status === "awaiting_approval") - Number(a.status === "active" || a.status === "awaiting_approval") || b.buildNumber - a.buildNumber);

  const focus = (row: Row) => {
    selectBuild(row.projectId, row.buildId);
    setSelectedNode(`part:${row.projectId}:build`);
    setDockTab("state");
  };
  const command = (row: Row, type: string) => void sendTo(`Project/${row.projectId}`, { type, buildId: row.buildId });

  return (
    <section className="min-h-0">
        <Table>
          <Table.Header variant="compact">
            <Table.Row>
              <Table.Head>Status</Table.Head>
              <Table.Head>Project</Table.Head>
              <Table.Head>Commit</Table.Head>
              <Table.Head>Started</Table.Head>
              <Table.Head>
                <span className="sr-only">Actions</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.length === 0 && (
              <Table.Row>
                <Table.Cell colSpan={5}>
                  <Text variant="secondary">No builds yet. Pick a scenario and press play.</Text>
                </Table.Cell>
              </Table.Row>
            )}
            {rows.map((row) => (
              <Table.Row key={row.buildId} onClick={() => focus(row)} className="row-enter cursor-pointer hover:bg-kumo-tint">
                <Table.Cell className="whitespace-nowrap">
                  {row.status === "active" ? (
                    <Progress value={row.value} />
                  ) : row.status === "awaiting_approval" ? (
                    <Badge variant="warning">Awaiting approval</Badge>
                  ) : (
                    <OutcomeBadge outcome={row.status} />
                  )}
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap">
                  <span className="grid min-w-max">
                    <ObjectLabel address={`Project/${row.projectId}`} showKind={false} />
                    <span className="text-xs text-kumo-subtle">Build #{row.buildNumber}</span>
                  </span>
                </Table.Cell>
                <Table.Cell className="max-w-0 w-full">
                  <span className="grid min-w-0">
                    <span className="truncate">{row.error ?? row.message}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
                      <EnvBadge env={row.environment} />
                      {row.fromFork && <Badge variant="warning">Fork</Badge>}
                      <GitBranchIcon aria-hidden className="shrink-0" />
                      <span className="truncate">{row.branch}</span>
                      <code className="font-mono text-[0.9em]">{shortSha(row.sha)}</code>
                    </span>
                  </span>
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap text-kumo-subtle">{ago(row.startedAt)}</Table.Cell>
                <Table.Cell className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                  {row.status === "awaiting_approval" && (
                    <span className="mr-1 inline-flex gap-1">
                      <Button variant="primary" size="xs" onClick={() => command(row, "build.approve")}>
                        Approve
                      </Button>
                      <Button variant="secondary" size="xs" onClick={() => command(row, "build.reject")}>
                        Reject
                      </Button>
                    </span>
                  )}
                  {(row.status === "active" || row.status === "awaiting_approval") && (
                    <Button variant="ghost" shape="square" size="xs" icon={XIcon} aria-label={`Cancel build #${row.buildNumber}`} onClick={() => command(row, "build.cancel")} />
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
    </section>
  );
}
