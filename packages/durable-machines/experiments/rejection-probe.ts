// Probe: a schema-invalid event reaches the adapter's deadLetter with issues.
// Run from examples/ci: npx jiti ../../packages/durable-machines/experiments/rejection-probe.ts
import { createDurable } from "xstate/durable";
import { projectMachine } from "../../../examples/ci/src/machines/project";

const durable = createDurable(
  projectMachine.provide({ actions: { toAccount: () => {}, terminateWorkflow: () => {} } }),
  {
    executeAction: (a, _m, r) => a.exec(r),
    waitForEvent: () => new Promise(() => {}),
    enqueueRootEvent: () => {},
    scheduleTimer: () => {},
    deadLetter: (_source, target, event, reason, detail) =>
      console.log("deadLetter", target?.address, event.type, reason, detail?.issues?.map((i) => i.message)),
  },
  { captureRootEvents: false },
);
let [state, effects] = durable.initialTransition({ projectId: "p", accountId: "a", repo: "acme/web", productionBranch: "main", generation: "g" });
await durable.executeEffects(effects);
const before = state;
[state, effects] = durable.transition(state, { type: "build.cancel" } as never);
console.log("effects", effects.map((e) => e.descriptor.type));
await durable.executeEffects(effects);
console.log("snapshot unchanged:", before === state);
