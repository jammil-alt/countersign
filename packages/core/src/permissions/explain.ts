// Why a write waits for a person (ARCHITECTURE §11.1 "Why it needs you", docs/plan.md §1.39). The
// gate decides (decide.ts); this only explains, over the gate's own inputs, which of them asked for
// a signature. Stored on the approval's payload as `whyApproval` when the change is proposed.
// Client-safe: only codes and the route's source and rule id, never instructions or prompts.

import { z } from "zod";
import type { ApprovalSource } from "../approvals/rules";
import type {
  AgentMode,
  ApprovalRequirement,
  PermissionLevel,
  PermissionMatrix,
  Verb,
} from "../schemas/permissions";
import { levelFor } from "./decide";
import { entityAsksApproval } from "./entities";
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
    // v0.12 W2-A: with `matrix` or `grant`, the entity whose own setting asked for approval
    // (`invoice`), so the Desk can say which one.
    // DECISION: no new reason code: ARCHITECTURE §11.1 keeps `matrix` for "the connection or the
    // entity allows only approval" (and `grant` likewise); this names the entity beside it.
    entity: z.string().optional(),
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
  /** The mode the gate decided with: core `effectiveMode(definition, stage)`. */
  agentMode: AgentMode;
  /** The agent's own mode, as its definition sets it; absent = `agentMode`. */
  definitionMode?: AgentMode | undefined;
  /**
   * The agent's go-live stage (ARCHITECTURE §10.9). Trial and sign-off force a signature on every
   * write; absent until the stage is known to the caller.
   */
  // DECISION: the stage is its own reason, beside `mode`: effectiveMode turns trial and sign-off
  // into `suggest_only` for the gate, so the explanation names `stage` for that, and `mode` only
  // when the effective mode asks for a signature for another reason (the definition only
  // suggests, or a stage other than trial and sign-off), so a person reads "in its trial" rather
  // than "only suggests".
  stage?: string | null | undefined;
  /** The level the recipient's autonomy sets for this channel (docs/plan.md §1.42), if any. */
  person?: PermissionLevel | null | undefined;
  /** What chose the approver (core routeApproval). */
  route?: { source: ApprovalSource; ruleId: string | null } | null | undefined;
  /** v0.12 W2-A: the entity the call works on (core `entityOfCall`), if any. */
  entity?: string | null | undefined;
}

/**
 * The reasons a write waits, in a fixed order. Pure; called only where the gate already decided
 * `approval`. Every input that by itself would have asked for a signature is listed, so turning
 * one of them off shows what is left.
 */
export function explainWrite(input: ExplainWriteInput): WhyApproval {
  const reasons: WhyCode[] = [];
  if ((input.stepApproval ?? "required") !== "not_required") reasons.push("step");
  // v0.12 W2-A: `matrix` and `grant` also when the entity's own level asks (ARCHITECTURE §11.1:
  // "the connection or the entity allows only approval"); `entity` names it.
  const write = input.verb !== "read";
  const connEntity = write && entityAsksApproval(input.matrix, input.entity, input.verb);
  const grantEntity =
    write && Boolean(input.grant) && entityAsksApproval(input.grant, input.entity, input.verb);
  if (write && (levelFor(input.matrix, input.verb) === "approval" || connEntity)) {
    reasons.push("matrix");
  }
  if (input.grant && (grantLevel(input.grant, input.verb) === "approval" || grantEntity)) {
    reasons.push("grant");
  }
  const stage = input.stage === "trial" || input.stage === "signoff" ? input.stage : undefined;
  const ownMode = input.definitionMode ?? input.agentMode;
  if (input.agentMode === "suggest_only" && !(stage && ownMode === "act")) reasons.push("mode");
  if (stage) reasons.push("stage");
  if (input.person === "approval") reasons.push("person");
  return {
    reasons,
    ...(stage ? { stage } : {}),
    ...((connEntity || grantEntity) && input.entity ? { entity: input.entity } : {}),
    ...(input.route ? { route: { source: input.route.source, ruleId: input.route.ruleId } } : {}),
  };
}

/** Reads a stored `whyApproval`; anything unreadable is no explanation. */
export function readWhyApproval(value: unknown): WhyApproval | null {
  const parsed = WhyApproval.safeParse(value);
  return parsed.success ? parsed.data : null;
}
