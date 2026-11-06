// v0.12 W2-B: automations expand before execution (ARCHITECTURE §10.7; docs/plan.md §1.45).
//
// Pure: given a workflow and the automation versions it pins (loaded once, in the run's durable load
// step), each use step gets its pinned version's steps, with the use step's approval overrides
// applied to inner write steps. Versions are immutable and inner ids are never regenerated, so the
// expansion is the same on every replay and retry: an inner step's durable name is
// `${useNodeId}/${innerId}` (inside a loop, `${loop}:${index}:${useId}/${innerId}`).

import { type AutomationDefinition, type Step, useSteps, type Workflow } from "@countersign/core";

/** One use step's expansion: the steps it runs and what it outputs. */
export interface ExpandedAutomation {
  /** The pinned reference, `slug@version`. */
  ref: string;
  name: string;
  /** The version's steps, with the use step's approval overrides applied. */
  steps: Step[];
  /** The use step's output: a template over the inner steps and the resolved input. */
  output: Record<string, unknown>;
}

/** Use step id → its expansion. */
export type Expansions = Record<string, ExpandedAutomation>;

/** Looks up a pinned automation version: a record by `slug@version`, or a function. */
export type AutomationResolver =
  | Readonly<Record<string, AutomationDefinition>>
  | ((ref: string) => AutomationDefinition | undefined);

export class ExpandError extends Error {
  override name = "ExpandError";
  constructor(
    /** The use step that can't be expanded. */
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

/** A deep copy of `steps` with each overridden inner write step's approval replaced. */
function withApprovals(steps: readonly Step[], approvals: Record<string, unknown>): Step[] {
  return steps.map((step): Step => {
    const own = Object.hasOwn(approvals, step.id) ? approvals[step.id] : undefined;
    if ((step.kind === "skill" || step.kind === "action") && own !== undefined) {
      return { ...step, approval: own as NonNullable<typeof step.approval> };
    }
    if (step.kind === "fork") {
      return {
        ...step,
        paths: step.paths.map((p) => ({ ...p, steps: withApprovals(p.steps, approvals) })),
        otherwise: {
          ...step.otherwise,
          steps: withApprovals(step.otherwise.steps, approvals),
        },
      };
    }
    if (step.kind === "for_each") return { ...step, steps: withApprovals(step.steps, approvals) };
    return step;
  });
}

/**
 * Expands every use step of `workflow` against the pinned versions. Throws `ExpandError` for a
 * version that isn't loaded, or one that uses another automation (no nesting in v0.12).
 */
export function expandAutomations(
  workflow: Pick<Workflow, "steps">,
  resolve: AutomationResolver,
): Expansions {
  const out: Expansions = {};
  for (const use of useSteps([workflow])) {
    const def = lookup(resolve, use.automation);
    if (!def) throw new ExpandError(use.id, `automation ${use.automation} is not available`);
    if (useSteps([def]).length > 0) {
      throw new ExpandError(use.id, `automation ${use.automation} uses another automation`);
    }
    out[use.id] = {
      ref: use.automation,
      name: def.name,
      // Inner write steps keep their own approval (on by default, invariant 8) unless the
      // operator set an override on this client agent's use step.
      steps: withApprovals(def.steps, use.approvals ?? {}),
      output: def.output,
    };
  }
  return out;
}
