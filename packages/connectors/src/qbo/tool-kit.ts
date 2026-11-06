// What the qbo tools share (./tools.ts, ./ar.ts, ./bill-create.ts): paging a query, the new-line
// shape a write sends (account or item lines, amounts in decimal), the line as it goes onto the
// wire, the names an approval card shows for ids, and the errors a write refuses with.

import { DecimalString, dec, toNumeric } from "@countersign/core";
import { z } from "zod";
import type { ToolContext } from "../connector";
import { QboApiError, type QboClient, QboStaleObjectError, qboLiteral } from "./api";
import { QboId, type QboTxnLine, wire } from "./records";

export type ClientFor = (ctx: ToolContext) => Promise<QboClient>;

export const IsoDate = z.iso.date();
export const Page = {
  start: z.number().int().min(1).max(100_000).default(1),
  limit: z.number().int().min(1).max(100).default(25),
};

export function where(conds: string[]): string {
  return conds.length > 0 ? ` where ${conds.join(" and ")}` : "";
}

/** `limit + 1` rows are asked for, so `more` is known without a count query. */
export async function page<T>(
  client: QboClient,
  entity: string,
  conds: string[],
  input: { start: number; limit: number },
  map: (row: unknown) => T,
  order = "Metadata.LastUpdatedTime desc",
): Promise<{ rows: T[]; more: boolean }> {
  const sql = `select * from ${entity}${where(conds)} orderby ${order} startposition ${input.start} maxresults ${input.limit + 1}`;
  const { rows } = await client.query(sql, entity);
  return { rows: rows.slice(0, input.limit).map(map), more: rows.length > input.limit };
}

/** A line a write adds: an item line (qty × unit price) or an account line. */
export const NewLine = z
  .object({
    /** An item line (the invoice's product), or … */
    itemId: QboId.optional(),
    /** … an account line. */
    accountId: QboId.optional(),
    description: z.string().max(4000).optional(),
    qty: DecimalString.optional(),
    unitPrice: DecimalString.optional(),
    amount: DecimalString,
  })
  .superRefine((l, ctx) => {
    if ((l.itemId === undefined) === (l.accountId === undefined)) {
      ctx.addIssue({ code: "custom", message: "give exactly one of itemId and accountId" });
      return;
    }
    if (dec(l.amount).isNegative()) {
      ctx.addIssue({ code: "custom", message: "a line's amount can't be negative" });
    }
    if (!dec(l.amount).equals(dec(l.amount).toDecimalPlaces(2))) {
      ctx.addIssue({ code: "custom", message: "a line's amount has at most 2 decimals" });
    }
    if (l.itemId !== undefined) {
      if (l.qty === undefined || l.unitPrice === undefined) {
        ctx.addIssue({ code: "custom", message: "an item line needs qty and unitPrice" });
        return;
      }
      // DECISION: an item line's amount must be qty × unit price rounded half up to cents, as
      // QuickBooks computes it; a mismatch is refused here rather than adjusted by QuickBooks.
      const product = dec(l.qty).times(dec(l.unitPrice)).toDecimalPlaces(2);
      if (!product.equals(dec(l.amount))) {
        ctx.addIssue({
          code: "custom",
          message: `amount ${l.amount} is not qty × unitPrice (${product.toFixed(2)})`,
        });
      }
    } else if (l.qty !== undefined || l.unitPrice !== undefined) {
      ctx.addIssue({ code: "custom", message: "an account line has no qty or unitPrice" });
    }
  });
export type NewLine = z.infer<typeof NewLine>;

export function sum(values: string[]): string {
  return toNumeric(values.reduce((s, v) => s.plus(dec(v)), dec("0")));
}

/** A new line as QuickBooks takes it, with what it inherits (job, class, billable, tax code). */
export function wireLine(l: NewLine, inherit: Record<string, unknown>): Record<string, unknown> {
  const base = {
    ...(l.description === undefined ? {} : { Description: l.description }),
    Amount: wire(l.amount),
  };
  if (l.itemId !== undefined) {
    return {
      ...base,
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: {
        ...inherit,
        ItemRef: { value: l.itemId },
        Qty: wire(l.qty as string),
        UnitPrice: wire(l.unitPrice as string),
      },
    };
  }
  return {
    ...base,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { ...inherit, AccountRef: { value: l.accountId } },
  };
}

