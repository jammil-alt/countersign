// The golden datasets (docs/plan.md §1.212), written from one source so a scenario's world and its
// expected writes sit together. Synthetic: every vendor, item, price, payee and mailbox here is
// made up (invariant 14). Run from the repo root, then commit the JSON:
//   node fixtures/evals/generate.mjs
//
// A case names `@name` for an id in its world (`@invoice`, `@item:baltic`, `@txn:shell`,
// `@account:Fuel`); the runner fixes each from the case id, so the model's requests replay.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function write(path, dataset) {
  writeFileSync(join(here, path), `${JSON.stringify(dataset, null, 2)}\n`);
}

// ── Invoice review ─────────────────────────────────────────────────────────────────────────────

const CATALOG = {
  baltic: 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB',
  maple: 'MAPLE PLYWOOD 3/4" 4X8 PREFINISHED',
  mdf: 'MDF 5/8" 49X97',
  melamine: 'MELAMINE 3/4" 4X8',
  melblack: 'MELAMINE 3/4" 4X8 BLACK',
  hardboard: "HARDBOARD 4X8",
};
const catalog = (...refs) => refs.map((ref) => ({ ref, name: CATALOG[ref] }));
const line = (ref, qty, unitPrice, extra = {}) => ({
  description: CATALOG[ref] ?? ref,
  qty,
  uom: "SHT",
  unitPrice,
  ...extra,
});
const invoice = (number, lines, extra = {}) => ({ number, date: "2026-11-02", lines, ...extra });
const AP = { name: "Accounts payable", email: "ap@golden-millwork.example" };
const PRICING = { name: "Pricing desk", email: "pricing@golden-millwork.example" };
const apParams = (more = {}) => ({
  "materials.invoice-review": { ap_email: AP.email, ...more },
});

/** The writes every reviewed invoice makes before its matches. */
const readAndRecord = [
  { step: "invoice", expect: { tool: "docs.read", output: { readNow: false } } },
  {
    step: "purchase",
    expect: { tool: "docs.record_purchase", output: { status: "already_linked" } },
  },
];
/** Lines all settled by the rules: their decisions, in order. */
const settled = (...items) => ({
  step: "save-settled",
  expect: {
    tool: "materials.matches.record",
    output: {
      total: items.length,
      matched: items.filter((i) => i !== null).length,
      lines: items.map((i) =>
        i === null
          ? { decision: "new_item" }
          : { decision: "matched", catalogItemId: `@item:${i}` },
      ),
    },
  },
});
/** Prices recorded, per standard unit, in line order. */
const prices = (...unit) => ({
  step: "save-prices",
  expect: {
    tool: "materials.prices.record",
    output: { lines: unit.map((u) => ({ unitPriceStd: u })) },
  },
});
const alert = (kind, severity, dollarImpact) => alerts2([[kind, severity, dollarImpact]]);
const alerts2 = (list) => ({
  step: "save-alerts",
  expect: {
    tool: "materials.prices.check",
    output: {
      alerts: list.map(([kind, severity, dollarImpact]) => ({ kind, severity, dollarImpact })),
    },
  },
});
/** Lines settled after the model answered the open ones: the same record, under `save-open`. */
const matchedByModel = (items) => ({ ...settled(...items), step: "save-open" });
/** Prices with freight spread over the lines: [unit, landed] per line. */
const landed = (...pairs) => ({
  step: "save-prices",
  expect: {
    tool: "materials.prices.record",
    output: { lines: pairs.map(([u, l]) => ({ unitPriceStd: u, landedUnitPriceStd: l })) },
  },
});
const send = (to, subject) => ({
  step: "send-ap",
  expect: { tool: "send_email", input: { to, ...(subject ? { subject } : {}) } },
});

const invoiceCases = [];
const ic = (c) => invoiceCases.push({ tags: [], parameters: {}, answers: [], ...c });

ic({
  id: "clean-two-lines",
  name: "Two lines, both in the catalog, no history: matched by the rules, nothing to send",
  tags: ["rules"],
  trigger: { documentId: "@invoice" },
  world: {
    vendor: "Northline Panel Supply",
    catalog: catalog("baltic", "mdf"),
    invoice: invoice("NPS-1001", [line("baltic", "2", "100.00"), line("mdf", "4", "40.00")]),
  },
  writes: [...readAndRecord, settled("baltic", "mdf"), prices("100.0000", "40.0000")],
});

