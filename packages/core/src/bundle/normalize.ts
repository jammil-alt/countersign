// R1 (docs/plan.md §1.86, §9): read a bundle's stored v3 workflows as v4 processes, so diff,
// merge and select compare like with like. Pure: nothing stored changes (invariant 3), and the
// converter keeps every step, path, otherwise and trigger id, so items still line up by id.

import { cloneJson } from "../json";
import { type ConvertLookup, fromWorkflowV3 } from "../process/convert";
import { Process, type Step as ProcessStep } from "../process/schema";
import {
  type AnyAgentBundle,
  holdsProcess,
  type ProcessAgentBundle,
  type ProcessBundleWorkflow,
} from "../schemas/agent";

/** How diff, merge and select read bundles that hold v4 processes. */
export interface BundleReadOptions {
  /**
   * The registries' view for reading v3 workflows as v4 (`processes.ConvertLookup`). Needed only
   * when the bundles mix v3 workflows and v4 processes.
   */
  lookup?: ConvertLookup;
}

/**
 * Every workflow of the bundle as a v4 process: v3 workflows through `fromWorkflowV3` (ids kept),
 * v4 processes as they are. The result is a copy.
 */
// DECISION: converted processes are parsed with the v4 schema, so a converted v3 side carries the
// same defaults as a stored (parsed) v4 side and the two never differ by defaults alone.
export function toProcessBundle(bundle: AnyAgentBundle, lookup: ConvertLookup): ProcessAgentBundle {
  const out = cloneJson(bundle);
  const workflows: ProcessBundleWorkflow[] = out.workflows.map((w) => ({
    ...w,
    workflow:
      w.workflow.schemaVersion === 4
        ? w.workflow
        : Process.parse(cloneJson(fromWorkflowV3(w.workflow, lookup))),
  }));
  return { ...out, workflows };
}

/**
 * The bundles as diff, merge and select read them. All v3: as they are, so v3 diffs and merges
 * are what they always were. Any v4 process on any side: every side read as v4 (the lookup is
 * then required when a v3 workflow is left to convert).
 */
// DECISION: the whole bundle is read as v4 when any side holds a process, not workflow by
// workflow: one shape per merge, and the result is ready to save as a v4 version.
export function readBundles(
  bundles: readonly AnyAgentBundle[],
  options: BundleReadOptions = {},
): { bundles: AnyAgentBundle[]; asProcess: boolean } {
  if (!bundles.some(holdsProcess)) return { bundles: [...bundles], asProcess: false };
  const allV4 = bundles.every((b) => b.workflows.every((w) => w.workflow.schemaVersion === 4));
  if (allV4) return { bundles: [...bundles], asProcess: true };
  const { lookup } = options;
  if (!lookup) {
    throw new Error(
      "these bundles mix v3 workflows and v4 processes: pass a lookup to read the v3 ones as v4",
    );
  }
  return { bundles: bundles.map((b) => toProcessBundle(b, lookup)), asProcess: true };
}

/** Visits every v4 step depth first, in run order (if paths, then otherwise; loop bodies). */
export function eachProcessStep(steps: readonly ProcessStep[], visit: (step: ProcessStep) => void) {
  for (const step of steps) {
    visit(step);
    if (step.kind === "if") {
      for (const p of step.paths) eachProcessStep(p.steps, visit);
      eachProcessStep(step.otherwise.steps, visit);
    } else if (step.kind === "for_each") {
      eachProcessStep(step.steps, visit);
    }
  }
}
