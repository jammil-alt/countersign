import {
  type AgentMode,
  type ApprovalRequirement,
  DEFAULT_PERMISSIONS,
  type PermissionLevel,
  type PermissionMatrix,
  type SideEffect,
  type Verb,
} from "../schemas/permissions";
import { effectiveMatrix, type GrantLimits } from "./grants";

export type WriteDecision = "run" | "approval" | "refused";

export interface DecideWriteInput {
  verb: Verb;
  /** The bound connection's matrix; missing verbs take the platform defaults. */
  matrix: Partial<PermissionMatrix> | undefined;
  /** The step's approval setting; absent means `required` (approval is on by default). */
  stepApproval?: ApprovalRequirement | undefined;
  agentMode: AgentMode;
}

export function levelFor(
  matrix: Partial<PermissionMatrix> | undefined,
  verb: Verb,
): PermissionLevel {
  return matrix?.[verb] ?? DEFAULT_PERMISSIONS[verb];
}

/**
 * The permission gate's decision for a call through a connection (ARCHITECTURE §9.5, v0.8):
 * - `off` on the connection refuses it;
 * - reads run;
 * - a write runs without a person only when all three say so: the connection allows `auto` for the
 *   verb, the step is set to `not_required`, and the agent's mode is `act`. Anything else waits
 *   for approval.
 * Test runs never execute writes; the runtime handles that before asking here.
 */
export function decideWrite(input: DecideWriteInput): WriteDecision {
  const level = levelFor(input.matrix, input.verb);
  if (level === "off") return "refused";
  if (input.verb === "read") return "run";
  const step = input.stepApproval ?? "required";
  if (level === "auto" && step === "not_required" && input.agentMode === "act") return "run";
  return "approval";
}

/**
 * The gate for any tool call. `none` tools are reads through a connection (or no connection);
 * `internal` tools write the platform's own records and run; `external` tools go through
 * decideWrite. With the agent's grant on the connection, each verb's ceiling is the stricter of
 * the matrix and the grant (docs/plan.md §1.26): a read-only grant refuses a write the matrix
 * allows.
 */
export function decideToolCall(input: {
  sideEffect: SideEffect;
  verb: Verb;
  matrix?: Partial<PermissionMatrix> | undefined;
  /** The agent's grant on the connection; null or absent = no narrowing. */
  grant?: GrantLimits | null | undefined;
  stepApproval?: ApprovalRequirement | undefined;
  agentMode: AgentMode;
  // v0.12 W1-G: extra ceilings (docs/plan.md §1.42), e.g. a message's recipient's autonomy for the
  // channel. `off` refuses the call, `approval` makes a write wait; none of them loosens anything.
  ceilings?: readonly PermissionLevel[] | undefined;
}): WriteDecision {
  if (input.sideEffect === "internal") return "run";
  // v0.12 W1-G: the strictest input wins.
  if (input.ceilings?.includes("off")) return "refused";
  const matrix = input.grant ? effectiveMatrix(input.matrix, input.grant) : input.matrix;
  if (input.sideEffect === "none") {
    if (matrix === undefined) return "run";
    return levelFor(matrix, "read") === "off" ? "refused" : "run";
  }
  const decision = decideWrite({
    verb: input.verb,
    matrix,
    stepApproval: input.stepApproval,
    agentMode: input.agentMode,
  });
  // v0.12 W1-G: an `approval` ceiling turns a write that would run on its own into one that waits.
  return decision === "run" && input.ceilings?.includes("approval") ? "approval" : decision;
}

const STRICTNESS: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };
const VERBS: Verb[] = ["read", "create", "update", "delete"];

/** The verbs a change would loosen (e.g. approval → auto). Client roles may only tighten. */
export function loosenedVerbs(
  before: Partial<PermissionMatrix> | undefined,
  after: Partial<PermissionMatrix>,
): Verb[] {
  return VERBS.filter((v) => STRICTNESS[levelFor(after, v)] < STRICTNESS[levelFor(before, v)]);
}

/** Whether a step may be offered "run without approval" on this connection. */
export function canSkipApproval(
  matrix: Partial<PermissionMatrix> | undefined,
  verb: Verb,
): boolean {
  return verb !== "read" && levelFor(matrix, verb) === "auto";
}
