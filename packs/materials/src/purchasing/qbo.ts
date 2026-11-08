// P-9: a purchase order for QuickBooks (docs/plan.md §1.71). Two deterministic steps around the
// QuickBooks connector's own tools, which do every read and write (a write only after approval,
// invariant 8): `vendorQbo` ties one of our vendors to its QuickBooks vendor id (stored, found among
// the vendors `qbo.vendor.query` listed by name, or the new one `qbo.vendor.create` made), kept in
// `vendor.external_refs.qbo`; `poQboLines` turns the chosen quote into `qbo.purchaseorder.create`'s
// input: the QuickBooks vendor, one account line per quoted line, amounts rounded to cents.

import { Decimal, dec } from "@countersign/core";
import { type Db, type Tx, vendor, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { vendorContacts } from "./contacts";
import { poContent } from "./po";
import { type PurchasingContext, PurchasingError } from "./requests";

/** A QuickBooks vendor as `qbo.vendor.query` lists it. */
export interface QboVendorSeen {
  id: string;
  name: string;
  companyName?: string | null | undefined;
  active?: boolean | undefined;
}

/** Case, spacing and punctuation don't make a name another vendor's. */
export function sameVendorName(a: string, b: string): boolean {
  const n = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return n(a) === n(b);
}

async function vendorRow(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx
    .select()
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, id)))
    .limit(1);
  if (!row) throw new PurchasingError("not_found", `vendor ${id} not found`);
  return row;
}

const qboRef = (row: { externalRefs: unknown }) => {
  const v = (row.externalRefs as Record<string, unknown> | null)?.qbo;
  return typeof v === "string" && v.length > 0 ? v : null;
};

export interface VendorQbo {
  vendorId: string;
  vendorName: string;
  qboVendorId: string | null;
  /** How it is known: kept from sync or before, found by name, or given (just created). */
  how: "stored" | "found" | "given" | null;
  /** The name to look for with qbo.vendor.query. */
  searchName: string;
  /** When none was found: the input for qbo.vendor.create (approval on). */
  create: { displayName: string; email?: string } | null;
}

// DECISION: one of our vendors is a QuickBooks vendor by its stored id, else by the one active
// QuickBooks vendor whose display or company name is the same (case, spacing and punctuation
// aside); two such, or none, is not a match: the step goes on to create it, behind approval.
export async function vendorQbo(
  db: Db,
  ctx: PurchasingContext,
  input: {
    vendorId: string;
    qboVendors?: readonly QboVendorSeen[] | undefined;
    qboVendorId?: string | undefined;
  },
): Promise<VendorQbo> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const row = await vendorRow(tx, ctx.tenantId, input.vendorId);
    const stored = qboRef(row);
    const answer = (qboVendorId: string | null, how: VendorQbo["how"]) => ({
      vendorId: row.id,
      vendorName: row.name,
      qboVendorId,
      how,
      searchName: row.name.slice(0, 100),
      create: null,
    });
    const keep = async (qboVendorId: string) => {
      if (ctx.testRun) return;
      await tx
        .update(vendor)
        .set({
          externalRefs: { ...(row.externalRefs as Record<string, unknown>), qbo: qboVendorId },
        })
        .where(and(eq(vendor.tenantId, ctx.tenantId), eq(vendor.id, row.id)));
    };
    if (input.qboVendorId) {
      if (stored && stored !== input.qboVendorId) {
        throw new PurchasingError(
          "invalid",
          `${row.name} is already QuickBooks vendor ${stored}, not ${input.qboVendorId}`,
        );
      }
      if (!stored) await keep(input.qboVendorId);
      return answer(input.qboVendorId, stored ? "stored" : "given");
    }
    if (stored) return answer(stored, "stored");
    const same = (input.qboVendors ?? []).filter(
      (v) =>
        v.active !== false &&
        (sameVendorName(v.name, row.name) ||
          (v.companyName ? sameVendorName(v.companyName, row.name) : false)),
    );
    if (same.length === 1 && same[0]) {
      await keep(same[0].id);
      return answer(same[0].id, "found");
    }
    const [who] = await vendorContacts(tx, ctx.tenantId, [row.id]);
    const email = who?.contacts.find((c) => c.contactId === who.contactId)?.email;
    return {
      ...answer(null, null),
      create: { displayName: row.name.slice(0, 500), ...(email ? { email } : {}) },
    };
  });
}

export interface QboPoInput {
  vendorId: string;
  docNumber: string;
  txnDate: string;
  dueDate?: string;
  currency: string;
  expectedTotal: string;
  memo: string;
  lines: { accountId: string; description: string; amount: string }[];
}

/** Cents, half up (as QuickBooks rounds an amount). */
export const cents = (v: string): string =>
  dec(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

// DECISION: a purchase order's lines go to QuickBooks as account lines on the one expense account
// set for the client agent (skill setting `qbo_account_id`, or the step's `accountId`): catalog
// items carry no QuickBooks item id, so item lines would be a guess. Each line's amount is the
// quoted unit price times the quantity, rounded half up to cents; the total is the lines' sum.
export async function poQboLines(
  db: Db,
  ctx: PurchasingContext,
  input: {
    requestId: string;
    quoteRequestId: string;
    accountId: string | null;
    reference?: string | undefined;
    requestLineIds?: readonly string[] | undefined;
    txnDate: string;
  },
): Promise<{
  order: QboPoInput;
  vendorName: string;
  reference: string;
  sources: string[];
}> {
  if (!input.accountId) {
    throw new PurchasingError(
      "invalid",
      "set the QuickBooks account purchase orders book to (the skill's qbo_account_id)",
    );
  }
  const accountId = input.accountId;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const made = await poContent(tx, ctx, input);
    const row = await vendorRow(tx, ctx.tenantId, made.vendorId);
    const qboVendorId = qboRef(row);
    if (!qboVendorId) {
      throw new PurchasingError(
        "invalid",
        `${row.name} has no QuickBooks vendor yet (materials.vendor.qbo first)`,
      );
    }
    const c = made.content;
    const lines = c.lines.map((l) => ({
      accountId,
      description:
        `${l.description}: ${dec(l.qty).toString()}${l.unit ? ` ${l.unit}` : ""} at ${dec(l.unitPrice).toString()}`.slice(
          0,
          4000,
        ),
      amount: cents(l.amount),
    }));
    const total = lines.reduce((sum, l) => sum.plus(l.amount), dec("0")).toFixed(2);
    const order: QboPoInput = {
      vendorId: qboVendorId,
      docNumber: c.reference.slice(0, 21),
      txnDate: input.txnDate,
      ...(c.neededBy && c.neededBy >= input.txnDate ? { dueDate: c.neededBy } : {}),
      currency: c.currency,
      expectedTotal: total,
      memo: `Purchase request ${input.requestId.slice(0, 8)}, quote from ${c.vendorName}`,
      lines,
    };
    return {
      order,
      vendorName: c.vendorName,
      reference: c.reference,
      sources: [input.requestId, input.quoteRequestId, row.id, ...made.quoteLineIds],
    };
  });
}