export function notFound(entity: string, id: string): QboApiError {
  return new QboApiError(404, "NOT_FOUND", `${entity} ${id} is not in QuickBooks`, false);
}

/** The record changed since the agent read it, and not by this change. */
export function stale(entity: string, id: string, read: string, now: string): QboStaleObjectError {
  return new QboStaleObjectError(
    `${entity} ${id} changed in QuickBooks since it was read (SyncToken ${read}, now ${now}); read it again`,
  );
}

/** Names by id of the items and accounts new lines use: `{ items: { "12": "Oak board 4/4" } }`. */
export const RefNames = z.object({
  items: z.record(z.string(), z.string()),
  accounts: z.record(z.string(), z.string()),
});
export type RefNames = z.infer<typeof RefNames>;

/**
 * The names of the items and accounts the new lines use, for the approval card: those the record
 * already names (`known`), then the rest read from QuickBooks.
 */
// DECISION: the lines tools keep these names in their before state (`names`), read when the change
// is proposed (and again before it is written), so the card shows "Oak board 4/4" rather than an
// id. A failed lookup leaves the ids on the card and never stops the write.
export async function refNames(
  client: QboClient,
  known: QboTxnLine[],
  lines: NewLine[],
  ctx: ToolContext,
): Promise<RefNames> {
  const names: RefNames = { items: {}, accounts: {} };
  for (const l of known) {
    if (l.item?.name) names.items[l.item.id] = l.item.name;
    if (l.account?.name) names.accounts[l.account.id] = l.account.name;
  }
  const missing = (ids: (string | undefined)[], have: Record<string, string>) => [
    ...new Set(ids.filter((id): id is string => id !== undefined && !Object.hasOwn(have, id))),
  ];
  const items = missing(
    lines.map((l) => l.itemId),
    names.items,
  );
  const accounts = missing(
    lines.map((l) => l.accountId),
    names.accounts,
  );
  const named = async (entity: "Item" | "Account", ids: string[], into: Record<string, string>) => {
    if (ids.length === 0) return;
    const { rows } = await client.query(
      `select * from ${entity} where Id in (${ids.map(qboLiteral).join(", ")}) maxresults 100`,
      entity,
    );
    for (const row of rows) {
      const r = row as { Id?: unknown; Name?: unknown; FullyQualifiedName?: unknown };
      // An account reads with its parent ("Job materials:Lumber"), as its refs on lines do.
      const name =
        entity === "Account" && typeof r.FullyQualifiedName === "string"
          ? r.FullyQualifiedName
          : r.Name;
      if (typeof r.Id === "string" && typeof name === "string") into[r.Id] = name;
    }
  };
  try {
    await named("Item", items, names.items);
    await named("Account", accounts, names.accounts);
  } catch (error) {
    ctx.logger.warn("could not read names for the approval card", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return names;
}

export const QBO_TOOLS = {
  purchaseQuery: "qbo.purchase.query",
  billQuery: "qbo.bill.query",
  vendorQuery: "qbo.vendor.query",
  itemQuery: "qbo.item.query",
  attachableList: "qbo.attachable.list",
  billUpdateLines: "qbo.bill.update_lines",
  purchaseUpdateLines: "qbo.purchase.update_lines",
  billUpdateMemo: "qbo.bill.update_memo",
  purchaseUpdateMemo: "qbo.purchase.update_memo",
  itemUpdatePurchaseCost: "qbo.item.update_purchase_cost",
  attachableUpload: "qbo.attachable.upload",
  // v0.12 W1-F: accounts receivable and create bill (docs/plan.md §1.41).
  invoiceQuery: "qbo.invoice.query",
  customerQuery: "qbo.customer.query",
  paymentQuery: "qbo.payment.query",
  agingReport: "qbo.aging_report",
  invoiceAddNote: "qbo.invoice.add_note",
  billCreate: "qbo.bill.create",
} as const;

/** A write refused because it would change the transaction's total (or its tax). */
export class QboTotalWouldChangeError extends QboApiError {
  constructor(message: string) {
    super(422, "TOTAL_WOULD_CHANGE", message, false);
    this.name = "QboTotalWouldChangeError";
  }
}
