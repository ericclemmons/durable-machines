import { bindings, defineConfig, exports } from "cf/config";

const name = "durable-machines";

// One Worker serves the docs at `/` and Durable Bank at `/bank/`; see vite.config.ts.
export default defineConfig({
  worker: {
    name,
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker/index.ts",
    workersDev: true,
    observability: { enabled: true },
    assets: {
      notFoundHandling: "404-page",
      runWorkerFirst: ["/agents/*", "/api/*"],
    },
    exports: {
      Account: exports.durableObject({ storage: "sqlite" }),
      Transfer: exports.durableObject({ storage: "sqlite" }),
      Bank: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      Account: bindings.durableObject({ worker: name, exportName: "Account" }),
      Transfer: bindings.durableObject({ worker: name, exportName: "Transfer" }),
      Bank: bindings.durableObject({ worker: name, exportName: "Bank" }),
    },
  },
});
