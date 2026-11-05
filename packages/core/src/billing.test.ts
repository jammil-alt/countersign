import { describe, expect, it } from "vitest";
import {
  billingPeriod,
  buildStatement,
  centsOf,
  creditsForCost,
  daysInMonth,
  overageCredits,
  periodCredits,
  periodSeconds,
  previousPeriod,
  priceMeasures,
  readTenantBilling,
  resolveAgentPrice,
  statementStripeKey,
  sumAmounts,
  toCents,
  type UnitCost,
  UnitCost as UnitCostSchema,
} from "./billing";

const MODEL: UnitCost = { measure: "cost_usd", unitCost: "1.0000", perUnits: 1 };

describe("credit conversion", () => {
  it("prices each measure with its unit cost, per its units, in decimals", () => {
    const priced = priceMeasures({ cost_usd: "0.1234", messages: "3", call_seconds: "90" }, [
      MODEL,
      { measure: "messages", unitCost: "0.0083", perUnits: 1 },
      { measure: "call_seconds", unitCost: "0.1000", perUnits: 60 },
    ]);
    // 0.1234 + 3 × 0.0083 + 90 × 0.1 / 60 = 0.1234 + 0.0249 + 0.15
    expect(priced.cost.toString()).toBe("0.2983");
    expect(priced.unpriced).toEqual([]);
  });

  it("is generic over measures: a new usage column counts once it has a unit cost", () => {
    // A measure the platform doesn't know (here `widgets`) is billed as soon as it is priced.
    const unit = { measure: "widgets", unitCost: "0.0250", perUnits: 4 } satisfies UnitCost;
    const without = priceMeasures({ cost_usd: "0.0100", widgets: "8" }, [MODEL]);
    expect(without.cost.toString()).toBe("0.01");
    expect(without.unpriced).toEqual(["widgets"]);
    const withIt = priceMeasures({ cost_usd: "0.0100", widgets: "8" }, [MODEL, unit]);
    expect(withIt.cost.toString()).toBe("0.06");
    expect(withIt.byMeasure.find((m) => m.measure === "widgets")).toEqual({
      measure: "widgets",
      quantity: "8",
      cost: "0.05",
    });
    // A priced measure with no usage column yet (no total) counts nothing.
    expect(priceMeasures({}, [MODEL, unit]).cost.isZero()).toBe(true);
  });

  it("never goes through a float: 0.1 + 0.2 is exactly 0.3 and costs 30 credits", () => {
    const priced = priceMeasures({ cost_usd: "0.1", other: "0.2" }, [
      MODEL,
      { measure: "other", unitCost: "1", perUnits: 1 },
    ]);
    expect(priced.cost.toString()).toBe("0.3");
    expect(creditsForCost(priced.cost)).toBe(30);
  });

  it("keeps precision below a hundredth of a cent until the day rounds", () => {
    // A third of a cent per unit, three units: exactly one cent, not 1.0000000001.
    const priced = priceMeasures({ ticks: "3" }, [
      { measure: "ticks", unitCost: "0.01", perUnits: 3 },
    ]);
    expect(creditsForCost(priced.cost)).toBe(1);
  });

  it("validates unit costs: decimal strings, not negative, whole units", () => {
    expect(UnitCostSchema.safeParse(MODEL).success).toBe(true);
    expect(UnitCostSchema.safeParse({ ...MODEL, unitCost: "-1" }).success).toBe(false);
    expect(UnitCostSchema.safeParse({ ...MODEL, unitCost: "0.00001" }).success).toBe(false);
    expect(UnitCostSchema.safeParse({ ...MODEL, unitCost: 1 }).success).toBe(false);
    expect(UnitCostSchema.safeParse({ ...MODEL, perUnits: 0 }).success).toBe(false);
    expect(UnitCostSchema.safeParse({ ...MODEL, measure: "Cost USD" }).success).toBe(false);
  });
});

describe("rounding", () => {
  it("rounds a day's cost up to whole cents", () => {
    expect(creditsForCost("0")).toBe(0);
    expect(creditsForCost("0.0001")).toBe(1);
    expect(creditsForCost("0.0100")).toBe(1);
    expect(creditsForCost("0.0101")).toBe(2);
    expect(creditsForCost("12.3400")).toBe(1234);
    expect(creditsForCost("12.34000000001")).toBe(1235);
    expect(creditsForCost("-0.5")).toBe(0);
  });

  it("rounds per client per day, not per run, then sums the days", () => {
    const result = periodCredits(
      [
        { day: "2026-11-02", totals: { cost_usd: "0.0040" } },
        { day: "2026-11-01", totals: { cost_usd: "0.0030" } },
        { day: "2026-11-03", totals: { cost_usd: "0.0000" } },
      ],
      [MODEL],
    );
    // 0.3 and 0.4 of a cent: one credit each day (two), not ceil(0.7) = 1 for the period.
    expect(result.credits).toBe(2);
    expect(result.days.map((d) => [d.day, d.credits])).toEqual([
      ["2026-11-01", 1],
      ["2026-11-02", 1],
      ["2026-11-03", 0],
    ]);
    expect(result.cost).toBe("0.007");
  });
});

