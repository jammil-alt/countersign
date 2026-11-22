// The reconciliation engine (docs/plan.md §1.80): two sides, each a closing balance (and its opening
// when known) with the items behind it, compared in decimal. Pure: no database, no model. Matching
// is the platform's matching engine (§1.215) under its `bank_to_ledger` configuration, in
// invariant 7's order (the client's saved rules, exact by reference, then amount and date with one
// candidate only, then groups); the model's proposals and a person's decisions come after, outside
// this file.
//
// The anchor: each side rolls forward (opening + its items = closing) and the difference is
// explained by the items: (closing A − closing B) = Σ unmatched A − Σ unmatched B. What is left is
// the residual; anything but 0 is "unexplained". The start gap, (opening A − opening B) less what
// was carried from the pair's last sign-off, is part of the residual, never an explanation: the
// openings should differ by exactly what was carried, and when they don't, something changed
// before the period (an entry deleted or edited in a month already signed off) that a person
// explains.

import {
  alnumReference,
  BANK_TO_LEDGER,
  dec,
  type MatchConfig,
  matchItems,
  type SavedMatchRule,
  toNumeric,
} from "@countersign/core";

type Decimal = ReturnType<typeof dec>;

export interface ReconItem {
  /** Its id where it came from. */
  ref: string;
  /** yyyy-mm-dd, or null when the source gives none. */
  date: string | null;
  /** How much it moves its side's balance (signed decimal string). */
  effect: string;
  reference?: string | null | undefined;
  description?: string | null | undefined;
  /** Unmatched at the pair's last sign-off, carried here. */
  carried?: boolean | undefined;
}

export interface ReconSide {
  label: string;
  /** Null when the source doesn't say (a bank feed's balance is today's only). */
  opening: string | null;
  closing: string;
  items: ReconItem[];
}

export interface ReconSettings {
  /** How many days apart the two sides' dates of one payment may be. */
  windowDays: number;
  /** The most an effect may differ by and still match; "0" unless a setting says (currency). */
  tolerance: string;
  /** The most items one item may be the sum of. */
  maxGroup: number;
  /** An unmatched item dated within this many days of the end is `timing` (likely to clear). */
  timingDays: number;
}

export const DEFAULT_RECON_SETTINGS: ReconSettings = {
  windowDays: 5,
  tolerance: "0",
  maxGroup: 6,
  timingDays: 7,
};

export type EngineMethod = "exact" | "amount_date" | "group";
export type EngineLabel = "timing" | "missing" | "amount_differs" | "duplicate";

export interface EngineMatch {
  method: EngineMethod;
  /** The engine's rule: `reference`, `amount_date`, `group`, or `client_rule:<id>`. */
  rule: string;
  /** Indexes into side A's and side B's items. */
  a: number[];
  b: number[];
}

export interface RollForward {
  /** opening + items − closing: 0 when the side adds up; null when the opening isn't known. */
  gap: string | null;
}

export interface EngineResult {
  difference: string;
  /**
   * (opening A − opening B) − carried net, or 0 when an opening isn't known: what the openings
   * differ by that nothing carried explains. It shows in the residual.
   */
  startGap: string;
  /** Σ unmatched A − Σ unmatched B. */
  unmatchedNet: string;
  residual: string;
  outcome: "balanced" | "explained" | "unexplained";
  matches: EngineMatch[];
  /** Each side's unmatched items by index, with their label. */
  unmatched: { a: Map<number, EngineLabel>; b: Map<number, EngineLabel> };
  rollForward: { a: RollForward; b: RollForward };
}

/** Candidate pools larger than this aren't searched for groups (the search stays bounded). */
export const GROUP_POOL_MAX = 18;

const DAY = 86_400_000;

function days(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;
}

/** A reference compared on its letters and digits, lower case: "CHK #1042" is "chk1042". */
export function normalizeReference(v: string | null | undefined): string | null {
  return alnumReference(v);
}

/** The engine's `bank_to_ledger` configuration with a pair's own settings. */
export function bankToLedger(settings: ReconSettings): MatchConfig {
  return {
    ...BANK_TO_LEDGER,
    windowDays: settings.windowDays,
    tolerance: settings.tolerance,
    maxGroup: settings.maxGroup,
    groupPoolMax: GROUP_POOL_MAX,
  };
}

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((s, v) => s.plus(v), dec("0"));
}

