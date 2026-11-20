import { routeAgentRequest } from "agents/routing";
import bank from "@durable-machines/example-bank/worker";
import ci from "@durable-machines/example-ci/worker";

export { Bank, BankAccount, Transfer } from "@durable-machines/example-bank/worker";
export { Account, BuildWorkflow, Clock, Installation, Project } from "@durable-machines/example-ci/worker";

// Each example owns the paths under its own prefix. WebSocket clients of both connect at /agents/*.
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/bank/")) return bank.fetch(request, env, ctx);
    if (pathname.startsWith("/ci/")) return ci.fetch(request, env);
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
