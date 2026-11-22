// P-9: a purchase order for QuickBooks (docs/plan.md §1.71). Two deterministic steps around the
// QuickBooks connector's own tools, which do every read and write (a write only after approval,
// invariant 8): `vendorQbo` ties one of our vendors to its QuickBooks vendor id (stored, found among
// the vendors `qbo.vendor.query` listed by name, or the new one `qbo.vendor.create` made), kept in
// `vendor.external_refs.qbo`; `poQboLines` turns the chosen quote into `qbo.purchaseorder.create`'s
// input: the QuickBooks vendor and one line per quoted line, amounts rounded to cents.
// C2.4 (docs/plan.md §1.193): a catalog item tied to its QuickBooks item (`catalog_item.ext.qbo`,
// by `itemQbo` or the bill-price import) is ordered as an item line; any other as an account line.

import { dec } from "@countersign/core";
import { type Db, type Tx, vendor, withTenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { liveItem } from "../catalog/store";
import { catalogItem } from "../schema";
import { vendorContacts } from "./contacts";
import { cents, poContent } from "./po";
import { clientDay, type PurchasingContext, PurchasingError } from "./requests";

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

// ── C2.4: catalog items and QuickBooks items (docs/plan.md §1.193) ──────────────────────────────

/** A QuickBooks item as `qbo.item.query` lists it. */
export interface QboItemSeen {
  id: string;
  name: string;
  type?: string | null | undefined;
  active?: boolean | undefined;
}

const QBO_ID = /^[0-9]{1,20}$/;

/** The QuickBooks item a catalog item is booked as, when one is kept. */
export function qboItemOf(row: { ext: unknown }): string | null {
  const v = (row.ext as Record<string, unknown> | null)?.qbo;
  return typeof v === "string" && QBO_ID.test(v) ? v : null;
}

// DECISION (C2.4): the tie lives in `catalog_item.ext.qbo` (no migration): one QuickBooks item per
// catalog item, kept once and never overwritten by a later find (a person changes it). Many
// catalog items may share one QuickBooks item: a client that books every sheet good as
// "Plywood" orders them that way too. The write is one statement that sets it only when none is
// kept, so two runs at once keep the first.
/** Keeps `qboItemId` as the catalog item's QuickBooks item when it has none; true when kept now. */
export async function keepQboItem(
  tx: Tx,
  tenantId: string,
  catalogItemId: string,
  qboItemId: string,
): Promise<boolean> {
  const done = await tx
    .update(catalogItem)
    .set({
      ext: sql`${catalogItem.ext} || ${JSON.stringify({ qbo: qboItemId })}::jsonb`,
    })
    .where(
      and(
        eq(catalogItem.tenantId, tenantId),
        eq(catalogItem.id, catalogItemId),
        sql`not (${catalogItem.ext} ? 'qbo')`,
      ),
    )
    .returning({ id: catalogItem.id });
  return done.length > 0;
}

export interface ItemQbo {
  catalogItemId: string;
  name: string;
  qboItemId: string | null;
  /** How it is known: kept before (a bill or an earlier step), found by name, or given. */
  how: "stored" | "found" | "given" | null;
  /** The name to look for with qbo.item.query. */
  searchName: string;
}

// DECISION (C2.4): a catalog item is a QuickBooks item by its kept id, else by the one active
// QuickBooks item (not a category) whose name is the catalog item's (case, spacing and punctuation
// aside), else by the id a person or step gives. Two such, or none, is no tie: its PO lines stay
// account lines. A different id for an item already tied is refused; a person unties it first.
// Nothing is created in QuickBooks: a new item there is the client's bookkeeping choice.
export async function itemQbo(
  db: Db,
  ctx: PurchasingContext,
  input: {
    catalogItemId: string;
    qboItems?: readonly QboItemSeen[] | undefined;
    qboItemId?: string | undefined;
  },
): Promise<ItemQbo> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const row = await liveItem(tx, ctx.tenantId, input.catalogItemId);
    if (!row)
      throw new PurchasingError("not_found", `catalog item ${input.catalogItemId} not found`);
    const stored = qboItemOf(row);
    const answer = (qboItemId: string | null, how: ItemQbo["how"]): ItemQbo => ({
      catalogItemId: row.id,
      name: row.canonicalName,
      qboItemId,
      how,
      searchName: row.canonicalName.slice(0, 100),
    });
    const keep = async (id: string) => {
      if (!ctx.testRun) await keepQboItem(tx, ctx.tenantId, row.id, id);
    };
    if (input.qboItemId) {
      if (stored && stored !== input.qboItemId) {
        throw new PurchasingError(
          "invalid",
          `${row.canonicalName} is already QuickBooks item ${stored}, not ${input.qboItemId}`,
        );
      }
      if (!stored) await keep(input.qboItemId);
      return answer(input.qboItemId, stored ? "stored" : "given");
    }
    if (stored) return answer(stored, "stored");
    const same = (input.qboItems ?? []).filter(
      (i) =>
        i.active !== false &&
        (i.type ?? "").toLowerCase() !== "category" &&
        QBO_ID.test(i.id) &&
        sameVendorName(i.name, row.canonicalName),
    );
    if (same.length === 1 && same[0]) {
      await keep(same[0].id);
      return answer(same[0].id, "found");
    }
    return answer(null, null);
  });
}

