// R1 (docs/plan.md §1.86, §9): read a bundle's stored v3 workflows as v4 processes, so diff,
// merge and select compare like with like. Pure: nothing stored changes (invariant 3), and the
// converter keeps every step, path, otherwise and trigger id, so items still line up by id.

import { cloneJson } from "../json";
import { type ConvertLookup, fromWorkflowV3 } from "../process/convert";
import { Process, type Step as ProcessStep, Step } from "../process/schema";
import { findStep as findProcessStep } from "../process/walk";
import {
  type AnyAgentBundle,
  type AnyBundleWorkflow,
  holdsProcess,
  type ProcessAgentBundle,
  type ProcessBundleWorkflow,
} from "../schemas/agent";
import { Trigger, type Step as V3Step, type Workflow, WorkflowHandoff } from "../schemas/workflow";
import { findStep as findV3Step, walkSteps as walkV3Steps } from "../workflow/walk";

/** How diff, merge and select read bundles that hold v4 processes. */
export interface BundleReadOptions {
  /**
   * The registries' view for reading v3 workflows as v4 (`processes.ConvertLookup`). Needed only
   * when the bundles mix v3 workflows and v4 processes.
   *
   * A mixed diff, merge or select converts every v3 side with this lookup, the registries as they
   * are now, not as they were when each version was saved: a skill that has since become a
   * tool-wrapper (or a tool whose side effect changed) reads as a `read` or `write` step on every
   * side alike, so the sides still line up by id, but a v3 base and a v4 side saved before the
   * change can differ in a step's kind. Pass the same lookup to every call over the same versions.
   */
  lookup?: ConvertLookup;
}

/**
 * Every workflow of the bundle as a v4 process: v3 workflows through `fromWorkflowV3` (ids kept),
 * v4 processes as they are. The result is a copy. Never throws on what a draft may hold: see
 * `readConverted`.
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
        : readConverted(cloneJson(fromWorkflowV3(w.workflow, lookup))),
  }));
  return { ...out, workflows };
}

/**
 * A converted v3 workflow, parsed with the v4 schema where it can be. A stored draft may hold what
 * v4's minimums refuse (an empty fork, a person step with no assignee: a v3 draft is saved with
 * its errors), so reading never fails on them: a part that doesn't parse keeps its converted value,
 * and every part that does gets its defaults. Whether the process is valid is for validation to
 * say (validateBundle, validateProcess), not for reading.
 */
// DECISION: defaults are filled node by node (each trigger, each step with its children filled
// first, the handoff), so one bad step leaves the rest of the process with its defaults. A step
// that fails keeps its converted value whole; the converter writes every field v4 requires, so only
// what the v3 draft itself left invalid stays unparsed.
export function readConverted(converted: Process): Process {
  const whole = Process.safeParse(converted);
  if (whole.success) return whole.data;
  const handoff = converted.handoff ? WorkflowHandoff.safeParse(converted.handoff) : undefined;
  return {
    ...converted,
    triggers: converted.triggers.map((t) => {
      const r = Trigger.safeParse(t);
      return r.success ? r.data : t;
    }),
    steps: converted.steps.map(fillStep),
    ...(converted.handoff ? { handoff: handoff?.success ? handoff.data : converted.handoff } : {}),
  };
}

/** A placeholder body, so a loop's own fields parse while its real body is filled apart. */
const STUB: ProcessStep = { id: "stub", name: "", kind: "stop", status: "succeeded" };

function fillStep(raw: ProcessStep): ProcessStep {
  let s = raw;
  if (s.kind === "if") {
    s = {
      ...s,
      paths: s.paths.map((p) => ({ ...p, steps: p.steps.map(fillStep) })),
      otherwise: { ...s.otherwise, steps: s.otherwise.steps.map(fillStep) },
    };
  } else if (s.kind === "for_each") {
    s = { ...s, steps: s.steps.map(fillStep) };
  }
  const whole = Step.safeParse(s);
  if (whole.success) return whole.data;
  // A container whose own fields parse but a child doesn't: its defaults, its children as filled.
  if (s.kind === "if") {
    const ifStep = s;
    const shell = Step.safeParse({
      ...ifStep,
      paths: ifStep.paths.map((p) => ({ ...p, steps: [] })),
      otherwise: { ...ifStep.otherwise, steps: [] },
    });
    if (shell.success && shell.data.kind === "if") {
      return {
        ...shell.data,
        paths: shell.data.paths.map((p, i) => ({ ...p, steps: ifStep.paths[i]?.steps ?? [] })),
        otherwise: { ...shell.data.otherwise, steps: ifStep.otherwise.steps },
      };
    }
  } else if (s.kind === "for_each") {
    const loop = s;
    const shell = Step.safeParse({ ...loop, steps: [STUB] });
    if (shell.success && shell.data.kind === "for_each")
      return { ...shell.data, steps: loop.steps };
  }
  return s;
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

/** A step of a bundle's workflow: a stored v3 step or a v4 process step (`kind` tells which). */
export type AnyStep = V3Step | ProcessStep;

/**
 * Wave 3b: visits every step of a bundle's workflows, v3 workflows and v4 processes alike, depth
 * first in run order, with the workflow entry that holds it. Readers that only need each step (the
 * tools, skills and automations a bundle uses, the values promotion strips) share this rather than
 * switching on `schemaVersion` themselves. `enabledOnly` skips disabled workflows.
 */
export function eachBundleStep(
  bundle: Pick<AnyAgentBundle, "workflows">,
  visit: (step: AnyStep, workflow: AnyBundleWorkflow) => void,
  options: { enabledOnly?: boolean } = {},
): void {
  for (const w of bundle.workflows) {
    if (options.enabledOnly && !w.enabled) continue;
    if (w.workflow.schemaVersion === 4) eachProcessStep(w.workflow.steps, (step) => visit(step, w));
    else walkV3Steps(w.workflow, ({ step }) => visit(step, w));
  }
}

/**
 * Wave 3b: the step a `step_run`'s node id names, in a v3 workflow or a v4 process: the id, or the
 * last part of `${loop}:${index}:${childId}` inside a loop.
 */
export function findNodeStep(
  workflow: Pick<Workflow, "schemaVersion" | "steps"> | Pick<Process, "schemaVersion" | "steps">,
  nodeId: string,
): AnyStep | undefined {
  return findAnyStep(workflow, nodeId) ?? findAnyStep(workflow, nodeId.split(":").at(-1) ?? nodeId);
}

/** Wave 3b: a step of a v3 workflow or a v4 process by id, nested ones included. */
export function findAnyStep(
  workflow: Pick<Workflow, "schemaVersion" | "steps"> | Pick<Process, "schemaVersion" | "steps">,
  id: string,
): AnyStep | undefined {
  return workflow.schemaVersion === 4
    ? findProcessStep(workflow, id)?.step
    : findV3Step(workflow, id)?.step;
}
