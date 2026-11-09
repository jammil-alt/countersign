// The reconciliation engine (docs/plan.md §1.80): two sides, each a closing balance (and its opening
// when known) with the items behind it, compared in decimal. Pure: no database, no model. Matching
// runs in invariant 7's order (exact by reference, then amount and date with one candidate only,
// then groups); the model's proposals and a person's decisions come after, outside this file.
//
// The anchor: each side rolls forward (opening + its items = closing) and the difference is
// explained: (closing A − closing B) = start gap + (Σ unmatched A − Σ unmatched B), where the start
// gap is (opening A − opening B) less what was carried from the pair's last sign-off. What is left
// is the residual; anything but 0 is "unexplained".

import { dec, toNumeric } from "@countersign/core";

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
  /** (opening A − opening B) − carried net, or 0 when an opening isn't known. */
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
  const r = (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return r.length >= 3 ? r : null;
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
): EngineResult {
  const tol = dec(settings.tolerance).abs();
  const ea = a.items.map((i) => dec(i.effect));
  const eb = b.items.map((i) => dec(i.effect));
  const freeA = new Set(a.items.map((_, i) => i));
  const freeB = new Set(b.items.map((_, i) => i));
  const matches: EngineMatch[] = [];
  const same = (x: Decimal, y: Decimal) => x.minus(y).abs().lte(tol);
  const near = (i: number, j: number) =>
    days(a.items[i]?.date ?? null, b.items[j]?.date ?? null) <= settings.windowDays;
  const take = (method: EngineMethod, ai: number[], bj: number[]) => {
    matches.push({ method, a: ai, b: bj });
    for (const i of ai) freeA.delete(i);
    for (const j of bj) freeB.delete(j);
  };

  // (1) Exact: the same reference, the same effect, within the window; one each way.
  const refA = a.items.map((i) => normalizeReference(i.reference));
  const refB = b.items.map((i) => normalizeReference(i.reference));
  for (const i of [...freeA]) {
    const r = refA[i];
    if (!r) continue;
    const cands = [...freeB].filter(
      (j) => refB[j] === r && same(ea[i] as Decimal, eb[j] as Decimal) && near(i, j),
    );
    if (cands.length !== 1) continue;
    const j = cands[0] as number;
    const back = [...freeA].filter(
      (k) => refA[k] === r && same(ea[k] as Decimal, eb[j] as Decimal) && near(k, j),
    );
    if (back.length === 1) take("exact", [i], [j]);
  }

  // (2) The same effect within the window, one candidate each way; again until nothing changes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of [...freeA]) {
      const cands = [...freeB].filter(
        (j) => same(ea[i] as Decimal, eb[j] as Decimal) && near(i, j),
      );
      if (cands.length !== 1) continue;
      const j = cands[0] as number;
      const back = [...freeA].filter((k) => same(ea[k] as Decimal, eb[j] as Decimal) && near(k, j));
      if (back.length !== 1) continue;
      take("amount_date", [i], [j]);
      changed = true;
    }
  }

  // (3) Groups: one item is the sum of 2..maxGroup on the other side, within the window, when
  // exactly one group fits (a payout: charges − refunds − fees; a split transfer).
  const groupFor = (target: Decimal, pool: number[], effects: Decimal[]): number[] | null => {
    if (pool.length < 2 || pool.length > GROUP_POOL_MAX) return null;
    let found: number[] | null = null;
    let count = 0;
    const pick: number[] = [];
    const walk = (start: number, total: Decimal) => {
      if (count > 1) return;
      if (pick.length >= 2 && same(total, target)) {
        count += 1;
        found = [...pick];
        // A group that sums with more items added is another group: keep looking.
      }
      if (pick.length >= settings.maxGroup) return;
      for (let k = start; k < pool.length; k++) {
        const idx = pool[k] as number;
        pick.push(idx);
        walk(k + 1, total.plus(effects[idx] as Decimal));
        pick.pop();
        if (count > 1) return;
      }
    };
    walk(0, dec("0"));
    return count === 1 ? found : null;
  };
  for (const i of [...freeA]) {
    const pool = [...freeB].filter((j) => near(i, j));
    const g = groupFor(ea[i] as Decimal, pool, eb);
    if (g) take("group", [i], g);
  }
  for (const j of [...freeB]) {
    const pool = [...freeA].filter((i) => near(i, j));
    const g = groupFor(eb[j] as Decimal, pool, ea);
    if (g) take("group", g, [j]);
  }

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
  // DECISION: with an opening unknown, the start is taken as what was carried (start gap 0), so
  // the residual still names anything the items can't explain.
  const startGap =
    a.opening === null || b.opening === null
      ? dec("0")
      : dec(a.opening).minus(dec(b.opening)).minus(carriedNet);
  const unmatchedNet = sum([...freeA].map((i) => ea[i] as Decimal)).minus(
    sum([...freeB].map((j) => eb[j] as Decimal)),
  );
  const residual = difference.minus(startGap).minus(unmatchedNet);
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
