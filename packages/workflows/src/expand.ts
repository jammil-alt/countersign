// v0.12 W2-B: automations expand before execution (ARCHITECTURE §10.7; docs/plan.md §1.45).
//
// Pure: given a workflow and the automation versions it pins (loaded once, in the run's durable load
// step), each use step gets its pinned version's steps, with the use step's approval overrides
// applied to inner write steps. Versions are immutable and inner ids are never regenerated, so the
// expansion is the same on every replay and retry: an inner step's durable name is
// `${useNodeId}/${innerId}` (inside a loop, `${loop}:${index}:${useId}/${innerId}`).

import {
  type AnyAutomationDefinition,
  processes,
  type Step,
  useSteps,
  type Workflow,
} from "@countersign/core";
// R3
import { type Origins, stepsFromV3 } from "./process";

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
  | Readonly<Record<string, AnyAutomationDefinition>>
  | ((ref: string) => AnyAutomationDefinition | undefined);

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

function lookup(resolve: AutomationResolver, ref: string): AnyAutomationDefinition | undefined {
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
    // Wave 3b: a v4 automation runs only inside a v4 process (validation refuses it here too).
    if (def.schemaVersion === 2) {
      throw new ExpandError(use.id, `automation ${use.automation} holds process steps`);
    }
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

// ── R3: process steps (docs/plan.md §1.86, §9) ──────────────────────────────────────────────────

/** One `process` step's expansion: the automation's steps read as v4. */
export interface ExpandedProcess {
  /** The pinned reference, `slug@version`. */
  ref: string;
  name: string;
  /** The version's steps as v4, with the step's approval overrides on their `checks.approval`. */
  steps: processes.Step[];
  /** The step's output: a template over the inner steps and the resolved input. */
  output: Record<string, unknown>;
}

/** Process step id → its expansion. */
export type ProcessExpansions = Record<string, ExpandedProcess>;

/** A deep copy of v4 `steps` with each overridden inner work step's approval replaced. */
function withApprovalChecks(
  steps: readonly processes.Step[],
  approvals: Record<string, processes.ApprovalCheck>,
  origins: Origins,
  overrides?: WeakSet<object>,
): processes.Step[] {
  return steps.map((step): processes.Step => {
    const keep = (next: processes.Step): processes.Step => {
      const origin = origins.get(step);
      if (origin) origins.set(next, origin);
      return next;
    };
    const own = Object.hasOwn(approvals, step.id) ? approvals[step.id] : undefined;
    if ((step.kind === "skill" || step.kind === "write" || step.kind === "read") && own) {
      overrides?.add(own);
      return keep({ ...step, checks: { ...step.checks, approval: own } });
    }
    if (step.kind === "if") {
      return keep({
        ...step,
        paths: step.paths.map((p) => ({
          ...p,
          steps: withApprovalChecks(p.steps, approvals, origins, overrides),
        })),
        otherwise: {
          ...step.otherwise,
          steps: withApprovalChecks(step.otherwise.steps, approvals, origins, overrides),
        },
      });
    }
    if (step.kind === "for_each" || step.kind === "repeat") {
      return keep({
        ...step,
        steps: withApprovalChecks(step.steps, approvals, origins, overrides),
      });
    }
    return step;
  });
}

/**
 * Expands every `process` step of a v4 process against the pinned automation versions, as
 * `expandAutomations` does for v3: the version's (v3) steps read as v4 with their origins paired,
 * the step's approval overrides applied. Throws `ExpandError` for a version that isn't loaded, or
 * one that uses another automation. `overrides` collects the override checks a native v4 `process`
 * step sets: they are native v4 approvals (modes, deadlines, away approvers), though the steps they
 * sit on were converted. A converted v3 `use_automation` step's overrides are its stored v3
 * approvals (the converter's `approvalOf`), so they are not collected: they are decided exactly as
 * v3 decided them (the approver waited for, never skipped as away).
 */
// DECISION (R3): overrides are applied to the v4 steps' `checks.approval`, and the gate's approval
// is read back from it (`gateApproval`); for a converted v3 override that is the stored v3 approval
// again, so a v3 workflow's automations run with exactly the approvals they had.
export function expandProcesses(
  process: Pick<processes.Process, "steps">,
  resolve: AutomationResolver,
  convert: processes.ConvertLookup,
  origins: Origins,
  overrides?: WeakSet<object>,
): ProcessExpansions {
  const out: ProcessExpansions = {};
  for (const use of processes.subProcessSteps([process])) {
    const def = lookup(resolve, use.process);
    if (!def) throw new ExpandError(use.id, `automation ${use.process} is not available`);
    // Wave 3b: a v4 automation's steps are process steps already, run as they are.
    const nested =
      def.schemaVersion === 2
        ? processes.subProcessSteps([def]).length > 0
        : useSteps([def]).length > 0;
    if (nested) {
      throw new ExpandError(use.id, `automation ${use.process} uses another automation`);
    }
    out[use.id] = {
      ref: use.process,
      name: def.name,
      steps: withApprovalChecks(
        def.schemaVersion === 2 ? def.steps : stepsFromV3(def.steps, convert, origins),
        use.approvals ?? {},
        origins,
        // DECISION (wave 2c): a step with an origin is a converted v3 use step, whose overrides
        // stay v3 approvals; only a native process step's are collected as native checks.
        origins.has(use) ? undefined : overrides,
      ),
      output: def.output,
    };
  }
  return out;
}
