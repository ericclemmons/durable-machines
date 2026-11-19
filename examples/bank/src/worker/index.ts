import { routeAgentRequest } from "agents/routing";

export { Account, Bank, Transfer } from "./objects";

type Action =
  | { action: "deposit" | "withdraw"; amount: number }
  | { action: "send"; amount: number; to: string }
  | { action: "freeze" | "unfreeze" | "reset" };

/** Your account is named by your IP address, so it's the same account on every device behind it. */
const accountOf = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/me" && request.method === "GET") {
      const accountId = accountOf(request);
      ctx.waitUntil(env.Bank.getByName("global").send({ type: "account.seen", accountId }));
      return Response.json({ accountId });
    }

    // Only your own account takes commands, and only through here: WebSocket clients just watch.
    if (url.pathname === "/api/me" && request.method === "POST") {
      const accountId = accountOf(request);
      const account = env.Account.getByName(accountId);
      const input = await request.json<Action>();
      const at = Date.now();
      if (input.action === "reset") {
        await account.reset();
        return Response.json({ ok: true, value: "active" });
      }
      const event =
        input.action === "send"
          ? { type: "transfer.send" as const, transferId: crypto.randomUUID().slice(0, 8), to: input.to, amount: input.amount, at }
          : input.action === "deposit" || input.action === "withdraw"
            ? { type: input.action, amount: input.amount, at }
            : { type: input.action };
      return Response.json(await account.send(event as never));
    }

    if (url.pathname.startsWith("/api/view/")) {
      const [, , , kind, name] = url.pathname.split("/");
      const namespace = kind === "transfer" ? env.Transfer : kind === "bank" ? env.Bank : env.Account;
      return Response.json(await namespace.getByName(decodeURIComponent(name ?? "")).view());
    }

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
