// Comparing quotes, without a database: prices compare per standard unit in decimal, never across
// units without a conversion rule or across currencies (invariant 7), totals are for the lines as
// asked, missing and unavailable lines count against a vendor, a late vendor gives way to an
// on-time one, a split needs to save enough, and every answer carries its sources.

import { describe, expect, it } from "vitest";
import type { CatalogItemRow } from "../catalog/store";
import { type CompareLine, type CompareOfferInput, compareOffers } from "./compare";
import { standardPrice } from "./quotes";

const REQ = "req-1";
const sheet = (id: string, lineNo: number, qty: string): CompareLine => ({
  id,
  lineNo,
  description: `line ${lineNo}`,
  qty,
  unit: "sheets",
  catalogItemId: `item-${id}`,
  standardUom: "sheet",
  qtyStd: qty,
});
const quotes = [
  { id: "q-a", vendorId: "v-a", vendorName: "Atlas Panel", receivedAt: null },
  { id: "q-b", vendorId: "v-b", vendorName: "Birch Supply", receivedAt: null },
];
let n = 0;
const offer = (
  quoteRequestId: string,
  requestLineId: string,
  o: Partial<CompareOfferInput> = {},
): CompareOfferInput => ({
  id: `ql-${++n}`,
  quoteRequestId,
  requestLineId,
  qty: "10.0000",
  unit: "SHT",
  unitPrice: null,
  currency: "USD",
  unitPriceStd: null,
  standardUom: null,
  leadTimeDays: null,
  available: true,
  ...o,
});
const std = (price: string, more: Partial<CompareOfferInput> = {}) => ({
  unitPrice: price,
  unitPriceStd: price,
  standardUom: "sheet",
  ...more,
});

const base = { requestId: REQ, neededBy: null, asOf: "2026-11-08", quotes };

