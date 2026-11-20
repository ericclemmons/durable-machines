import { Badge, Button, Table, Text } from "@cloudflare/kumo";
import { activeIds, ObjectLabel, sendTo, setSelectedNode, stateAt, useAllViews, type Point } from "@durable-machines/inspector";
import { GitBranchIcon, XIcon } from "@phosphor-icons/react";
import { selectBuild } from "./builds";
import type { BuildContext, ProjectContext, ProjectRecord } from "./types";
import { EnvBadge, OutcomeBadge, shortSha } from "./ui";

const STEPS = ["cloning", "installing", "building", "deploying"] as const;
const STEP_LABEL: Record<(typeof STEPS)[number], string> = { cloning: "Clone", installing: "Install", building: "Build", deploying: "Deploy" };

/** The BuildWorkflow's name for each step, as a settled build reports where it stopped. */
const WORKFLOW_STEP: Record<string, number> = { clone: 0, install: 1, build: 2, deploy: 3 };

/**
 * One bar per step. Running: done steps, then the current one pulsing. Settled: how far it
 * got, with the step it failed on in red.
 */
function StepBar({ current, outcome }: { current: number; outcome?: string }) {
  const reached = outcome === "succeeded" ? STEPS.length : current;
  return (
    <span className="flex gap-0.5" aria-hidden>
      {STEPS.map((step, i) => (
        <span
          key={step}
          className={`h-1.5 w-4 rounded-full ${
            i < reached
              ? "bg-sky-600"
              : i === current && outcome === "failed"
                ? "bg-kumo-danger"
                : i === current && outcome
                  ? "bg-neutral-400"
                  : i === current
                    ? "animate-pulse bg-sky-500"
                    : "bg-kumo-tint"
          }`}
        />
      ))}
    </span>
  );
}

function Progress({ value }: { value: unknown }) {
  const ids = activeIds(value);
  const current = STEPS.findIndex((s) => ids.includes(`running.${s}`) || ids.includes(s));
  const step = STEPS[current];
  const label = step ? STEP_LABEL[step] : "Queued";
  return (
    <span className="inline-flex items-center gap-2" aria-label={step ? `Running: ${label}` : "Queued"}>
      <Badge variant="neutral" appearance="dot">
        {label}
      </Badge>
      <StepBar current={current} />
    </span>
  );
}

const ago = (at: number) => {
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
  /** The step a settled build stopped on: the BuildWorkflow's name for it. */
  step?: string | null;
};

const waiting = (row: Row) => row.status === "active" || row.status === "awaiting_approval";

/**
 * What the Workers Builds dashboard shows: every build of this account's
 * projects, newest first, as of `point` or live. Click a row to focus its build machine.
 */
export function Deployments({ projects, point }: { projects: ProjectRecord[]; point?: Point }) {
  const views = new Map(useAllViews());
  const rows: Row[] = [];
  for (const p of projects) {
    const key = `Project/${p.id}`;
    const view = views.get(key);
    if (!view) continue;
    const state = stateAt(key, view, point);
    const ctx = state.root.context as unknown as ProjectContext;
    for (const b of ctx.active) {
      const child = state.children.find((c) => c.id === b.buildId);
      const build = child?.context as unknown as BuildContext | undefined;
      rows.push({ ...b, projectId: p.id, status: b.phase === "awaiting_approval" ? "awaiting_approval" : "active", value: child?.value, startedAt: build?.startedAt });
    }
    for (const b of ctx.history) rows.push({ ...b, projectId: p.id, status: b.outcome, error: b.error, step: b.step });
  }
  rows.sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || b.buildNumber - a.buildNumber);

  const focus = (row: Row) => {
    selectBuild(row.projectId, row.buildId);
    setSelectedNode(`part:${row.projectId}:build`);
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
                  <span className="inline-flex items-center gap-2">
                    <OutcomeBadge outcome={row.status} />
                    {(row.step || row.status === "succeeded") && (
                      <StepBar current={row.step ? (WORKFLOW_STEP[row.step] ?? -1) : STEPS.length} outcome={row.status} />
                    )}
                  </span>
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
              <Table.Cell className="whitespace-nowrap text-kumo-subtle">{row.startedAt ? ago(row.startedAt) : waiting(row) ? "Not started" : "—"}</Table.Cell>
              <Table.Cell className="w-px whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                <span className="flex items-center justify-end gap-1">
                  {row.status === "awaiting_approval" && (
                    <>
                      <Button variant="primary" size="xs" onClick={() => command(row, "build.approve")}>
                        Approve
                      </Button>
                      <Button variant="secondary" size="xs" onClick={() => command(row, "build.reject")}>
                        Reject
                      </Button>
                    </>
                  )}
                  {waiting(row) && (
                    <Button variant="ghost" shape="square" size="xs" icon={XIcon} aria-label={`Cancel build #${row.buildNumber}`} onClick={() => command(row, "build.cancel")} />
                  )}
                </span>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </section>
  );
}