const NPS = "Northline Panel Supply";
const base = (lines, more = {}) => ({
  vendor: NPS,
  catalog: catalog("baltic", "maple", "mdf", "melamine", "melblack", "hardboard"),
  invoice: invoice("NPS-2001", lines),
  ...more,
});
const hist = (item, unitPrice, date = "2026-10-05", more = {}) => ({
  item,
  date,
  unitPrice,
  ...more,
});
const contract = (items, more = {}) => ({
  name: "Northline 2026 price agreement",
  from: "2026-01-01",
  to: "2026-12-31",
  netDays: 30,
  paymentTerms: "Net 30",
  items: items.map(([item, listPrice]) => ({ item, name: CATALOG[item], listPrice })),
  ...more,
});
const doc = { documentId: "@invoice" };

ic({
  id: "clean-ap-control",
  name: "No findings, AP control: sent to AP saying so",
  tags: ["rules", "handoff"],
  trigger: doc,
  parameters: apParams(),
  world: base([line("baltic", "2", "100.00")], { contacts: [AP] }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("100.0000"),
    send(AP.email, "Invoice NPS-2001 from Northline Panel Supply: no findings"),
  ],
});
ic({
  id: "ap-mailbox-not-an-address",
  name: "AP mailbox that isn't an address: kept, nothing sent",
  tags: ["handoff"],
  trigger: doc,
  parameters: { "materials.invoice-review": { ap_email: "accounts payable" } },
  world: base([line("baltic", "2", "100.00")]),
  writes: [...readAndRecord, settled("baltic"), prices("100.0000")],
});
ic({
  id: "jump-warning",
  name: "8% over the last price: a price jump",
  tags: ["history"],
  trigger: doc,
  world: base([line("baltic", "2", "108.00")], { history: [hist("baltic", "100.00")] }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("108.0000"),
    alert("price_jump", "warning", "24.0000"),
  ],
});
ic({
  id: "jump-critical",
  name: "20% over the last price: a critical jump",
  tags: ["history"],
  trigger: doc,
  world: base([line("baltic", "2", "120.00")], { history: [hist("baltic", "100.00")] }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("120.0000"),
    alert("price_jump", "critical", "60.0000"),
  ],
});
ic({
  id: "within-threshold",
  name: "4% over the last price: under the 5% threshold, no alert",
  tags: ["history"],
  trigger: doc,
  world: base([line("baltic", "2", "104.00")], { history: [hist("baltic", "100.00")] }),
  writes: [...readAndRecord, settled("baltic"), prices("104.0000")],
});
ic({
  id: "price-down",
  name: "Cheaper than last time: no alert",
  tags: ["history"],
  trigger: doc,
  world: base([line("baltic", "2", "90.00")], { history: [hist("baltic", "100.00")] }),
  writes: [...readAndRecord, settled("baltic"), prices("90.0000")],
});
ic({
  id: "over-average",
  name: "Over the 90-day average, not the last price",
  tags: ["history"],
  trigger: doc,
  world: base([line("mdf", "3", "42.40")], {
    history: [hist("mdf", "38.00", "2026-09-20"), hist("mdf", "42.00", "2026-10-20")],
  }),
  writes: [
    ...readAndRecord,
    settled("mdf"),
    prices("42.4000"),
    alert("price_vs_avg", "warning", "12.0000"),
  ],
});
ic({
  id: "vendor-spread",
  name: "Another vendor sold it this month for much less",
  tags: ["history"],
  trigger: doc,
  world: base([line("maple", "2", "100.00")], {
    otherVendors: ["Cascade Hardwoods"],
    history: [hist("maple", "80.00", "2026-11-01", { vendor: "Cascade Hardwoods" })],
  }),
  writes: [
    ...readAndRecord,
    settled("maple"),
    prices("100.0000"),
    alert("vendor_spread", "warning", "40.0000"),
  ],
});
ic({
  id: "jump-with-ap",
  name: "A price jump, AP control: sent with the finding",
  tags: ["history", "handoff"],
  trigger: doc,
  parameters: apParams(),
  world: base([line("baltic", "2", "112.00")], {
    history: [hist("baltic", "100.00")],
    contacts: [AP],
  }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("112.0000"),
    alert("price_jump", "warning", "36.0000"),
    send(AP.email, "Invoice NPS-2001 from Northline Panel Supply: 1 finding, $36.00 at stake"),
  ],
});
ic({
  id: "contract-above",
  name: "Billed over the contract price",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "2", "110.00")], { contract: contract([["baltic", "100.00"]]) }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("110.0000"),
    alert("above_contract", "warning", "20.0000"),
  ],
});
ic({
  id: "contract-below",
  name: "Billed under the contract price: noted",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "2", "95.00")], { contract: contract([["baltic", "100.00"]]) }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("95.0000"),
    alert("below_contract", "info", "-10.0000"),
  ],
});
ic({
  id: "contract-exact",
  name: "Billed at the contract price",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "2", "100.00")], { contract: contract([["baltic", "100.00"]]) }),
  writes: [...readAndRecord, settled("baltic"), prices("100.0000")],
});
ic({
  id: "contract-cents",
  name: "A cent over the contract price",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "2", "100.01")], { contract: contract([["baltic", "100.00"]]) }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("100.0100"),
    alert("above_contract", "warning", "0.0200"),
  ],
});
ic({
  id: "not-on-contract",
  name: "A line the contract doesn't list",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "2", "100.00"), line("mdf", "2", "40.00")], {
    contract: contract([["baltic", "100.00"]]),
  }),
  writes: [
    ...readAndRecord,
    settled("baltic", "mdf"),
    prices("100.0000", "40.0000"),
    alert("not_on_contract", "info", null),
  ],
});
ic({
  id: "contract-expired",
  name: "The contract ended before the invoice",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "2", "100.00")], {
    contract: contract([["baltic", "100.00"]], { from: "2025-01-01", to: "2025-12-31" }),
  }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("100.0000"),
    alert("contract_not_in_effect", "warning", null),
  ],
});
ic({
  id: "terms-mismatch",
  name: "The invoice's terms aren't the contract's",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "2", "100.00")], {
    contract: contract([["baltic", "100.00"]]),
    invoice: invoice("NPS-2001", [line("baltic", "2", "100.00")], { paymentTerms: "Net 15" }),
  }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("100.0000"),
    alert("terms_mismatch", "warning", null),
  ],
});
ic({
  id: "contract-two-lines",
  name: "Two contract lines, one over",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "2", "100.00"), line("maple", "3", "79.00")], {
    contract: contract([
      ["baltic", "100.00"],
      ["maple", "75.00"],
    ]),
  }),
  writes: [
    ...readAndRecord,
    settled("baltic", "maple"),
    prices("100.0000", "79.0000"),
    alert("above_contract", "warning", "12.0000"),
  ],
});
ic({
  id: "pricing-issue-sent",
  name: "Pricing issues: a finding goes to the pricing desk",
  tags: ["contract", "handoff"],
  trigger: doc,
  parameters: apParams({ handoff: "pricing_issues", pricing_email: PRICING.email }),
  world: base([line("baltic", "2", "110.00")], {
    contract: contract([["baltic", "100.00"]]),
    contacts: [AP, PRICING],
  }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("110.0000"),
    alert("above_contract", "warning", "20.0000"),
    send(PRICING.email, "Invoice NPS-2001 from Northline Panel Supply: 1 finding, $20.00 at stake"),
  ],
});
ic({
  id: "pricing-issue-none",
  name: "Pricing issues: no finding, nothing sent",
  tags: ["contract", "handoff"],
  trigger: doc,
  parameters: apParams({ handoff: "pricing_issues", pricing_email: PRICING.email }),
  world: base([line("baltic", "2", "100.00")], {
    contract: contract([["baltic", "100.00"]]),
    contacts: [AP, PRICING],
  }),
  writes: [...readAndRecord, settled("baltic"), prices("100.0000")],
});
ic({
  id: "pricing-issue-to-ap",
  name: "Pricing issues with no pricing desk: AP gets it",
  tags: ["contract", "handoff"],
  trigger: doc,
  parameters: apParams({ handoff: "pricing_issues" }),
  world: base([line("baltic", "2", "110.00")], {
    contract: contract([["baltic", "100.00"]]),
    contacts: [AP],
  }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("110.0000"),
    alert("above_contract", "warning", "20.0000"),
    send(AP.email, "Invoice NPS-2001 from Northline Panel Supply: 1 finding, $20.00 at stake"),
  ],
});
const answer = (lineNo, decision, item, confidence = 0.95, hingeAttribute = null) => ({
  lineNo,
  decision,
  catalogItemId: item ? `@item:${item}` : null,
  confidence,
  hingeAttribute,
});
ic({
  id: "six-lines",
  name: "Six lines: five by the rules, the hardboard (no thickness) by the model",
  tags: ["rules", "model"],
  trigger: doc,
  answers: [{ answers: [answer(6, "matched", "hardboard")] }],
  world: base([
    line("baltic", "2", "100.00"),
    line("maple", "1", "80.00"),
    line("mdf", "4", "40.00"),
    line("melamine", "3", "45.00"),
    line("melblack", "1", "52.00"),
    line("hardboard", "5", "18.00"),
  ]),
  writes: [
    ...readAndRecord,
    matchedByModel(["baltic", "maple", "mdf", "melamine", "melblack", "hardboard"]),
    prices("100.0000", "80.0000", "40.0000", "45.0000", "52.0000", "18.0000"),
  ],
});
ic({
  id: "black-not-plain",
  name: "Black melamine matched to the black sheet, never the plain one",
  tags: ["rules"],
  trigger: doc,
  world: base([line("melblack", "2", "52.00")]),
  writes: [...readAndRecord, settled("melblack"), prices("52.0000")],
});
ic({
  id: "not-in-catalog",
  name: "A line the catalog doesn't have",
  tags: ["new"],
  trigger: doc,
  world: base([line('WHITE OAK PLYWOOD 3/4" 4X8 A1', "2", "140.00")]),
  writes: [...readAndRecord, settled(null), prices("140.0000")],
});
ic({
  id: "freight-billed",
  name: "Freight billed with the lines",
  tags: ["rules"],
  trigger: doc,
  world: base([line("baltic", "4", "100.00")], {
    invoice: invoice("NPS-2001", [line("baltic", "4", "100.00")], { freight: "40.00" }),
    history: [hist("baltic", "100.00")],
  }),
  writes: [...readAndRecord, settled("baltic"), landed(["100.0000", "110.0000"])],
});
ic({
  id: "freight-included-contract",
  name: "Freight billed though the contract includes it",
  tags: ["contract"],
  trigger: doc,
  world: base([line("baltic", "4", "100.00")], {
    invoice: invoice("NPS-2001", [line("baltic", "4", "100.00")], { freight: "40.00" }),
    contract: contract([["baltic", "100.00"]], { freight: "included" }),
  }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    landed(["100.0000", "110.0000"]),
    alert("terms_mismatch", "warning", "40.0000"),
  ],
});
ic({
  id: "large-order",
  name: "A large order at the usual price",
  tags: ["history"],
  trigger: doc,
  world: base([line("mdf", "120", "40.00")], { history: [hist("mdf", "40.00")] }),
  writes: [...readAndRecord, settled("mdf"), prices("40.0000")],
});
ic({
  id: "jump-and-spread",
  name: "Up on last time and dearer than another vendor",
  tags: ["history"],
  trigger: doc,
  world: base([line("maple", "2", "100.00")], {
    otherVendors: ["Cascade Hardwoods"],
    history: [
      hist("maple", "85.00", "2026-10-01"),
      hist("maple", "80.00", "2026-11-01", { vendor: "Cascade Hardwoods" }),
    ],
  }),
  writes: [
    ...readAndRecord,
    settled("maple"),
    prices("100.0000"),
    alerts2([
      ["price_jump", "critical", "45.0000"],
      ["vendor_spread", "warning", "40.0000"],
    ]),
  ],
});
ic({
  id: "contract-and-history",
  name: "On contract and steady against history",
  tags: ["contract", "history"],
  trigger: doc,
  world: base([line("baltic", "2", "100.00")], {
    history: [hist("baltic", "100.00")],
    contract: contract([["baltic", "100.00"]]),
  }),
  writes: [...readAndRecord, settled("baltic"), prices("100.0000")],
});
ic({
  id: "mixed-catalog-and-new",
  name: "One line in the catalog, one not",
  tags: ["new"],
  trigger: doc,
  world: base([line("baltic", "2", "100.00"), line('WALNUT PLYWOOD 3/4" 4X8 A1', "1", "210.00")]),
  writes: [...readAndRecord, settled("baltic", null), prices("100.0000", "210.0000")],
});
ic({
  id: "sku-line",
  name: "A line with the vendor's sku",
  tags: ["rules"],
  trigger: doc,
  world: base([line("mdf", "6", "40.00", { sku: "MDF58-4997" })]),
  writes: [...readAndRecord, settled("mdf"), prices("40.0000")],
});
ic({
  id: "ap-control-contract-finding",
  name: "AP control with a contract finding: sent with it",
  tags: ["contract", "handoff"],
  trigger: doc,
  parameters: apParams(),
  world: base([line("baltic", "2", "110.00")], {
    contract: contract([["baltic", "100.00"]]),
    contacts: [AP],
  }),
  writes: [
    ...readAndRecord,
    settled("baltic"),
    prices("110.0000"),
    alert("above_contract", "warning", "20.0000"),
    send(AP.email, "Invoice NPS-2001 from Northline Panel Supply: 1 finding, $20.00 at stake"),
  ],
});

