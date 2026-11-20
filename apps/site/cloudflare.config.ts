import { bindings, defineConfig, defineWorker, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const name = "durable-machines";

// The Worker's own classes, so the bindings below are typed from the entrypoint.
const worker = defineWorker({
  name,
  entrypoint,
  compatibilityDate: "2026-11-01",
  exports: {
    BankAccount: exports.durableObject({ storage: "sqlite" }),
    Transfer: exports.durableObject({ storage: "sqlite" }),
    Bank: exports.durableObject({ storage: "sqlite" }),
    Account: exports.durableObject({ storage: "sqlite" }),
    Project: exports.durableObject({ storage: "sqlite" }),
    Installation: exports.durableObject({ storage: "sqlite" }),
    Clock: exports.durableObject({ storage: "sqlite" }),
    BuildWorkflow: exports.workflow({ name: `${name}-build` }),
  },
});

// Inline, the export name would widen to every class, since the classes' `Env` comes from this file.
const durableObject = <T extends Exclude<keyof typeof worker.exports, "BuildWorkflow">>(exportName: T) =>
  bindings.durableObject<typeof worker, T>({ worker, exportName });

// One Worker: the docs at `/`, Durable Bank at `/bank/` and the CI example at `/ci/`; see vite.config.ts.
export default defineConfig({
  worker: {
    ...worker,
    compatibilityFlags: ["nodejs_compat"],
    workersDev: true,
    observability: { enabled: true },
    assets: {
      notFoundHandling: "404-page",
      runWorkerFirst: ["/agents/*", "/bank/api/*", "/ci/api/*", "/ci/webhooks/*"],
    },
    env: {
      BankAccount: durableObject("BankAccount"),
      Transfer: durableObject("Transfer"),
      Bank: durableObject("Bank"),
      Account: durableObject("Account"),
      Project: durableObject("Project"),
      Installation: durableObject("Installation"),
      Clock: durableObject("Clock"),
      BUILD_WORKFLOW: bindings.workflow({ name: `${name}-build`, worker, exportName: "BuildWorkflow" }),
      GITHUB_WEBHOOK_SECRET: bindings.text("demo-webhook-secret"),
    },
  },
});
