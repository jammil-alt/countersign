// The engine's model tier (docs/plan.md §1.215; invariant 7: deterministic first, model second,
// human last). Only what the rules and the fuzzy tier left is asked about, each A item with at
// most a configuration's few candidates that pass the hard rules. The model is a function the
// caller gives (a pack's call through @countersign/llm, or a replayed answer in tests): core holds
// no client. Its answer is checked again here: candidates only, still free, and the hard rules
// (amounts within the tolerance, or a partial the configuration allows) veto whatever it says.
// Under the threshold it is a proposal for a person, never a match. Item text reaches the model as
// data in the caller's tool result, never in instructions (invariant 9).

import { z } from "zod";
import { type Decimal, dec, toNumeric } from "../money";
import type { MatchConfig } from "./config";
import {
  defaultScorer,
  type EngineMatch,
  type MatchItem,
  type MatchOutcome,
  type PairScorer,
  pairVeto,
} from "./engine";

export interface ModelQuestion {
  /** Side A's item index. */
  a: number;
  item: MatchItem;
  /** Side B's candidates, best first by the fuzzy score. */
  candidates: { b: number; item: MatchItem; score: number }[];
}

/** The model's answer about one question: the B items it is (none: null). */
export const ModelAnswer = z.object({
  a: z.number().int().min(0),
  b: z.array(z.number().int().min(0)).max(12).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
});
export type ModelAnswer = z.infer<typeof ModelAnswer>;

/** Asks the model the questions; the answers are validated here. */
export type ModelTier = (questions: ModelQuestion[]) => Promise<unknown[]>;

/** The questions the model tier would ask: free A items with candidates the hard rules allow. */
export function modelQuestions(
  outcome: MatchOutcome,
  aItems: readonly MatchItem[],
  bItems: readonly MatchItem[],
  config: MatchConfig,
  scorer: PairScorer = defaultScorer(config),
): ModelQuestion[] {
  if (!config.model) return [];
  const out: ModelQuestion[] = [];
  for (const a of outcome.unmatched.a) {
    const item = aItems[a] as MatchItem;
    const candidates = outcome.unmatched.b
      .filter((b) => pairVeto(item, bItems[b] as MatchItem, config) === null)
      .map((b) => {
        const s = scorer(item, bItems[b] as MatchItem);
        return { b, item: bItems[b] as MatchItem, score: s.veto ? 0 : s.score };
      })
      .sort((x, y) => y.score - x.score || x.b - y.b)
      .slice(0, config.model.candidates);
    if (candidates.length > 0) out.push({ a, item, candidates });
  }
  return out;
}

/**
 * The model tier over an outcome of `matchItems`: a new outcome with the model's matches (tier
 * `model`), its proposals under the threshold, and what the hard rules refused.
 */
export async function withModel(
  outcome: MatchOutcome,
  aItems: readonly MatchItem[],
  bItems: readonly MatchItem[],
  config: MatchConfig,
  ask: ModelTier,
  scorer?: PairScorer,
): Promise<MatchOutcome> {
  const questions = modelQuestions(outcome, aItems, bItems, config, scorer);
  if (!config.model || questions.length === 0) return outcome;
  const threshold = config.model.threshold;
  const tol = dec(config.tolerance).abs();
  const raw = await ask(questions);
  const freeA = new Set(outcome.unmatched.a);
  const freeB = new Set(outcome.unmatched.b);
  const matches = [...outcome.matches];
  const proposals = [...outcome.proposals];
  const refused = [...outcome.refused];
  const asked = new Map(questions.map((q) => [q.a, q]));
  for (const r of raw) {
    // DECISION: an answer that doesn't read, names an item it wasn't asked about or a candidate it
    // wasn't given, or repeats one, is dropped: the item stays for a person.
    const parsed = ModelAnswer.safeParse(r);
    if (!parsed.success) continue;
    const answer = parsed.data;
    const q = asked.get(answer.a);
    if (!q || !freeA.has(answer.a) || answer.b === null || answer.b.length === 0) continue;
    const allowed = new Set(q.candidates.map((c) => c.b));
    const bs = [...new Set(answer.b)];
    if (bs.length !== answer.b.length || bs.some((b) => !allowed.has(b) || !freeB.has(b))) continue;
    asked.delete(answer.a);
    const item = aItems[answer.a] as MatchItem;
    const veto = bs.map((b) => pairVeto(item, bItems[b] as MatchItem, config)).find((v) => v);
    if (veto) {
      refused.push({ a: answer.a, b: bs, veto });
      continue;
    }
    const target = dec(item.amount);
    const total = bs.reduce<Decimal>(
      (s, b) => s.plus(dec((bItems[b] as MatchItem).amount)),
      dec("0"),
    );
    const equal = target.minus(total).abs().lte(tol);
    const sign = target.isNegative();
    const partialOk =
      config.rules.includes("partial") &&
      !target.isZero() &&
      bs.every((b) => {
        const x = dec((bItems[b] as MatchItem).amount);
        return !x.isZero() && x.isNegative() === sign;
      });
    if (!equal && !partialOk) {
      refused.push({ a: answer.a, b: bs, veto: "amount" });
      continue;
    }
    const m: EngineMatch = {
      type: !equal ? "partial" : bs.length === 1 ? "one_to_one" : "one_to_many",
      tier: "model",
      rule: "model",
      a: [answer.a],
      b: bs,
      score: Math.round(answer.confidence * 1000) / 1000,
      difference: toNumeric(target.minus(total)),
      reason: answer.reason,
    };
    if (answer.confidence >= threshold) {
      matches.push(m);
      freeA.delete(answer.a);
      for (const b of bs) freeB.delete(b);
    } else {
      proposals.push(m);
    }
  }
  return {
    ...outcome,
    matches,
    proposals,
    refused,
    unmatched: { a: [...freeA].sort((x, y) => x - y), b: [...freeB].sort((x, y) => x - y) },
  };
}
