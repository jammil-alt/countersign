// Comparing quotes, without a database: prices compare per standard unit in decimal, never across
// units without a conversion rule or across currencies (invariant 7), totals are for the lines as
// asked, missing and unavailable lines count against a vendor, a late vendor gives way to an
// on-time one, a split needs to save enough, and every answer carries its sources.

import { describe, expect, it } from "vitest";
import type { CatalogItemRow } from "../catalog/store";
import { type CompareLine, type CompareOfferInput, compareOffers } from "./compare";
import { quotedQtyAsAsked, standardPrice } from "./quotes";
import type { RequestLineRow } from "./requests";

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
  qty: null,
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
      // 61.1001 × 10 = 611.001: each line rounded to cents, as its purchase order is.
      ["Birch Supply", "611.9000", true],
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
    expect(c.lines[0]?.compared).toBe(false);
    expect(c.suggestion.reasons[0]).toMatch(/^Line 1 \(line 1\) is left out of the totals/);
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

  it("costs each offer at what its purchase order charges, and holds what was quoted against what was asked", () => {
    const three = [
      ...quotes,
      { id: "q-c", vendorId: "v-c", vendorName: "Cedar Ridge", receivedAt: null },
    ];
    // 100 sheets asked with no unit (the item counts sheets).
    const asked: CompareLine = { ...sheet("l1", 1, "100.0000"), unit: null };
    const c = compareOffers({
      ...base,
      quotes: three,
      lines: [asked],
      offers: [
        // 2 bundles of 50 at 50.00: 100 sheets, 100.00.
        offer("q-a", "l1", {
          ...std("1.0000"),
          unit: "bundle",
          unitPrice: "50.0000",
          qty: "2.0000",
          qtyStd: "100.0000",
        }),
        // A minimum order: 150 sheets at 0.95 is cheaper a sheet, but its order is 142.50.
        offer("q-b", "l1", std("0.9500", { qty: "150.0000", qtyStd: "150.0000" })),
        // 1 bundle of 50 for the 100 asked: short, whatever its price.
        offer("q-c", "l1", {
          ...std("0.5000"),
          unit: "bundle",
          unitPrice: "25.0000",
          qty: "1.0000",
          qtyStd: "50.0000",
        }),
      ],
    });
    const line = c.lines[0];
    const by = (v: string) => line?.offers.find((o) => o.vendorId === v);
    expect(by("v-a")).toMatchObject({ comparable: true, cost: "100.0000", note: null });
    expect(by("v-b")).toMatchObject({ comparable: true, cost: "142.5000" });
    expect(by("v-b")?.note).toBe(
      "quoted 150 sheets where 100 sheets were asked (a minimum order?): priced as quoted",
    );
    expect(by("v-c")).toMatchObject({ comparable: false });
    expect(by("v-c")?.note).toBe("quoted 50 sheets of the 100 sheets asked");
    expect(line?.best).toMatchObject({ vendorId: "v-a", cost: "100.0000" });
    expect(c.vendors.map((v) => [v.vendorName, v.total, v.complete])).toEqual([
      ["Atlas Panel", "100.0000", true],
      ["Birch Supply", "142.5000", true],
      ["Cedar Ridge", "0.0000", false],
    ]);
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "v-a", total: "100.0000" });

    // With no catalog item, in the unit asked: half the bundles is short.
    const bundles: CompareLine = {
      ...sheet("l1", 1, "100.0000"),
      unit: "bundle",
      catalogItemId: null,
      standardUom: null,
      qtyStd: null,
    };
    const raw = compareOffers({
      ...base,
      lines: [bundles],
      offers: [
        offer("q-a", "l1", { unit: "bundle", unitPrice: "2.0000", qty: "100.0000" }),
        offer("q-b", "l1", { unit: "bundle", unitPrice: "2.5000", qty: "50.0000" }),
      ],
    });
    const short = raw.lines[0]?.offers.find((o) => o.vendorId === "v-b");
    expect(short).toMatchObject({ comparable: false, cost: "125.0000" });
    expect(short?.note).toBe("quoted 50 bundle of the 100 bundle asked");
    expect(raw.vendors.map((v) => [v.vendorName, v.total, v.complete])).toEqual([
      ["Atlas Panel", "200.0000", true],
      ["Birch Supply", "0.0000", false],
    ]);
  });

  it("compares the comparable offers when another vendor's box can't be, and leaves out a line nobody's can", () => {
    const three = [
      ...quotes,
      { id: "q-c", vendorId: "v-c", vendorName: "Cedar Ridge", receivedAt: null },
    ];
    const each: CompareLine = {
      ...sheet("l1", 1, "10.0000"),
      unit: "EA",
      catalogItemId: null,
      standardUom: null,
      qtyStd: null,
    };
    const screws: CompareLine = { ...sheet("l2", 2, "5.0000"), unit: "BX", qtyStd: null };
    const c = compareOffers({
      ...base,
      quotes: three,
      lines: [each, screws],
      offers: [
        offer("q-a", "l1", { unit: "EA", unitPrice: "2.0000" }),
        offer("q-b", "l1", { unit: "EA", unitPrice: "1.9000" }),
        offer("q-c", "l1", { unit: "BX", unitPrice: "15.0000" }),
        offer("q-a", "l2", { unit: "BX", unitPrice: "9.0000" }),
        offer("q-b", "l2", { unit: "BX", unitPrice: "8.0000" }),
      ],
    });
    expect(c.lines[0]?.best).toMatchObject({ vendorId: "v-b", cost: "19.0000" });
    expect(c.lines[0]?.compared).toBe(true);
    expect(c.lines[1]).toMatchObject({ best: null, compared: false });
    expect(c.vendors.map((v) => [v.vendorName, v.complete])).toEqual([
      ["Atlas Panel", true],
      ["Birch Supply", true],
      ["Cedar Ridge", false],
    ]);
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "v-b", total: "19.0000" });
    expect(c.suggestion.reasons.at(-1)).toBe(
      "Line 2 (line 2) is left out of the totals: no vendor's box, case or container converts to sheet with a known pack size.",
    );
  });

  it("never counts a vendor that didn't price a line left out of the totals as complete", () => {
    const three = [
      ...quotes,
      { id: "q-c", vendorId: "v-c", vendorName: "Cedar Ridge", receivedAt: null },
    ];
    const screws: CompareLine = {
      ...sheet("l2", 2, "5.0000"),
      unit: "BX",
      standardUom: "each",
      qtyStd: null,
    };
    const c = compareOffers({
      ...base,
      quotes: three,
      lines: [sheet("l1", 1, "10.0000"), screws],
      offers: [
        offer("q-a", "l1", std("50.0000")),
        offer("q-a", "l2", { unit: "BX", unitPrice: "9.0000", qty: "5.0000" }),
        offer("q-b", "l1", std("51.0000")),
        offer("q-b", "l2", { unit: "BX", unitPrice: "8.0000", qty: "5.0000" }),
        // Cheapest plywood, but no screws at all.
        offer("q-c", "l1", std("49.0000")),
      ],
    });
    expect(c.lines[1]?.compared).toBe(false);
    expect(c.vendors.map((v) => [v.vendorName, v.total, v.complete])).toEqual([
      ["Atlas Panel", "500.0000", true],
      ["Birch Supply", "510.0000", true],
      ["Cedar Ridge", "490.0000", false],
    ]);
    expect(c.suggestion).toMatchObject({ kind: "single", vendorId: "v-a" });
    expect(c.suggestion.reasons[0]).toBe(
      "Atlas Panel quoted every line for $500.00 in total, the lowest of 2 complete quotes.",
    );
  });

  it("never suggests a split that adds up prices in two currencies", () => {
    const four = [
      ...quotes,
      { id: "q-c", vendorId: "v-c", vendorName: "Cedar Ridge", receivedAt: null },
      { id: "q-d", vendorId: "v-d", vendorName: "Dogwood", receivedAt: null },
    ];
    const lines = [sheet("l1", 1, "10.0000"), sheet("l2", 2, "10.0000")];
    const c = compareOffers({
      ...base,
      quotes: four,
      lines,
      offers: [
        offer("q-a", "l1", std("1.0000")),
        offer("q-b", "l1", std("2.0000")),
        offer("q-c", "l2", std("100.0000", { currency: "CAD" })),
        offer("q-d", "l2", std("200.0000", { currency: "CAD" })),
      ],
    });
    expect(c.suggestion.kind).toBe("none");
    expect(c.suggestion.total).toBeNull();
    expect(c.suggestion.reasons[0]).toBe(
      "Buying each line from its cheapest vendor would mix currencies (USD and CAD), so no split is suggested.",
    );
  });

  it("costs a quote that gives no quantity at the quantity asked, in its own unit", () => {
    const screws: CompareLine = {
      ...sheet("l1", 1, "500.0000"),
      unit: "EA",
      standardUom: "each",
      qtyStd: "500.0000",
    };
    const c = compareOffers({
      ...base,
      lines: [screws],
      offers: [
        // 9.00 a box of 100, no quantity: 500 each is 45.00, not 500 boxes.
        offer("q-a", "l1", {
          unit: "BX",
          unitPrice: "9.0000",
          unitPriceStd: "0.0900",
          standardUom: "each",
        }),
        offer("q-b", "l1", {
          unit: "EA",
          unitPrice: "0.1200",
          unitPriceStd: "0.1200",
          standardUom: "each",
        }),
      ],
    });
    const by = (v: string) => c.lines[0]?.offers.find((o) => o.vendorId === v);
    expect(by("v-a")).toMatchObject({ cost: "45.0000", comparable: true, note: null });
    expect(by("v-b")).toMatchObject({ cost: "60.0000", comparable: true });
    expect(c.lines[0]?.best?.vendorId).toBe("v-a");
  });

  it("costs a quote with no quantity on a request with no unit in the item's unit", () => {
    const screws: CompareLine = {
      ...sheet("l1", 1, "500.0000"),
      unit: null,
      standardUom: "each",
      qtyStd: "500.0000",
    };
    const c = compareOffers({
      ...base,
      lines: [screws],
      offers: [
        offer("q-a", "l1", {
          unit: "BX",
          unitPrice: "9.0000",
          unitPriceStd: "0.0900",
          standardUom: "each",
        }),
      ],
    });
    // 500 screws at 0.09: 45.00, never 500 boxes.
    expect(c.lines[0]?.offers[0]).toMatchObject({ cost: "45.0000", comparable: true });
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

describe("quotedQtyAsAsked", () => {
  const screws = {
    id: "item-screws",
    standardUom: "each",
    attributes: { kind: "screw" },
  } as unknown as CatalogItemRow;
  const asked = {
    row: { qty: "500.0000", unit: "EA", description: "#8 X 1-1/4 WOOD SCREW" } as RequestLineRow,
    item: screws,
  };
  it("turns the quantity asked into the vendor's unit, else leaves it to a person", () => {
    const box = { vendorUom: "pack", stdPerVendorUom: "100" };
    expect(quotedQtyAsAsked(asked, { unit: "BX", description: null }, box)).toBe("5.0000");
    expect(quotedQtyAsAsked(asked, { unit: "BX", description: null }, null)).toBeNull();
    expect(quotedQtyAsAsked(asked, { unit: "ea", description: null }, null)).toBe("500.0000");
    // Boxes are ordered whole: 500 each from boxes of 30 is 17 boxes.
    const thirty = { vendorUom: "pack", stdPerVendorUom: "30" };
    expect(quotedQtyAsAsked(asked, { unit: "BX", description: null }, thirty)).toBe("17.0000");
  });

  it("reads a request with no unit in its item's unit, and a box and a case as two units", () => {
    const noUnit = { ...asked, row: { ...asked.row, unit: null } as RequestLineRow };
    const box = { vendorUom: "pack", stdPerVendorUom: "100" };
    // 500 screws asked with no unit, quoted per box of 100: 5 boxes, not 500.
    expect(quotedQtyAsAsked(noUnit, { unit: "BX", description: null }, box)).toBe("5.0000");
    // 5 boxes of 100 asked, quoted per case of unknown size: nothing, not 5 cases.
    const boxes = {
      ...asked,
      row: {
        qty: "5.0000",
        unit: "BX",
        description: "#8 X 1-1/4 WOOD SCREW 100/BX",
      } as RequestLineRow,
    };
    expect(quotedQtyAsAsked(boxes, { unit: "CS", description: null }, null)).toBeNull();
    const kase = { vendorUom: "pack", stdPerVendorUom: "1000" };
    expect(quotedQtyAsAsked(boxes, { unit: "CS", description: null }, kase)).toBe("1.0000");
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
