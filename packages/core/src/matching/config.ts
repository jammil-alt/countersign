// The matching engine's configurations (docs/plan.md §1.215): one engine, the tiers and rules each
// use set here. A pack names a configuration and may tighten its numbers; nothing here names a
// pack (invariant 2).

import { z } from "zod";
import { DecimalString } from "../money";
import { MATCH_RULE_FIELDS, MatchConfigId } from "./fields";
import { REFERENCE_FORMS } from "./normalize";

/** The deterministic rules, in the order a configuration lists them. */
export const DETERMINISTIC_RULES = [
  /** The same reference, the same amount, within the window: one each way. */
  "reference",
  /** One item is several on the other side that all carry its reference, and their sum. */
  "reference_group",
  /** The same counterparty, the same amount, within the window: one each way. */
  "counterparty_amount",
  /** The same amount within the window, one candidate each way; again until nothing changes. */
  "amount_date",
  /** One item is the sum of 2..maxGroup on the other side within the window, when one group fits. */
  "group",
  /** The same reference, the same sign, amounts that differ: part of it (a part payment). */
  "partial",
] as const;
export type DeterministicRule = (typeof DETERMINISTIC_RULES)[number];

export const MATCH_TIERS = ["client_rule", "deterministic", "fuzzy", "model"] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

export const MATCH_TYPES = ["one_to_one", "one_to_many", "many_to_one", "partial"] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const MatchConfig = z.object({
  id: MatchConfigId,
  /** What each side is, in plain words ("Bank", "Books"). */
  sides: z.object({ a: z.string().min(1).max(60), b: z.string().min(1).max(60) }),
  /** How many days apart two sides' dates of one thing may be. */
  windowDays: z.number().int().min(0).max(366),
  /** The most two amounts may differ by and still be the same (in the currency). */
  tolerance: DecimalString,
  reference: z.enum(REFERENCE_FORMS),
  rules: z.array(z.enum(DETERMINISTIC_RULES)).max(DETERMINISTIC_RULES.length),
  /** The most items one item may be the sum of. */
  maxGroup: z.number().int().min(2).max(12),
  /** Candidate pools larger than this aren't searched for groups (the search stays bounded). */
  groupPoolMax: z.number().int().min(2).max(24),
  /** The fuzzy tier, or null for none. */
  fuzzy: z
    .object({
      threshold: z.number().gt(0).max(1),
      /** Two counterparties both stated and less alike than this are never the same. */
      counterpartyFloor: z.number().min(0).max(1),
    })
    .nullable(),
  /** The model tier for what is left, or null for none. */
  model: z
    .object({
      threshold: z.number().gt(0).max(1),
      /** At most this many candidates a question. */
      candidates: z.number().int().min(1).max(10),
    })
    .nullable(),
  /** Hard rules: two references both stated that differ, or two currencies, are never the same. */
  vetoes: z.object({ reference: z.boolean(), currency: z.boolean() }),
});
export type MatchConfig = z.infer<typeof MatchConfig>;

/**
 * Bank (or card) lines against the ledger: Bookkeeping's reconciliation (§1.80) on the engine.
 * DECISION: deterministic only, as §1.80 had it: a bank line's words beside a ledger memo say little,
 * so the model's proposals and a person's decisions stay the reconciliation's own, after the engine.
 */
export const BANK_TO_LEDGER: MatchConfig = {
  id: "bank_to_ledger",
  sides: { a: "Bank", b: "Books" },
  windowDays: 5,
  tolerance: "0",
  reference: "alnum",
  rules: ["reference", "amount_date", "group"],
  maxGroup: 6,
  groupPoolMax: 18,
  fuzzy: null,
  model: null,
  vetoes: { reference: false, currency: true },
};

/**
 * One invoice as two systems hold it (the ROMCO case: the client's books and a customer's or
 * vendor's own system): numbers written differently, names spelled differently, dates a few days
 * apart, an invoice paid in parts or split in two.
 */
// DECISION: 30 days and a cent: two systems date an invoice by issue, posting or receipt, and round
// tax by line or by total. Two invoice numbers both stated that differ are never the same (a hard
// rule); the model sees only what the rules and the fuzzy tier left, and is held to the same vetoes.
export const INVOICE_TWO_SYSTEMS: MatchConfig = {
  id: "invoice_two_systems",
  sides: { a: "Our books", b: "Their system" },
  windowDays: 30,
  tolerance: "0.01",
  reference: "invoice_number",
  rules: ["reference", "reference_group", "counterparty_amount", "partial", "group"],
  maxGroup: 4,
  groupPoolMax: 16,
  fuzzy: { threshold: 0.9, counterpartyFloor: 0.5 },
  model: { threshold: 0.9, candidates: 5 },
  vetoes: { reference: true, currency: true },
};

/**
 * A vendor's bill against the client's purchase orders (the AP pack, Plan entry §1.233): side A the
 * bills, side B the orders placed with that vendor. The bill names the order by the reference it
 * prints (the PO number), and a bill often differs from its order by freight, tax or a part
 * delivery, so a same-reference pair whose amounts differ is a `partial` the pack explains line by
 * line (quantities against receipts, prices against the order).
 */
// DECISION: 120 days (an order billed after a long lead time) and a cent. Two PO numbers both
// stated that differ are never the same (a hard rule); no model tier: an order the rules don't
// settle waits for a person on the week's list, and the fuzzy tier's pairs are only proposals
// there (the pack reads a fuzzy match as `proposed`).
export const BILL_TO_PO: MatchConfig = {
  id: "bill_to_po",
  sides: { a: "Bills", b: "Purchase orders" },
  windowDays: 120,
  tolerance: "0.01",
  reference: "alnum",
  rules: ["reference", "partial", "counterparty_amount"],
  maxGroup: 4,
  groupPoolMax: 16,
  fuzzy: { threshold: 0.9, counterpartyFloor: 0.5 },
  model: null,
  vetoes: { reference: true, currency: true },
};

export const MATCH_CONFIGS: Readonly<Record<string, MatchConfig>> = {
  [BANK_TO_LEDGER.id]: BANK_TO_LEDGER,
  [INVOICE_TWO_SYSTEMS.id]: INVOICE_TWO_SYSTEMS,
  [BILL_TO_PO.id]: BILL_TO_PO,
};

/** A saved rule as the engine reads it (packages/db's `match_rule`; values already normalised). */
export const SavedMatchRule = z.object({
  id: z.string().min(1),
  field: z.enum(MATCH_RULE_FIELDS),
  aValue: z.string().min(1).max(200),
  bValue: z.string().min(1).max(200),
});
export type SavedMatchRule = z.infer<typeof SavedMatchRule>;
