// §1.104: the contract rules as pure functions: which contract holds on a day, the agreed price
// per standard unit (never across units without a conversion: invariant 7), reading payment
// terms, each rule at its edge, and one dedupe key per alert as the decision says.

import { describe, expect, it } from "vitest";
import {
  agreedPriceStd,
  type ContractTerms,
  checkContract,
  contractDedupeKey,
  contractOn,
  contractVariance,
  type InvoiceTerms,
  readTerms,
  termsMismatch,
} from "./contract";
import { dedupeKey, type Observation } from "./rules";

const C: ContractTerms = {
  id: "c-2027",
  vendorId: "v1",
  name: "2027 supply agreement",
  effectiveFrom: "2027-01-01",
  effectiveTo: "2027-12-31",
  paymentTerms: "2% 10, net 30",
  netDays: 30,
  earlyPayDiscountPct: "2.00",
  earlyPayDays: 10,
  freight: "included",
  minOrderAmount: null,
  currency: "USD",
  documentId: "doc-contract",
  sources: ["doc-contract"],
};

const INVOICE: InvoiceTerms = {
  documentId: "doc-1",
  extractionId: "x-1",
  invoiceNumber: "20501",
  invoiceDate: "2027-02-01",
  dueDate: "2027-03-03",
  paymentTerms: "2% 10, Net 30",
  freight: "0.0000",
  currency: "USD",
};

const obs = (o: Partial<Observation> = {}): Observation => ({
  id: "o1",
  catalogItemId: "item-bb",
  vendorId: "v1",
  observedOn: "2027-02-01",
  unitPriceStd: "62.5000",
  qtyStd: "20.0000",
  standardUom: "sheet",
  docLineId: "l1",
  ...o,
});

const names = { item: "Baltic birch 3/4in", vendor: () => "Northline" };
const BUNDLE = {
  vendorItemId: "vi1",
  catalogItemId: "item-bb",
  price: "300.0000",
  vendorUom: "bundle",
  stdPerVendorUom: "5.0000",
};

describe("which contract holds", () => {
  const next: ContractTerms = {
    ...C,
    id: "c-2028",
    effectiveFrom: "2028-01-01",
    effectiveTo: null,
  };
  it("takes the latest to start on or before the day, not yet ended", () => {
    expect(contractOn([C, next], "2027-01-01")?.id).toBe("c-2027");
    expect(contractOn([C, next], "2027-12-31")?.id).toBe("c-2027");
    expect(contractOn([C, next], "2030-06-01")?.id).toBe("c-2028");
    expect(contractOn([C], "2026-12-31")).toBeNull();
    expect(contractOn([C], "2028-01-01")).toBeNull();
  });
});

describe("the agreed price per standard unit", () => {
  it("uses the price in the item's unit, else the vendor's pack, else nothing", () => {
    expect(agreedPriceStd(BUNDLE, "sheet")?.toString()).toBe("60");
    expect(agreedPriceStd({ ...BUNDLE, vendorUom: "sheet" }, "sheet")?.toString()).toBe("300");
    expect(agreedPriceStd({ ...BUNDLE, vendorUom: null }, "sheet")?.toString()).toBe("300");
    expect(agreedPriceStd({ ...BUNDLE, stdPerVendorUom: null }, "sheet")).toBeNull();
  });
});

