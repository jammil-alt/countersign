// The publish guard for the account agent (docs/plan.md §1.47 "Guards"; ARCHITECTURE §9.8): an
// agent of `platform` kind with the account agent's slug (the supervisor template, and each
// client's fork of it) never reaches a client's tool. Publishing refuses any connector tool or
// `external` tool among its extra tools, its skills' tools and its action steps, and any
// connection binding: Sloan sees only what the portal shows and writes only internal records.

import type { AgentBundle } from "../schemas/agent";
import type { AutomationDefinition } from "../schemas/automation";
import { parseSkillRef } from "../schemas/common";
import { type SkillDefinition, skillTools } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import type { Step } from "../schemas/workflow";
import { ACCOUNT_AGENT_SLUG } from "../threads/schemas";
import type { ValidationError } from "../workflow/validate";
import { walkSteps } from "../workflow/walk";

/** Whether the guard applies: the account agent's slug on a `platform` definition. */
export function isAccountAgent(slug: string | null | undefined, bundle: AgentBundle): boolean {
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
  bundle: AgentBundle;
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
  /** A step's tools: an action's, a skill's; `at` is the bundle's step that holds it. */
  const check = (step: Step, at: { id: string; field: string }, slug: string) => {
    if (step.kind === "action") refuse(step.tool, at.field || "tool", at.id, slug);
    // R9: a v4 process's read and write steps (the supervisor's v4 version) name their tool.
    const kind = (step as { kind: string }).kind;
    if (kind === "read" || kind === "write") {
      refuse((step as unknown as { tool: string }).tool, at.field || "tool", at.id, slug);
    }
    if (step.kind === "skill") {
      const skill = input.skills[step.skill] ?? input.skills[parseSkillRef(step.skill).id];
      for (const id of skill ? skillTools(skill) : []) refuse(id, at.field || "skill", at.id, slug);
    }
  };
  for (const w of bundle.workflows) {
    walkSteps(w.workflow, ({ step }) => {
      check(step, { id: step.id, field: "" }, w.slug);
      // v0.12 W2-B: an automation's steps count as the use step's own.
      if (step.kind === "use_automation") {
        const automation = input.automations?.[step.automation];
        if (!automation) return;
        walkSteps({ steps: automation.steps }, ({ step: inner }) => {
          check(inner, { id: step.id, field: "automation" }, w.slug);
        });
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
