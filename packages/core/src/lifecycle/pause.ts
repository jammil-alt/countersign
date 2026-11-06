// Client controls (ARCHITECTURE §11.5; docs/plan.md §1.36): pausing a client agent records who
// paused it, from which side, why and until when (`agent.pause`). Pausing stops new runs (the
// agent's run status is paused, as today); running ones finish. A client resumes only a pause made
// by the client side; the operator resumes any; the minute cron resumes a pause whose `until` passed.

import { z } from "zod";

export const PAUSE_SIDES = ["client", "operator", "system"] as const;
export const PauseSide = z.enum(PAUSE_SIDES);
export type PauseSide = z.infer<typeof PauseSide>;

/** A pause lasts at most this long when it has an end. */
export const MAX_PAUSE_DAYS = 90;
export const MAX_PAUSE_REASON = 500;

/** `agent.pause` (ARCHITECTURE §5.5). */
export const AgentPause = z
  .object({
    side: PauseSide,
    by: z.string().nullable(),
    reason: z.string(),
    at: z.string(),
    until: z.string().optional(),
    /** Paused by "pause all". */
    all: z.boolean().optional(),
  })
  .loose();
export type AgentPause = z.infer<typeof AgentPause>;

/** A stored `agent.pause`, read leniently: null when absent or unreadable. */
export function readPause(value: unknown): AgentPause | null {
  if (value === null || value === undefined) return null;
  const parsed = AgentPause.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The client admin's pause request: a reason, and an end if they want one. */
export const PauseBody = z.strictObject({
  reason: z.string().trim().min(1).max(MAX_PAUSE_REASON),
  until: z.iso.datetime({ offset: true }).optional(),
});
export type PauseBody = z.infer<typeof PauseBody>;

/** Why `until` can't be used: it must be in the future and at most 90 days away. */
export function pauseUntilProblem(until: string | undefined, now: Date): string | null {
  if (until === undefined) return null;
  const t = new Date(until).getTime();
  if (Number.isNaN(t)) return "the end of the pause isn't a time";
  if (t <= now.getTime()) return "the end of the pause must be in the future";
  if (t - now.getTime() > MAX_PAUSE_DAYS * 86_400_000) {
    return `a pause lasts at most ${MAX_PAUSE_DAYS} days`;
  }
  return null;
}

/** Whether `side` may resume this pause: the client only its own side's; the operator any. */
export function mayResume(pause: AgentPause | null, side: "client" | "operator"): boolean {
  if (side === "operator") return true;
  // DECISION: an agent paused with no record of who paused it (paused before v0.12) is the
  // operator's to resume: the client never resumes what it can't see it paused.
  return pause?.side === "client";
}

/** Whether the minute cron should resume this pause now. */
export function pauseEnded(pause: AgentPause | null, now: Date): boolean {
  if (!pause?.until) return false;
  const t = new Date(pause.until).getTime();
  return !Number.isNaN(t) && t <= now.getTime();
}
