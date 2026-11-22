import { describe, expect, it } from "vitest";
import { MODELS } from "./models";
import {
  baseModelId,
  costOf,
  knownModelIds,
  knownModels,
  PREVIOUS_PRICES,
  PRICES,
  priceFor,
  sumCosts,
} from "./pricing";
import { type LlmUsage, ZERO_USAGE } from "./usage";

const usage = (u: Partial<LlmUsage>): LlmUsage => ({ ...ZERO_USAGE, ...u });

describe("costOf", () => {
  it("prices input and output per million tokens, exactly", () => {
    // 1M in at $2 + 1M out at $10.
    expect(
      costOf("claude-sonnet-5-5", usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })),
    ).toBe("12.000000");
    // 1234 in at $2/M = 0.002468; 567 out at $10/M = 0.00567.
    expect(costOf("claude-sonnet-5-5", usage({ inputTokens: 1234, outputTokens: 567 }))).toBe(
      "0.008138",
    );
  });

  it("prices cache writes by TTL and cache reads separately", () => {
    const p = PRICES["claude-opus-5-5"];
    expect(p).toBeDefined();
    // 1M written, of which 400k for 1h: 600k * 5 + 400k * 8 = 3.0 + 3.2; 1M read at 0.20.
    expect(
      costOf(
        "claude-opus-5-5",
        usage({
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 400_000,
          cacheReadTokens: 1_000_000,
        }),
      ),
    ).toBe("6.400000");
  });

  it("keeps sub-cent costs instead of rounding them to zero", () => {
    expect(costOf("claude-haiku-5-5", usage({ inputTokens: 100, outputTokens: 20 }))).toBe(
      "0.000020",
    );
  });

  it("switches Haiku to its long-context rate above 100k prompt tokens", () => {
    expect(costOf("claude-haiku-5-5", usage({ inputTokens: 100_000 }))).toBe("0.010000");
    expect(costOf("claude-haiku-5-5", usage({ inputTokens: 100_001 }))).toBe("0.050001");
    // Cached tokens count toward the threshold.
    expect(
      costOf("claude-haiku-5-5", usage({ inputTokens: 50_000, cacheReadTokens: 60_000 })),
    ).toBe("0.028000");
  });

  it("returns null for a model with no price", () => {
    expect(costOf("claude-unknown-1", usage({ inputTokens: 10 }))).toBeNull();
    expect(costOf("claude-unknown-1-20260101", usage({ inputTokens: 10 }))).toBeNull();
  });

  // QA (usage costs): staging recorded 30 calls of the API's dated answer id at $0.00.
  it("prices a dated id as its model, and the previous Anthropic models", () => {
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(costOf("claude-sonnet-5-5-20261101", u)).toBe(costOf("claude-sonnet-5-5", u));
    // Above 200k prompt tokens, Sonnet 4.5 is at its long-context rate ($6 / $22.50).
    expect(costOf("claude-sonnet-4-5-20250929", u)).toBe("28.500000");
    const small = usage({ inputTokens: 100_000, outputTokens: 100_000 });
    expect(costOf("claude-sonnet-4-5-20250929", small)).toBe("1.800000");
    expect(costOf("claude-sonnet-4-5@20250929", small)).toBe("1.800000");
    expect(costOf("claude-haiku-4-5-20251001", u)).toBe("6.000000");
    // 100k cache reads at 0.1x of $3.
    expect(costOf("claude-sonnet-4-5", usage({ cacheReadTokens: 100_000 }))).toBe("0.030000");
    expect(baseModelId("claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
    expect(baseModelId("openai:gpt-5.5")).toBe("openai:gpt-5.5");
    expect(priceFor("claude-sonnet-4-5-20250929")).toBe(PREVIOUS_PRICES["claude-sonnet-4-5"]);
    // The previous models price calls but are never offered to a step.
    expect(knownModelIds()).not.toContain("claude-sonnet-4-5");
  });

  it("prices Sonnet 5.5's cache reads at $0.10", () => {
    expect(costOf("claude-sonnet-5-5", usage({ cacheReadTokens: 1_000_000 }))).toBe("0.100000");
  });
});

describe("sumCosts", () => {
  it("adds decimal strings without float drift and skips unpriced calls", () => {
    expect(sumCosts(["0.100000", "0.200000", null, "0.000001"])).toBe("0.300001");
  });
});

// v0.13 W2-H (docs/plan.md §1.53).
describe("knownModels", () => {
  it("lists every priced model, cheapest output first, with the builder's labels", () => {
    const models = knownModels();
    expect(models.map((m) => m.id).sort()).toEqual(Object.keys(PRICES).sort());
    expect(models[0]).toMatchObject({ id: MODELS.haiku, label: "Fast (Haiku)" });
    expect(models.find((m) => m.id === MODELS.opus)?.label).toBe("Strong (Opus)");
    expect(knownModelIds()).toEqual(Object.keys(PRICES).sort());
  });

  it("lists xAI's and Google's models with their provider in the label", () => {
    const models = knownModels();
    expect(models.find((m) => m.id === "xai:grok-4.7")).toMatchObject({
      label: "xAI (Grok 4.7)",
      inputPerMtok: "2.00",
      outputPerMtok: "6.00",
    });
    expect(models.find((m) => m.id === "google:gemini-3.1-pro")).toMatchObject({
      label: "Google (Gemini 3.1 Pro)",
      outputPerMtok: "12.00",
    });
    expect(models.find((m) => m.id === "google:gemini-3.5-flash-lite")?.label).toBe(
      "Google (Gemini 3.5 Flash-Lite)",
    );
    // Every priced model has a label of its own.
    for (const m of models) expect(m.label).not.toBe(m.id);
  });

  it("prices long Grok and Gemini Pro prompts at their higher rate above 200K", () => {
    expect(costOf(MODELS.grok, usage({ inputTokens: 200_000 }))).toBe("0.400000");
    expect(costOf(MODELS.grok, usage({ inputTokens: 200_001, outputTokens: 1_000 }))).toBe(
      "0.812004",
    );
    expect(costOf(MODELS.geminiPro, usage({ inputTokens: 150_000, cacheReadTokens: 60_000 }))).toBe(
      "0.624000",
    );
  });

  it("names only models with a price", () => {
    const one = { [MODELS.haiku]: PRICES[MODELS.haiku] as (typeof PRICES)[string] };
    expect(knownModelIds(one)).toEqual([MODELS.haiku]);
  });
});
