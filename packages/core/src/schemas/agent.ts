import { z } from "zod";
// v0.12 W2-G
import { ClientView } from "../kpi/schema";
// B3 (docs/builder-plan.md §5): the agent manual.
import { AgentManual } from "../manual/manual";
import { DecimalString } from "../money";
// v0.13 W2-I
import { OversightSettings } from "../oversight/decision";
import { OwnerArea } from "../owners/areas";
// R1 (docs/plan.md §1.86): a bundle entry may hold a v4 process.
import { Process } from "../process/schema";
import { PersonRole } from "../reach/rules";
// docs/builder-plan.md §7 (B5): the settings a client may adjust, with their bounds.
import { AdjustableSettings } from "../setup/adjustable";
// docs/builder-plan.md §6: the setup checklist a client copy is set up by.
import { SetupChecklist } from "../setup/item";
// The step model (docs/step-model-plan.md §13c, wave 1): a bundle entry may hold a v5 workflow.
import { Workflow as StepWorkflow } from "../steps/schema";
import { SkillRef, Slug, ToolId } from "./common";
import { AgentMode } from "./permissions";
import { ModelChoice } from "./skill";
import { Workflow } from "./workflow";

/** ARCHITECTURE §9.1. */
export const AgentDefinition = z
  .object({
    schemaVersion: z.literal(2),
    identity: z.object({
      name: z.string().min(1),
      role: z.string(),
      mission: z.string(),
      avatar: z.string().optional(),
    }),
    kind: z.enum(["functional", "platform"]),
    model: z.object({
      id: z.string().min(1),
      maxTokens: z.number().int().positive().default(4096),
    }),
    /** Plain language: how this agent works. */
    instructions: z.string(),
    skills: z.array(
      z.object({
        skill: SkillRef,
        /** Overrides the skill's settings defaults. */
        settings: z.record(z.string(), z.unknown()).default({}),
        // Skill model (2026-11-10): the agent's own values for the skill's parameters, and the
        // model every use of an AI skill runs on in this agent (a step may still override it).
        // Optional with no default, so stored bundles parse and hash as they were.
        // DECISION: on the agent's existing `skills[]` entry, beside `settings`, rather than a
        // new `skillSettings` map: one place per skill the agent uses, and a merge of two
        // versions lines the values up with the skill they belong to.
        /** Parameter name to value: the skill's parameters as this agent uses them. */
        parameters: z.record(z.string(), z.unknown()).optional(),
        /** The model this agent runs an AI skill on, over the skill's recommended model. */
        model: ModelChoice.optional(),
      }),
    ),
    /** Tools beyond those its skills bring. */
    extraTools: z.array(ToolId).default([]),
    /** Agent slugs (same client) it may ask. */
    canCommand: z.array(Slug).default([]),
    permissions: z
      .object({
        mode: AgentMode.default("suggest_only"),
        /** Default approver for this agent's steps (role or user id). */
        approver: z.string().min(1).optional(),
      })
      .prefault({}),
    budgets: z
      .object({
        maxSteps: z.number().int().positive().default(12),
        // DECISION: a decimal string, not a JS number as the sketch in ARCHITECTURE §9.1 has it,
        // because cost is money (CLAUDE.md invariant 6) and is compared with decimal.js.
        maxCostUsd: DecimalString.default("0.50"),
        // §1.77: a client agent's spend on models in a calendar month (UTC), every run and step of
        // it together. Optional with no default, so bundles without it parse and hash as they were;
        // absent means no monthly cap.
        maxMonthlyCostUsd: DecimalString.optional(),
      })
      .prefault({}),
    memory: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    // v0.12 W2-G: what the client sees of this agent (ARCHITECTURE §9.9). Optional with no
    // default, so bundles without it parse and hash as they were.
    clientView: ClientView.optional(),
    // v0.13 W2-I: run oversight (ARCHITECTURE §10.11). Optional with no default: absent means
    // `off`, so bundles without it parse, hash and run as they were.
    oversight: OversightSettings.optional(),
    // v0.19: the business area a template's process belongs to (ARCHITECTURE §10.15). Optional
    // with no default, so bundles without it parse and hash as they were; absent reads from
    // `requiresPacks`, else `general` (`processArea`).
    area: OwnerArea.optional(),
    // B3 (docs/builder-plan.md §5): the agent's manual, written by its build (what it does, its
    // decisions, decision points and known risks). Optional with no default, so bundles without
    // it parse and hash as they were; diffed and merged as any definition field.
    manual: AgentManual.optional(),
    // docs/builder-plan.md §6 (B4): the setup checklist a client copy is set up by, made by code
    // from the build's intake form, its client_setup decisions and the draft's writes. Optional
    // with no default, so bundles without it parse and hash as they were. Each client's progress
    // is operational (`agent.stage_state.setup`), never in a version.
    setup: SetupChecklist.optional(),
    // docs/builder-plan.md §7 (B5): the settings the client admin may adjust in the portal, each
    // a skill parameter or a schedule with its bounds, marked by the operator. Optional with no
    // default, so bundles without it parse and hash as they were; a copy keeps its template's.
    adjustable: AdjustableSettings.optional(),
  })
  .meta({ id: "AgentDefinition" });
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export const BundleWorkflow = z.object({
  slug: Slug,
  name: z.string(),
  enabled: z.boolean().default(true),
  workflow: Workflow,
});
export type BundleWorkflow = z.infer<typeof BundleWorkflow>;