describe("compareOffers", () => {
  it("picks the cheapest per standard unit in decimal, totals as asked, and suggests one vendor", () => {
    const lines = [sheet("l1", 1, "10.0000"), sheet("l2", 2, "3.0000")];
    const c = compareOffers({
      ...base,
      lines,
      offers: [
        // 0.1 + 0.2 style prices: decimal, not float.
        offer("q-a", "l1", std("61.1000")),
        offer("q-a", "l2", std("0.2000")),
        offer("q-b", "l1", std("61.1001")),
        offer("q-b", "l2", std("0.3000")),
      ],
    });
    expect(c.lines[0]?.best).toMatchObject({ vendorId: "v-a", price: "61.1000", cost: "611.0000" });
    expect(c.lines[1]?.best).toMatchObject({ vendorId: "v-a", price: "0.2000", cost: "0.6000" });
    expect(c.vendors.map((v) => [v.vendorName, v.total, v.complete])).toEqual([
      ["Atlas Panel", "611.6000", true],
      ["Birch Supply", "611.9010", true],
    ]);
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "v-a", total: "611.6000" });
    expect(c.suggestion.reasons[0]).toBe(
      "Atlas Panel quoted every line for $611.60 in total, the lowest of 2 complete quotes.",
    );
    expect(c.sources).toEqual(expect.arrayContaining([REQ, "l1", "l2", "q-a", "q-b"]));
    expect(c.sources.filter((s) => s.startsWith("ql-"))).toHaveLength(4);
  });

  it("never compares a price in a unit with no conversion rule against standard-unit prices", () => {
    const c = compareOffers({
      ...base,
      lines: [sheet("l1", 1, "10.0000")],
      offers: [
        offer("q-a", "l1", std("62.0000")),
        // Per bundle, no rule to sheets: far cheaper on its face, but not comparable.
        offer("q-b", "l1", { unit: "BUNDLE", unitPrice: "300.0000" }),
      ],
    });
    const line = c.lines[0];
    expect(line?.best).toMatchObject({ vendorId: "v-a", per: "sheet" });
    const bundle = line?.offers.find((o) => o.vendorId === "v-b");
    expect(bundle).toMatchObject({ comparable: false });
    expect(bundle?.note).toBe("quoted per bundle, and no conversion rule turns that into sheet");
    expect(c.vendors.find((v) => v.vendorId === "v-b")).toMatchObject({
      complete: false,
      linesPriced: 0,
    });
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "v-a" });
  });

  it("refuses to compare when the vendors quoted in different units and none converts", () => {
    const unmatched: CompareLine = {
      ...sheet("l1", 1, "4.0000"),
      catalogItemId: null,
      standardUom: null,
      qtyStd: null,
    };
    const c = compareOffers({
      ...base,
      lines: [unmatched],
      offers: [
        offer("q-a", "l1", { unit: "BOX", unitPrice: "40.0000", qty: "4.0000" }),
        offer("q-b", "l1", { unit: "EA", unitPrice: "0.5000", qty: "400.0000" }),
      ],
    });
    expect(c.lines[0]?.best).toBeNull();
    expect(c.lines[0]?.note).toMatch(
      /^Not compared: the vendors quoted this line in different units/,
    );
    expect(c.lines[0]?.offers.every((o) => !o.comparable)).toBe(true);
    expect(c.suggestion.kind).toBe("none");
    expect(c.suggestion.reasons[0]).toMatch(/^Line 1 \(line 1\) has no price we can compare/);
  });

  it("compares offers in the same unit when the line has no catalog item", () => {
    const unmatched: CompareLine = {
      ...sheet("l1", 1, "2.0000"),
      unit: "bundle",
      catalogItemId: null,
      standardUom: null,
      qtyStd: null,
    };
    const c = compareOffers({
      ...base,
      lines: [unmatched],
      offers: [
        offer("q-a", "l1", { unit: "bundle", unitPrice: "40.0000", qty: "2.0000" }),
        offer("q-b", "l1", { unit: "BUNDLE", unitPrice: "38.5000", qty: "2.0000" }),
      ],
    });
    expect(c.lines[0]?.best).toMatchObject({ vendorId: "v-b", per: "bundle", cost: "77.0000" });
  });

  it("never ranks boxes, cases or pails with no known pack size, even in the same word", () => {
    // Screws in each; A sells a case of 12 boxes at 240.00 (20.00 a box), B a box at 22.00.
    // Neither converts to each, and "a pack" isn't one size: nothing is compared.
    const screws: CompareLine = {
      ...sheet("l1", 1, "10.0000"),
      unit: "BX",
      standardUom: "each",
      qtyStd: null,
    };
    const c = compareOffers({
      ...base,
      lines: [screws],
      offers: [
        offer("q-a", "l1", { unit: "CS", unitPrice: "240.0000", qty: "10.0000" }),
        offer("q-b", "l1", { unit: "BX", unitPrice: "22.0000", qty: "10.0000" }),
      ],
    });
    const line = c.lines[0];
    expect(line?.best).toBeNull();
    expect(line?.offers.every((o) => !o.comparable)).toBe(true);
    expect(line?.offers.find((o) => o.vendorId === "v-a")?.note).toBe(
      "quoted per CS with no known pack size, so it can't be compared",
    );
    expect(line?.note).toBe(
      "Not compared: no vendor's box, case or container converts to each with a known pack size.",
    );
    expect(c.vendors.every((v) => !v.complete && v.linesPriced === 0)).toBe(true);
    expect(c.suggestion.kind).toBe("none");
    // The same word from both (BX and BOX) is still not one size.
    const same = compareOffers({
      ...base,
      lines: [screws],
      offers: [
        offer("q-a", "l1", { unit: "BOX", unitPrice: "15.0000", qty: "10.0000" }),
        offer("q-b", "l1", { unit: "BX", unitPrice: "9.0000", qty: "10.0000" }),
      ],
    });
    expect(same.lines[0]?.best).toBeNull();
    expect(same.suggestion.kind).toBe("none");
  });

  it("costs a line on the quantity asked, and a vendor quoting less is not complete", () => {
    const bundles: CompareLine = {
      ...sheet("l1", 1, "100.0000"),
      unit: "bundle",
      catalogItemId: null,
      standardUom: null,
      qtyStd: null,
    };
    const c = compareOffers({
      ...base,
      lines: [bundles],
      offers: [
        offer("q-a", "l1", { unit: "bundle", unitPrice: "2.0000", qty: "100.0000" }),
        // Half the quantity at a higher price: 125.00 on its face, 250.00 for what was asked.
        offer("q-b", "l1", { unit: "bundle", unitPrice: "2.5000", qty: "50.0000" }),
      ],
    });
    const short = c.lines[0]?.offers.find((o) => o.vendorId === "v-b");
    expect(short).toMatchObject({ comparable: false, cost: "250.0000" });
    expect(short?.note).toBe("quoted 50 of the 100 asked");
    expect(c.vendors.map((v) => [v.vendorName, v.total, v.complete])).toEqual([
      ["Atlas Panel", "200.0000", true],
      ["Birch Supply", "0.0000", false],
    ]);
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "v-a", total: "200.0000" });
    // A standard-unit offer for less than asked is short as well.
    const std100 = compareOffers({
      ...base,
      lines: [sheet("l1", 1, "100.0000")],
      offers: [
        offer("q-a", "l1", std("1.0000", { qty: "100.0000" })),
        offer("q-b", "l1", std("0.9000", { qty: "50.0000" })),
      ],
    });
    expect(std100.lines[0]?.best?.vendorId).toBe("v-a");
    expect(std100.vendors.find((v) => v.vendorId === "v-b")?.complete).toBe(false);
  });

  it("never compares across currencies", () => {
    const three = [
      ...quotes,
      { id: "q-c", vendorId: "v-c", vendorName: "Cedar Ridge", receivedAt: null },
    ];
    const c = compareOffers({
      ...base,
      quotes: three,
      lines: [sheet("l1", 1, "1.0000")],
      offers: [
        offer("q-a", "l1", std("60.0000")),
        offer("q-b", "l1", std("50.0000", { currency: "CAD" })),
        offer("q-c", "l1", std("61.0000")),
      ],
    });
    // Most offers are in USD; the CAD one is set aside with its reason, however cheap.
    const cad = c.lines[0]?.offers.find((o) => o.vendorId === "v-b");
    expect(cad?.comparable).toBe(false);
    expect(cad?.note).toBe("quoted in CAD, not USD");
    expect(c.lines[0]?.best?.vendorId).toBe("v-a");
    // One each: nothing decides between the currencies, so the line isn't compared.
    const tie = compareOffers({
      ...base,
      lines: [sheet("l1", 1, "1.0000")],
      offers: [
        offer("q-a", "l1", std("60.0000")),
        offer("q-b", "l1", std("50.0000", { currency: "CAD" })),
      ],
    });
    expect(tie.lines[0]?.best).toBeNull();
    expect(tie.suggestion.kind).toBe("none");
  });

  it("counts missing and unavailable lines, and splits when no vendor quoted every line", () => {
    const lines = [sheet("l1", 1, "1.0000"), sheet("l2", 2, "1.0000")];
    const c = compareOffers({
      ...base,
      lines,
      offers: [
        offer("q-a", "l1", std("10.0000")),
        offer("q-a", "l2", { available: false }),
        offer("q-b", "l2", std("20.0000")),
      ],
    });
    expect(c.lines[0]?.missing).toEqual(["v-b"]);
    expect(c.lines[1]?.unavailable).toEqual(["v-a"]);
    expect(c.vendors.map((v) => [v.linesMissing, v.linesUnavailable, v.complete])).toEqual([
      [0, 1, false],
      [1, 0, false],
    ]);
    expect(c.suggestion).toMatchObject({ kind: "split", total: "30.0000" });
    expect(c.suggestion.split).toEqual([
      { quoteRequestId: "q-a", vendorId: "v-a", requestLineIds: ["l1"], total: "10.0000" },
      { quoteRequestId: "q-b", vendorId: "v-b", requestLineIds: ["l2"], total: "20.0000" },
    ]);
  });

  it("splits only when it saves at least the setting's percent", () => {
    const lines = [sheet("l1", 1, "1.0000"), sheet("l2", 2, "1.0000")];
    const offers = [
      offer("q-a", "l1", std("100.0000")),
      offer("q-a", "l2", std("100.0000")),
      offer("q-b", "l1", std("104.0000")),
      offer("q-b", "l2", std("90.0000")),
    ];
    // A alone 200, B alone 194, split 190: 2.1% less than B.
    const small = compareOffers({ ...base, lines, offers });
    expect(small.suggestion).toMatchObject({ kind: "single", vendorId: "v-b", total: "194.0000" });
    expect(small.suggestion.reasons).toContain(
      "Splitting the order would save $4.00 (2.1%), less than 5%, so one vendor is simpler.",
    );
    const eager = compareOffers({ ...base, lines, offers, splitMinSavingPct: 2 });
    expect(eager.suggestion).toMatchObject({ kind: "split", total: "190.0000" });
  });

  it("prefers a vendor that delivers by the needed-by date, and says why", () => {
    const lines = [sheet("l1", 1, "10.0000")];
    const c = compareOffers({
      ...base,
      neededBy: "2026-11-12",
      lines,
      offers: [
        offer("q-a", "l1", std("50.0000", { leadTimeDays: 10 })),
        offer("q-b", "l1", std("55.0000", { leadTimeDays: 2 })),
      ],
    });
    expect(c.vendors.find((v) => v.vendorId === "v-a")?.late).toBe(true);
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "v-b" });
    expect(c.suggestion.reasons).toContain(
      "Atlas Panel is cheaper at $500.00 but can't deliver by 2026-11-12.",
    );
  });

  it("says so when no quote is in", () => {
    const c = compareOffers({ ...base, quotes: [], lines: [sheet("l1", 1, "1")], offers: [] });
    expect(c.suggestion).toMatchObject({ kind: "none", reasons: ["No quotes are in yet."] });
  });
});

