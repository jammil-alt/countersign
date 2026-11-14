// M61 (ARCHITECTURE v0.17 §10.14 "Automations, repeat and the agent's choice"; docs/plan.md §1.99):
// what the agent answers when it chooses an `if`'s path or says whether a repeat is done. One model
// call each, no tools but `finish`; these schemas check the answer (invariant 5). An answer that
// doesn't parse, or names a path the step doesn't allow, counts as unsure (an `if`) or as the limit
// (a repeat): a failed check never picks a path or spends a pass.

import { z } from "zod";

/** The most an answer's reason may say; the operator reads it in the back office only. */
export const CHOICE_REASON_MAX = 500;
/** The most the agent may tell the next pass of a repeat. */
export const CHOICE_FEEDBACK_MAX = 2000;
/** What the agent answers in place of a path when the data doesn't settle it. */
export const CHOICE_UNSURE = "unsure";

const Sources = z.array(z.string().min(1).max(200)).max(50).default([]);

/** An `if` the agent decides: one allowed path's id, or `unsure`, with why and the records used. */
export const PathChoiceAnswer = z.object({
  path: z.string().min(1),
  reason: z.string().trim().min(1).max(CHOICE_REASON_MAX),
  sources: Sources,
});
export type PathChoiceAnswer = z.infer<typeof PathChoiceAnswer>;

/** A repeat the agent judges: done or not, why, and what the next pass should fix. */
export const PassVerdictAnswer = z.object({
  done: z.boolean(),
  reason: z.string().trim().min(1).max(CHOICE_REASON_MAX),
  feedback: z.string().trim().max(CHOICE_FEEDBACK_MAX).optional(),
  sources: Sources,
});
export type PassVerdictAnswer = z.infer<typeof PassVerdictAnswer>;

/** The `finish` tool's input schema for a path choice, its path one of `allowed` or `unsure`. */
export function pathChoiceFinishSchema(allowed: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      path: { type: "string", enum: [...allowed, CHOICE_UNSURE] },
      reason: { type: "string", maxLength: CHOICE_REASON_MAX },
      sources: { type: "array", items: { type: "string" }, maxItems: 50 },
    },
    required: ["path", "reason"],
  };
}

/** The `finish` tool's input schema for a repeat's check. */
export const PASS_VERDICT_FINISH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    done: { type: "boolean" },
    reason: { type: "string", maxLength: CHOICE_REASON_MAX },
    feedback: { type: "string", maxLength: CHOICE_FEEDBACK_MAX },
    sources: { type: "array", items: { type: "string" }, maxItems: 50 },
  },
  required: ["done", "reason"],
};

/**
 * The path an answer picks, if it is one of `allowed`; null for `unsure`, an answer that doesn't
 * parse, or a path the step doesn't allow (its rules failed, or it isn't the step's).
 */
export function pickedPath(answer: unknown, allowed: readonly string[]): PathChoiceAnswer | null {
  const parsed = PathChoiceAnswer.safeParse(answer);
  if (!parsed.success || !allowed.includes(parsed.data.path)) return null;
  return parsed.data;
}
