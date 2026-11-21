// The deterministic stage of the match (docs/plan.md §1.164 "The match"; invariant 7): a row's keys
// against one record's, scored from 0 to 1, with the hard rules that veto a pair whatever else
// agrees, and the rules' own decision among a row's candidates. The model and a person only see
// what this leaves open. Pure: no I/O. The golden test (./golden.test.ts) holds it to ≥ 95%
// precision on "same" at the default threshold.

import type { CrmKeys } from "../schema";
import { companySimilarity, dealSimilarity, personSimilarity } from "./similar";

/** The keys a row is matched on. */
export const KEY_FIELDS = ["email", "phone", "domain", "company", "name", "deal"] as const;
export type KeyField = (typeof KEY_FIELDS)[number];

/** What a module's record is: a person (lead, contact), a company (account), a deal. */
export const RECORD_KINDS = ["person", "company", "deal"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** The default threshold: at or above it the rules (or the model) match without a person. */
// DECISION: 0.9, Materials' match_confidence_auto: a name and a company that agree (0.95) or an
// exact key match by themselves; a name alone (0.85) goes on to the model.
export const MATCH_THRESHOLD = 0.9;

/** Two pairs at or above the threshold for one row: neither is sure, a person decides. */
export const VETOED_SCORE = 0;

const AGREE = 0.85;
const CONFLICT = 0.5;
/** A text match is never surer than this; exact keys go higher. */
const TEXT_CAP = 0.97;
/** The most a pair scores when a name, company or deal both sides state disagrees. */
const CONFLICT_CAP = 0.45;

export type Veto = "email" | "phone";

export interface PairScore {
  score: number;
  /** The exact key the score rests on (email, phone, domain), when it rests on one. */
  key: "email" | "phone" | "domain" | null;
  /** A hard rule ruled the pair out: two different emails, or two different phones. */
  vetoed: Veto | null;
  /** The fields both sides state and agree on, and those they state differently. */
  agree: KeyField[];
  differ: KeyField[];
}

function stated(keys: CrmKeys, field: KeyField): string | null {
  const v = keys[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}

const SIMILARITY: Record<"name" | "company" | "deal", (a: string, b: string) => number> = {
  name: personSimilarity,
  company: companySimilarity,
  deal: dealSimilarity,
};

const PRIMARY: Record<RecordKind, "name" | "company" | "deal"> = {
  person: "name",
  company: "company",
  deal: "deal",
};

/**
 * One row against one record of a kind, on the fields the step matches on. An exact email is the
 * record; an exact phone or website domain is, when the names don't say otherwise; else the
 * record's own name (a person's, a company's, a deal's) and the other names that agree.
 */
export function scorePair(
  row: CrmKeys,
  record: CrmKeys,
  options: { kind: RecordKind; fields?: readonly KeyField[] },
): PairScore {
  const fields = options.fields ?? KEY_FIELDS;
  const both = (f: KeyField): [string, string] | null => {
    if (!fields.includes(f)) return null;
    const a = stated(row, f);
    const b = stated(record, f);
    return a && b ? [a, b] : null;
  };
  const agree: KeyField[] = [];
  const differ: KeyField[] = [];
  const exact = (f: "email" | "phone" | "domain"): boolean | null => {
    const pair = both(f);
    if (!pair) return null;
    const same = pair[0] === pair[1];
    (same ? agree : differ).push(f);
    return same;
  };
  const email = exact("email");
  const phone = exact("phone");
  const domain = exact("domain");
  const sims: Partial<Record<"name" | "company" | "deal", number>> = {};
  for (const f of ["name", "company", "deal"] as const) {
    const pair = both(f);
    if (!pair) continue;
    const s = SIMILARITY[f](pair[0], pair[1]);
    sims[f] = s;
    if (s >= AGREE) agree.push(f);
    else if (s < CONFLICT) differ.push(f);
  }
  // Hard rules (invariant 7): never the same with two different emails or two different phones.
  if (email === false) return { score: VETOED_SCORE, key: null, vetoed: "email", agree, differ };
  if (phone === false) return { score: VETOED_SCORE, key: null, vetoed: "phone", agree, differ };

  const primary = PRIMARY[options.kind];
  const conflict = (f: "name" | "company" | "deal") => sims[f] !== undefined && sims[f] < CONFLICT;
  const agrees = (f: "name" | "company" | "deal") => sims[f] !== undefined && sims[f] >= AGREE;
  // The company agrees when its name does, or the website domains are the same.
  const companyAgrees = agrees("company") || domain === true;

  // Exact keys.
  let keyScore = 0;
  let key: PairScore["key"] = null;
  if (email === true) {
    keyScore = 1;
    key = "email";
  } else if (phone === true) {
    key = "phone";
    // DECISION: a phone may be a company's main line: when the names both sides state disagree,
    // the number alone decides nothing.
    if (conflict(primary) || (options.kind !== "company" && conflict("company"))) keyScore = 0.5;
    else if (agrees(primary)) keyScore = 0.98;
    else keyScore = 0.92;
  } else if (domain === true) {
    key = "domain";
    // A domain is a company's: it names an account, and a person or deal only with their name.
    if (options.kind === "company") {
      keyScore = conflict("company") ? 0.5 : agrees("company") ? 0.97 : 0.9;
    } else if (conflict(primary)) keyScore = 0.3;
    else if (agrees(primary)) keyScore = 0.95;
    else keyScore = 0.6;
  }

  // Text: the record's own name first, then the others that agree.
  let textScore = 0;
  const p = sims[primary];
  if (p === undefined) {
    textScore = (["name", "company", "deal"] as const).some((f) => f !== primary && agrees(f))
      ? 0.6
      : 0;
  } else {
    textScore = p === 1 ? 0.85 : p >= 0.9 ? 0.8 : p >= 0.75 ? 0.65 : 0.5 * p;
    let companyCounted = false;
    for (const f of ["name", "company", "deal"] as const) {
      if (f === primary) continue;
      if (agrees(f)) {
        textScore += sims[f] === 1 ? 0.1 : 0.08;
        if (f === "company") companyCounted = true;
      }
    }
    if (primary !== "company" && !companyCounted && companyAgrees) textScore += 0.1;
    textScore = Math.min(textScore, TEXT_CAP);
    if ((["name", "company", "deal"] as const).some((f) => conflict(f))) {
      textScore = Math.min(textScore, CONFLICT_CAP);
    }
  }

  const score = round3(Math.max(keyScore, textScore));
  return {
    score,
    key: keyScore > 0 && keyScore >= textScore ? key : null,
    vetoed: null,
    agree,
    differ,
  };
}

export function round3(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
}

/** A candidate as the rules weigh it. */
export interface Weighed<T> {
  candidate: T;
  pair: PairScore;
}

export type RulesVerdict<T> =
  | { kind: "matched"; best: Weighed<T> }
  /** Something is close but nothing is sure (or two are): the model, then a person. */
  | { kind: "open"; ranked: Weighed<T>[] }
  /** Nothing could be the row. */
  | { kind: "nothing" };

/**
 * The rules' decision among a row's candidates: the one at or above the threshold when it is the
 * only one; two or more there are a person's call (duplicates in the client's tool); below it, the
 * candidates not vetoed, best first, go on.
 */
export function decideByRules<T>(
  weighed: readonly Weighed<T>[],
  threshold: number,
): RulesVerdict<T> {
  const eligible = weighed
    .filter((w) => w.pair.vetoed === null && w.pair.score > 0)
    .sort((a, b) => b.pair.score - a.pair.score);
  const best = eligible[0];
  if (!best) return { kind: "nothing" };
  const sure = eligible.filter((w) => w.pair.score >= threshold);
  if (sure.length === 1) return { kind: "matched", best };
  return { kind: "open", ranked: eligible };
}
