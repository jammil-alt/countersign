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
  // DECISION: OpenAI's list prices for GPT-5.5 as reported in 2026-11 ($5 in, $0.50 cached in,
  // $30 out; prompts over 272k tokens at 2x input and 1.5x output), unverified against OpenAI's own
  // page like every price here. OpenAI does not charge for cache writes, so they cost what fresh
  // input does (the transport reports none).
  [MODELS.gpt]: {
    inputPerMtok: "5.00",
    outputPerMtok: "30.00",
    cacheWrite5mPerMtok: "5.00",
    cacheWrite1hPerMtok: "5.00",
    cacheReadPerMtok: "0.50",
    longContext: {
      aboveInputTokens: 272_000,
      price: {
        inputPerMtok: "10.00",
        outputPerMtok: "45.00",
        cacheWrite5mPerMtok: "10.00",
        cacheWrite1hPerMtok: "10.00",
        cacheReadPerMtok: "1.00",
      },
    },
  },
  // DECISION: xAI's list prices for Grok 4.7 as reported in 2026-11 ($2 in, $0.50 cached in, $6
  // out; prompts of 200k tokens or more at double every rate), from third-party summaries: xAI's
  // own page could not be read when this was written. Check before production, as every price
  // here. xAI does not charge for cache writes, so they cost what fresh input does.
  [MODELS.grok]: {
    inputPerMtok: "2.00",
    outputPerMtok: "6.00",
    cacheWrite5mPerMtok: "2.00",
    cacheWrite1hPerMtok: "2.00",
    cacheReadPerMtok: "0.50",
    longContext: {
      aboveInputTokens: 200_000,
      price: {
        inputPerMtok: "4.00",
        outputPerMtok: "12.00",
        cacheWrite5mPerMtok: "4.00",
        cacheWrite1hPerMtok: "4.00",
        cacheReadPerMtok: "1.00",
      },
    },
  },
  // DECISION: Google's paid-tier prices as reported in 2026-11, unverified like the rest (Google's
  // page could not be read when this was written). Gemini 3.1 Pro: $2 in, $12 out; prompts over
  // 200k tokens $4 in, $18 out. Gemini 3.5 Flash: $1.50 in, $9 out. Cached input is a tenth of
  // fresh input; implicit caching charges nothing to write, so writes cost what fresh input does.
  [MODELS.gemini]: {
    inputPerMtok: "2.00",
    outputPerMtok: "12.00",
    cacheWrite5mPerMtok: "2.00",
    cacheWrite1hPerMtok: "2.00",
    cacheReadPerMtok: "0.20",
    longContext: {
      aboveInputTokens: 200_000,
      price: {
        inputPerMtok: "4.00",
        outputPerMtok: "18.00",
        cacheWrite5mPerMtok: "4.00",
        cacheWrite1hPerMtok: "4.00",
        cacheReadPerMtok: "0.40",
      },
    },
  },
  [MODELS.geminiFlash]: {
    inputPerMtok: "1.50",
    outputPerMtok: "9.00",
    cacheWrite5mPerMtok: "1.50",
    cacheWrite1hPerMtok: "1.50",
    cacheReadPerMtok: "0.15",
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

// v0.13 W2-H: the models a skill or a step may name (ARCHITECTURE §10.11, docs/plan.md §1.53).

/** The builder's label for each model; the tiers are labels only, never stored. */
export const MODEL_LABELS: Readonly<Record<ModelId, string>> = {
  [MODELS.haiku]: "Fast (Haiku)",
  [MODELS.sonnet]: "Standard (Sonnet)",
  [MODELS.opus]: "Strong (Opus)",
  [MODELS.gpt]: "OpenAI (GPT)",
  [MODELS.grok]: "xAI (Grok)",
  [MODELS.gemini]: "Google (Gemini Pro)",
  [MODELS.geminiFlash]: "Google (Gemini Flash)",
};

export interface KnownModel {
  id: ModelId;
  label: string;
  inputPerMtok: string;
  outputPerMtok: string;
}

/**
 * The models a skill or a step may name: those with a price, so every call's cost is known
 * (plan §1.2 "Cost"). Cheapest output first, the order the builder lists them in.
 */
export function knownModels(prices: Readonly<Record<ModelId, ModelPrice>> = PRICES): KnownModel[] {
  return Object.entries(prices)
    .map(([id, p]) => ({
      id,
      label: MODEL_LABELS[id] ?? id,
      inputPerMtok: p.inputPerMtok,
      outputPerMtok: p.outputPerMtok,
    }))
    .sort((a, b) => new Decimal(a.outputPerMtok).cmp(b.outputPerMtok) || a.id.localeCompare(b.id));
}

/** The ids of `knownModels()`, for validation (core's `ValidationContext.models`). */
export function knownModelIds(prices: Readonly<Record<ModelId, ModelPrice>> = PRICES): string[] {
  return Object.keys(prices).sort();
}
