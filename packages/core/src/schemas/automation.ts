import { z } from "zod";
import { Step as ProcessStep } from "../process/schema";
import { JsonSchema, Slug, TemplateObject } from "./common";
import { Step } from "./workflow";

// v0.12 W2-B: automations (ARCHITECTURE §10.7; docs/plan.md §1.45). An automation is a reusable,
// versioned chain of steps used in a workflow as one `use_automation` step. Rows follow skills:
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

export const AutomationDefinition = z
  .object({
    schemaVersion: z.literal(1),
    slug: Slug,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(""),
    /** The input the use step must give: a JSON Schema object. */
    input: JsonSchema.default({ type: "object", properties: {} }),
    /** The use step's output: a template object over the automation's own top-level steps. */
    output: TemplateObject.default({}),
    /** Any kind except `use_automation` (validation refuses nesting); no trigger. */
    steps: z.array(Step),
    requires: AutomationRequires.prefault({}),
  })
  .meta({ id: "AutomationDefinition" });
export type AutomationDefinition = z.infer<typeof AutomationDefinition>;

// ── Wave 3b: automations whose steps are v4 process steps (docs/plan.md §1.86) ─────────────────
//
// DECISION: an automation saved from a v4 process (the Builder's and the workflow builder's "Save
// as automation") holds v4 process steps and is `schemaVersion: 2`; a stored v1 automation keeps
// its v3 steps and runs, validates and hashes exactly as before (invariant 3). A v4 process step
// pins either; a v3 workflow's use step pins v1 only (its expansion runs v3 steps).

/** An automation whose steps are v4 process steps (they read `{{input…}}`; no trigger). */
export const ProcessAutomationDefinition = z
  .object({
    schemaVersion: z.literal(2),
    slug: Slug,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(""),
    input: JsonSchema.default({ type: "object", properties: {} }),
    output: TemplateObject.default({}),
    /** Any v4 kind except `process` (validation refuses nesting); no trigger. */
    steps: z.array(ProcessStep),
    requires: AutomationRequires.prefault({}),
  })
  .meta({ id: "ProcessAutomationDefinition" });
export type ProcessAutomationDefinition = z.infer<typeof ProcessAutomationDefinition>;

/** A stored automation version: v3 steps (`schemaVersion: 1`) or v4 process steps (`2`). */
export const AnyAutomationDefinition = z.discriminatedUnion("schemaVersion", [
  AutomationDefinition,
  ProcessAutomationDefinition,
]);
export type AnyAutomationDefinition = z.infer<typeof AnyAutomationDefinition>;

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
