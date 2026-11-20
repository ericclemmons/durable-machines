# Durable Machines

XState machines in Durable Objects that you can watch live.

**[Docs and live examples](https://durable-machines.ericclemmons.workers.dev/)**

Durable Machines runs one [XState v6](https://stately.ai/docs) actor in each Cloudflare Durable Object. It handles persistence, durable timers, a transactional outbox between objects, and dead letters. Its Inspector draws every machine in your system and lights up each transition and message as it happens.

> Early work. The API will change. XState v6 is in beta, and this project tracks it on purpose.

## What's here

| Path | What |
| --- | --- |
| [`packages/durable-machines`](packages/durable-machines) | The npm package: `DurableMachine`, the outbox and Durable Object error handling (`.`), the client protocol types (`./protocol`), the debugger clock (`./clock`) and the graph coverage check (`./graph`). |
| [`examples/bank`](examples/bank) | **Durable Bank**: one account per visitor, a Transfer saga per transfer, and one clearing house everyone shares. The live demo. |
| [`examples/ci`](examples/ci) | A small CI system on four Durable Objects and a Workflow, with the live visualizer. |
| [`apps/docs`](apps/docs) | The [Nimbus](https://nimbus-docs.com) docs site. |
| [`apps/site`](apps/site) | The one Worker that serves the docs at `/`, Durable Bank at `/bank/` and the CI example at `/ci/`. |

## Try it

```sh
pnpm install
pnpm dev        # builds the docs, then serves the whole site at http://localhost:5173
pnpm dev:docs   # just the docs, with live reload
pnpm check      # typecheck + graph coverage
```

`pnpm dev` serves the docs at `/`, Durable Bank at `/bank/` and the CI example at `/ci/`.

## Deploy

One Worker, `durable-machines`, serves everything. It is configured in [`apps/site/cloudflare.config.ts`](apps/site/cloudflare.config.ts) and deployed with [`cf`](https://developers.cloudflare.com/cf/), not Wrangler.

```sh
pnpm build          # the package, the docs, then `cf build` of the Worker
pnpm run deploy     # `cf deploy --prebuilt` of that build
```

Workers Builds settings:

| Setting | Value |
| --- | --- |
| Root directory | `/` |
| Build command | `pnpm build` |
| Deploy command | `pnpm run deploy` |
| Production branch | `main` |

Set `SITE_URL` (build variable) only if the docs move off `https://durable-machines.ericclemmons.workers.dev`; it sets the docs' canonical URLs and sitemap.

## Publish

Publishing a GitHub release runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which publishes `durable-machines` to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). No npm token is stored. Bump `packages/durable-machines/package.json` first.

## License

MIT
