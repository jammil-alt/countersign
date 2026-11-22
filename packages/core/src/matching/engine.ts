// The matching engine (docs/plan.md §1.215): one reconciliation service for two lists of items
// (bank lines and ledger entries; one invoice in two systems), generalised from the three matchers
// that came before it (Materials' item matching, Sales' match to CRM, Bookkeeping's
// reconciliation). Invariant 7, in tiers:
//   1. client_rule    a client's saved corrections (a value on side A is side B's value)
//   2. deterministic  the configuration's rules in its order: reference, reference_group,
//                     counterparty_amount, amount_date, group, partial
//   3. fuzzy          a score from names, dates and amounts; one sure candidate each way
//   4. model          only for what is left, held to the same hard rules (./model.ts)
// and a person decides what none of them settles. Hard rules (amount beyond the tolerance, dates
// outside the window, two different references or currencies) veto a pair whatever else agrees.
// Every match states its tier and the rule that made it. Matches are 1:1, 1:many, many:1 or
// partial. Pure: no database, no model; amounts in decimal (invariant 6).

import { type Decimal, dec, toNumeric } from "../money";
import type {
  DeterministicRule,
  MatchConfig,
  MatchTier,
  MatchType,
  SavedMatchRule,
} from "./config";
import { normalizeCounterparty, normalizeReference, textSimilarity } from "./normalize";

/** One item on a side, as the engine reads it. */
export interface MatchItem {
  /** Signed decimal string: how much it moves its side (or the invoice's total). */
  amount: string;
  /** yyyy-mm-dd, or null when the source gives none (no window then). */
  date?: string | null | undefined;
  reference?: string | null | undefined;
  counterparty?: string | null | undefined;
  description?: string | null | undefined;
  /** ISO 4217, when the source says. */
  currency?: string | null | undefined;
}

export interface EngineMatch {
  type: MatchType;
  tier: MatchTier;
  /** The rule that made it: a deterministic rule's name, `similar`, `model`, or the saved rule's id. */
  rule: DeterministicRule | "similar" | "model" | `client_rule:${string}`;
  /** Indexes into side A's and side B's items. */
  a: number[];
  b: number[];
  /** 1 for the rules; the fuzzy score or the model's confidence otherwise. */
  score: number;
  /** Σ A − Σ B: "0.0000" unless partial (or within the tolerance). */
  difference: string;
  /** The model's reason, as data (never instructions); null otherwise. */
  reason: string | null;
}

/** A pair a hard rule ruled out. */
export type Veto = "amount" | "date" | "reference" | "currency" | "counterparty" | (string & {});

export interface PairScore {
  score: number;
  veto: Veto | null;
}

/** Scores one pair (0 to 1) with its hard rules; a pack may give its own (Materials' item keys). */
export type PairScorer = (a: MatchItem, b: MatchItem) => PairScore;

export interface MatchOptions {
  /** The client's live saved rules for this configuration. */
  rules?: readonly SavedMatchRule[] | undefined;
  /** Replaces the default fuzzy score (the hard rules stay the scorer's to give). */
  scorer?: PairScorer | undefined;
}

export interface MatchOutcome {
  config: string;
  matches: EngineMatch[];
  /** Below the threshold: a person decides (the model's, and the fuzzy tier's close calls). */
  proposals: EngineMatch[];
  /** What a hard rule refused of the model's answers. */
  refused: { a: number; b: number[]; veto: Veto }[];
  unmatched: { a: number[]; b: number[] };
}

const DAY = 86_400_000;

export function daysApart(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;
}

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((s, v) => s.plus(v), dec("0"));
}

/**
 * Two names alike: trigram similarity, or 0.9 when every word of the shorter is in the longer
 * ("romco" and "romco industries").
 */
export function nameSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const tri = textSimilarity(a, b);
  const wa = a.split(" ");
  const wb = new Set(b.split(" "));
  const [short, long] = wa.length <= wb.size ? [wa, wb] : [b.split(" "), new Set(wa)];
  const contained = short.every((w) => long.has(w));
  return Math.max(tri, contained ? 0.9 : 0);
}

/** The keys of one side's items, normalised once, with what a saved rule maps them to. */
interface Keys {
  ref: (string | null)[];
  cp: (string | null)[];
  /** The saved rule that mapped each item's reference or counterparty, by index. */
  ruled: (SavedMatchRule | null)[];
  amount: Decimal[];
}