describe("standardPrice", () => {
  // A master item is vendor-neutral: the pack size it was first seen with is one vendor's box.
  const screws = {
    id: "item-screws",
    standardUom: "each",
    attributes: { kind: "screw", pack_size: "100" },
  } as unknown as CatalogItemRow;
  const asked = { description: "#8 X 1-1/4 WOOD SCREW" };

  it("never converts a vendor's box with the master item's pack size", () => {
    // B's box of 50 at 9.00 is 0.18 each, not 0.09.
    const r = standardPrice(screws, { unit: "BX", unitPrice: "9.00", description: null }, asked);
    expect(r).toMatchObject({ unitPriceStd: null, standardUom: null });
    expect(r.conversion).toMatch(/no conversion rule from pack to each/);
  });

  it("converts a box through the vendor's own words or its vendor item", () => {
    const own = standardPrice(
      screws,
      { unit: "BX", unitPrice: "9.00", description: "#8 X 1-1/4 WOOD SCREW 50/BX" },
      asked,
    );
    expect(own).toMatchObject({ unitPriceStd: "0.1800", standardUom: "each" });
    const viaItem = standardPrice(
      screws,
      { unit: "BX", unitPrice: "9.00", description: null },
      asked,
      { vendorUom: "pack", stdPerVendorUom: "50" },
    );
    expect(viaItem).toMatchObject({ unitPriceStd: "0.1800", standardUom: "each" });
  });
});