ic({
  id: "model-match",
  name: "A line without its thickness, matched by the model",
  tags: ["model"],
  trigger: doc,
  answers: [{ answers: [answer(1, "matched", "hardboard")] }],
  world: base([line("hardboard", "10", "18.00")]),
  writes: [...readAndRecord, matchedByModel(["hardboard"]), prices("18.0000")],
});
ic({
  id: "model-unsure",
  name: "The model unsure: a person decides",
  tags: ["model"],
  trigger: doc,
  answers: [{ answers: [answer(1, "unsure", null, 0.4, "thickness")] }],
  world: base([line("hardboard", "10", "18.00")]),
  writes: [...readAndRecord],
});
ic({
  id: "model-low-confidence",
  name: "A match below the threshold: a person decides",
  tags: ["model"],
  trigger: doc,
  answers: [{ answers: [answer(1, "matched", "hardboard", 0.6)] }],
  world: base([line("hardboard", "10", "18.00")]),
  writes: [...readAndRecord],
});
ic({
  id: "model-new-item",
  name: "The model says it's new though the catalog has it: vetoed",
  tags: ["model", "veto"],
  trigger: doc,
  answers: [{ answers: [answer(1, "new_item", null, 0.9)] }],
  world: base([line("hardboard", "10", "18.00")]),
  writes: [...readAndRecord],
});
ic({
  id: "model-picks-black",
  name: "Black melamine without a thickness: the model picks the black sheet",
  tags: ["model"],
  trigger: doc,
  answers: [{ answers: [answer(1, "matched", "melblack")] }],
  world: base([line("MELAMINE 4X8 BLACK", "3", "52.00")]),
  writes: [...readAndRecord, matchedByModel(["melblack"]), prices("52.0000")],
});
ic({
  id: "model-vetoed",
  name: "Melamine matched by the model to maple plywood: the rules veto it",
  tags: ["model", "veto"],
  trigger: doc,
  answers: [{ answers: [answer(1, "matched", "maple")] }],
  world: base([line("MELAMINE 4X8 BLACK", "3", "52.00")]),
  writes: [...readAndRecord],
});
ic({
  id: "model-match-with-history",
  name: "Matched by the model, then a price jump on its history",
  tags: ["model", "history"],
  trigger: doc,
  answers: [{ answers: [answer(1, "matched", "hardboard")] }],
  world: base([line("hardboard", "10", "21.00")], { history: [hist("hardboard", "18.00")] }),
  writes: [
    ...readAndRecord,
    matchedByModel(["hardboard"]),
    prices("21.0000"),
    alert("price_jump", "critical", "33.0000"),
  ],
});

write("vendor-contracts/invoice-review.json", {
  schemaVersion: 1,
  template: "vendor-contracts",
  workflow: "invoice-review",
  description:
    "Vendor contracts and invoice review: an invoice read and recorded, its lines matched to the catalog (rules first, the model for the rest, the hard rules vetoing it), its prices checked against history and the vendor's contract, the review notes, and the hand-off to accounts payable.",
  cases: invoiceCases,
});
