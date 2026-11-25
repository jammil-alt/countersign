import { z } from "zod";
import { Step as ProcessStep } from "../process/schema";
import { JsonSchema, Slug, TemplateObject } from "./common";

// v0.12 W2-B: automations (ARCHITECTURE §10.7; docs/plan.md §1.45). An automation is a reusable,
// versioned chain of steps used in a workflow as one step (a Do that uses it). Rows follow skills:
// shared (tenant_id null) or written for one client, draft → publish → rollback, versions
// immutable. The step list has no trigger: its steps read `{{input.<path>}}` and their own earlier
// steps, and its `output` (a template over its own steps) is what the use step outputs.

/** What an automation needs from the agent that uses it. Computed on save, never trusted as sent. */
export const AutomationRequires = z.object({
  skills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  connectors: z.array(z.string()).default([]),
});
export type AutomationRequires = z.infer<typeof AutomationRequires>;

/** An automation: a reusable chain of steps (they read `{{input…}}`; no trigger). */
export const AutomationDefinition = z
  .object({
    schemaVersion: z.literal(2),
    slug: Slug,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(""),
    /** The input the step that uses it must give: a JSON Schema object. */
    input: JsonSchema.default({ type: "object", properties: {} }),
    /** The step's output: a template object over the automation's own top-level steps. */
    output: TemplateObject.default({}),
    /** Any kind except `process` (validation refuses nesting); no trigger. */
    steps: z.array(ProcessStep),
    requires: AutomationRequires.prefault({}),
  })
  .meta({ id: "AutomationDefinition" });
export type AutomationDefinition = z.infer<typeof AutomationDefinition>;

/** `follow-up@3` → `{ slug: "follow-up", version: 3 }`. */
export function parseAutomationRef(ref: string): { slug: string; version: number } {
  const at = ref.lastIndexOf("@");
  if (at === -1) return { slug: ref, version: Number.NaN };
  return { slug: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}

export function automationRef(slug: string, version: number): string {
  return `${slug}@${version}`;
}

/** The `step_run.skill_ref` a use step writes: `automation:<slug>@<version>`. */
export const AUTOMATION_SKILL_REF_PREFIX = "automation:";

export function automationSkillRef(ref: string): string {
  return `${AUTOMATION_SKILL_REF_PREFIX}${ref}`;
}

/**
 * The durable name of a step inside a use step: `${useNodeId}/${innerId}` (ids never contain `/`
 * or `:`, so the name stays unique and a retried run finds it).
 */
export function automationNodeId(useNodeId: string, innerId: string): string {
  return `${useNodeId}/${innerId}`;
}
