import { z } from "zod";
// v0.12 W2-G
import { ClientView } from "../kpi/schema";
import { DecimalString } from "../money";
// v0.13 W2-I
import { OversightSettings } from "../oversight/decision";
// R1 (docs/plan.md §1.86): a bundle entry may hold a v4 process.
import { Process } from "../process/schema";
import { PersonRole } from "../reach/rules";
import { SkillRef, Slug, ToolId } from "./common";
import { AgentMode } from "./permissions";
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

/** A workflow entry whose workflow is a stored v3 workflow or a v4 process. */
export const AnyBundleWorkflow = BundleWorkflow.extend({
  workflow: z.discriminatedUnion("schemaVersion", [Workflow, Process]),
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

/** True when any of the bundle's workflows is a v4 process. */
export function holdsProcess(bundle: Pick<AnyAgentBundle, "workflows">): boolean {
  return bundle.workflows.some((w) => w.workflow.schemaVersion === 4);
}
