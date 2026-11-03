// Per-model token prices and the cost of one call (plan §1.2 "Cost"; ARCHITECTURE §13).
//
// Cost is money (invariant 6): prices are decimal strings and arithmetic is decimal.js, never JS
// floats. Cost is computed when the call is made and stored with it, so a later price change never
// rewrites what a run cost.

import { Decimal } from "@countersign/core";
import { MODELS, type ModelId } from "./models";
import type { LlmUsage } from "./usage";

/** USD per million tokens, as decimal strings. */
export interface ModelPrice {
  readonly inputPerMtok: string;
  readonly outputPerMtok: string;
  /** Writing a 5-minute cache entry. */
  readonly cacheWrite5mPerMtok: string;
  /** Writing a 1-hour cache entry. */
  readonly cacheWrite1hPerMtok: string;
  readonly cacheReadPerMtok: string;
  /**
   * A higher rate for the whole call once its prompt (fresh + cached input) passes a size, for
   * models priced that way.
   */
  readonly longContext?: {
    readonly aboveInputTokens: number;
    readonly price: Omit<ModelPrice, "longContext">;
  };
}

// DECISION: verify against current Anthropic pricing before production (plan §1.2 "Cost": check
// the numbers when M4 starts). Input/output and Sonnet/Opus cache reads are the published list
// prices as of 2026-10; cache writes are derived from the usual multipliers (5m = 1.25x input,
// 1h = 2x input), and Haiku 5.5's cache read (0.1x input) and long-context cache rates are
// derived too, not published figures. Every number here is a placeholder until checked.
export const PRICES_CHECKED_ON = "unverified";

export const PRICES: Readonly<Record<ModelId, ModelPrice>> = {
  [MODELS.sonnet]: {
    inputPerMtok: "2.00",
    outputPerMtok: "10.00",
    cacheWrite5mPerMtok: "2.50",
    cacheWrite1hPerMtok: "4.00",
    cacheReadPerMtok: "0.20",
  },
  [MODELS.opus]: {
    inputPerMtok: "4.00",
    outputPerMtok: "20.00",
    cacheWrite5mPerMtok: "5.00",
    cacheWrite1hPerMtok: "8.00",
    cacheReadPerMtok: "0.20",
  },
  [MODELS.haiku]: {
    inputPerMtok: "0.10",
    outputPerMtok: "0.50",
    cacheWrite5mPerMtok: "0.125",
    cacheWrite1hPerMtok: "0.20",
    cacheReadPerMtok: "0.01",
    longContext: {
      aboveInputTokens: 100_000,
      price: {
        inputPerMtok: "0.50",
        outputPerMtok: "2.50",
        cacheWrite5mPerMtok: "0.625",
        cacheWrite1hPerMtok: "1.00",
        cacheReadPerMtok: "0.05",
      },
    },
  },
};

/**
 * Cost is kept to 6 decimal places of a dollar. A Haiku call can cost well under a hundredth of a
 * cent, which `numeric(14,4)` would round to zero; per-call cost is summed before it is rounded
 * for display.
 */
// DECISION: per-call cost is a 6-place decimal string (numeric(14,6) in the db), like Plenary
// Labs' llm_call.cost_usd; money columns elsewhere stay numeric(14,4).
export const COST_PLACES = 6;

const MILLION = new Decimal("1000000");

export function priceFor(
  model: ModelId,
  prices: Readonly<Record<ModelId, ModelPrice>> = PRICES,
): ModelPrice | undefined {
  return prices[model];
}

/**
 * The cost of one call in USD as a decimal string with `COST_PLACES` places, or null when the
 * model has no price (the call is still recorded with its tokens; the caller should alert rather
 * than price unknown spend at zero).
 */
export function costOf(
  model: ModelId,
  usage: LlmUsage,
  prices: Readonly<Record<ModelId, ModelPrice>> = PRICES,
): string | null {
  const base = priceFor(model, prices);
  if (!base) return null;
  const promptTokens = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  const price =
    base.longContext && promptTokens > base.longContext.aboveInputTokens
      ? base.longContext.price
      : base;
  const tokens = (n: number) => new Decimal(String(Math.max(0, Math.round(n))));
  const write1h = Math.min(usage.cacheWrite1hTokens, usage.cacheWriteTokens);
  const write5m = usage.cacheWriteTokens - write1h;
  const micro = tokens(usage.inputTokens)
    .mul(price.inputPerMtok)
    .add(tokens(usage.outputTokens).mul(price.outputPerMtok))
    .add(tokens(write5m).mul(price.cacheWrite5mPerMtok))
    .add(tokens(write1h).mul(price.cacheWrite1hPerMtok))
    .add(tokens(usage.cacheReadTokens).mul(price.cacheReadPerMtok));
  return micro.div(MILLION).toDecimalPlaces(COST_PLACES).toFixed(COST_PLACES);
}

/** Sum of call costs (decimal strings); unpriced calls (null) are skipped. */
export function sumCosts(costs: readonly (string | null)[]): string {
  return costs
    .reduce<Decimal>((sum, c) => (c === null ? sum : sum.add(c)), new Decimal(0))
    .toFixed(COST_PLACES);
}
