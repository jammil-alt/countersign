// Why a write waits for a person (ARCHITECTURE §11.1 "Why it needs you", docs/plan.md §1.39). The
// gate decides (decide.ts); this only explains, over the gate's own inputs, which of them asked for
// a signature. Stored on the approval's payload as `whyApproval` when the change is proposed.
// Client-safe: only codes and the route's source and rule id, never instructions or prompts.

import { z } from "zod";
import type { ApprovalSource } from "../approvals/rules";
import {
  type AgentMode,
  type ApprovalRequirement,
  type PermissionLevel,
  type PermissionMatrix,
  type Verb,
} from "../schemas/permissions";
import { levelFor } from "./decide";
import { type GrantLimits, grantLevel } from "./grants";

/**
 * - `step`: the step asks for approval (the default);
 * - `matrix`: the connection allows this verb only with approval;
 * - `grant`: the agent's access to the connection allows it only with approval;
 * - `mode`: the agent only suggests;
 * - `stage`: the agent is in its trial or sign-off stage, where every write is signed;
 * - `person`: the person the change reaches asked to see it first (their autonomy).
 */
export const WHY_CODES = ["step", "matrix", "grant", "mode", "stage", "person"] as const;
export const WhyCode = z.enum(WHY_CODES);
export type WhyCode = z.infer<typeof WhyCode>;

export const WhyApproval = z
  .object({
    reasons: z.array(WhyCode),
    /** With `stage`: which stage forced the signature. */
    stage: z.enum(["trial", "signoff"]).optional(),
    /** What chose the approver, and the rule when one did. */
    route: z
      .object({
        source: z.enum(["rule", "step", "agent", "client", "default"]),
        ruleId: z.string().nullable(),
      })
      .optional(),
  })
  .meta({ id: "WhyApproval" });
export type WhyApproval = z.infer<typeof WhyApproval>;

export interface ExplainWriteInput {
  verb: Verb;
  /** The bound connection's matrix. */
  matrix: Partial<PermissionMatrix> | undefined;
  /** The agent's grant on the connection; null or absent = no narrowing. */
  grant?: GrantLimits | null | undefined;
  /** The step's approval setting; absent means `required`. */
  stepApproval?: ApprovalRequirement | undefined;
  /** The agent's own mode, as its definition sets it (not the mode a stage forces). */
  agentMode: AgentMode;
  /**
   * The agent's go-live stage (ARCHITECTURE §10.9). Trial and sign-off force a signature on every
   * write; absent until the stage is known to the caller.
   */
  // DECISION: the stage is its own reason, beside `mode`: W1-A's effectiveMode turns a stage into
  // `suggest_only` for the gate, so the gate passes the definition's mode here and the stage
  // separately, and the person reads "in its trial" rather than "only suggests".
  stage?: string | null | undefined;
  /** The level the recipient's autonomy sets for this channel (docs/plan.md §1.42), if any. */
  person?: PermissionLevel | null | undefined;
  /** What chose the approver (core routeApproval). */
  route?: { source: ApprovalSource; ruleId: string | null } | null | undefined;
}

/**
 * The reasons a write waits, in a fixed order. Pure; called only where the gate already decided
 * `approval`. Every input that by itself would have asked for a signature is listed, so turning
 * one of them off shows what is left.
 */
export function explainWrite(input: ExplainWriteInput): WhyApproval {
  const reasons: WhyCode[] = [];
  if ((input.stepApproval ?? "required") !== "not_required") reasons.push("step");
  if (input.verb !== "read" && levelFor(input.matrix, input.verb) === "approval") {
    reasons.push("matrix");
  }
  if (input.grant && grantLevel(input.grant, input.verb) === "approval") reasons.push("grant");
  if (input.agentMode === "suggest_only") reasons.push("mode");
  const stage = input.stage === "trial" || input.stage === "signoff" ? input.stage : undefined;
  if (stage) reasons.push("stage");
  if (input.person === "approval") reasons.push("person");
  return {
    reasons,
    ...(stage ? { stage } : {}),
    ...(input.route ? { route: { source: input.route.source, ruleId: input.route.ruleId } } : {}),
  };
}

/** Reads a stored `whyApproval`; anything unreadable is no explanation. */
export function readWhyApproval(value: unknown): WhyApproval | null {
  const parsed = WhyApproval.safeParse(value);
  return parsed.success ? parsed.data : null;
}
