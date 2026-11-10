// The publish guard for the account agent (docs/plan.md §1.47 "Guards"; ARCHITECTURE §9.8): an
// agent of `platform` kind with the account agent's slug (the supervisor template, and each
// client's fork of it) never reaches a client's tool. Publishing refuses any connector tool or
// `external` tool among its extra tools, its skills' tools and its action steps, and any
// connection binding: Sloan sees only what the portal shows and writes only internal records.

import type { Step as ProcessStep } from "../process/schema";
import { walkSteps as walkProcessSteps } from "../process/walk";
import type { AnyAgentBundle } from "../schemas/agent";
import type { AutomationDefinition } from "../schemas/automation";
import { parseSkillRef } from "../schemas/common";
import { type SkillDefinition, skillTools } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import type { Step } from "../schemas/workflow";
import { ACCOUNT_AGENT_SLUG } from "../threads/schemas";
import type { ValidationError } from "../workflow/validate";
import { walkSteps } from "../workflow/walk";

/** Whether the guard applies: the account agent's slug on a `platform` definition. */
export function isAccountAgent(
  slug: string | null | undefined,
  bundle: Pick<AnyAgentBundle, "definition">,
): boolean {
  return slug === ACCOUNT_AGENT_SLUG && bundle.definition.kind === "platform";
}

/**
 * Why a tool may not be the account agent's: it writes to a client's tool, or it is not one of the
 * platform's own (a connector's). Null: allowed.
 */
// DECISION: "connector tool" is read as any tool whose source is not the platform: a pack's tools
// read the client's business data in their own shapes, not the portal's, so they are refused too.
export function accountToolProblem(spec: ToolSpec | undefined, id: string): string | null {
  if (!spec) return null; // unknown tools are validateBundle's to report
  if (spec.sideEffect === "external") return `${id} writes to a client's tool`;
  if (spec.source !== "platform") return `${id} is a connector's tool`;
  return null;
}

/**
 * The guard's errors for an account agent's bundle. `skills` are the resolved skill definitions
 * by reference (as publish resolves them), `tools` every registered tool's spec, `bindings` the
 * client agent's connection bindings (none for a template).
 */
export function accountAgentProblems(input: {
  slug: string | null | undefined;
  bundle: AnyAgentBundle;
  skills: Readonly<Record<string, SkillDefinition>>;
  tools: Readonly<Record<string, ToolSpec>>;
  bindings?: Readonly<Record<string, string>> | undefined;
  /** The automations its use steps pin, by reference (W2-B). */
  automations?: Readonly<Record<string, AutomationDefinition>> | undefined;
}): ValidationError[] {
  const { bundle, tools } = input;
  if (!isAccountAgent(input.slug, bundle)) return [];
  const errors: ValidationError[] = [];
  const refuse = (id: string, field: string, stepId: string | null, workflow?: string) => {
    const problem = accountToolProblem(tools[id], id);
    if (!problem) return;
    errors.push({
      stepId,
      field,
      code: "tool_not_allowed",
      message: `the account agent only reads what the portal shows: ${problem}`,
      ...(workflow ? { workflow } : {}),
    });
  };
  bundle.definition.extraTools.forEach((id, i) => {
    refuse(id, `definition.extraTools.${i}`, null);
  });
  bundle.definition.skills.forEach((s, i) => {
    const skill = input.skills[s.skill] ?? input.skills[parseSkillRef(s.skill).id];
    for (const id of skill ? skillTools(skill) : []) {
      refuse(id, `definition.skills.${i}.skill`, null);
    }
  });
  /** A v3 step's tools: an action's, a skill's; `at` is the bundle's step that holds it. */
  const check = (step: Step, at: { id: string; field: string }, slug: string) => {
    if (step.kind === "action") refuse(step.tool, at.field || "tool", at.id, slug);
    if (step.kind === "skill") {
      const skill = input.skills[step.skill] ?? input.skills[parseSkillRef(step.skill).id];
      for (const id of skill ? skillTools(skill) : []) refuse(id, at.field || "skill", at.id, slug);
    }
  };
  /** v0.12 W2-B: an automation's steps count as the step's own that pins it. */
  const checkPinned = (ref: string, at: { id: string; field: string }, slug: string) => {
    const automation = input.automations?.[ref];
    if (!automation) return;
    walkSteps({ steps: automation.steps }, ({ step: inner }) => check(inner, at, slug));
  };
  /**
   * Wave 3b: a v4 process step's tools: a read's or a write's tool, a skill's tools, and a
   * `process` step's pinned automation, opened as `use_automation` is. A conversation messages
   * someone outside the client's team, which the account agent never does.
   */
  const checkProcessStep = (step: ProcessStep, slug: string) => {
    if (step.kind === "read" || step.kind === "write") refuse(step.tool, "tool", step.id, slug);
    else if (step.kind === "skill") {
      const skill = input.skills[step.skill] ?? input.skills[parseSkillRef(step.skill).id];
      for (const id of skill ? skillTools(skill) : []) refuse(id, "skill", step.id, slug);
    } else if (step.kind === "process") {
      checkPinned(step.process, { id: step.id, field: "process" }, slug);
    } else if (step.kind === "conversation") {
      errors.push({
        stepId: step.id,
        field: "channel",
        code: "tool_not_allowed",
        message:
          "the account agent only reads what the portal shows: a conversation messages someone outside",
        workflow: slug,
      });
    }
  };
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion === 4) {
      walkProcessSteps(w.workflow, ({ step }) => checkProcessStep(step, w.slug));
      continue;
    }
    walkSteps(w.workflow, ({ step }) => {
      check(step, { id: step.id, field: "" }, w.slug);
      if (step.kind === "use_automation") {
        checkPinned(step.automation, { id: step.id, field: "automation" }, w.slug);
      }
    });
  }
  if (input.bindings && Object.keys(input.bindings).length > 0) {
    errors.push({
      stepId: null,
      field: "bindings",
      code: "tool_not_allowed",
      message: "the account agent has no connections: remove its bindings",
    });
  }
  return errors;
}
