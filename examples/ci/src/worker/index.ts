import { Effect } from "effect";
import { githubPayload, type Simulation } from "../domain/github";
import { accounts, installations, projects } from "../domain/registry";
import type { ChaosMode } from "../lib/chaos";
import { ingest, sign, statusFor } from "./webhook";

export { Account } from "./account";
export { Installation } from "./installation";
export { Project } from "./project";
export { BuildWorkflow } from "./build-workflow";
export { Clock } from "./clock";

type Replay = { githubEvent: string; deliveryId: string; payload: unknown };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/ci/webhooks/github") {
      const result = await Effect.runPromise(ingest(env, request));
      return Response.json(result, { status: statusFor(result) });
    }

    if (request.method === "POST" && url.pathname === "/ci/api/simulate") {
      // Either a new simulated event, or a replay of an earlier delivery (same delivery id).
      const input = await request.json<(Simulation & { tamper?: boolean }) | { replay: Replay }>();
      const replay = "replay" in input ? input.replay : undefined;
      const { event, payload } = replay ? { event: replay.githubEvent, payload: replay.payload } : githubPayload(input as Simulation);
      const body = JSON.stringify(payload);
      const deliveryId = replay?.deliveryId ?? crypto.randomUUID();
      const tamper = !replay && (input as Simulation).tamper;
      const webhook = new Request(new URL("/ci/webhooks/github", url), {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": deliveryId,
          "x-hub-signature-256": await sign(tamper ? "wrong-secret" : env.GITHUB_WEBHOOK_SECRET, body),
        },
      });
      const result = await Effect.runPromise(ingest(env, webhook));
      return Response.json({ ...result, githubEvent: event, deliveryId, payload });
    }

    const view = url.pathname.match(/^\/ci\/api\/view\/(account|project|installation)\/([\w-]+)$/);
    if (view) {
      const [, kind, name] = view as unknown as [string, string, string];
      const stub = kind === "account" ? env.Account.getByName(name) : kind === "project" ? env.Project.getByName(name) : env.Installation.getByName(name);
      return Response.json(await stub.view());
    }

    if (request.method === "POST" && url.pathname === "/ci/api/chaos") {
      const { target, mode, seconds } = await request.json<{ target: string; mode: ChaosMode | null; seconds: number }>();
      const [kind, name] = target.split("/") as [string, string];
      const stub = kind === "Account" ? env.Account.getByName(name) : env.Project.getByName(name);
      await stub.setChaos(mode, seconds);
      return Response.json({ ok: true });
    }

    // The debugger clock. The UI drives it over WebSocket; this route is for scripts.
    if (url.pathname === "/ci/api/clock") {
      const clock = env.Clock.getByName("global");
      if (request.method !== "POST") return Response.json(await clock.state());
      const { action, pace } = await request.json<{ action: "play" | "pause" | "next" | "nextMachine"; pace?: number }>();
      return Response.json(await clock.control(action, pace));
    }

    if (url.pathname === "/ci/api/topology") {
      return Response.json({ accounts, projects, installations });
    }

    if (request.method === "POST" && url.pathname === "/ci/api/reset") {
      // Senders first, so nothing from the old run reaches an Account after it has been reset.
      await Promise.all([
        ...Object.keys(installations).map((id) => env.Installation.getByName(id).reset()),
        ...Object.keys(projects).map((id) => env.Project.getByName(id).reset()),
        env.Clock.getByName("global").control("clear"),
      ]);
      await Promise.all(Object.keys(accounts).map((id) => env.Account.getByName(id).reset()));
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
