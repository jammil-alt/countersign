// R8 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "The Library and the client's settings"): every
// condition a process uses, where it uses it. The Library's condition sets are named `Rules` reused
// across checks and `if` steps; nothing stores named sets yet, so the Library shows the conditions
// the processes use, grouped where two places use the same rules. Pure.

import { canonicalJson } from "../canonical";
import type { Rules } from "../schemas/rules";
import type { Checks, Process } from "./schema";
import { walkSteps } from "./walk";

/** Where a condition sits: a trigger's filter, an `if` path, or one of a step's checks. */
export const CONDITION_PLACES = [
  "trigger",
  "if_path",
  "confer",
  "conferee",
  "approval",
  "notify",
  "urgent",
] as const;
export type ConditionPlace = (typeof CONDITION_PLACES)[number];

export interface ConditionUse {
  when: Rules;
  place: ConditionPlace;
  /** The step it is on; null for a trigger's filter. */
  stepId: string | null;
  stepName: string | null;
  /** The trigger's id, or the `if` path's name; null elsewhere. */
  label: string | null;
}

/** Rules with no rows always hold: they are no condition, so they are left out. */
function holdsSomething(when: Rules | undefined): when is Rules {
  return when !== undefined && when.rules.length > 0;
}

function checkUses(
  checks: Checks | undefined,
  at: { stepId: string; stepName: string },
  out: ConditionUse[],
): void {
  if (!checks) return;
  const add = (when: Rules | undefined, place: ConditionPlace) => {
    if (holdsSomething(when)) out.push({ when, place, ...at, label: null });
  };
  add(checks.confer?.when, "confer");
  for (const c of checks.confer?.with ?? []) add(c.when, "conferee");
  add(checks.approval?.when, "approval");
  for (const n of checks.notify ?? []) {
    add(n.when, "notify");
    add(n.urgent?.when, "urgent");
  }
}

/**
 * Every condition in a process, in run order: the triggers' filters, then each step's `if` paths
 * and checks (a notify step's own `when` is a notify's; a `process` step's approval overrides are
 * approvals).
 */
export function conditionUses(process: Pick<Process, "triggers" | "steps">): ConditionUse[] {
  const out: ConditionUse[] = [];
  for (const t of process.triggers) {
    const filter = "filter" in t.on ? t.on.filter : undefined;
    if (holdsSomething(filter)) {
      out.push({ when: filter, place: "trigger", stepId: null, stepName: null, label: t.id });
    }
  }
  walkSteps(process, ({ step }) => {
    const at = { stepId: step.id, stepName: step.name };
    if (step.kind === "if") {
      for (const p of step.paths) {
        if (holdsSomething(p.when))
          out.push({ when: p.when, place: "if_path", ...at, label: p.name });
      }
    }
    if (step.kind === "notify") checkUses({ notify: [step.notify] }, at, out);
    if (step.kind === "process") {
      for (const a of Object.values(step.approvals ?? {})) checkUses({ approval: a }, at, out);
    }
    checkUses(step.checks, at, out);
  });
  return out;
}

/**
 * The key two uses of the same rules share: the canonical JSON of the rows and how they combine
 * (`all` when unsaid), so rules written in another key order still group together.
 */
export function conditionKey(when: Rules): string {
  return canonicalJson({ match: when.match ?? "all", rules: when.rules });
}
