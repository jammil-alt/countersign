// Hand off (owner, 2026-11-11; docs/plan.md §1.96) and ways in, ways out (2026-11-23), checked on a
// v5 workflow's hand-off steps when a bundle is saved or published: the target agent and step, the
// agent's own other workflows, and the loops such hand-offs make between workflows.

import type { AgentBundle } from "../schemas/agent";
import { doEngine, ENGINE_OUTCOMES } from "../steps/engine";
import type { HandoffStep, Step } from "../steps/schema";
import { eachStep } from "../steps/walk";
import { HANDOFF_ENTRY_KINDS, type HandoffAgent, handoffTargetOf, isSelfHandoff } from "./handoff";
import type { ProcessValidationCode } from "./validate";

/** The client's other agents a hand-off can start, and this agent's own slug (`ctx.handoff`). */
export interface HandoffKnown {
  self?: string | undefined;
  agents: readonly HandoffAgent[];
}

export interface HandoffError {
  stepId: string;
  field: string;
  code: ProcessValidationCode;
  message: string;
  workflow: string;
}

type Workflows = Pick<AgentBundle, "workflows">["workflows"];

function handoffSteps(steps: readonly Step[]): HandoffStep[] {
  const out: HandoffStep[] = [];
  eachStep(steps, ({ step }) => {
    if (step.kind === "handoff") out.push(step);
  });
  return out;
}

/**
 * Whether a v5 step is one a hand-off can start at: the engine it runs as is a read, skill or write
 * (a Do done by a person, a Tell, a Contact or a Collect would ignore the hand-off's input).
 */
function startsHandoff(step: Step): boolean {
  if (step.kind === "loop") return true;
  if (step.kind !== "do") return false;
  try {
    // An action the catalog doesn't tell is a Change, as the engine reads it.
    return HANDOFF_ENTRY_KINDS.has(
      ENGINE_OUTCOMES[doEngine(step, () => undefined).engine] as never,
    );
  } catch {
    return false;
  }
}

/**
 * The errors on every hand-off step of a bundle. With the client's agents known (`known`) a hand-off
 * to another agent is checked against their live versions; one to this agent's own workflow
 * (`@self`) needs no client.
 */
export function stepModelHandoffErrors(
  workflows: Workflows,
  known: HandoffKnown | undefined,
): HandoffError[] {
  const errors: HandoffError[] = [];
  for (const w of workflows) {
    for (const step of handoffSteps(w.workflow.steps)) {
      const add = (field: string, code: ProcessValidationCode, message: string) =>
        errors.push({ stepId: step.id, field, code, message, workflow: w.slug });
      if (isSelfHandoff(step)) {
        selfHandoffErrors(step, w.slug, workflows, add);
        continue;
      }
      if (step.to.agent === "") {
        add("to.agent", "handoff_unknown_agent", "choose the agent to hand off to");
        continue;
      }
      if (step.to.step === "")
        add("to.step", "handoff_unknown_step", "choose the step it starts at");
      if (!known || step.to.step === "") continue;
      if (known.self !== undefined && step.to.agent === known.self) {
        add(
          "to.agent",
          "handoff_same_agent",
          'a hand-off goes to another agent; for one of this agent\'s own workflows, choose "This agent"',
        );
        continue;
      }
      const target = handoffTargetOf(known.agents, step);
      if (!target) {
        add("to.agent", "handoff_unknown_agent", `no agent "${step.to.agent}" in this client`);
      } else if (target.agent.workflow === null) {
        add(
          "to.agent",
          "handoff_no_live",
          `${target.agent.name} has no live version to hand off to`,
        );
      } else if (!target.step) {
        add(
          "to.step",
          "handoff_unknown_step",
          `${target.agent.name}'s live version has no step "${step.to.step}"`,
        );
      } else if (!HANDOFF_ENTRY_KINDS.has(target.step.kind)) {
        add("to.step", "handoff_entry_kind", "a hand-off starts at a read, skill or write step");
      }
    }
  }
  for (const loop of workflowLoops(workflows)) {
    const nameOf = (slug: string) => workflows.find((w) => w.slug === slug)?.name ?? slug;
    const words = loop.map((s) => `"${nameOf(s)}"`).join(" → ");
    const reported = new Set<string>();
    for (let i = 0; i < loop.length - 1; i++) {
      const from = workflows.find((w) => w.slug === loop[i]);
      if (!from) continue;
      for (const step of handoffSteps(from.workflow.steps)) {
        if (!isSelfHandoff(step) || step.to.workflow !== loop[i + 1]) continue;
        const key = `${from.slug}:${step.id}`;
        if (reported.has(key)) continue;
        reported.add(key);
        errors.push({
          stepId: step.id,
          field: "to.workflow",
          code: "handoff_loop",
          message: `these hand-offs go round in a loop: ${words}`,
          workflow: from.slug,
        });
      }
    }
  }
  return errors;
}

function selfHandoffErrors(
  step: HandoffStep,
  own: string,
  workflows: Workflows,
  add: (field: string, code: ProcessValidationCode, message: string) => void,
): void {
  const slug = step.to.workflow;
  if (slug === undefined) {
    add("to.workflow", "handoff_unknown_workflow", "choose the workflow to hand off to");
    return;
  }
  if (step.to.step === "") add("to.step", "handoff_unknown_step", "choose the step it starts at");
  if (slug === own) {
    add(
      "to.workflow",
      "handoff_same_workflow",
      "a hand-off goes to another of this agent's workflows, not back into its own",
    );
    return;
  }
  const target = workflows.find((w) => w.slug === slug);
  if (!target) {
    add("to.workflow", "handoff_unknown_workflow", `this agent has no workflow "${slug}"`);
    return;
  }
  if (target.enabled === false) {
    add(
      "to.workflow",
      "handoff_workflow_off",
      `"${target.name}" is turned off, so nothing can be handed off to it`,
    );
    return;
  }
  if (step.to.step === "") return;
  const entry = target.workflow.steps.find((s) => s.id === step.to.step);
  if (!entry) {
    add(
      "to.step",
      "handoff_unknown_step",
      `"${target.name}" has no step "${step.to.step}" at its top level`,
    );
  } else if (!startsHandoff(entry)) {
    add("to.step", "handoff_entry_kind", "a hand-off starts at a read, skill or write step");
  }
}

/**
 * The loops self hand-offs make between a bundle's workflows (A hands to B, B back to A; or
 * longer): each loop as the workflow slugs in order, starting and ending at the same one. A
 * hand-off to its own workflow is not counted here (the step's own check refuses it).
 */
function workflowLoops(workflows: Workflows): string[][] {
  const edges = new Map<string, string[]>();
  for (const w of workflows) {
    const to = new Set<string>();
    for (const step of handoffSteps(w.workflow.steps)) {
      const target = step.to.workflow;
      if (isSelfHandoff(step) && target !== undefined && target !== w.slug) to.add(target);
    }
    edges.set(w.slug, [...to]);
  }
  // Each loop once: found from its smallest slug, through slugs larger than it.
  const loops: string[][] = [];
  for (const start of [...edges.keys()].sort()) {
    const path = [start];
    const onPath = new Set(path);
    const visit = (at: string) => {
      for (const next of edges.get(at) ?? []) {
        if (next === start) loops.push([...path, start]);
        else if (next > start && !onPath.has(next) && edges.has(next)) {
          path.push(next);
          onPath.add(next);
          visit(next);
          path.pop();
          onPath.delete(next);
        }
      }
    };
    visit(start);
  }
  return loops;
}