function keysOf(
  items: readonly MatchItem[],
  config: MatchConfig,
  rules: readonly SavedMatchRule[],
): Keys {
  const byRef = new Map(rules.filter((r) => r.field === "reference").map((r) => [r.aValue, r]));
  const byCp = new Map(rules.filter((r) => r.field === "counterparty").map((r) => [r.aValue, r]));
  const ref: (string | null)[] = [];
  const cp: (string | null)[] = [];
  const ruled: (SavedMatchRule | null)[] = [];
  for (const item of items) {
    let r = normalizeReference(config.reference, item.reference);
    let c = normalizeCounterparty(item.counterparty);
    let rule: SavedMatchRule | null = null;
    const rr = r ? byRef.get(r) : undefined;
    if (rr) {
      r = rr.bValue;
      rule = rr;
    }
    const cr = c ? byCp.get(c) : undefined;
    if (cr) {
      c = cr.bValue;
      rule ??= cr;
    }
    ref.push(r);
    cp.push(c);
    ruled.push(rule);
  }
  return { ref, cp, ruled, amount: items.map((i) => dec(i.amount)) };
}

/** The hard rules for one pair under a configuration, amounts aside. */
export function pairVeto(
  a: MatchItem,
  b: MatchItem,
  config: MatchConfig,
  keys?: { refA: string | null; refB: string | null; cpA: string | null; cpB: string | null },
): Veto | null {
  if (
    config.vetoes.currency &&
    a.currency &&
    b.currency &&
    a.currency.toUpperCase() !== b.currency.toUpperCase()
  ) {
    return "currency";
  }
  if (daysApart(a.date, b.date) > config.windowDays) return "date";
  const refA = keys ? keys.refA : normalizeReference(config.reference, a.reference);
  const refB = keys ? keys.refB : normalizeReference(config.reference, b.reference);
  if (config.vetoes.reference && refA && refB && refA !== refB) return "reference";
  if (config.fuzzy) {
    const cpA = keys ? keys.cpA : normalizeCounterparty(a.counterparty);
    const cpB = keys ? keys.cpB : normalizeCounterparty(b.counterparty);
    if (cpA && cpB && nameSimilarity(cpA, cpB) < config.fuzzy.counterpartyFloor) {
      return "counterparty";
    }
  }
  return null;
}

/**
 * The default fuzzy score: the amount agreeing (required: a hard rule), then the counterparty's
 * name, the date's closeness and an equal reference.
 */
// DECISION: 0.6 for the amount, up to 0.3 for the name, 0.1 for the date and 0.1 for the reference,
// capped at 1: an equal amount with an alike name the same week reaches the 0.9 threshold; an equal
// amount alone (0.6–0.7) never does, so it waits for the model or a person.
export function defaultScorer(config: MatchConfig): PairScorer {
  const tol = dec(config.tolerance).abs();
  return (a, b) => {
    const veto = pairVeto(a, b, config);
    if (veto) return { score: 0, veto };
    if (dec(a.amount).minus(dec(b.amount)).abs().gt(tol)) return { score: 0, veto: "amount" };
    let score = 0.6;
    const cpA = normalizeCounterparty(a.counterparty);
    const cpB = normalizeCounterparty(b.counterparty);
    if (cpA && cpB) score += 0.3 * nameSimilarity(cpA, cpB);
    if (a.date && b.date) {
      const w = Math.max(config.windowDays, 1);
      score += 0.1 * Math.max(0, 1 - daysApart(a.date, b.date) / w);
    }
    const refA = normalizeReference(config.reference, a.reference);
    if (refA && refA === normalizeReference(config.reference, b.reference)) score += 0.1;
    return { score: Math.round(Math.min(1, score) * 1000) / 1000, veto: null };
  };
}

function typeOf(a: number[], b: number[]): MatchType {
  if (a.length === 1 && b.length === 1) return "one_to_one";
  return a.length === 1 ? "one_to_many" : "many_to_one";
}

