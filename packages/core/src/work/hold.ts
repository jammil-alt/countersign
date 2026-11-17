// The safety hold (docs/plan.md §1.124; docs/cases-plan.md §3.2): on a critical issue the client
// agent's writes and messages stop; its runs go on as drafts and the held items wait. Only a person
// releases it. Stored on `agent.hold`; operational, never in a version.

import { z } from "zod";

export const AgentHold = z.object({
  issueId: z.string(),
  by: z.enum(["reggie", "operator"]),
  userId: z.string().nullable(),
  at: z.string(),
  reason: z.string(),
});
export type AgentHold = z.infer<typeof AgentHold>;

/** The stored hold, or null when none. */
export function readHold(value: unknown): AgentHold | null {
  if (value === null || value === undefined) return null;
  const parsed = AgentHold.safeParse(value);
  if (parsed.success) return parsed.data;
  // DECISION: a stored value that no longer parses is still a hold: the gate only tightens, so a
  // malformed hold keeps the agent held until an operator releases it.
  return { issueId: "", by: "operator", userId: null, at: new Date(0).toISOString(), reason: "" };
}
