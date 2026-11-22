// What the route contract needs of the matching engine (docs/plan.md §1.215), kept apart from the
// configurations so the web app's first load carries only these few schemas.

import { z } from "zod";

/** What a saved rule makes equal (packages/db's `MATCH_RULE_FIELDS`, checked equal there). */
export const MATCH_RULE_FIELDS = ["reference", "counterparty"] as const;
export type MatchRuleField = (typeof MATCH_RULE_FIELDS)[number];

export const MatchConfigId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** An operator's correction, as the API takes it to save a rule. */
export const MatchCorrection = z.object({
  config: MatchConfigId,
  field: z.enum(MATCH_RULE_FIELDS),
  /** As written on each side; normalised by the configuration before it is kept. */
  a: z.string().min(1).max(200),
  b: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});
export type MatchCorrection = z.infer<typeof MatchCorrection>;