/** A purchase order line as `qbo.purchaseorder.create` takes it: an item line or an account line. */
export type QboPoLine =
  | { itemId: string; description: string; qty: string; unitPrice: string; amount: string }
  | { accountId: string; description: string; amount: string };

export interface QboPoInput {
  vendorId: string;
  docNumber: string;
  txnDate: string;
  dueDate?: string;
  currency: string;
  expectedTotal: string;
  memo: string;
  lines: QboPoLine[];
}

// The one rounding rule for a purchase order's amounts, shared with its PDF (./po.ts).
export { cents };

// DECISION: a purchase order's line is an item line when its catalog item is tied to a QuickBooks
// item (C2.4: quantity and unit price as quoted, in the vendor's unit, which the description
// names; QuickBooks items carry no unit), else an account line on the one expense account set for
// the client agent (skill setting `qbo_account_id`, or the step's `accountId`), which is needed
// only when some line is an account line. Each line's amount is the quoted unit price times the
// quantity, rounded half up to cents; the total is the lines' sum.
export async function poQboLines(
  db: Db,
  ctx: PurchasingContext,
  input: {
    requestId: string;
    quoteRequestId: string;
    accountId: string | null;
    reference?: string | undefined;
    requestLineIds?: readonly string[] | undefined;
    /** yyyy-mm-dd; the client's own today (its time zone) when not given. */
    txnDate?: string | undefined;
  },
): Promise<{
  order: QboPoInput;
  vendorName: string;
  reference: string;
  /** C2.4: the order's catalog items with no QuickBooks item yet (for materials.item.qbo). */
  untied: { catalogItemId: string; name: string }[];
  sources: string[];
}> {
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
    const txnDate = input.txnDate ?? (await clientDay(tx, ctx.tenantId, new Date()));
    const items = new Map<string, { name: string; qbo: string | null }>();
    for (const id of made.catalogItemIds) {
      if (id === null || items.has(id)) continue;
      const [it] = await tx
        .select({ name: catalogItem.canonicalName, ext: catalogItem.ext })
        .from(catalogItem)
        .where(and(eq(catalogItem.tenantId, ctx.tenantId), eq(catalogItem.id, id)))
        .limit(1);
      items.set(id, { name: it?.name ?? "", qbo: it ? qboItemOf(it) : null });
    }
    const lines: QboPoLine[] = c.lines.map((l, i) => {
      const description =
        `${l.description}: ${dec(l.qty).toString()}${l.unit ? ` ${l.unit}` : ""} at ${dec(l.unitPrice).toString()}`.slice(
          0,
          4000,
        );
      const id = made.catalogItemIds[i] ?? null;
      const qboItemId = id ? (items.get(id)?.qbo ?? null) : null;
      if (qboItemId) {
        return {
          itemId: qboItemId,
          description,
          qty: dec(l.qty).toString(),
          unitPrice: dec(l.unitPrice).toString(),
          amount: cents(l.amount),
        };
      }
      if (!input.accountId) {
        throw new PurchasingError(
          "invalid",
          `line ${l.lineNo} has no QuickBooks item: set the QuickBooks account purchase orders book to (the skill's qbo_account_id), or tie its item (materials.item.qbo)`,
        );
      }
      return { accountId: input.accountId, description, amount: cents(l.amount) };
    });
    const total = lines.reduce((sum, l) => sum.plus(l.amount), dec("0")).toFixed(2);
    const order: QboPoInput = {
      vendorId: qboVendorId,
      docNumber: c.reference.slice(0, 21),
      txnDate,
      ...(c.neededBy && c.neededBy >= txnDate ? { dueDate: c.neededBy } : {}),
      currency: c.currency,
      expectedTotal: total,
      memo: `Purchase request ${input.requestId.slice(0, 8)}, quote from ${c.vendorName}`,
      lines,
    };
    return {
      order,
      vendorName: c.vendorName,
      reference: c.reference,
      untied: [...items.entries()]
        .filter(([, it]) => it.qbo === null)
        .map(([catalogItemId, it]) => ({ catalogItemId, name: it.name })),
      sources: [
        input.requestId,
        input.quoteRequestId,
        row.id,
        ...made.quoteLineIds,
        ...items.keys(),
      ],
    };
  });
}
