// Reggie's read of an issue (docs/plan.md §1.124; docs/cases-plan.md §6): what it is, how urgent,
// the agent it's about, what Reggie found (with sources, invariant 10), its plan and a draft.
// Stored on `issue.reggie_read`; never in a portal response.

import { z } from "zod";
import { WorkCauseKind, WorkUrgency } from "./pipelines";

export const ReggieRead = z.object({
  kind: z.enum(["issue", "ask", "question", "not_ours"]),
  urgency: WorkUrgency,
  agentId: z.string().nullable(),
  title: z.string().max(200),
  read: z.string().max(600),
  found: z.array(z.object({ text: z.string().max(300), sources: z.array(z.string()) })).max(8),
  plan: z
    .array(
      z.object({
        text: z.string().max(300),
        detail: z.string().max(300),
        who: z.enum(["operator", "reggie", "client"]),
        mode: z.enum(["approve", "draft", "auto"]),
      }),
    )
    .max(6),
  draft: z.object({ text: z.string().max(4000) }).nullable(),
  sure: z.string().max(200),
  /** Reggie's guess at the cause's kind, when it has one (§1.124.4: "Find the cause"). */
  cause: WorkCauseKind.nullable().optional(),
  confident: z.boolean(),
  at: z.string(),
  sourceMessageId: z.string().nullable(),
});
export type ReggieRead = z.infer<typeof ReggieRead>;

/** The stored read, or null when none or unreadable. */
export function readReggieRead(value: unknown): ReggieRead | null {
  const parsed = ReggieRead.safeParse(value);
  return parsed.success ? parsed.data : null;
}