/** The tiers up to the fuzzy one, in order; the model tier is ./model.ts's, after this. */
export function matchItems(
  aItems: readonly MatchItem[],
  bItems: readonly MatchItem[],
  config: MatchConfig,
  options: MatchOptions = {},
): MatchOutcome {
  const rules = options.rules ?? [];
  // DECISION: a saved rule maps side A's value to side B's only; B's items keep their own keys.
  const ka = keysOf(aItems, config, rules);
  const kb = keysOf(bItems, config, []);
  const tol = dec(config.tolerance).abs();
  const freeA = new Set(aItems.map((_, i) => i));
  const freeB = new Set(bItems.map((_, i) => i));
  const matches: EngineMatch[] = [];
  const proposals: EngineMatch[] = [];
  const same = (x: Decimal, y: Decimal) => x.minus(y).abs().lte(tol);
  const near = (i: number, j: number) =>
    daysApart(aItems[i]?.date, bItems[j]?.date) <= config.windowDays;
  const sameAmount = (i: number, j: number) =>
    same(ka.amount[i] as Decimal, kb.amount[j] as Decimal);
  const currencyOk = (i: number, j: number) => {
    const x = aItems[i]?.currency;
    const y = bItems[j]?.currency;
    return !config.vetoes.currency || !x || !y || x.toUpperCase() === y.toUpperCase();
  };
  // A hard rule in every rule that doesn't itself require equal references.
  const refOk = (i: number, j: number) =>
    !config.vetoes.reference || !ka.ref[i] || !kb.ref[j] || ka.ref[i] === kb.ref[j];
  const take = (
    tier: MatchTier,
    rule: EngineMatch["rule"],
    a: number[],
    b: number[],
    type: MatchType = typeOf(a, b),
    score = 1,
  ) => {
    const diff = sum(a.map((i) => ka.amount[i] as Decimal)).minus(
      sum(b.map((j) => kb.amount[j] as Decimal)),
    );
    matches.push({ type, tier, rule, a, b, score, difference: toNumeric(diff), reason: null });
    for (const i of a) freeA.delete(i);
    for (const j of b) freeB.delete(j);
  };

  /** One each way on a key: the shape of the reference and counterparty rules. */
  const oneEachWay = (
    key: (side: "a" | "b", k: number) => string | null,
    i: number,
  ): number | null => {
    const r = key("a", i);
    if (!r) return null;
    const fits = (x: number, y: number) =>
      sameAmount(x, y) && near(x, y) && currencyOk(x, y) && refOk(x, y);
    const cands = [...freeB].filter((j) => key("b", j) === r && fits(i, j));
    if (cands.length !== 1) return null;
    const j = cands[0] as number;
    const back = [...freeA].filter((k) => key("a", k) === r && fits(k, j));
    return back.length === 1 ? j : null;
  };
  const refKey = (side: "a" | "b", k: number) => (side === "a" ? ka.ref[k] : kb.ref[k]) ?? null;
  const cpKey = (side: "a" | "b", k: number) => (side === "a" ? ka.cp[k] : kb.cp[k]) ?? null;

  // 1. A client's saved rules: the items whose reference or counterparty a rule mapped.
  for (const i of [...freeA]) {
    const rule = ka.ruled[i];
    if (!rule) continue;
    const j = oneEachWay(rule.field === "reference" ? refKey : cpKey, i);
    if (j !== null) take("client_rule", `client_rule:${rule.id}`, [i], [j]);
  }

  // 2. The configuration's deterministic rules, in its order.
  const byRef = () => {
    const out = new Map<string, { a: number[]; b: number[] }>();
    for (const i of freeA) {
      const r = ka.ref[i];
      if (r) (out.get(r) ?? out.set(r, { a: [], b: [] }).get(r))?.a.push(i);
    }
    for (const j of freeB) {
      const r = kb.ref[j];
      if (r) out.get(r)?.b.push(j);
    }
    return out;
  };
  const allNear = (as: number[], bs: number[]) =>
    as.every((i) => bs.every((j) => near(i, j) && currencyOk(i, j)));
  const groupFor = (target: Decimal, pool: number[], amounts: Decimal[]): number[] | null => {
    if (pool.length < 2 || pool.length > config.groupPoolMax) return null;
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
      if (pick.length >= config.maxGroup) return;
      for (let k = start; k < pool.length; k++) {
        const idx = pool[k] as number;
        pick.push(idx);
        walk(k + 1, total.plus(amounts[idx] as Decimal));
        pick.pop();
        if (count > 1) return;
      }
    };
    walk(0, dec("0"));
    return count === 1 ? found : null;
  };

  for (const rule of config.rules) {
    if (rule === "reference") {
      for (const i of [...freeA]) {
        const j = oneEachWay(refKey, i);
        if (j !== null) take("deterministic", "reference", [i], [j]);
      }
    } else if (rule === "counterparty_amount") {
      for (const i of [...freeA]) {
        const j = oneEachWay(cpKey, i);
        if (j !== null) take("deterministic", "counterparty_amount", [i], [j]);
      }
    } else if (rule === "amount_date") {
      let changed = true;
      while (changed) {
        changed = false;
        for (const i of [...freeA]) {
          const cands = [...freeB].filter(
            (j) => sameAmount(i, j) && near(i, j) && currencyOk(i, j) && refOk(i, j),
          );
          if (cands.length !== 1) continue;
          const j = cands[0] as number;
          const back = [...freeA].filter(
            (k) => sameAmount(k, j) && near(k, j) && currencyOk(k, j) && refOk(k, j),
          );
          if (back.length !== 1) continue;
          take("deterministic", "amount_date", [i], [j]);
          changed = true;
        }
      }
    } else if (rule === "reference_group") {
      for (const { a, b } of byRef().values()) {
        if (a.length === 1 && b.length >= 2 && b.length <= config.maxGroup && allNear(a, b)) {
          const total = sum(b.map((j) => kb.amount[j] as Decimal));
          if (same(ka.amount[a[0] as number] as Decimal, total)) {
            take("deterministic", "reference_group", a, b);
          }
        } else if (
          b.length === 1 &&
          a.length >= 2 &&
          a.length <= config.maxGroup &&
          allNear(a, b)
        ) {
          const total = sum(a.map((i) => ka.amount[i] as Decimal));
          if (same(total, kb.amount[b[0] as number] as Decimal)) {
            take("deterministic", "reference_group", a, b);
          }
        }
      }
    } else if (rule === "group") {
      for (const i of [...freeA]) {
        const pool = [...freeB].filter((j) => near(i, j) && currencyOk(i, j) && refOk(i, j));
        const g = groupFor(ka.amount[i] as Decimal, pool, kb.amount);
        if (g) take("deterministic", "group", [i], g);
      }
      for (const j of [...freeB]) {
        const pool = [...freeA].filter((i) => near(i, j) && currencyOk(i, j) && refOk(i, j));
        const g = groupFor(kb.amount[j] as Decimal, pool, ka.amount);
        if (g) take("deterministic", "group", g, [j]);
      }
    } else if (rule === "partial") {
      // DECISION: part of one item only (one on side A, one or more on side B carrying its
      // reference), every amount of one sign, and only when the reference names nothing else on
      // side A. The difference stays on the match, for a person or the pack to explain.
      for (const { a, b } of byRef().values()) {
        if (a.length !== 1 || b.length === 0 || b.length > config.maxGroup) continue;
        if (!allNear(a, b)) continue;
        const target = ka.amount[a[0] as number] as Decimal;
        const parts = b.map((j) => kb.amount[j] as Decimal);
        const sign = target.isNegative();
        if (target.isZero() || parts.some((p) => p.isZero() || p.isNegative() !== sign)) continue;
        take("deterministic", "partial", a, b, "partial");
      }
    }
  }

  // 3. Fuzzy: one sure candidate each way.
  if (config.fuzzy) {
    const threshold = config.fuzzy.threshold;
    const scorer = options.scorer ?? defaultScorer(config);
    const cache = new Map<string, PairScore>();
    const score = (i: number, j: number): PairScore => {
      const k = `${i}:${j}`;
      let s = cache.get(k);
      if (!s) {
        s = scorer(aItems[i] as MatchItem, bItems[j] as MatchItem);
        cache.set(k, s);
      }
      return s;
    };
    for (const i of [...freeA]) {
      const scored = [...freeB]
        .map((j) => ({ j, s: score(i, j) }))
        .filter((x) => x.s.veto === null && x.s.score > 0);
      const sure = scored.filter((x) => x.s.score >= threshold);
      if (sure.length !== 1) continue;
      const { j, s } = sure[0] as { j: number; s: PairScore };
      const back = [...freeA].filter((k) => {
        const t = score(k, j);
        return t.veto === null && t.score >= threshold;
      });
      if (back.length !== 1) continue;
      take("fuzzy", "similar", [i], [j], "one_to_one", s.score);
    }
  }

  return {
    config: config.id,
    matches,
    proposals,
    refused: [],
    unmatched: { a: [...freeA].sort((x, y) => x - y), b: [...freeB].sort((x, y) => x - y) },
  };
}

/**
 * Among one item's candidates, the rules' decision (Sales' match to CRM, generalised): the one at
 * or above the threshold when it is the only one; two or more there are a person's call; below it,
 * the candidates not vetoed, best first, go on to the model.
 */
export type RankedVerdict<T> =
  | { kind: "matched"; best: T }
  | { kind: "open"; ranked: T[] }
  | { kind: "nothing" };

export function decideRanked<T>(
  weighed: readonly T[],
  threshold: number,
  read: (w: T) => { score: number; vetoed: boolean },
): RankedVerdict<T> {
  const eligible = weighed
    .filter((w) => {
      const r = read(w);
      return !r.vetoed && r.score > 0;
    })
    .sort((x, y) => read(y).score - read(x).score);
  const best = eligible[0];
  if (best === undefined) return { kind: "nothing" };
  const sure = eligible.filter((w) => read(w).score >= threshold);
  if (sure.length === 1) return { kind: "matched", best };
  return { kind: "open", ranked: eligible };
}
