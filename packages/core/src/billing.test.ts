import { describe, expect, it } from "vitest";
import {
  allowanceFor,
  billingPeriod,
  creditsForCost,
  endOfDaySeconds,
  nextPeriodAnchor,
  overageCredits,
  periodCredits,
  priceMeasures,
  readTenantBilling,
  reportDay,
  type UnitCost,
  UnitCost as UnitCostSchema,
  usageIncrement,
  usageReportIdentifier,
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

describe("allowance and overage", () => {
  it("pools the allowance across a client's active agents", () => {
    expect(allowanceFor(3, 2000)).toBe(6000);
    expect(allowanceFor(0, 2000)).toBe(0);
  });

  it("bills nothing up to the allowance and every credit past it", () => {
    expect(overageCredits(5999, 6000)).toBe(0);
    expect(overageCredits(6000, 6000)).toBe(0);
    expect(overageCredits(6001, 6000)).toBe(1);
    expect(overageCredits(10, 0)).toBe(10);
  });

  it("reports only the increment, never a negative one", () => {
    expect(usageIncrement(150, 100)).toBe(50);
    expect(usageIncrement(150, 150)).toBe(0);
    // The allowance grew (a new agent): nothing is taken back.
    expect(usageIncrement(20, 100)).toBe(0);
  });
});

describe("periods", () => {
  it("are calendar months in UTC", () => {
    expect(billingPeriod("2026-11-04")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(billingPeriod("2028-02-29")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(billingPeriod("2026-12-31")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("report yesterday, anchor on the next 1st, and stamp the end of the day", () => {
    expect(reportDay(new Date("2026-12-01T00:07:00Z"))).toBe("2026-11-30");
    expect(new Date(nextPeriodAnchor(new Date("2026-12-15T10:00:00Z")) * 1000).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(new Date(endOfDaySeconds("2026-11-30") * 1000).toISOString()).toBe(
      "2026-11-30T23:59:59.000Z",
    );
    expect(usageReportIdentifier("t", "2026-11-01", "2026-11-03")).toBe(
      "mezonas:t:2026-11-01:2026-11-03",
    );
  });
});

describe("a client's billing record", () => {
  it("reads tenant.settings.billing, or null when not set up", () => {
    expect(readTenantBilling({})).toBeNull();
    expect(readTenantBilling(null)).toBeNull();
    expect(readTenantBilling({ billing: { nonsense: true } })).toBeNull();
    const b = readTenantBilling({
      billing: {
        customerId: "cus_1",
        subscriptionId: "sub_1",
        baseItemId: "si_1",
        overageItemId: "si_2",
        quantity: 2,
        subscriptionStatus: "active",
        setUpAt: "2026-11-04T00:00:00.000Z",
        setUpBy: null,
      },
    });
    expect(b?.lastInvoice).toBeNull();
    expect(b?.subscriptionEventAt).toBeNull();
  });
});