describe("reading payment terms", () => {
  it("reads the usual spellings and nothing else", () => {
    expect(readTerms("Net 30")).toEqual({ netDays: 30, discountPct: null, discountDays: null });
    expect(readTerms("N30").netDays).toBe(30);
    expect(readTerms("2% 10, net 30")).toEqual({
      netDays: 30,
      discountPct: "2.00",
      discountDays: 10,
    });
    expect(readTerms("2/10 Net 30")).toEqual({
      netDays: 30,
      discountPct: "2.00",
      discountDays: 10,
    });
    expect(readTerms("Due on receipt").netDays).toBe(0);
    expect(readTerms("Payable at our convenience")).toEqual({
      netDays: null,
      discountPct: null,
      discountDays: null,
    });
    expect(readTerms(null).netDays).toBeNull();
  });

  it("reads net days with a dash or slash, and stays quick on long text", () => {
    expect(readTerms("Net-30").netDays).toBe(30);
    expect(readTerms("net / 45").netDays).toBe(45);
    const started = Date.now();
    expect(readTerms(`n${" ".repeat(50_000)}x`).netDays).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe("the contract rules", () => {
  it("raises above_contract from a cent over on the invoice, with the dollars", () => {
    const a = contractVariance(obs(), BUNDLE, C, names);
    expect(a).toMatchObject({
      kind: "above_contract",
      severity: "warning",
      dollarImpact: "50.0000",
    });
    expect(a?.evidence).toEqual(expect.arrayContaining(["o1", "l1", "vi1", "c-2027"]));
    expect(contractVariance(obs({ unitPriceStd: "60.0000" }), BUNDLE, C, names)).toBeNull();
    expect(
      contractVariance(obs({ unitPriceStd: "60.0004", qtyStd: "1" }), BUNDLE, C, names),
    ).toBeNull();
    // No conversion from the vendor's pack: never compared (invariant 7).
    expect(contractVariance(obs(), { ...BUNDLE, stdPerVendorUom: null }, C, names)).toBeNull();
  });

  it("notes a price below the agreed one as a saving (owner: every variance)", () => {
    const b = contractVariance(obs({ unitPriceStd: "59.0000" }), BUNDLE, C, names);
    expect(b).toMatchObject({
      kind: "below_contract",
      severity: "info",
      dollarImpact: "-20.0000",
      facts: { direction: "below", withinTolerance: false },
    });
    expect(b?.title).toBe("Baltic birch 3/4in below the agreed price at Northline");
  });

  it("notes a variance within the item's tolerance as within tolerance, either way", () => {
    // $1.50 a bundle is $0.30 a sheet; 1% of $60 is $0.60: the larger allowance holds.
    const tol = { ...BUNDLE, toleranceAmount: "1.5000", tolerancePct: "1.00" };
    const up = contractVariance(obs({ unitPriceStd: "60.5000" }), tol, C, names);
    expect(up).toMatchObject({
      kind: "within_tolerance",
      severity: "info",
      dollarImpact: "10.0000",
      facts: { direction: "above", withinTolerance: true, tolerance: "0.6000" },
    });
    expect(up?.title).toContain("within tolerance");
    const down = contractVariance(obs({ unitPriceStd: "59.4000" }), tol, C, names);
    expect(down).toMatchObject({ kind: "within_tolerance", facts: { direction: "below" } });
    // Past the allowance: the variance itself.
    expect(contractVariance(obs({ unitPriceStd: "60.6100" }), tol, C, names)?.kind).toBe(
      "above_contract",
    );
    // An amount alone, through the pack: $5 a bundle is $1 a sheet.
    const amount = { ...BUNDLE, toleranceAmount: "5" };
    expect(contractVariance(obs({ unitPriceStd: "61.0000" }), amount, C, names)?.kind).toBe(
      "within_tolerance",
    );
    // No tolerance: the one-cent rule as before.
    expect(contractVariance(obs({ unitPriceStd: "60.0100" }), BUNDLE, C, names)?.kind).toBe(
      "above_contract",
    );
  });

  it("finds terms that differ, and none where the invoice says nothing", () => {
    expect(
      termsMismatch({ vendorId: "v1", vendorName: "Northline", contract: C, invoice: INVOICE }),
    ).toEqual([]);
    const sooner = termsMismatch({
      vendorId: "v1",
      vendorName: "Northline",
      contract: C,
      invoice: { ...INVOICE, paymentTerms: null, dueDate: "2027-02-16" },
    });
    expect(sooner.map((a) => [a.facts.term, a.severity])).toEqual([["payment", "warning"]]);
    const discount = termsMismatch({
      vendorId: "v1",
      vendorName: "Northline",
      contract: C,
      invoice: { ...INVOICE, paymentTerms: "1% 10, net 30" },
    });
    expect(discount.map((a) => a.facts.term)).toEqual(["discount"]);
    const freight = termsMismatch({
      vendorId: "v1",
      vendorName: "Northline",
      contract: C,
      invoice: { ...INVOICE, freight: "75.0000" },
    });
    expect(freight).toMatchObject([{ facts: { term: "freight" }, dollarImpact: "75.0000" }]);
    expect(
      termsMismatch({
        vendorId: "v1",
        vendorName: "Northline",
        contract: { ...C, freight: "charged" },
        invoice: { ...INVOICE, freight: "75.0000" },
      }),
    ).toEqual([]);
  });

  it("checks nothing against a contract that doesn't hold, and says so once", () => {
    const r = checkContract({
      vendorId: "v1",
      vendorName: "Northline",
      contracts: [C],
      agreedFor: () => BUNDLE,
      hasPrices: () => true,
      invoice: { ...INVOICE, invoiceDate: "2028-02-01", freight: "75.0000" },
      lines: [obs({ observedOn: "2028-02-01" })],
      names: () => names,
    });
    expect(r.contract).toBeNull();
    expect(r.alerts.map((a) => a.kind)).toEqual(["contract_not_in_effect"]);
    expect(r.alerts[0]?.facts.expired).toBe(true);
  });

  it("names a line not on a contract that lists prices; a terms-only contract checks no items", () => {
    const run = (hasPrices: boolean) =>
      checkContract({
        vendorId: "v1",
        vendorName: "Northline",
        contracts: [C],
        agreedFor: () => null,
        hasPrices: () => hasPrices,
        invoice: INVOICE,
        lines: [obs()],
        names: () => names,
      }).alerts.map((a) => a.kind);
    expect(run(true)).toEqual(["not_on_contract"]);
    expect(run(false)).toEqual([]);
  });

  it("keys one open alert per item, per standing term, and per invoice's freight", () => {
    const [freight] = termsMismatch({
      vendorId: "v1",
      vendorName: "Northline",
      contract: C,
      invoice: { ...INVOICE, freight: "75.0000" },
    });
    if (!freight) throw new Error("no freight alert");
    expect(dedupeKey(freight)).toBe("materials:terms_mismatch:v1:freight:doc-1");
    const above = contractVariance(obs(), BUNDLE, C, names);
    if (!above) throw new Error("no alert");
    expect(dedupeKey(above)).toBe("materials:above_contract:item-bb:v1");
    expect(contractDedupeKey({ ...freight, facts: { term: "payment" } })).toBe(
      "materials:terms_mismatch:v1:payment",
    );
  });
});
