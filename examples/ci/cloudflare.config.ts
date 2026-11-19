import { bindings, defineConfig, exports } from "cf/config";

const name = "durable-machines-ci";

export default defineConfig({
  worker: {
    name,
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker/index.ts",
    workersDev: true,
    observability: { enabled: true },
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/agents/*", "/api/*", "/webhooks/*"],
    },
    exports: {
      Account: exports.durableObject({ storage: "sqlite" }),
      Project: exports.durableObject({ storage: "sqlite" }),
      Installation: exports.durableObject({ storage: "sqlite" }),
      Clock: exports.durableObject({ storage: "sqlite" }),
      BuildWorkflow: exports.workflow({ name: `${name}-build` }),
    },
    env: {
      Account: bindings.durableObject({ worker: name, exportName: "Account" }),
      Project: bindings.durableObject({ worker: name, exportName: "Project" }),
      Installation: bindings.durableObject({ worker: name, exportName: "Installation" }),
      Clock: bindings.durableObject({ worker: name, exportName: "Clock" }),
      BUILD_WORKFLOW: bindings.workflow({ name: `${name}-build`, worker: name, exportName: "BuildWorkflow" }),
      GITHUB_WEBHOOK_SECRET: bindings.text("demo-webhook-secret"),
    },
  },
});
