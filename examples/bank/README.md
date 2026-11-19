# Durable Bank

A bank on three kinds of Durable Object, each running one XState v6 machine. Open it, and you get your own account. Send money to a stranger and watch the transfer move between objects, live.

```sh
pnpm install   # from the repository root
pnpm dev       # http://localhost:5173/bank/
pnpm check     # typecheck + graph coverage
```

## The objects

| Object | One per | Machine | What it does |
| --- | --- | --- | --- |
| `Account/<your IP>` | visitor | [`account.ts`](src/machines/account.ts) | Holds the balance. Sets money aside when you send a transfer. A frozen account bounces money sent to it. |
| `Transfer/<id>` | transfer | [`transfer.ts`](src/machines/transfer.ts) | The saga: `requested → review? → clearing → crediting → settling → completed`, or `→ refunding → refunded` when the receiver bounces it. |
| `Bank/global` | site | [`bank.ts`](src/machines/bank.ts) | The clearing house everyone shares. It clears one transfer every 2.5 s, so when it's busy your transfer waits behind everyone else's. |

Two accounts always exist: `alice`, and `bob`, who starts frozen so a transfer to him shows the refund path.

- **Review:** a transfer of $100 or more waits in `review` for 12 s (an `after` timer that survives eviction), then clears.
- **Your account is your IP.** Only the Worker sends commands to it (`POST /api/me`), so nobody else can spend your money. Everyone can watch every object over WebSocket.
- **Every hop waits 700 ms** (`pace` in [`objects.ts`](src/worker/objects.ts)) so you can see messages travel.

## The canvas

The page connects to your account and the Bank, then follows the wires: the Transfers your account talked to, and the accounts on their other end. Nothing in [`SystemMap.tsx`](src/app/SystemMap.tsx) knows about banks; it draws each object's machine definition and derives the wires from each object's journal and outbox.

## Deploy

This Worker also serves the docs site: `vite.config.ts` ships `apps/docs/dist` as static assets, the docs live at `/`, and the demo at `/bank/`. The [Live demo](../../apps/docs/src/content/docs/demo.mdx) docs page embeds it.

```sh
pnpm run deploy   # from the repository root: builds the docs, then `cf deploy`
```

Deploys use [`cf`](https://developers.cloudflare.com/cf/) and [`cloudflare.config.ts`](cloudflare.config.ts), not Wrangler.
