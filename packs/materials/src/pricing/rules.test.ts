// The six alert rules at their threshold edges (ARCHITECTURE §12.4), one table each: just over the
// threshold fires, at it doesn't. Plus the dollar impact, evidence, the UOM guard and the dedupe key.

import { dec } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  type AlertDraft,
  dedupeKey,
  madDistance,
  newFees,
  type Observation,
  outlier,
  priceCreep,
  priceJump,
  priceSettingsFrom,
  priceVsAverage,
  vendorSpread,
} from "./rules";

const ITEM = "0192f7a0-0000-7000-8000-00000000c001";
const V1 = "0192f7a0-0000-7000-8000-00000000f001";
const V2 = "0192f7a0-0000-7000-8000-00000000f002";
const settings = priceSettingsFrom({});
const names = {
  item: "Baltic birch 3/4in",
  vendor: (id: string) => (id === V1 ? "Northline" : "Keystone"),
};

let n = 0;
function obs(on: string, price: string, over: Partial<Observation> = {}): Observation {
  n++;
  return {
    id: `obs-${n}`,
    catalogItemId: ITEM,
    vendorId: V1,
    observedOn: on,
    unitPriceStd: price,
    qtyStd: "10",
    standardUom: "sheet",
    docLineId: `line-${n}`,
    ...over,
  };
}

describe("thresholds from settings", () => {
  it("defaults to 5, 10 and 8 percent and ignores nonsense", () => {
    expect(priceSettingsFrom({}).priceChangePct.toString()).toBe("5");
    expect(priceSettingsFrom({ price_change_pct: 12 }).priceChangePct.toString()).toBe("12");
    expect(priceSettingsFrom({ price_change_pct: "lots" }).priceChangePct.toString()).toBe("5");
    expect(priceSettingsFrom({ creep_pct: -3 }).creepPct.toString()).toBe("8");
    expect(priceSettingsFrom({ vendor_spread_pct: 15 }).vendorSpreadPct.toString()).toBe("15");
  });
});

describe("price_jump: more than price_change_pct on the vendor's last price", () => {
  const cases: [string, string, boolean][] = [
    ["100.00", "105.00", false], // exactly 5%: no
    ["100.00", "105.01", true], // just over
    ["100.00", "104.99", false],
    ["100.00", "90.00", false], // a drop is not an alert
    ["62.50", "68.50", true], // 9.6%
  ];
  it.each(cases)("%s → %s fires: %s", (before, after, fires) => {
    const last = obs("2026-10-01", before);
    const cur = obs("2026-10-28", after);
    const a = priceJump(cur, [last], settings, names);
    expect(a !== null).toBe(fires);
    if (a) {
      expect(a.kind).toBe("price_jump");
      expect(a.evidence).toEqual([cur.id, cur.docLineId, last.id, last.docLineId]);
    }
  });

  it("takes the threshold from the agent's settings", () => {
    const last = obs("2026-10-01", "100");
    const cur = obs("2026-10-28", "108");
    expect(priceJump(cur, [last], priceSettingsFrom({ price_change_pct: 10 }), names)).toBeNull();
    expect(
      priceJump(cur, [last], priceSettingsFrom({ price_change_pct: 7.5 }), names),
    ).not.toBeNull();
  });

  it("measures dollar impact as the change times the trailing 90-day quantity", () => {
    const old = obs("2026-06-01", "100", { qtyStd: "999" }); // outside 90 days
    const last = obs("2026-10-01", "100", { qtyStd: "30" });
    const cur = obs("2026-10-28", "110", { qtyStd: "10" });
    const a = priceJump(cur, [old, last], settings, names) as AlertDraft;
    // $10 more a sheet × (30 + 10) sheets.
    expect(a.dollarImpact).toBe("400.0000");
    expect(a.title).toBe("Baltic birch 3/4in up 10% at Northline");
  });

  it("never compares across units (invariant 7) or vendors", () => {
    const cur = obs("2026-10-28", "110");
    expect(
      priceJump(cur, [obs("2026-10-01", "1", { standardUom: "each" })], settings, names),
    ).toBeNull();
    expect(priceJump(cur, [obs("2026-10-01", "1", { vendorId: V2 })], settings, names)).toBeNull();
  });
});

describe("price_vs_avg: more than price_change_pct over the 90-day average", () => {
  const cases: [string[], string, boolean][] = [
    [["100", "100"], "105.00", false],
    [["100", "100"], "105.01", true],
    [["90", "110"], "105.01", true], // average 100
    [["100"], "120", false], // needs two earlier prices
  ];
  it.each(cases)("%j then %s fires: %s", (before, after, fires) => {
    const history = before.map((p, i) => obs(`2026-09-${String(10 + i).padStart(2, "0")}`, p));
    const a = priceVsAverage(obs("2026-10-28", after), history, settings, names);
    expect(a !== null).toBe(fires);
  });

  it("leaves out prices older than 90 days", () => {
    const history = [obs("2026-05-01", "50"), obs("2026-09-10", "100"), obs("2026-09-20", "100")];
    expect(priceVsAverage(obs("2026-10-28", "104"), history, settings, names)).toBeNull();
  });
});

