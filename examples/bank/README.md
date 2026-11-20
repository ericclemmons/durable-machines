# Durable Bank

A bank on three kinds of Durable Object, each running one XState v6 machine. Open it, and you get your own account. Send money to a stranger and watch the transfer move between objects, live.

```sh
pnpm install   # from the repository root
pnpm dev       # http://localhost:5173/bank/, with the docs and the CI example
pnpm check     # typecheck + graph coverage
```

## The objects

| Object | One per | Machine | What it does |
| --- | --- | --- | --- |
| `BankAccount/<your IP>` | visitor | [`account.ts`](src/machines/account.ts) | Holds the balance. Sets money aside when you send a transfer. A frozen account bounces money sent to it. |
| `Transfer/<id>` | transfer | [`transfer.ts`](src/machines/transfer.ts) | The saga: `requested → review? → clearing → crediting → settling → completed`, or `→ refunding → refunded` when the receiver bounces it. |
| `Bank/global` | site | [`bank.ts`](src/machines/bank.ts) | The clearing house everyone shares. It clears one transfer every 2.5 s, so when it's busy your transfer waits behind everyone else's. |

Two accounts always exist: `alice`, and `bob`, who starts frozen so a transfer to him shows the refund path.

- **Review:** a transfer of $100 or more waits in `review` for 12 s (an `after` timer that survives eviction), then clears.
- **Your account is your IP.** Only the Worker sends commands to it (`POST /bank/api/me`), so nobody else can spend your money. Everyone can watch every object over WebSocket.
- **Every hop waits 700 ms** (`pace` in [`objects.ts`](src/worker/objects.ts)) so you can see messages travel.

## The canvas

The page connects to your account and the Bank, then follows the wires: the Transfers your account talked to, and the accounts on their other end. Nothing in [`SystemMap.tsx`](src/app/SystemMap.tsx) knows about banks; it draws each object's machine definition and derives the wires from each object's journal and outbox.

## Naming

The CI example has an `Account` too, and both run in one Worker, so this one is `BankAccount`: the class, its binding and its address (`BankAccount/<your IP>`). The page still labels it "Account" ([`objects.ts`](src/app/objects.ts)).

## Deploy

This example has no Worker of its own. [`apps/site`](../../apps/site) serves it at `/bank/`, next to the docs at `/` and the CI example at `/ci/`, and routes `/bank/api/*` to [`src/worker/index.ts`](src/worker/index.ts). The [Durable Bank](../../apps/docs/src/content/docs/examples/bank.mdx) docs page embeds it. To deploy, see [Deploy](../../README.md#deploy).
