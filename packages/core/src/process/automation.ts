// Wave 3b (docs/plan.md §1.86): automations whose steps are v4 process steps (`schemaVersion: 2`):
// what one requires, and how a stored automation is validated and read.
// Pure, so the server, the Builder and the workflow builder share it.

import type { AutomationDefinition, AutomationRequires } from "../schemas/automation";
import { skillTools } from "../schemas/skill";
import { lookupSkill, type TypingContext } from "../template/typer";
import type { ValidationError } from "./checks";
import { type ProcessValidationContext, validateProcessAutomation } from "./validate";
import { walkSteps } from "./walk";

/**
 * What a v4 automation needs from an agent that uses it: the skills its steps name, the tools its
 * read and write steps call and its skills' tools, and the connectors behind them. A
 * conversation's channel connection is chosen at run time, so it adds none.
 */
export function processAutomationRequires(
  automation: Pick<AutomationDefinition, "steps">,
  ctx: TypingContext,
  connectorIds?: ReadonlySet<string>,
): AutomationRequires {
  const skills = new Set<string>();
  const tools = new Set<string>();
  const connectors = new Set<string>();
  walkSteps(automation, ({ step }) => {
    if (step.kind === "skill") {
      skills.add(step.skill);
      const def = lookupSkill(step.skill, ctx);
      if (def) {
        for (const t of skillTools(def)) tools.add(t);
        for (const c of def.requiresConnectors) connectors.add(c);
      }
    } else if (step.kind === "read" || (step.kind === "write" && step.tool !== undefined)) {
      tools.add(step.tool as string);
    }
    // DECISION (skill model): an action write step requires no tool or connector here: it resolves
    // from the using agent's bindings when it runs, and publish checks those (`checkWriteAction`).
  });
  for (const id of tools) {
    const spec = ctx.tools?.[id];
    if (spec?.connector) connectors.add(spec.connector);
    else if (spec && connectorIds?.has(spec.source)) connectors.add(spec.source);
  }
  return {
    skills: [...skills].sort(),
    tools: [...tools].sort(),
    connectors: [...connectors].sort(),
  };
}

/** What a stored automation requires. */
export const automationRequires = processAutomationRequires;

/** Validates an automation version (`validateProcessAutomation`). */
export function validateAutomation(
  input: unknown,
  ctx: Omit<ProcessValidationContext, "agent" | "publish" | "clientAgent"> = {},
): { valid: boolean; errors: ValidationError[] } {
  const r = validateProcessAutomation(input, ctx);
  return { valid: r.valid, errors: r.errors as ValidationError[] };
}