/** The side's roll-forward: opening + its own period items (carried ones excluded) − closing. */
export function rollForward(side: ReconSide): RollForward {
  if (side.opening === null) return { gap: null };
  const items = sum(side.items.filter((i) => !i.carried).map((i) => dec(i.effect)));
  return { gap: toNumeric(dec(side.opening).plus(items).minus(dec(side.closing))) };
}

export function reconcile(
  a: ReconSide,
  b: ReconSide,
  settings: ReconSettings = DEFAULT_RECON_SETTINGS,
  asOf: string | null = null,
  /** The client's live saved rules for `bank_to_ledger` (match_rule, §1.215). */
  rules: readonly SavedMatchRule[] = [],
): EngineResult {
  const ea = a.items.map((i) => dec(i.effect));
  const eb = b.items.map((i) => dec(i.effect));
  const toItem = (i: ReconItem) => ({
    amount: i.effect,
    date: i.date,
    reference: i.reference ?? null,
    description: i.description ?? null,
  });
  const matched = matchItems(a.items.map(toItem), b.items.map(toItem), bankToLedger(settings), {
    rules,
  });
  // DECISION: a match by a client's saved rule is kept as `exact` (the method's list is §1.80's);
  // the rule that made it is kept beside it (`rule`, and the match row's reason).
  const METHOD: Record<string, EngineMethod> = {
    reference: "exact",
    amount_date: "amount_date",
    group: "group",
  };
  const matches: EngineMatch[] = matched.matches.map((m) => ({
    method: METHOD[m.rule] ?? "exact",
    rule: m.rule,
    a: m.a,
    b: m.b,
  }));
  const freeA = new Set(matched.unmatched.a);
  const freeB = new Set(matched.unmatched.b);
  const refA = a.items.map((i) => normalizeReference(i.reference));
  const refB = b.items.map((i) => normalizeReference(i.reference));

  // Labels for what is left.
  const label = (
    side: ReconSide,
    refs: (string | null)[],
    otherRefs: (string | null)[],
    effects: Decimal[],
    otherEffects: Decimal[],
    free: Set<number>,
  ): Map<number, EngineLabel> => {
    const out = new Map<number, EngineLabel>();
    for (const i of [...free].sort((x, y) => x - y)) {
      const item = side.items[i] as ReconItem;
      const r = refs[i];
      const dup = [...free].some(
        (k) =>
          k < i &&
          (effects[k] as Decimal).equals(effects[i] as Decimal) &&
          refs[k] === r &&
          side.items[k]?.date === item.date,
      );
      if (dup) out.set(i, "duplicate");
      else if (
        r &&
        otherRefs.some(
          (o, j) => o === r && !(otherEffects[j] as Decimal).equals(effects[i] as Decimal),
        )
      ) {
        out.set(i, "amount_differs");
      } else if (
        item.carried ||
        (asOf && item.date && days(item.date, asOf) <= settings.timingDays && item.date <= asOf)
      ) {
        out.set(i, "timing");
      } else out.set(i, "missing");
    }
    return out;
  };
  const unmatched = {
    a: label(a, refA, refB, ea, eb, freeA),
    b: label(b, refB, refA, eb, ea, freeB),
  };

  const difference = dec(a.closing).minus(dec(b.closing));
  const carriedNet = sum(a.items.filter((i) => i.carried).map((i) => dec(i.effect))).minus(
    sum(b.items.filter((i) => i.carried).map((i) => dec(i.effect))),
  );
  // DECISION: with an opening unknown, the start is taken as what was carried (start gap 0).
  const startGap =
    a.opening === null || b.opening === null
      ? dec("0")
      : dec(a.opening).minus(dec(b.opening)).minus(carriedNet);
  const unmatchedNet = sum([...freeA].map((i) => ea[i] as Decimal)).minus(
    sum([...freeB].map((j) => eb[j] as Decimal)),
  );
  // DECISION: the start gap is never taken off the residual. With both sides rolling forward,
  // taking it off would leave the residual 0 whatever the openings were, so a gap at the start
  // (on a pair's first reconciliation too, where nothing is carried) waits for a person, who
  // explains it with an item of their own.
  const residual = difference.minus(unmatchedNet);
  const outcome = !residual.isZero()
    ? "unexplained"
    : difference.isZero() && freeA.size === 0 && freeB.size === 0
      ? "balanced"
      : "explained";
  return {
    difference: toNumeric(difference),
    startGap: toNumeric(startGap),
    unmatchedNet: toNumeric(unmatchedNet),
    residual: toNumeric(residual),
    outcome,
    matches,
    unmatched,
    rollForward: { a: rollForward(a), b: rollForward(b) },
  };
}