/** One agent version: the whole agent (ARCHITECTURE §9.1), stored in `agent_version.bundle`. */
export const AgentBundle = z
  .object({
    schemaVersion: z.literal(1),
    definition: AgentDefinition,
    workflows: z.array(BundleWorkflow),
    /**
     * The roles this agent reaches (docs/plan.md §1.25): no contact data, which is bound on the
     * client agent. Optional with no default, so older versions parse and hash as they were.
     */
    people: z.array(PersonRole).optional(),
  })
  .meta({ id: "AgentBundle" });
export type AgentBundle = z.infer<typeof AgentBundle>;
export type AgentBundleInput = z.input<typeof AgentBundle>;

// ── R1: bundles that may hold v4 processes (docs/plan.md §1.86, §9) ──────────────────────────
//
// DECISION: `AgentBundle` keeps its v3-only type and schema while the runtime, validator, Builder
// and screens read v3 only; a bundle that may hold v4 processes is `AnyAgentBundle`, whose entries
// are a v3 workflow or a v4 process by `schemaVersion`. Every `AgentBundle` is an
// `AnyAgentBundle`, and a v3 bundle parses to the same value (so the same canonical JSON and
// `bundle_hash`) under either schema. When every reader handles v4 (R3, R8), `AgentBundle` becomes
// this schema and the v3-only one goes.

/**
 * A workflow entry whose workflow is a stored v3 workflow, a v4 process, or (the step model,
 * docs/step-model-plan.md §13a) a v5 workflow.
 */
// DECISION (step model, wave 1): v5 joins the same union rather than a bundle schema of its own,
// so a bundle stores, hashes and validates the same way whichever versions it holds; v3 and v4
// leave the union in wave 4 (§12, R2).
export const AnyBundleWorkflow = BundleWorkflow.extend({
  workflow: z.discriminatedUnion("schemaVersion", [Workflow, Process, StepWorkflow]),
});
export type AnyBundleWorkflow = z.infer<typeof AnyBundleWorkflow>;

/** An agent bundle whose workflows may be v3 workflows or v4 processes, mixed. */
export const AnyAgentBundle = AgentBundle.extend({
  workflows: z.array(AnyBundleWorkflow),
}).meta({ id: "AnyAgentBundle" });
export type AnyAgentBundle = z.infer<typeof AnyAgentBundle>;
export type AnyAgentBundleInput = z.input<typeof AnyAgentBundle>;

/** A workflow entry read as a v4 process. */
export type ProcessBundleWorkflow = Omit<BundleWorkflow, "workflow"> & { workflow: Process };

/** A bundle with every workflow read as a v4 process (core's `toProcessBundle`). */
export type ProcessAgentBundle = Omit<AgentBundle, "workflows"> & {
  workflows: ProcessBundleWorkflow[];
};

/**
 * Wave 3b: the schema of a bundle whose workflows are all v4 processes: what the Builder drafts
 * and answers (docs/plan.md §1.86). Its value is a `ProcessAgentBundle`.
 */
export const ProcessAgentBundle = AgentBundle.extend({
  workflows: z.array(BundleWorkflow.extend({ workflow: Process })),
}).meta({ id: "ProcessAgentBundle" });

/** A workflow entry read as a v5 workflow (the step model). */
export type StepBundleWorkflow = Omit<BundleWorkflow, "workflow"> & { workflow: StepWorkflow };

/** True when any of the bundle's workflows is a v5 workflow (the step model). */
export function holdsStepModel(bundle: Pick<AnyAgentBundle, "workflows">): boolean {
  return bundle.workflows.some((w) => w.workflow.schemaVersion === 5);
}

/** True when any of the bundle's workflows is a v4 process. */
export function holdsProcess(bundle: Pick<AnyAgentBundle, "workflows">): boolean {
  return bundle.workflows.some((w) => w.workflow.schemaVersion === 4);
}
