// The settings a client may adjust (docs/builder-plan.md §7, B5), as the agent's version carries
// them (`definition.adjustable`). Kept apart from their logic (`adjust.ts`) so the agent schema
// can import it without a cycle.

import { z } from "zod";
import { Slug } from "../schemas/common";
import { SetupBounds, SetupItemId, SetupSetting } from "./item";

// ── What the operator marks ────────────────────────────────────────────────────────────────────

/** A skill parameter: the agent's value for the skill, or one step's (as a setup answer sets). */
export const AdjustParameter = SetupSetting.extend({ kind: z.literal("parameter") });
export type AdjustParameter = z.infer<typeof AdjustParameter>;

/** A schedule trigger's time (its cron), in one of the agent's workflows. */
export const AdjustSchedule = z.object({
  kind: z.literal("schedule"),
  workflow: Slug,
  triggerId: z.string().min(1).max(100),
});
export type AdjustSchedule = z.infer<typeof AdjustSchedule>;

/**
 * What a client-adjustable setting changes. Only these two kinds exist: an approval, a permission,
 * a write, a step, a connector or who signs can't be named, so it can't be marked (the "never"
 * class, ARCHITECTURE §10.15).
 */
// DECISION: "who is contacted" is not a kind here: the client admin already chooses the people
// bound to each of the agent's roles on the same Settings tab ("Who it contacts", §1.25), with no
// bounds to keep. A person step's assignee is who decides, which the never class keeps ours.
export const AdjustTarget = z.discriminatedUnion("kind", [AdjustParameter, AdjustSchedule]);
export type AdjustTarget = z.infer<typeof AdjustTarget>;

/** Which way is tighter for a number: a lower tolerance, or a higher threshold to act alone. */
export const AdjustTighter = z.enum(["lower", "higher"]);
export type AdjustTighter = z.infer<typeof AdjustTighter>;

export const AdjustableSetting = z.object({
  id: SetupItemId,
  /** What the client reads: "Price tolerance (%)". */
  label: z.string().trim().min(1).max(200),
  hint: z.string().trim().max(500).default(""),
  target: AdjustTarget,
  /** A number's low and high, or the options it may be (a schedule's allowed crons). */
  bounds: SetupBounds.optional(),
  /** For a number: the side a change may go past the bounds on, because it only asks more. */
  tighter: AdjustTighter.optional(),
  /** The manual's decision it is about, if one: its change is written there. */
  decisionId: z.string().min(1).max(60).optional(),
});
export type AdjustableSetting = z.infer<typeof AdjustableSetting>;
export type AdjustableSettingInput = z.input<typeof AdjustableSetting>;

export const ADJUSTABLE_MAX = 30;

/** `definition.adjustable`: absent on bundles made before it (they parse and hash as they were). */
export const AdjustableSettings = z.array(AdjustableSetting).max(ADJUSTABLE_MAX);
export type AdjustableSettings = z.infer<typeof AdjustableSettings>;

/** The settings a definition marks, read leniently: a list that doesn't read is none. */
export function readAdjustable(raw: unknown): AdjustableSetting[] {
  if (raw === undefined || raw === null) return [];
  const parsed = AdjustableSettings.safeParse(raw);
  return parsed.success ? parsed.data : [];
}
