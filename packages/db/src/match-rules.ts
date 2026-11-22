// A client's saved match rules (docs/plan.md §1.215; migration 0085): an operator's correction to
// a match kept for that client and one matching configuration, read by the matching engine's first
// tier. One client's transaction; nothing of another client is visible (invariant 1). Values come
// here already normalised by the configuration (core's `ruleFromCorrection`). Retired, never
// edited or deleted.

import type { SavedMatchRule } from "@countersign/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Tx } from "./client";
import { type MATCH_RULE_FIELDS, matchRule } from "./schema";

export interface MatchRuleView {
  id: string;
  config: string;
  field: (typeof MATCH_RULE_FIELDS)[number];
  aValue: string;
  bValue: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

/** At most this many live rules a configuration is read (the engine's maps stay small). */
// DECISION: 2,000 a client and configuration, oldest first: far more than corrections a person
// makes; past it the newest wait, and the screen says how many there are.
export const MATCH_RULES_MAX = 2000;

/** The client's live rules for a configuration, as the engine reads them. */
export async function liveMatchRules(
  tx: Tx,
  tenantId: string,
  config: string,
): Promise<SavedMatchRule[]> {
  const rows = await tx
    .select({
      id: matchRule.id,
      field: matchRule.field,
      aValue: matchRule.aValue,
      bValue: matchRule.bValue,
    })
    .from(matchRule)
    .where(
      and(
        eq(matchRule.tenantId, tenantId),
        eq(matchRule.config, config),
        isNull(matchRule.retiredAt),
      ),
    )
    .orderBy(asc(matchRule.createdAt), asc(matchRule.id))
    .limit(MATCH_RULES_MAX);
  return rows;
}

/** The client's live rules, every configuration, for the back office. */
export async function listMatchRules(tx: Tx, tenantId: string): Promise<MatchRuleView[]> {
  const rows = await tx
    .select()
    .from(matchRule)
    .where(and(eq(matchRule.tenantId, tenantId), isNull(matchRule.retiredAt)))
    .orderBy(asc(matchRule.config), asc(matchRule.createdAt), asc(matchRule.id))
    .limit(MATCH_RULES_MAX);
  return rows.map((r) => ({
    id: r.id,
    config: r.config,
    field: r.field,
    aValue: r.aValue,
    bValue: r.bValue,
    note: r.note,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Saves a rule. A live rule for the same value on side A is retired first, so the newest
 * correction is the one the engine reads.
 */
export async function saveMatchRule(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    config: string;
    field: (typeof MATCH_RULE_FIELDS)[number];
    aValue: string;
    bValue: string;
    note?: string | null | undefined;
  },
): Promise<{ id: string; replaced: string | null }> {
  const [old] = await tx
    .update(matchRule)
    .set({ retiredAt: new Date(), retiredBy: input.userId })
    .where(
      and(
        eq(matchRule.tenantId, input.tenantId),
        eq(matchRule.config, input.config),
        eq(matchRule.field, input.field),
        eq(matchRule.aValue, input.aValue),
        isNull(matchRule.retiredAt),
      ),
    )
    .returning({ id: matchRule.id });
  const [made] = await tx
    .insert(matchRule)
    .values({
      tenantId: input.tenantId,
      config: input.config,
      field: input.field,
      aValue: input.aValue,
      bValue: input.bValue,
      note: input.note ?? null,
      createdBy: input.userId,
    })
    .returning({ id: matchRule.id });
  if (!made) throw new Error("the rule wasn't saved");
  return { id: made.id, replaced: old?.id ?? null };
}

/** Retires a live rule; false when there is none by that id for the client. */
export async function retireMatchRule(
  tx: Tx,
  input: { tenantId: string; userId: string; id: string },
): Promise<boolean> {
  const rows = await tx
    .update(matchRule)
    .set({ retiredAt: new Date(), retiredBy: input.userId })
    .where(
      and(
        eq(matchRule.tenantId, input.tenantId),
        eq(matchRule.id, input.id),
        isNull(matchRule.retiredAt),
      ),
    )
    .returning({ id: matchRule.id });
  return rows.length > 0;
}
