import { describe, expect, it } from "vitest";
import { costOf, PRICES, sumCosts } from "./pricing";
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
  });
});

describe("sumCosts", () => {
  it("adds decimal strings without float drift and skips unpriced calls", () => {
    expect(sumCosts(["0.100000", "0.200000", null, "0.000001"])).toBe("0.300001");
  });
});
