import { z } from "zod";
import { isUuid } from "../ids";
import { MATCH_RULE_FIELDS, MatchConfigId, MatchCorrection } from "../matching/fields";
import { defineRoute } from "./contract";

// A client's saved match rules (docs/plan.md §1.215): an operator's correction to a match, kept
// for that client so the matching engine's first tier settles the same pair next time. Back office
// only: clients never see or change matching rules (invariant 11), and a rule never loosens the
// hard rules (amounts, dates, currencies stay checked).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

export const MatchRuleView = z.object({
  id: z.string(),
  config: MatchConfigId,
  field: z.enum(MATCH_RULE_FIELDS),
  aValue: z.string(),
  bValue: z.string(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type MatchRuleView = z.infer<typeof MatchRuleView>;

export const MatchRulesView = z.object({
  rules: z.array(MatchRuleView),
  /** The configurations a rule may be saved for, with what each side is. */
  configs: z.array(z.object({ id: MatchConfigId, a: z.string(), b: z.string() })),
});
export type MatchRulesView = z.infer<typeof MatchRulesView>;

export const SaveMatchRule = MatchCorrection.strict();
export type SaveMatchRule = z.infer<typeof SaveMatchRule>;

export const matchRuleRoutes = {
  opsMatchRules: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/match-rules",
    auth: "session",
    roles: OPS,
    summary: "A client's saved match rules, by configuration",
    params: z.object({ id: Id }),
    response: MatchRulesView,
  }),
  opsSaveMatchRule: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/match-rules",
    auth: "session",
    roles: OPS,
    summary:
      "Save a correction as a rule for the client (normalised; replaces a live rule for the same value); 400 no_rule when the values already agree",
    params: z.object({ id: Id }),
    body: SaveMatchRule,
    response: MatchRulesView,
  }),
  opsRetireMatchRule: defineRoute({
    method: "DELETE",
    path: "/api/ops/clients/:id/match-rules/:ruleId",
    auth: "session",
    roles: OPS,
    summary: "Retire one of the client's saved match rules (kept as history)",
    params: z.object({ id: Id, ruleId: Id }),
    response: MatchRulesView,
  }),
} as const;
