import { z } from "zod";
// v0.12 W2-G
import { ClientView } from "../kpi/schema";
// B3 (docs/builder-plan.md §5): the agent manual.
import { AgentManual } from "../manual/manual";
import { DecimalString } from "../money";
// v0.13 W2-I
import { OversightSettings } from "../oversight/decision";
import { OwnerArea } from "../owners/areas";
import { PersonRole } from "../reach/rules";
import { AgentData } from "../records/grants";
// docs/builder-plan.md §7 (B5): the settings a client may adjust, with their bounds.
import { AdjustableSettings } from "../setup/adjustable";
// docs/builder-plan.md §6: the setup checklist a client copy is set up by.
import { SetupChecklist } from "../setup/item";
// The step model (docs/step-model-plan.md §13c): a bundle entry holds a v5 workflow.
import { Workflow } from "../steps/schema";
import { SkillRef, Slug, ToolId } from "./common";
import { AgentMode } from "./permissions";
import { ModelChoice } from "./skill";

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
    // Step model §10f (stream N): what the agent may read, create and update of our own records,
    // per record type, and its data sets. Optional with no default, so bundles without it parse
    // and hash as they were; absent grants nothing (the standard record actions are refused).
    data: AgentData.optional(),
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
