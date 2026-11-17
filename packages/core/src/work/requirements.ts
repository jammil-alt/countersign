// A requirements request (docs/plan.md §1.124; docs/cases-plan.md §3.2): a build's intake
// questions, pre-filled from what we know, sent to the client admin's Desk with a due date.

import { z } from "zod";

export const RequirementField = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(300),
  kind: z.enum(["text", "choice", "file"]),
  required: z.boolean(),
  hint: z.string().max(500).optional(),
  choices: z.array(z.string().max(200)).max(20).optional(),
  prefill: z.object({ value: z.string().max(2000), source: z.string().max(200) }).optional(),
});
export type RequirementField = z.infer<typeof RequirementField>;

export const RequirementsRequest = z.object({
  inboxItemId: z.string(),
  fields: z.array(RequirementField).max(60),
  sentAt: z.string(),
  dueOn: z.string(),
  to: z.object({ userId: z.string(), name: z.string() }),
  answered: z.number().int(),
  total: z.number().int(),
});
export type RequirementsRequest = z.infer<typeof RequirementsRequest>;

/** The request stored on a build, or null when none (or unreadable). */
export function readRequirements(value: unknown): RequirementsRequest | null {
  const parsed = RequirementsRequest.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Answers: a field's key to its text, its choice or a document id. */
export const RequirementAnswers = z.record(z.string(), z.string().max(4000));
export type RequirementAnswers = z.infer<typeof RequirementAnswers>;

/** How many required fields have an answer, of how many required. */
export function requirementsProgress(
  fields: readonly RequirementField[],
  answers: RequirementAnswers,
): { answered: number; total: number } {
  const required = fields.filter((f) => f.required);
  return {
    answered: required.filter((f) => (answers[f.key] ?? "").trim().length > 0).length,
    total: required.length,
  };
}
