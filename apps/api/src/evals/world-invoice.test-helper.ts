// docs/plan.md §1.212: the invoice review's golden world. A vendor's invoice already read (its
// reading, as Read document leaves it) and already a purchase (as a bill synced from the client's
// tool is), the client's catalog, the prices it paid before (from this vendor and others), the
// vendor's contract with its agreed prices, and the directory's mailboxes. Every id is fixed by the
// case (`ctx.id`), so the model's requests replay. Synthetic only (invariant 14).

import { createHash } from "node:crypto";
import { Decimal } from "@countersign/core";
import { docExtraction, docLine, document, transaction, vendor } from "@countersign/db";
import {
  catalogItem,
  parseLine,
  priceObservation,
  STANDARD_UOMS,
  vendorContract,
  vendorItem,
} from "@countersign/pack-materials";
import { z } from "zod";
import { addContact, setUpEmail, type WorldContext } from "./golden.test-helper";

const Money = z.string().regex(/^-?\d+(\.\d+)?$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const InvoiceWorld = z.strictObject({
  vendor: z.string().min(1),
  /** Other vendors the client buys from (for prices across vendors). */
  otherVendors: z.array(z.string().min(1)).default([]),
  /** The catalog: `@item:<ref>` in a case is the item's id. */
  catalog: z
    .array(
      z.strictObject({
        ref: z.string().min(1),
        name: z.string().min(1),
        uom: z.enum(STANDARD_UOMS).optional(),
      }),
    )
    .default([]),
  /** Prices paid before, per standard unit (from `vendor` unless named). */
  history: z
    .array(
      z.strictObject({
        item: z.string(),
        vendor: z.string().optional(),
        date: Day,
        unitPrice: Money,
        qty: Money.default("1"),
      }),
    )
    .default([]),
  contract: z
    .strictObject({
      name: z.string(),
      from: Day,
      to: Day.nullable().default(null),
      paymentTerms: z.string().optional(),
      netDays: z.number().int().optional(),
      earlyPayDiscountPct: z.string().optional(),
      earlyPayDays: z.number().int().optional(),
      freight: z.enum(["included", "charged", "unknown"]).default("unknown"),
      items: z.array(
        z.strictObject({
          item: z.string(),
          name: z.string(),
          sku: z.string().optional(),
          vendorUom: z.string().optional(),
          listPrice: Money,
        }),
      ),
    })
    .optional(),
  /** Mailboxes in the directory, each agreed to email. */
  contacts: z.array(z.strictObject({ name: z.string(), email: z.string() })).default([]),
  invoice: z.strictObject({
    number: z.string(),
    date: Day,
    dueDate: Day.optional(),
    paymentTerms: z.string().optional(),
    freight: Money.default("0"),
    tax: Money.default("0"),
    lines: z
      .array(
        z.strictObject({
          description: z.string(),
          sku: z.string().optional(),
          qty: Money,
          uom: z.string().optional(),
          unitPrice: Money,
        }),
      )
      .min(1),
  }),
});
export type InvoiceWorld = z.infer<typeof InvoiceWorld>;

export async function seedInvoice(ctx: WorldContext, raw: unknown): Promise<void> {
  const w = InvoiceWorld.parse(raw);
  const db = ctx.H.t.db;
  const tenantId = ctx.tenantId;
  const vendorIds = new Map<string, string>();
  for (const name of [w.vendor, ...w.otherVendors]) {
    const id = ctx.id(name === w.vendor ? "vendor" : `vendor:${name}`);
    await db.insert(vendor).values({
      id,
      tenantId,
      name,
      normalizedName: name.toLowerCase().replace(/[^a-z0-9 ]/g, ""),
    });
    vendorIds.set(name, id);
  }
  const uoms = new Map<string, string>();
  for (const item of w.catalog) {
    const p = parseLine(item.name);
    const uom = item.uom ?? p.standardUom;
    uoms.set(item.ref, uom);
    await db.insert(catalogItem).values({
      id: ctx.id(`item:${item.ref}`),
      tenantId,
      category: p.category,
      canonicalName: item.name,
      attributes: p.attributes,
      standardUom: uom,
    } as never);
  }
  const itemId = (ref: string) => {
    if (!uoms.has(ref)) throw new Error(`no catalog item ${ref}`);
    return ctx.id(`item:${ref}`);
  };
  for (const [i, h] of w.history.entries()) {
    await db.insert(priceObservation).values({
      id: ctx.id(`history:${i}`),
      tenantId,
      catalogItemId: itemId(h.item),
      vendorId: vendorIds.get(h.vendor ?? w.vendor) as string,
      observedOn: h.date,
      unitPriceStd: h.unitPrice,
      qtyStd: h.qty,
      standardUom: uoms.get(h.item),
    } as never);
  }
  if (w.contract) {
    const k = w.contract;
    const contractId = ctx.id("contract");
    await db.insert(vendorContract).values({
      id: contractId,
      tenantId,
      vendorId: ctx.id("vendor"),
      name: k.name,
      effectiveFrom: k.from,
      effectiveTo: k.to,
      paymentTerms: k.paymentTerms ?? null,
      netDays: k.netDays ?? null,
      earlyPayDiscountPct: k.earlyPayDiscountPct ?? null,
      earlyPayDays: k.earlyPayDays ?? null,
      freight: k.freight,
    } as never);
    for (const it of k.items) {
      await db.insert(vendorItem).values({
        id: ctx.id(`vendor-item:${it.item}`),
        tenantId,
        vendorId: ctx.id("vendor"),
        catalogItemId: itemId(it.item),
        sku: it.sku ?? null,
        name: it.name,
        vendorUom: it.vendorUom ?? null,
        listPrice: it.listPrice,
        listPriceOn: k.from,
        contractId,
      } as never);
    }
  }
  if (w.contacts.length > 0) await setUpEmail(ctx);
  for (const c of w.contacts) await addContact(ctx, c.name, c.email);

  // The invoice: its purchase, its document and its reading.
  const inv = w.invoice;
  const ext = inv.lines.map((l) => new Decimal(l.qty).times(l.unitPrice));
  const subtotal = ext.reduce((s, x) => s.plus(x), new Decimal(0));
  const total = subtotal.plus(inv.freight).plus(inv.tax);
  await db.insert(transaction).values({
    id: ctx.id("bill"),
    tenantId,
    kind: "bill",
    connector: "upload",
    vendorId: ctx.id("vendor"),
    txnDate: inv.date,
    total: total.toFixed(4),
    externalId: `golden-${ctx.caseId}`,
  });
  const sha = createHash("sha256").update(`golden ${ctx.caseId}`).digest("hex");
  await db.insert(document).values({
    id: ctx.id("invoice"),
    tenantId,
    transactionId: ctx.id("bill"),
    source: "upload",
    storageKey: `tenants/${tenantId}/content/${sha.slice(0, 2)}/${sha}`,
    mimeType: "application/pdf",
    filename: `${inv.number}.pdf`,
    sizeBytes: 1000,
    sha256: sha,
  });
  await db.insert(docExtraction).values({
    id: ctx.id("reading"),
    tenantId,
    documentId: ctx.id("invoice"),
    model: "golden",
    header: {
      vendorName: w.vendor,
      invoiceNumber: inv.number,
      invoiceDate: inv.date,
      ...(inv.dueDate ? { dueDate: inv.dueDate } : {}),
      ...(inv.paymentTerms ? { paymentTerms: inv.paymentTerms } : {}),
    },
    subtotal: subtotal.toFixed(4),
    freight: inv.freight,
    tax: inv.tax,
    total: total.toFixed(4),
    linesSum: subtotal.toFixed(4),
    totalsMatch: true,
  });
  for (const [i, l] of inv.lines.entries()) {
    await db.insert(docLine).values({
      id: ctx.id(`line${i + 1}`),
      tenantId,
      extractionId: ctx.id("reading"),
      lineNo: i + 1,
      vendorSku: l.sku ?? null,
      rawDescription: l.description,
      qty: l.qty,
      uomRaw: l.uom ?? null,
      unitPrice: l.unitPrice,
      extPrice: (ext[i] as Decimal).toFixed(4),
    });
  }
}
