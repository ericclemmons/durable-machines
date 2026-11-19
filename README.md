# Durable Machines

XState machines in Durable Objects that you can watch live.

Durable Machines runs one [XState v6](https://stately.ai/docs) actor in each Cloudflare Durable Object. It handles persistence, durable timers, a transactional outbox between objects, and dead letters. Its Inspector draws every machine in your system and lights up each transition and message as it happens.

> Early work. The API will change. XState v6 is in beta, and this project tracks it on purpose.

## What's here

| Path | What |
| --- | --- |
| [`packages/durable-machines`](packages/durable-machines) | The npm package: `DurableMachine`, the outbox and Durable Object error handling (`.`), the client protocol types (`./protocol`), the debugger clock (`./clock`) and the graph coverage check (`./graph`). |
| [`examples/bank`](examples/bank) | **Durable Bank**: one account per visitor, a Transfer saga per transfer, and one clearing house everyone shares. The live demo. |
| [`examples/ci`](examples/ci) | A small CI system on four Durable Objects and a Workflow, with the live visualizer. |
| [`apps/docs`](apps/docs) | The [Nimbus](https://nimbus-docs.com) docs site. |

## Try it

```sh
pnpm install
pnpm dev      # Durable Bank, at http://localhost:5173
pnpm dev:ci   # the CI example
pnpm check    # typecheck + graph coverage
```

Docs:

```sh
pnpm --filter @durable-machines/docs dev
```

## Publish

`.github/workflows/publish.yml` publishes `durable-machines` to npm from a GitHub release, with npm trusted publishing (OIDC). No npm token is stored.

## License

MIT