describe("vendor_spread: another vendor cheaper the same month by more than vendor_spread_pct", () => {
  const cases: [string, string, string, boolean][] = [
    ["2026-10-05", "100.00", "110.00", false], // exactly 10%
    ["2026-10-05", "100.00", "110.01", true],
    ["2026-09-28", "100.00", "130.00", false], // another month
    ["2026-10-30", "100.00", "130.00", false], // after this price
  ];
  it.each(cases)("other on %s at %s, ours %s fires: %s", (on, theirs, ours, fires) => {
    const other = obs(on, theirs, { vendorId: V2 });
    const a = vendorSpread(obs("2026-10-28", ours), [other], settings, names);
    expect(a !== null).toBe(fires);
    if (a) {
      expect(a.title).toBe("Baltic birch 3/4in 10% cheaper at Keystone");
      expect(a.dollarImpact).toBe("100.1000");
    }
  });
});

describe("price_creep: more than creep_pct over 90 days, no single jump", () => {
  const cases: [string[], boolean][] = [
    [["100", "104", "108"], false], // exactly 8%
    [["100", "104", "108.01"], true],
    [["100", "106", "109"], false], // a 6% step is a jump, not creep
    [["100", "109"], false], // two prices are one step
  ];
  it.each(cases)("%j fires: %s", (prices, fires) => {
    const series = prices.map((p, i) => obs(`2026-${String(8 + i).padStart(2, "0")}-15`, p));
    const cur = series.at(-1) as Observation;
    const a = priceCreep(cur, series.slice(0, -1), settings, names);
    expect(a !== null).toBe(fires);
    if (a) expect(a.evidence.length).toBe(6);
  });
});

describe("outlier: more than 3 MADs from the item's history", () => {
  const history = ["100", "102", "98", "101", "99"].map((p, i) =>
    obs(`2026-0${i + 4}-01`, p, { vendorId: i % 2 ? V2 : V1 }),
  );
  // median 100, MAD 1: over 103 is an outlier.
  const cases: [string, string, boolean][] = [
    ["103", "10", false],
    ["103.01", "10", true],
    ["96.99", "10", true],
    ["100", "10", false],
    ["100", "1000", true], // quantity
  ];
  it.each(cases)("price %s qty %s fires: %s", (price, qty, fires) => {
    const a = outlier(obs("2026-10-28", price, { qtyStd: qty }), history, settings, names);
    expect(a !== null).toBe(fires);
  });

  it("needs five earlier prices, and floors a zero MAD at 1% of the median", () => {
    expect(madDistance(dec("200"), [dec("100"), dec("100")])).toBeNull();
    const flat = Array.from({ length: 5 }, () => dec("100"));
    expect(madDistance(dec("103"), flat)?.toString()).toBe("3");
  });
});

describe("new_fee: a surcharge type the vendor never charged before", () => {
  const base = { vendorId: V1, vendorName: "Northline", evidence: ["doc", "ext"] };
  it("fires for a new type, not a seen one, not on the vendor's first invoice", () => {
    const fees = [
      { label: "Fuel surcharge 3%", amount: "42.10" },
      { label: "Pallet fee", amount: "15.00" },
    ];
    const a = newFees({ ...base, fees, priorFeeTypes: ["FUEL SURCHARGE 2%"], priorInvoices: 3 });
    expect(a.map((x) => x.facts.feeType)).toEqual(["pallet fee"]);
    expect(a[0]?.dollarImpact).toBe("15.0000");
    expect(newFees({ ...base, fees, priorFeeTypes: [], priorInvoices: 0 })).toEqual([]);
  });
});

describe("dedupe keys", () => {
  it("are one per kind, item and vendor; a fee's per vendor and fee type", () => {
    const a = priceJump(
      obs("2026-10-28", "120"),
      [obs("2026-10-01", "100")],
      settings,
      names,
    ) as AlertDraft;
    expect(dedupeKey(a)).toBe(`materials:price_jump:${ITEM}:${V1}`);
    const [fee] = newFees({
      vendorId: V1,
      vendorName: "Northline",
      evidence: ["d"],
      fees: [{ label: "Pallet fee", amount: "5" }],
      priorFeeTypes: [],
      priorInvoices: 1,
    });
    expect(dedupeKey(fee as AlertDraft)).toBe(`materials:new_fee:${V1}:pallet fee`);
  });
});
