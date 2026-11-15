// The Purchasing area's contract tools (docs/plan.md §1.104): read a vendor's contracts and their
// agreed prices (`none`), save a contract and its prices (`internal`, Save to records), and lay out
// an invoice's review notes for accounts payable (`none`). None writes to a client's tool; the
// email to AP is the process's own write step (approval on, invariant 8).

import { dec, formatAmount } from "@countersign/core";
import { withTenant } from "@countersign/db";
import { z } from "zod";
import { contractOn } from "../pricing/contract";
import { loadPricedDocument, priceLines } from "../pricing/record";
import { FREIGHT_TERMS } from "../schema";
import { defineTool, type PackTool } from "../tools";
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

// ── The review notes for accounts payable ───────────────────────────────────────────────────────

/** A finding as the price and contract check gives it (`materials.prices.compare`'s alerts). */
const FindingIn = z.object({
  kind: z.string(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  dollarImpact: z.string().nullable(),
  evidence: z.array(z.string()).default([]),
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The AP mailbox from the skill's parameter (`ap_email`), when it is an address. */
export function apEmailOf(settings: Readonly<Record<string, unknown>>): string | null {
  const v = typeof settings.ap_email === "string" ? settings.ap_email.trim() : "";
  return EMAIL.test(v) && v.length <= 320 ? v : null;
}

const money = (v: string, currency: string) =>
  currency === "USD" ? `$${formatAmount(v)}` : `${formatAmount(v)} ${currency}`;

/** The invoice's review notes: what was checked, what was found, what wasn't checked. */
export const invoiceReview = defineTool({
  id: "materials.invoice.review",
  description:
    "Lays out an invoice's review notes for accounts payable: the invoice (vendor, number, dates, total), the contract it was checked against, each finding of the price and contract check with its dollars, and the lines that couldn't be checked; with the email's subject and body, the invoice to attach, and the AP mailbox from the skill's `ap_email`. Writes nothing.",
  sideEffect: "none",
  summary: "{{findings}} findings on invoice {{invoiceNumber}}",
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
    findings: z.number().int(),
    dollarImpact: z.string(),
    unchecked: z.number().int(),
    subject: z.string(),
    body: z.string(),
    attachments: z.array(z.object({ documentId: z.string() })),
    apEmail: z.string().nullable(),
    hasApEmail: z.boolean(),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const doc = await loadPricedDocument(tx, ctx.tenantId, input.documentId, {
        testRun: ctx.mode === "test",
      });
      const { lines } = await priceLines(tx, ctx.tenantId, doc);
      const total = doc.total;
      const contracts = await vendorContracts(tx, ctx.tenantId, doc.vendorId);
      const contract = contractOn(contracts, doc.observedOn);
      const findings = input.findings;
      const atStake = findings.reduce(
        (s, f) => (f.dollarImpact ? s.plus(f.dollarImpact) : s),
        dec("0"),
      );
      const unchecked = lines.filter((l) => l.skipped !== null);
      const number = doc.terms.invoiceNumber;
      const cur = doc.currency;
      const subject = `Invoice ${number ?? ""} from ${doc.vendorName}: ${
        findings.length === 0
          ? "no findings"
          : `${findings.length} finding${findings.length === 1 ? "" : "s"}${
              atStake.greaterThan(0) ? `, ${money(atStake.toFixed(2), cur)} at stake` : ""
            }`
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
        findings.length === 0
          ? "Findings: none."
          : [
              `Findings (${findings.length}${atStake.greaterThan(0) ? `, ${money(atStake.toFixed(2), cur)} at stake` : ""}):`,
              ...findings.map((f) => `- ${f.title}. ${f.body}`),
            ].join("\n"),
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
      return {
        documentId: doc.documentId,
        vendorId: doc.vendorId,
        vendorName: doc.vendorName,
        invoiceNumber: number,
        invoiceDate: doc.observedOn,
        total,
        currency: cur,
        contractId: contract?.id ?? null,
        findings: findings.length,
        dollarImpact: atStake.toFixed(2),
        unchecked: unchecked.length,
        subject: subject.slice(0, 200),
        body: body.slice(0, 20_000),
        attachments: [{ documentId: doc.documentId }],
        apEmail,
        hasApEmail: apEmail !== null,
        sources: [
          ...new Set([
            doc.documentId,
            doc.extractionId,
            ...(contract ? [contract.id] : []),
            ...findings.flatMap((f) => f.evidence),
          ]),
        ],
      };
    }),
});

export const CONTRACT_TOOLS: readonly PackTool[] = [contractGet, contractSave, invoiceReview];
