import { cell, type Busy, type Running } from "@durable-machines/inspector";
import type { MachineView } from "durable-machines/protocol";

// The build each Project's diagram focuses on. The Deployments table sets it.
const selected = cell<Readonly<Record<string, string>>>({});
export const selectBuild = (projectId: string, buildId: string) => selected.set({ ...selected.get(), [projectId]: buildId });
export const useSelectedBuilds = selected.use;

/** A build's child actor id as its number: "free-web-3" → "#3". */
export const buildLabel = (actor: string) => `build ${actor.replace(/^.*-(\d+)$/, "#$1")}`;

/** Still working beyond its outbox: an Account dispatching a build, or a build not waiting for approval. */
export const busy: Busy = (key, v) =>
  (key.startsWith("Account/") && JSON.stringify(v.root.value).includes("dispatching")) ||
  v.children.some((c) => c.status === "active" && c.value !== "awaiting_approval");

/** Builds running their steps, for the events list. */
export const runningBuilds = (views: Array<[string, MachineView]>): Running[] =>
  views.flatMap(([owner, v]) =>
    v.children
      .filter((c) => c.status === "active" && typeof c.value === "object" && c.value && "running" in c.value)
      .map((c) => ({ key: `${owner}|${c.id}`, owner, actor: c.id, value: c.value })),
  );
