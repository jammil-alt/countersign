// The Purchasing area's contract tools (docs/plan.md §1.104): read a vendor's contracts and their
// agreed prices (`none`), save a contract and its prices (`internal`, Save to records), and lay out
// an invoice's review notes for accounts payable (`none`). None writes to a client's tool; the
// email to AP is the process's own write step (approval on, invariant 8).

import { dec } from "@countersign/core";
import { withTenant } from "@countersign/db";
import { z } from "zod";
import { contractCheckFor } from "../pricing/check";
import { contractOn } from "../pricing/contract";
import { loadPricedDocument, priceLines } from "../pricing/record";
import { moneyIn } from "../pricing/rules";
import { FREIGHT_TERMS } from "../schema";
import { defineTool, type PackTool } from "../tools";
import {
  readTolerance,
  setTolerance,
  VendorItemError,
  vendorItemById,
  vendorItemView,
} from "../vendor/store";
import { agreedPrices, contractTerms, saveContract, vendorContracts } from "./store";

const Uuid = z.uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, yyyy-mm-dd");
const Money = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'a decimal string, e.g. "62.50"');

/** A contract's terms, as the contract reading and a person give them. */
export const ContractIn = z.object({
  name: z.string().trim().min(1).max(300),
  effectiveFrom: Day,
  effectiveTo: Day.nullable().optional(),
  paymentTerms: z.string().max(300).nullable().optional(),
  netDays: z.number().int().min(0).max(365).nullable().optional(),
  earlyPayDiscountPct: z
    .string()
    .regex(/^\d{1,2}(\.\d{1,2})?$/, 'a percent, e.g. "2" or "1.5"')
    .nullable()
    .optional(),
  earlyPayDays: z.number().int().min(0).max(365).nullable().optional(),
  freight: z.enum(FREIGHT_TERMS).optional(),
  minOrderAmount: Money.nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
});

/** One item and its agreed price, as a price list row (the vendor's own words). */
export const ContractItemIn = z.object({
  sku: z.string().max(100).nullable().optional(),
  name: z.string().max(500).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  packSize: z.string().max(100).nullable().optional(),
  vendorUom: z.string().max(40).nullable().optional(),
  stdPerVendorUom: z.string().max(20).nullable().optional(),
  minOrderQty: z.string().max(20).nullable().optional(),
  listPrice: z.string().max(20).nullable().optional(),
  catalogItemId: z.string().max(40).nullable().optional(),
  // §1.104 (0052): the client's tolerance on this price (an amount in the same unit, a percent).
  priceToleranceAmount: z.string().max(20).nullable().optional(),
  priceTolerancePct: z.string().max(20).nullable().optional(),
});

const ContractOut = z.object({
  id: z.string(),
  vendorId: z.string(),
  name: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  netDays: z.number().nullable(),
  earlyPayDiscountPct: z.string().nullable(),
  earlyPayDays: z.number().nullable(),
  freight: z.string(),
  minOrderAmount: z.string().nullable(),
  currency: z.string(),
  documentId: z.string().nullable(),
  sources: z.array(z.string()),
});

/** A vendor's contracts, the one in effect on a day, and its agreed prices. */
export const contractGet = defineTool({
  id: "materials.contract.get",
  entity: "contract",
  description:
    "A vendor's contracts with the client (dates, payment terms, early-pay discount, freight, minimum order), the one in effect on a day (default today), and its agreed item prices in the vendor's units.",
  sideEffect: "none",
  summary: "{{contracts.length}} contracts; {{prices.length}} agreed prices",
  input: z.object({ vendorId: Uuid, on: Day.optional() }),
  output: z.object({
    contracts: z.array(ContractOut),
    inEffect: ContractOut.nullable(),
    prices: z.array(
      z.object({
        vendorItemId: z.string(),
        catalogItemId: z.string(),
        sku: z.string().nullable(),
        name: z.string(),
        price: z.string(),
        vendorUom: z.string().nullable(),
        toleranceAmount: z.string().nullable(),
        tolerancePct: z.string().nullable(),
        currency: z.string(),
      }),
    ),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const contracts = await vendorContracts(tx, ctx.tenantId, input.vendorId);
      const inEffect = contractOn(contracts, input.on ?? new Date().toISOString().slice(0, 10));
      const prices = inEffect ? await agreedPrices(tx, ctx.tenantId, [inEffect.id]) : [];
      return {
        contracts,
        inEffect,
        prices: prices.map((p) => ({
          vendorItemId: p.vendorItemId,
          catalogItemId: p.catalogItemId,
          sku: p.sku,
          name: p.name,
          price: p.price,
          vendorUom: p.vendorUom,
          toleranceAmount: p.toleranceAmount ?? null,
          tolerancePct: p.tolerancePct ?? null,
          currency: p.currency,
        })),
        sources: [...contracts.map((c) => c.id), ...prices.map((p) => p.vendorItemId)],
      };
    }),
});