describe("overage", () => {
  it("bills nothing up to the included credits and every credit past them", () => {
    expect(overageCredits(5999, 6000)).toBe(0);
    expect(overageCredits(6000, 6000)).toBe(0);
    expect(overageCredits(6001, 6000)).toBe(1);
    expect(overageCredits(10, 0)).toBe(10);
  });
});

describe("periods", () => {
  it("are calendar months in UTC", () => {
    expect(billingPeriod("2026-11-04")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(billingPeriod("2028-02-29")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(billingPeriod("2026-12-31")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(daysInMonth("2026-11-15")).toBe(30);
    expect(daysInMonth("2027-02-01")).toBe(28);
    expect(daysInMonth("2028-02-10")).toBe(29);
  });

  it("build on the 1st for the month just ended, over the whole month", () => {
    expect(previousPeriod(new Date("2026-12-01T00:07:00Z"))).toBe("2026-11-01");
    expect(previousPeriod(new Date("2027-01-01T00:07:00Z"))).toBe("2026-12-01");
    const s = periodSeconds("2026-11-01");
    expect(new Date(s.start * 1000).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(new Date(s.end * 1000).toISOString()).toBe("2026-11-30T23:59:59.000Z");
    expect(statementStripeKey("s1", "item", "l1")).toBe("mezonas:s1:item:l1");
    expect(statementStripeKey("s1", "send")).toBe("mezonas:s1:send");
  });
});

describe("prices", () => {
  const defaults = { monthlyPrice: "250", includedCredits: 2000 };
  const template = { monthlyPrice: "400.0000", includedCredits: 5000 };
  const override = { monthlyPrice: "350.5", includedCredits: 4000 };

  it("take the client agent's own, then its template's, then the default", () => {
    expect(resolveAgentPrice({ override, template, templateSlug: "pia", defaults })).toEqual({
      monthlyPrice: "350.5000",
      includedCredits: 4000,
      source: "override",
    });
    expect(resolveAgentPrice({ override: null, template, templateSlug: "pia", defaults })).toEqual({
      monthlyPrice: "400.0000",
      includedCredits: 5000,
      source: "template",
    });
    expect(
      resolveAgentPrice({ override: null, template: null, templateSlug: null, defaults }),
    ).toEqual({ monthlyPrice: "250.0000", includedCredits: 2000, source: "default" });
  });

  it("make the supervisor free unless its template is priced", () => {
    expect(
      resolveAgentPrice({ override: null, template: null, templateSlug: "supervisor", defaults }),
    ).toEqual({ monthlyPrice: "0.0000", includedCredits: 0, source: "platform" });
    expect(
      resolveAgentPrice({ override: null, template, templateSlug: "supervisor", defaults }).source,
    ).toBe("template");
  });
});

describe("statements", () => {
  const day = (agentId: string, d: string, monthlyPrice: string, includedCredits = 0) => ({
    agentId,
    agentName: agentId === "a" ? "Orders desk" : "Invoice clerk",
    day: d,
    monthlyPrice,
    includedCredits,
  });
  const range = (agentId: string, from: number, to: number, price: string, credits = 0) =>
    Array.from({ length: to - from + 1 }, (_, i) =>
      day(agentId, `2026-11-${String(from + i).padStart(2, "0")}`, price, credits),
    );

  it("prorate an agent active 10 of 30 days: a third of its price", () => {
    const s = buildStatement({
      period: "2026-11-01",
      days: range("a", 1, 10, "300.0000", 3000),
      creditsUsed: 0,
      creditPrice: "0.02",
    });
    expect(s.daysInMonth).toBe(30);
    expect(s.lines[0]).toMatchObject({
      kind: "agent",
      description: "Orders desk",
      amount: "100.0000",
      detail: { days: 10, daysInMonth: 30, prices: [{ monthlyPrice: "300.0000", days: 10 }] },
    });
    expect(s.creditsIncluded).toBe(1000);
    expect(s.total).toBe("100.0000");
  });

  it("prorate each price by its own days when it changes mid-month", () => {
    // 15 days at $300, then 15 at $450: 150 + 225.
    const s = buildStatement({
      period: "2026-11-01",
      days: [...range("a", 1, 15, "300.0000"), ...range("a", 16, 30, "450.0000")],
      creditsUsed: 0,
      creditPrice: "0.02",
    });
    const line = s.lines.find((l) => l.kind === "agent");
    expect(line?.amount).toBe("375.0000");
    expect(line?.detail).toMatchObject({
      days: 30,
      prices: [
        { monthlyPrice: "300.0000", days: 15 },
        { monthlyPrice: "450.0000", days: 15 },
      ],
    });
  });

  it("pool the credits by days and bill the extra at the credit price", () => {
    // a: 2000 credits all month; b: 3000 credits for 10 of 30 days → 2000 + 1000 = 3000 pooled.
    const s = buildStatement({
      period: "2026-11-01",
      days: [...range("a", 1, 30, "250.0000", 2000), ...range("b", 21, 30, "0.0000", 3000)],
      creditsUsed: 3250,
      creditPrice: "0.0200",
    });
    expect(s.creditsIncluded).toBe(3000);
    expect(s.extraCredits).toBe(250);
    const usage = s.lines.find((l) => l.kind === "usage");
    expect(usage).toMatchObject({
      description: "Extra usage",
      amount: "5.0000",
      detail: {
        creditsUsed: 3250,
        creditsIncluded: 3000,
        extraCredits: 250,
        creditPrice: "0.0200",
      },
    });
    // A free agent's line is there, at zero (the screens say "Included").
    expect(s.lines.find((l) => l.agentId === "b")?.amount).toBe("0.0000");
    expect(s.total).toBe("255.0000");
    // Within the pool: no extra.
    const within = buildStatement({
      period: "2026-11-01",
      days: range("a", 1, 30, "250.0000", 2000),
      creditsUsed: 2000,
      creditPrice: "0.0200",
    });
    expect(within.extraCredits).toBe(0);
    expect(within.lines.at(-1)?.amount).toBe("0.0000");
  });

  it("round half up to cents once per line, and the pool half up to whole credits", () => {
    // $100 for 1 of 30 days: 3.3333… → 3.33; $100.05 for 1 of 30: 3.335 → 3.34 (half up).
    const a = buildStatement({
      period: "2026-11-01",
      days: [day("a", "2026-11-01", "100.0000"), day("b", "2026-11-01", "100.0500")],
      creditsUsed: 0,
      creditPrice: "0.02",
    });
    // Lines are by name: Invoice clerk (b), Orders desk (a), then extra usage.
    expect(a.lines.map((l) => l.amount)).toEqual(["3.3400", "3.3300", "0.0000"]);
    expect(a.total).toBe("6.6700");
    // Rounding is per line, not per day: 7 days of $10 in a 31-day month is 2.2580… → 2.26.
    const b = buildStatement({
      period: "2026-12-01",
      days: Array.from({ length: 7 }, (_, i) => day("a", `2026-12-0${i + 1}`, "10.0000")),
      creditsUsed: 0,
      creditPrice: "0.02",
    });
    expect(b.lines[0]?.amount).toBe("2.2600");
    // Pool: 1000 credits × 15/30 = 500; 45 credits × 1/30 = 1.5 → 2 (half up), once.
    const c = buildStatement({
      period: "2026-11-01",
      days: [day("a", "2026-11-01", "0", 45)],
      creditsUsed: 3,
      creditPrice: "0.0150",
    });
    expect(c.creditsIncluded).toBe(2);
    // 1 extra credit at $0.015 → $0.02 (half up to cents).
    expect(c.lines.at(-1)?.amount).toBe("0.0200");
  });

  it("ignore days outside the month, and give whole cents to Stripe", () => {
    const s = buildStatement({
      period: "2026-11-01",
      days: [day("a", "2026-10-31", "300"), day("a", "2026-12-01", "300")],
      creditsUsed: 0,
      creditPrice: "0.02",
    });
    expect(s.lines.filter((l) => l.kind === "agent")).toEqual([]);
    expect(s.total).toBe("0.0000");
    expect(centsOf("123.4500")).toBe(12345);
    expect(centsOf("-5.0000")).toBe(-500);
    expect(() => centsOf("0.0050")).toThrow();
    expect(toCents("0.005")).toBe("0.0100");
    expect(sumAmounts(["1.10", "2.20", "-0.30"])).toBe("3.0000");
  });
});

describe("a client's billing record", () => {
  it("reads tenant.settings.billing, or null when not set up", () => {
    expect(readTenantBilling({})).toBeNull();
    expect(readTenantBilling(null)).toBeNull();
    expect(readTenantBilling({ billing: { nonsense: true } })).toBeNull();
    // A record from §1.24 (with subscription fields) still reads: only the customer matters now.
    const b = readTenantBilling({
      billing: {
        customerId: "cus_1",
        subscriptionId: "sub_1",
        quantity: 2,
        setUpAt: "2026-11-04T00:00:00.000Z",
        setUpBy: null,
      },
    });
    expect(b).toEqual({
      customerId: "cus_1",
      email: null,
      setUpAt: "2026-11-04T00:00:00.000Z",
      setUpBy: null,
    });
  });
});
