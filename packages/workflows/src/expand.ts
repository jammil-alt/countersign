// Automations expand before execution (ARCHITECTURE §10.7; docs/plan.md §1.45).
//
// Pure: given a workflow and the automation versions its `process` steps pin (loaded once, in the
// run's durable load step), each process step gets its pinned version's steps, with the step's
// approval overrides applied to inner steps. Versions are immutable and inner ids are never
// regenerated, so the expansion is the same on every replay and retry: an inner step's durable
// name is `${processStepId}/${innerId}` (inside a loop, `${loop}:${index}:${stepId}/${innerId}`).

import { type AutomationDefinition, processes } from "@countersign/core";

/** Looks up a pinned automation version: a record by `slug@version`, or a function. */
export type AutomationResolver =
  | Readonly<Record<string, AutomationDefinition>>
  | ((ref: string) => AutomationDefinition | undefined);

export class ExpandError extends Error {
  override name = "ExpandError";
  constructor(
    /** The process step that can't be expanded. */
    readonly stepId: string,
    message: string,
  ) {
    super(message);
  }
}

function lookup(resolve: AutomationResolver, ref: string): AutomationDefinition | undefined {
  if (typeof resolve === "function") return resolve(ref);
  return Object.hasOwn(resolve, ref) ? resolve[ref] : undefined;
}

// ── R3: process steps (docs/plan.md §1.86, §9) ──────────────────────────────────────────────────

/** One `process` step's expansion: the automation's steps. */
export interface ExpandedProcess {
  /** The pinned reference, `slug@version`. */
  ref: string;
  name: string;
  /** The version's steps with the step's approval overrides on their `checks.approval`. */
  steps: processes.Step[];
  /** The step's output: a template over the inner steps and the resolved input. */
  output: Record<string, unknown>;
}

/** Process step id → its expansion. */
export type ProcessExpansions = Record<string, ExpandedProcess>;

/** A deep copy of `steps` with each overridden inner work step's approval replaced. */
function withApprovalChecks(
  steps: readonly processes.Step[],
  approvals: Record<string, processes.ApprovalCheck>,
): processes.Step[] {
  return steps.map((step): processes.Step => {
    const own = Object.hasOwn(approvals, step.id) ? approvals[step.id] : undefined;
    if ((step.kind === "skill" || step.kind === "write" || step.kind === "read") && own) {
      return { ...step, checks: { ...step.checks, approval: own } };
    }
    if (step.kind === "if") {
      return {
        ...step,
        paths: step.paths.map((p) => ({
          ...p,
          steps: withApprovalChecks(p.steps, approvals),
        })),
        otherwise: {
          ...step.otherwise,
          steps: withApprovalChecks(step.otherwise.steps, approvals),
        },
      };
    }
    if (step.kind === "for_each" || step.kind === "repeat") {
      return {
        ...step,
        steps: withApprovalChecks(step.steps, approvals),
      };
    }
    return step;
  });
}

/**
 * Expands every `process` step of a process against the pinned automation versions: the version's
 * steps with the step's approval overrides applied. Throws `ExpandError` for a version that isn't
 * loaded, or one that uses another automation.
 */
// DECISION (R3): the approval overrides are applied to the steps' `checks.approval`, and the gate's approval
// is read back from it (`gateApproval`).
export function expandProcesses(
  process: Pick<processes.Process, "steps">,
  resolve: AutomationResolver,
): ProcessExpansions {
  const out: ProcessExpansions = {};
  for (const use of processes.subProcessSteps([process])) {
    const def = lookup(resolve, use.process);
    if (!def) throw new ExpandError(use.id, `automation ${use.process} is not available`);
    // An automation's steps are process steps already, run as they are.
    if (processes.subProcessSteps([def]).length > 0) {
      throw new ExpandError(use.id, `automation ${use.process} uses another automation`);
    }
    out[use.id] = {
      ref: use.process,
      name: def.name,
      steps: withApprovalChecks(def.steps, use.approvals ?? {}),
      output: def.output,
    };
  }
  return out;
}