class RollBack extends Error {
  constructor(readonly result: unknown) {
    super("test run: rolled back");
  }
}

/** Save to records: a vendor's contract and its agreed prices. */
export const contractSave = defineTool({
  id: "materials.contract.save",
  entity: "contract",
  description:
    "Saves a vendor's contract or agreed price sheet: its terms (dates, payment terms, early-pay discount, freight, minimum order, the signed document) and its item prices into the vendor's catalog, each an agreed price dated the contract's start. The vendor by id, else by name (added when new). Saving the same vendor and start date again updates it. A row no master item is known for is listed as unplaced. A test run saves nothing.",
  sideEffect: "internal",
  summary: "Saved {{contract.name}}: {{prices.updated}} prices updated, {{prices.created}} added",
  input: z
    .object({
      vendorId: Uuid.optional(),
      vendorName: z.string().trim().min(1).max(500).optional(),
      documentId: Uuid.nullable().optional(),
      contract: ContractIn,
      items: z.array(ContractItemIn).max(5000).default([]),
      sources: z.array(z.string().max(100)).max(50).optional(),
    })
    .refine((v) => v.vendorId !== undefined || v.vendorName !== undefined, {
      message: "name the vendor: vendorId or vendorName",
    }),
  output: z.object({
    contract: ContractOut,
    created: z.boolean(),
    vendorId: z.string(),
    vendorName: z.string(),
    vendorCreated: z.boolean(),
    prices: z.object({
      updated: z.number().int(),
      created: z.number().int(),
      unplaced: z.number().int(),
      skipped: z.number().int(),
      rows: z.array(
        z.object({
          rowNo: z.number().int(),
          sku: z.string().nullable(),
          name: z.string().nullable(),
          outcome: z.enum(["updated", "created", "unplaced", "skipped"]),
          vendorItemId: z.string().nullable(),
          catalogItemId: z.string().nullable(),
          reason: z.string().nullable(),
        }),
      ),
    }),
    vendorItemIds: z.array(z.string()),
    testRun: z.boolean(),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const testRun = ctx.mode === "test";
    const work = () =>
      withTenant(ctx.db, ctx.tenantId, async (tx) => {
        const saved = await saveContract(tx, {
          tenantId: ctx.tenantId,
          vendorId: input.vendorId,
          vendorName: input.vendorName,
          documentId: input.documentId ?? null,
          contract: input.contract,
          items: input.items,
          sources: input.sources,
          by: { agentVersionId: ctx.agentVersionId },
        });
        const out = {
          contract: contractTerms(saved.contract),
          created: saved.created,
          vendorId: saved.vendorId,
          vendorName: saved.vendorName,
          vendorCreated: saved.vendorCreated,
          prices: {
            updated: saved.prices.updated,
            created: saved.prices.created,
            unplaced: saved.prices.unplaced,
            skipped: saved.prices.skipped,
            rows: saved.prices.rows,
          },
          vendorItemIds: saved.prices.vendorItemIds,
          testRun,
          sources: [
            saved.contract.id,
            ...(input.documentId ? [input.documentId] : []),
            ...saved.prices.rows.flatMap((r) => (r.vendorItemId ? [r.vendorItemId] : [])),
          ],
        };
        // A test run does the work and rolls it back, answering what it would have saved.
        if (testRun) throw new RollBack(out);
        return out;
      });
    try {
      return await work();
    } catch (error) {
      if (error instanceof RollBack) return error.result as Awaited<ReturnType<typeof work>>;
      throw error;
    }
  },
});

// ── A vendor item's tolerance ─────────────────────────────────────────────────────────────────

/** Save to records: the client's tolerance on one vendor item's agreed price. */
export const vendorItemSetTolerance = defineTool({
  id: "materials.vendor_item.set_tolerance",
  description:
    "Sets the client's tolerance on one vendor item's agreed price: an amount in the vendor's unit, a percent of the price, or both (the larger allowance holds); empty clears one. A variance within it is noted as within tolerance; outside it, as a variance.",
  sideEffect: "internal",
  entity: "vendor_item",
  verb: "update",
  summary: "Set the tolerance on {{item.name}}",
  input: z.object({
    vendorItemId: Uuid,
    amount: z.string().max(20).nullable(),
    pct: z.string().max(20).nullable(),
  }),
  output: z.object({
    item: z.object({
      id: z.string(),
      name: z.string(),
      listPrice: z.string().nullable(),
      vendorUom: z.string().nullable(),
      contractId: z.string().nullable(),
      priceToleranceAmount: z.string().nullable(),
      priceTolerancePct: z.string().nullable(),
    }),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const values = {
        amount: readTolerance(input.amount, "amount"),
        pct: readTolerance(input.pct, "pct"),
      };
      // A test run says what it would set and changes nothing.
      const row =
        ctx.mode === "test"
          ? await vendorItemById(tx, ctx.tenantId, input.vendorItemId)
          : await setTolerance(tx, ctx.tenantId, input.vendorItemId, values, {
              agentVersionId: ctx.agentVersionId,
            });
      if (!row)
        throw new VendorItemError("not_found", `vendor item ${input.vendorItemId} not found`);
      return {
        item: {
          ...vendorItemView(row),
          ...(ctx.mode === "test"
            ? { priceToleranceAmount: values.amount, priceTolerancePct: values.pct }
            : {}),
        },
        sources: [row.id],
      };
    }),
});

// ── The review notes, and who they go to ────────────────────────────────────────────────────────

/** A finding as the price and contract check gives it (`materials.prices.compare`'s alerts). */
const FindingIn = z.object({
  kind: z.string(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  dollarImpact: z.string().nullable(),
  evidence: z.array(z.string()).default([]),
});

// Domain labels hold no dot, so the pattern can match only one way (no slow backtracking).
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const emailOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length <= 320 && EMAIL.test(s) ? s : null;
};

/** The AP mailbox from the skill's parameter (`ap_email`), when it is an address. */
export function apEmailOf(settings: Readonly<Record<string, unknown>>): string | null {
  return emailOf(settings.ap_email);
}

/** How the review is handed off (the skill's `handoff` parameter). */
export const HANDOFFS = ["ap_control", "pricing_issues"] as const;
export type Handoff = (typeof HANDOFFS)[number];

// DECISION (owner, 2026-11-15): "AP control" (the default) sends every invoice to AP with its
// notes, "no findings" included; "Pricing issues" sends only an invoice with a finding outside
// tolerance, to `pricing_email` (else the AP mailbox), and the rest are noted only. A value that
// is neither reads as AP control: the safer way, every invoice still reaches AP.
export function handoffOf(settings: Readonly<Record<string, unknown>>): Handoff {
  return settings.handoff === "pricing_issues" ? "pricing_issues" : "ap_control";
}

/** A finding that is only a note: a variance within the item's tolerance. */
const isNote = (f: { kind: string }) => f.kind === "within_tolerance";

// One money format with the alerts' (`moneyIn`): `$12.50`, or `CAD 12.50`.
const money = (v: string, currency: string) => moneyIn(v, currency);

/** The invoice's review notes: what was checked, what was found, what wasn't checked. */
export const invoiceReview = defineTool({
  id: "materials.invoice.review",
  description:
    "Lays out an invoice's review notes: the invoice (vendor, number, dates, total), the contract it was checked against, each finding of the price and contract check with its dollars, the variances within tolerance, and the lines that couldn't be checked; with the email's subject and body, the invoice to attach, and the hand-off: whether to send it and to whom, from the skill's `handoff` (ap_control: every invoice to `ap_email`; pricing_issues: only invoices with a finding outside tolerance, to `pricing_email`, else `ap_email`). Writes nothing.",
  sideEffect: "none",
  summary: "{{issues}} findings on invoice {{invoiceNumber}}",
  input: z.object({
    documentId: Uuid,
    findings: z.array(FindingIn).max(200).default([]),
  }),
  output: z.object({
    documentId: z.string(),
    vendorId: z.string(),
    vendorName: z.string(),
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string(),
    total: z.string(),
    currency: z.string(),
    contractId: z.string().nullable(),
    /** Every finding, the notes within tolerance included. */
    findings: z.number().int(),
    /** Findings outside tolerance. */
    issues: z.number().int(),
    withinTolerance: z.number().int(),
    /** At stake: the positive dollar impacts of the findings outside tolerance. */
    dollarImpact: z.string(),
    /** Paid below the agreed prices, outside tolerance (a positive amount). */
    savings: z.string(),
    unchecked: z.number().int(),
    subject: z.string(),
    body: z.string(),
    attachments: z.array(z.object({ documentId: z.string() })),
    handoff: z.enum(HANDOFFS),
    /** Whether the hand-off step sends it, and to whom. */
    send: z.boolean(),
    to: z.string().nullable(),
    /** It should go, but no mailbox is set for it. */
    missingMailbox: z.boolean(),
    reason: z.string(),
    apEmail: z.string().nullable(),
    hasApEmail: z.boolean(),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const doc = await loadPricedDocument(tx, ctx.tenantId, input.documentId, {
        testRun: ctx.mode === "test",
      });
      const { drafts, lines } = await priceLines(tx, ctx.tenantId, doc);
      const total = doc.total;
      const contracts = await vendorContracts(tx, ctx.tenantId, doc.vendorId);
      const contract = contractOn(contracts, doc.observedOn);
      const issues = input.findings.filter((f) => !isNote(f));
      const notes = input.findings.filter(isNote);
      const impacts = issues.flatMap((f) => (f.dollarImpact ? [dec(f.dollarImpact)] : []));
      const atStake = impacts.filter((d) => d.greaterThan(0)).reduce((a, b) => a.plus(b), dec("0"));
      const savings = impacts
        .filter((d) => d.lessThan(0))
        .reduce((a, b) => a.plus(b.abs()), dec("0"));
      // Lines with no price, and (audit 7.11) priced lines the contract check couldn't compare: an
      // agreed price with no conversion to the line's unit, or a contract in another currency.
      const contractRun = await contractCheckFor(
        tx,
        ctx.tenantId,
        doc,
        drafts.map(({ line: _l, ext: _e, ...o }) => o),
        new Map(drafts.map((d) => [d.docLineId, d.vendorItem?.id ?? null])),
        () => ({ item: "An item", vendor: () => doc.vendorName }),
      );
      const notCompared = new Map(
        (contractRun?.unchecked ?? []).map((u) => [u.docLineId, u.reason]),
      );
      const unchecked = lines.flatMap((l) =>
        l.skipped !== null
          ? [l]
          : notCompared.has(l.docLineId)
            ? [
                {
                  ...l,
                  skipped: `not checked against the contract: ${notCompared.get(l.docLineId)}`,
                },
              ]
            : [],
      );
      const number = doc.terms.invoiceNumber;
      const cur = doc.currency;
      const stake = atStake.greaterThan(0) ? `, ${money(atStake.toFixed(2), cur)} at stake` : "";
      const subject = `Invoice ${number ?? ""} from ${doc.vendorName}: ${
        issues.length === 0
          ? notes.length === 0
            ? "no findings"
            : "no findings outside tolerance"
          : `${issues.length} finding${issues.length === 1 ? "" : "s"}${stake}`
      }`.replace(/\s+/g, " ");
      const terms = contract
        ? [
            contract.netDays !== null ? `net ${contract.netDays}` : null,
            contract.earlyPayDiscountPct !== null
              ? `${dec(contract.earlyPayDiscountPct).toString()}% off within ${contract.earlyPayDays} days`
              : null,
            contract.freight === "included"
              ? "freight included"
              : contract.freight === "charged"
                ? "freight charged"
                : null,
          ].filter(Boolean)
        : [];
      const body = [
        `Invoice ${number ?? "(no number)"} from ${doc.vendorName}, dated ${doc.observedOn}, for ${money(total, cur)}${doc.terms.dueDate ? `, due ${doc.terms.dueDate}` : ""}${doc.terms.paymentTerms ? ` (${doc.terms.paymentTerms})` : ""}.`,
        contract
          ? `We checked it against "${contract.name}" (from ${contract.effectiveFrom}${contract.effectiveTo ? ` to ${contract.effectiveTo}` : ""}${terms.length ? `: ${terms.join(", ")}` : ""}) and against past prices.`
          : contracts.length > 0
            ? "No contract with this vendor holds on the invoice's date; we checked it against past prices."
            : "There is no contract on file for this vendor; we checked it against past prices.",
        "",
        issues.length === 0
          ? "Findings: none."
          : [
              `Findings (${issues.length}${stake}${savings.greaterThan(0) ? `; ${money(savings.toFixed(2), cur)} below the agreed prices` : ""}):`,
              ...issues.map((f) => `- ${f.title}. ${f.body}`),
            ].join("\n"),
        ...(notes.length > 0
          ? [
              "",
              `Within tolerance (${notes.length}):`,
              ...notes.map((f) => `- ${f.title}. ${f.body}`),
            ]
          : []),
        ...(unchecked.length > 0
          ? [
              "",
              `Lines we couldn't check (${unchecked.length}):`,
              ...unchecked.map((l) => `- Line ${l.lineNo}, "${l.description}": ${l.skipped}`),
            ]
          : []),
        "",
        "The invoice is attached. Nothing has been paid or entered in your books.",
      ].join("\n");
      const apEmail = apEmailOf(ctx.settings);
      const handoff = handoffOf(ctx.settings);
      const goes = handoff === "ap_control" || issues.length > 0;
      const to =
        handoff === "pricing_issues" ? (emailOf(ctx.settings.pricing_email) ?? apEmail) : apEmail;
      const reason = !goes
        ? "No finding outside tolerance: noted, not sent (pricing issues only)."
        : to
          ? handoff === "ap_control"
            ? `To accounts payable (${to}).`
            : `A pricing issue: to ${to}.`
          : handoff === "ap_control"
            ? "No AP mailbox is set, so it wasn't sent."
            : "No mailbox for pricing issues is set, so it wasn't sent.";
      return {
        documentId: doc.documentId,
        vendorId: doc.vendorId,
        vendorName: doc.vendorName,
        invoiceNumber: number,
        invoiceDate: doc.observedOn,
        total,
        currency: cur,
        contractId: contract?.id ?? null,
        findings: input.findings.length,
        issues: issues.length,
        withinTolerance: notes.length,
        dollarImpact: atStake.toFixed(2),
        savings: savings.toFixed(2),
        unchecked: unchecked.length,
        subject: subject.slice(0, 200),
        body: body.slice(0, 20_000),
        attachments: [{ documentId: doc.documentId }],
        handoff,
        send: goes && to !== null,
        to: goes ? to : null,
        missingMailbox: goes && to === null,
        reason,
        apEmail,
        hasApEmail: apEmail !== null,
        sources: [
          ...new Set([
            doc.documentId,
            doc.extractionId,
            ...(contract ? [contract.id] : []),
            ...input.findings.flatMap((f) => f.evidence),
          ]),
        ],
      };
    }),
});

export const CONTRACT_TOOLS: readonly PackTool[] = [
  contractGet,
  contractSave,
  invoiceReview,
  // Owner, 2026-11-15: tolerance at an item level.
  vendorItemSetTolerance,
];
