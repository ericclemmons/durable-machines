import { Badge, Button, Text } from "@cloudflare/kumo";
import {
  Canvas,
  Dock,
  entryAt,
  formatValue,
  isInternalEntry,
  Notice,
  ObjectLabel,
  objectPurpose,
  sendTo,
  StateBody,
  stateAt,
  useAllViews,
  useClock,
  useDockOwner,
  useInspected,
  useObjectState,
  type NoticeValue,
  type PartState,
  type Point,
  type SystemPart,
  type SystemWire,
} from "@durable-machines/inspector";
import type { ActorView, JournalEntry, MachineView } from "durable-machines/protocol";
import { useEffect, useState } from "react";
import { useSelectedBuilds } from "./builds";
import { Deployments } from "./Deployments";
import type { ProjectContext, ProjectRecord } from "./types";

/** The map part an address belongs to: "installation", "account", a project id, "worker" or "workflow". */
export function partOf(address: string, accountId: string) {
  if (address === "webhook") return "worker";
  if (address === "BuildWorkflow" || address.startsWith("BuildWorkflow/")) return "workflow";
  const [cls, name] = address.split("/");
  if (cls === "Installation") return "installation";
  if (cls === "Account") return name === accountId ? "account" : undefined;
  if (cls === "Project") return name;
  return undefined;
}

/** The build a Project's build box shows as of a point: the one the point is about, else the one picked in Deployments, else the newest. */
function focusedBuild(owner: string, view: MachineView, point: Point | undefined, selected: Readonly<Record<string, string>>) {
  const state = stateAt(owner, view, point);
  const ctx = state.root.context as unknown as ProjectContext;
  const entry = point?.owner === owner && !point.next ? entryAt(view, point) : undefined;
  const pick = (id: string | undefined) => (id ? state.children.find((c) => c.id === id) : undefined);
  const child: ActorView | undefined =
    pick(entry?.actor) || pick(selected[owner.slice("Project/".length)]) || pick(ctx.active?.at(-1)?.buildId) || state.children.at(-1);
  // At a build's own event, show where that event took it. A build that reached a final
  // state is gone from the snapshot, so its value comes from the entry.
  const atBuild = entry?.kind === "transition" && entry.actor !== view.machineId ? entry : undefined;
  return { state, child, atBuild, done: atBuild ? !pick(atBuild.actor) || pick(atBuild.actor)?.status === "done" : child?.status === "done" };
}

/**
 * Every machine the run reached, on one canvas, with the Deployments table and an
 * object's state docked below it. The build machine sits inside the Project that
 * spawns it. Click an event to see the system as it was right after it.
 */
