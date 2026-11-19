// Strict graph coverage for XState v6 machines.
//
// XState's types check that literal targets name real states, but a
// transition function can still compute its target, and then no tool can
// see that edge (see xstate/docs/transition-functions.md, "Proposed strict
// graph extraction"). This check rejects those forms, so every possible
// destination is visible in `machineToJSON` and in the diagrams.
//
// Supported: `{ target: "literal" }` objects, and transition functions whose
// every `target` is a string literal. Rejected: computed or shorthand targets,
// template literals with `${}`, and returning another function's result.

type Json = Record<string, unknown>;

export type CoverageProblem = { state: string; transition: string; reason: string };

const isCode = (v: unknown): v is { "@code": string } => typeof v === "object" && v !== null && "@code" in v;

function checkCode(code: string): string | undefined {
  for (const match of code.matchAll(/(?<![.\w$])target\b\s*(:?)\s*(.?)/g)) {
    const [, colon, next] = match;
    if (!colon) return "uses a shorthand `target`; write the state name as a string literal";
    if (next !== '"' && next !== "'" && next !== "`") return "computes `target`; write the state name as a string literal";
  }
  if (/target\s*:\s*`[^`]*\$\{/.test(code)) return "builds `target` from a template; write the state name as a string literal";
  // Only the transition's own result matters; local helpers inside it are fine.
  const expressionBody = /^\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?!\(|\{)[A-Za-z_$][\w$.]*\s*\(/.test(code);
  // A `return helper(...)` at the function's own indentation, not inside a nested callback.
  const topLevelReturn = /^\s{0,6}return\s+(?!undefined\b)[A-Za-z_$][\w$.]*\s*\(/m.test(code);
  if (expressionBody || topLevelReturn) {
    return "returns a helper's result; its destinations can't be seen";
  }
  return undefined;
}

/** Every transition whose destinations can't all be read from the definition. */
export function graphCoverage(definition: unknown): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  const check = (state: string, transition: string, value: unknown) => {
    for (const t of [value].flat()) {
      if (!isCode(t)) continue;
      const reason = checkCode(t["@code"]);
      if (reason) problems.push({ state: state || "(root)", transition, reason });
    }
  };
  const visit = (path: string, config: Json) => {
    for (const [event, t] of Object.entries((config.on ?? {}) as Json)) check(path, event, t);
    for (const [delay, t] of Object.entries((config.after ?? {}) as Json)) check(path, `after ${delay}`, t);
    if (config.always) check(path, "always", config.always);
    if (config.onDone) check(path, "onDone", config.onDone);
    if (config.onTimeout) check(path, "onTimeout", config.onTimeout);
    if (config.choice) check(path, "choice", config.choice);
    for (const inv of config.invoke ? [config.invoke as Json].flat() : []) {
      if (inv.onDone) check(path, `invoke ${String(inv.src)} onDone`, inv.onDone);
      if (inv.onError) check(path, `invoke ${String(inv.src)} onError`, inv.onError);
    }
    for (const [key, child] of Object.entries((config.states ?? {}) as Record<string, Json>)) visit(path ? `${path}.${key}` : key, child);
  };
  visit("", definition as Json);
  return problems;
}

export const formatCoverage = (machineId: string, problems: CoverageProblem[]) =>
  problems.map((p) => `${machineId} · ${p.state} · ${p.transition}: ${p.reason}`).join("\n");
