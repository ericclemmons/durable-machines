import { Button, Sidebar, Text } from "@cloudflare/kumo";
import { ShikiProvider } from "@cloudflare/kumo/code";
import { GearSixIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { EventPanel, useClockConnection, useMachine } from "@durable-machines/inspector";
import { buildLabel, busy, runningBuilds } from "./builds";
import { Machines } from "./Machines";
import { Simulator } from "./Simulator";
import type { ProjectRecord, Topology } from "./types";

/** Keeps a WebSocket open to every object the selected account needs. */
function Connections({ installationId, accountId, projects }: { installationId: string; accountId: string; projects: ProjectRecord[] }) {
  useClockConnection();
  useMachine("Installation", installationId);
  useMachine("Account", accountId);
  return projects.map((p) => <ProjectConnection key={p.id} id={p.id} />);
}

function ProjectConnection({ id }: { id: string }) {
  useMachine("Project", id);
  return null;
}

/**
 * Left: Workers Builds and every object's events, with the scenario controls
 * pinned to its foot. The rest is the state machine canvas, with the
 * Deployments table and an object's state docked below it.
 */
export function App() {
  const [topology, setTopology] = useState<Topology>();
  const [accountId, setAccountId] = useState(() => new URLSearchParams(location.search).get("account") ?? "free-account");
  const [open, setOpen] = useState(() => localStorage.getItem("panel:events") !== "closed");
  useEffect(() => localStorage.setItem("panel:events", open ? "open" : "closed"), [open]);
  useEffect(() => {
    fetch("/api/topology").then(async (r) => setTopology(await r.json()));
  }, []);

  if (!topology) return <div className="p-8 text-kumo-subtle">Loading…</div>;
  const projects = Object.values(topology.projects).filter((p) => p.accountId === accountId);
  const [installation] = Object.values(topology.installations);
  const installationId = installation!.id;

  return (
    <ShikiProvider engine="javascript" languages={["json"]}>
      <Connections installationId={installationId} accountId={accountId} projects={projects} />
      <Sidebar.Provider
        side="left"
        collapsible="offcanvas"
        resizable
        defaultWidth={440}
        minWidth={340}
        maxWidth={800}
        open={open}
        onOpenChange={setOpen}
        className="isolate h-screen bg-kumo-canvas"
      >
        <Sidebar aria-label="Events">
          <EventPanel
            emptyText="No events yet. Pick a scenario and press play."
            actorLabel={buildLabel}
            running={runningBuilds}
            busy={busy}
            sendingText="Resetting and sending the scenario's webhooks…"
            header={
              <header className="flex items-center gap-2.5 border-b border-kumo-line px-3 py-2">
                <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-kumo-brand text-white">
                  <GearSixIcon weight="bold" />
                </div>
                <div className="grid min-w-0 leading-tight">
                  <Text as="h1" variant="heading3">
                    Workers Builds
                  </Text>
                  <Text size="xs" variant="secondary">
                    XState v6 on Durable Objects · {topology.accounts[accountId]?.name}
                  </Text>
                </div>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  icon={SidebarSimpleIcon}
                  aria-label="Hide events"
                  onClick={() => setOpen(false)}
                  className="ml-auto"
                />
              </header>
            }
            footer={<Simulator projects={projects} accounts={Object.values(topology.accounts)} accountId={accountId} onAccount={setAccountId} />}
          />
          <Sidebar.ResizeHandle />
        </Sidebar>
        <main className="relative flex h-screen min-w-0 flex-1 flex-col">
          {!open && (
            <Button
              variant="secondary"
              shape="square"
              size="sm"
              icon={SidebarSimpleIcon}
              aria-label="Show events"
              onClick={() => setOpen(true)}
              className="absolute left-3 top-3 z-20"
            />
          )}
          <Machines key={accountId} accountId={accountId} installationId={installationId} projects={projects} />
        </main>
      </Sidebar.Provider>
    </ShikiProvider>
  );
}