export function Machines({ accountId, installationId, projects }: { accountId: string; installationId: string; projects: ProjectRecord[] }) {
  const views = new Map(useAllViews());
  const clock = useClock();
  const selectedBuilds = useSelectedBuilds();
  const point = useInspected();
  const installation = views.get(`Installation/${installationId}`);
  const account = views.get(`Account/${accountId}`);
  const projectViews = projects.map((p) => [p, views.get(`Project/${p.id}`)] as const);
  const ready = Boolean(installation && account && projectViews.every(([, v]) => v));

  // Only machines that took part in this run appear: an object once it handled an
  // event, the build machine once a build was spawned, the Workflow once one was created.
  const took = (v: MachineView | undefined) => Boolean(v?.journal.some((e) => !isInternalEntry(e)));
  const spawned = (v: MachineView | undefined) => Boolean(v && (v.children.length || v.journal.some((e) => e.actor !== v.machineId)));
  const present = new Set<string>();
  if (took(installation)) present.add("installation");
  if (took(account)) present.add("account");
  for (const [p, v] of projectViews) {
    if (took(v)) present.add(p.id);
    if (spawned(v)) present.add(`${p.id}:build`);
  }
  // A hop on its way, or waiting for Next, brings its receiver in, so its wire has somewhere to go.
  for (const address of [...clock.parked.map((p) => p.to), ...[...views.values()].flatMap((v) => v.outbox.map((o) => o.to))]) {
    const to = partOf(address, accountId);
    if (to && to !== "workflow") present.add(to);
  }
  if (present.size) present.add("worker");
  if (
    account?.journal.some((e) => e.event.type.startsWith("xstate.done.actor") && JSON.stringify(e.from).includes("dispatching")) ||
    clock.parked.some((p) => p.to === "BuildWorkflow") ||
    projectViews.some(([, v]) => v?.journal.some((e) => e.source.startsWith("BuildWorkflow")))
  )
    present.add("workflow");

  const parts: SystemPart[] = !ready
    ? []
    : [
        { id: "worker", title: "Webhook Worker", subtitle: "Verifies and decodes webhooks" },
        {
          id: "installation",
          title: `Installation/${installationId}`,
          subtitle: objectPurpose("Installation") ?? "",
          definition: installation?.definitions.installation,
          direction: "RIGHT" as const,
        },
        { id: "account", title: `Account/${accountId}`, subtitle: objectPurpose("Account") ?? "", definition: account?.definitions.account },
        ...projectViews.map(([p, v]) => ({
          id: p.id,
          title: `Project/${p.id}`,
          subtitle: `${objectPurpose("Project") ?? ""} · ${p.repo}`,
          definition: v?.definitions.project,
          children: present.has(`${p.id}:build`)
            ? [{ id: `${p.id}:build`, title: "Build machine", subtitle: "A child actor of the Project, one per build", definition: v?.definitions.build, direction: "RIGHT" as const }]
            : [],
        })),
        { id: "workflow", title: "BuildWorkflow", subtitle: "Runs the steps" },
      ].filter((p) => present.has(p.id));
  const wires: SystemWire[] = [
    { source: "worker", target: "installation", events: ["scm.event"] },
    { source: "installation", target: "account", events: ["scm.event"] },
    { source: "account", target: "workflow", events: ["create()"] },
    ...projects.flatMap((p) => [
      { source: "account", target: p.id, events: ["scm.event", "build.start"] },
      { source: p.id, target: "account", events: ["build.requested", "build.finished"] },
      { source: "workflow", target: p.id, events: ["build.step", "build.completed"] },
    ]),
  ].filter((w) => present.has(w.source) && present.has(w.target));

  const part = (address: string) => partOf(address, accountId);
  const actorPart = (owner: string, entry: JournalEntry) => {
    const p = part(owner);
    return p && owner.startsWith("Project/") && entry.actor !== views.get(owner)?.machineId ? `${p}:build` : p;
  };
  const statesAt = (at: Point | undefined): PartState[] => {
    const states: PartState[] = [];
    if (installation) states.push({ part: "installation", value: stateAt(`Installation/${installationId}`, installation, at).root.value });
    if (account) states.push({ part: "account", value: stateAt(`Account/${accountId}`, account, at).root.value });
    for (const [p, v] of projectViews) {
      if (!v) continue;
      const { state, child, atBuild, done } = focusedBuild(`Project/${p.id}`, v, at, selectedBuilds);
      states.push({ part: p.id, value: state.root.value });
      states.push({ part: `${p.id}:build`, value: atBuild ? atBuild.to : child?.value, done });
    }
    return states;
  };

  const ownerOf = (p: string) => {
    const id = p.replace(/:build$/, "");
    return id === "installation" ? `Installation/${installationId}` : id === "account" ? `Account/${accountId}` : projects.some((x) => x.id === id) ? `Project/${id}` : undefined;
  };
  const owner = useDockOwner(ownerOf, `Installation/${installationId}`);
  const ownerView = views.get(owner);
  const isProject = owner.startsWith("Project/");
  const build = isProject && ownerView ? focusedBuild(owner, ownerView, point, selectedBuilds) : undefined;
  const buildId = build?.child?.id ?? build?.atBuild?.actor;
  const state = useObjectState(owner, point, (snap) => {
    const child = buildId ? snap.children.find((c) => c.id === buildId) : undefined;
    return child ? { [`build ${child.id.replace(/^.*-(\d+)$/, "#$1")}`]: { status: child.status, value: child.value, context: child.context } } : {};
  });
  const [notice, setNotice] = useState<NoticeValue>();
  useEffect(() => setNotice(undefined), [owner]);
  const command = async (event: { type: string; [k: string]: unknown }) => {
    const result = await sendTo(owner, event);
    setNotice(result.ok ? { ok: true, text: `${event.type} accepted → ${formatValue(result.value)}` } : { ok: false, text: result.error });
  };
  const asOf = point && <Badge variant="purple">As of {new Date(point.at).toLocaleTimeString([], { hour12: false })}</Badge>;

  return (
    <Canvas
      parts={parts}
      wires={wires}
      partOf={part}
      actorPart={actorPart}
      statesAt={statesAt}
      extraHot={(o, entry) => (entry.kind === "transition" && entry.event.type === "xstate.done.actor" && part(o) === "account" ? ["account→workflow|create()"] : [])}
      ready={ready}
      emptyText="No machine has run yet. Machines appear here as the scenario reaches them."
      dock={
        <Dock
          sections={[
            {
              grow: 3,
              label: (
                <>
                  <Text size="sm" bold>
                    Deployments
                  </Text>
                  {asOf}
                </>
              ),
              body: <Deployments projects={projects} point={point} />,
            },
            {
              grow: 2,
              label: (
                <>
                  <Text size="sm" bold>
                    State
                  </Text>
                  <ObjectLabel address={owner} className="min-w-0 text-sm text-kumo-subtle" />
                </>
              ),
              actions: (
                <>
                  {!state.missing && (
                    <Badge variant="orange">
                      <span className="truncate font-mono text-[0.9em]">{formatValue(state.value)}</span>
                    </Badge>
                  )}
                  {isProject && (
                    <Button variant="secondary-destructive" size="xs" onClick={() => void command({ type: "build.approve", buildId: 42 })}>
                      Send invalid event
                    </Button>
                  )}
                </>
              ),
              body: (
                <StateBody state={state}>
                  <Notice value={notice} />
                </StateBody>
              ),
            },
          ]}
        />
      }
    />
  );
}
