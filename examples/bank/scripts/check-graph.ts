// Fails when any machine has a transition whose destinations the diagrams can't see.
import { machineToJSON } from "xstate";
import { formatCoverage, graphCoverage } from "durable-machines/graph";
import { accountMachine } from "../src/machines/account";
import { bankMachine } from "../src/machines/bank";
import { transferMachine } from "../src/machines/transfer";

let failed = false;
for (const machine of [accountMachine, transferMachine, bankMachine]) {
  const problems = graphCoverage(machineToJSON(machine));
  if (problems.length) {
    failed = true;
    console.error(formatCoverage(machine.id, problems));
  } else {
    console.log(`✓ ${machine.id}: every destination is visible`);
  }
}
if (failed) process.exit(1);
