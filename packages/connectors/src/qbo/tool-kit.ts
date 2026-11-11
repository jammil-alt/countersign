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
    // P-2: job and class coding on a line (docs/plan.md §1.64).
    /** The class the line is tracked under (`qbo.class.query`), when the company uses classes. */
    classId: QboId.optional(),
    /** The customer or job the cost is for (`qbo.customer.query`). */
    customerId: QboId.optional(),
    /** Whether the customer is to be billed for it; only with `customerId`. */
    billable: z.boolean().optional(),
  })
  .superRefine((l, ctx) => {
    // P-2: billable says how a customer's cost is billed, so it needs the customer.
    if (l.billable !== undefined && l.customerId === undefined) {
      ctx.addIssue({ code: "custom", message: "billable needs a customerId" });
    }
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
  const coded = { ...inherit, ...lineCoding(l) };
  if (l.itemId !== undefined) {
    return {
      ...base,
      DetailType: "ItemBasedExpenseLineDetail",
      ItemBasedExpenseLineDetail: {
        ...coded,
        ItemRef: { value: l.itemId },
        Qty: wire(l.qty as string),
        UnitPrice: wire(l.unitPrice as string),
      },
    };
  }
  return {
    ...base,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { ...coded, AccountRef: { value: l.accountId } },
  };
}

// ── P-2: class and customer on lines (docs/plan.md §1.64) ──────────────────────────────────────

/**
 * The class and customer a line names, as QuickBooks' line detail takes them (both expense detail
 * types carry `ClassRef`, `CustomerRef` and `BillableStatus`; NOTES.md).
 */
// DECISION: what a line names wins over what it inherits from the line it replaces. A line that
// names a customer always says how it is billed (`Billable`, or `NotBillable` unless asked), so an
// inherited billable status never lands on another customer's cost.
export function lineCoding(l: NewLine): Record<string, unknown> {
  return {
    ...(l.classId === undefined ? {} : { ClassRef: { value: l.classId } }),
    ...(l.customerId === undefined
      ? {}
      : {
          CustomerRef: { value: l.customerId },
          BillableStatus: l.billable === true ? "Billable" : "NotBillable",
        }),
  };
}

/** A postal address as QuickBooks' `PhysicalAddress` takes it (a vendor's, a ship-to). */
export const QboAddressInput = z.object({
  line1: z.string().trim().min(1).max(500),
  line2: z.string().trim().min(1).max(500).optional(),
  city: z.string().trim().min(1).max(255).optional(),
  /** State or province, e.g. "OR". */
  region: z.string().trim().min(1).max(255).optional(),
  postalCode: z.string().trim().min(1).max(30).optional(),
  country: z.string().trim().min(1).max(255).optional(),
});
export type QboAddressInput = z.infer<typeof QboAddressInput>;

export function wireAddress(a: QboAddressInput): Record<string, string> {
  return {
    Line1: a.line1,
    ...(a.line2 === undefined ? {} : { Line2: a.line2 }),
    ...(a.city === undefined ? {} : { City: a.city }),
    ...(a.region === undefined ? {} : { CountrySubDivisionCode: a.region }),
    ...(a.postalCode === undefined ? {} : { PostalCode: a.postalCode }),
    ...(a.country === undefined ? {} : { Country: a.country }),
  };
}

/** "12 Mill St, Suite 4, Portland, OR 97201, US": the address on one line, for the card. */
export function addressLine(a: QboAddressInput | undefined): string | null {
  if (!a) return null;
  const place = [a.region, a.postalCode].filter(Boolean).join(" ");
  return [a.line1, a.line2, a.city, place || undefined, a.country].filter(Boolean).join(", ");
}

const idsOf = (lines: NewLine[], key: "classId" | "customerId") => [
  ...new Set(lines.flatMap((l) => (l[key] === undefined ? [] : [l[key] as string]))),
];

/**
 * Why the lines' classes and customers can't be used: one QuickBooks doesn't have, or one made
 * inactive. Read live, inactive ones too, so the refusal can say which. Null when they are fine.
 */
// DECISION: unknown or inactive classes and customers are refused when the change is proposed and
// again right before writing, like the vendor of a new bill, so nobody approves a line QuickBooks
// would refuse or a cost filed under a job that is closed.
export async function lineRefsProblem(
  client: QboClient,
  lines: NewLine[],
): Promise<QboApiError | null> {
  const check = async (entity: "Class" | "Customer", want: string[]) => {
    if (want.length === 0) return null;
    // UNCHECKED (NOTES.md): `Active in (true, false)` brings inactive name-list records too.
    const { rows } = await client.query(
      `select * from ${entity} where Id in (${want.map(qboLiteral).join(", ")}) and Active in (true, false) maxresults 100`,
      entity,
    );
    const found = new Map<string, boolean>();
    for (const row of rows) {
      const r = row as { Id?: unknown; Active?: unknown };
      if (typeof r.Id === "string") found.set(r.Id, r.Active !== false);
    }
    const word = entity === "Class" ? "class" : "customer";
    const code = entity === "Class" ? "CLASS" : "CUSTOMER";
    const missing = want.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return new QboApiError(
        422,
        `UNKNOWN_${code}`,
        `${word} ${missing.join(", ")} isn't one of this company's in QuickBooks`,
        false,
      );
    }
    const inactive = want.filter((id) => found.get(id) === false);
    if (inactive.length > 0) {
      return new QboApiError(
        422,
        `INACTIVE_${code}`,
        `${word} ${inactive.join(", ")} is inactive in QuickBooks`,
        false,
      );
    }
    return null;
  };
  return (
    (await check("Class", idsOf(lines, "classId"))) ??
    (await check("Customer", idsOf(lines, "customerId")))
  );
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
  // P-2: the classes and customers new lines name, present only when they name any.
  classes: z.record(z.string(), z.string()).optional(),
  customers: z.record(z.string(), z.string()).optional(),
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
  // P-2: the classes and customers the new lines name, those the record names first.
  const classIds = idsOf(lines, "classId");
  const customerIds = idsOf(lines, "customerId");
  const classes: Record<string, string> = {};
  const customers: Record<string, string> = {};
  for (const l of known) {
    if (l.item?.name) names.items[l.item.id] = l.item.name;
    if (l.account?.name) names.accounts[l.account.id] = l.account.name;
    if (l.class?.name && classIds.includes(l.class.id)) classes[l.class.id] = l.class.name;
    if (l.customer?.name && customerIds.includes(l.customer.id)) {
      customers[l.customer.id] = l.customer.name;
    }
  }
  if (classIds.length > 0) names.classes = classes;
  if (customerIds.length > 0) names.customers = customers;
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
  const named = async (
    entity: "Item" | "Account" | "Class" | "Customer",
    ids: string[],
    into: Record<string, string>,
  ) => {
    if (ids.length === 0) return;
    const { rows } = await client.query(
      `select * from ${entity} where Id in (${ids.map(qboLiteral).join(", ")}) maxresults 100`,
      entity,
    );
    for (const row of rows) {
      const r = row as {
        Id?: unknown;
        Name?: unknown;
        FullyQualifiedName?: unknown;
        DisplayName?: unknown;
      };
      // An account or class reads with its parent ("Job materials:Lumber"), as its refs on lines
      // do; a customer by its display name.
      const name =
        entity === "Customer"
          ? r.DisplayName
          : entity !== "Item" && typeof r.FullyQualifiedName === "string"
            ? r.FullyQualifiedName
            : r.Name;
      if (typeof r.Id === "string" && typeof name === "string") into[r.Id] = name;
    }
  };
  try {
    await named("Item", items, names.items);
    await named("Account", accounts, names.accounts);
    // P-2
    if (names.classes) await named("Class", missing(classIds, classes), names.classes);
    if (names.customers) await named("Customer", missing(customerIds, customers), names.customers);
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
  // P-2: QuickBooks ingredients (docs/plan.md §1.64).
  accountQuery: "qbo.account.query",
  classQuery: "qbo.class.query",
  vendorCreate: "qbo.vendor.create",
  purchaseOrderCreate: "qbo.purchaseorder.create",
  purchaseOrderQuery: "qbo.purchaseorder.query",
} as const;

/**
 * What a test run's later steps get for a record a create would have made (docs/plan.md §1.94):
 * id and version "0", which pass `QboId` and are plainly not real.
 */
// DECISION: "0" for every stand-in id; QuickBooks numbers its own records from 1.
export const QBO_STAND_IN = { id: "0", syncToken: "0", alreadyDone: false } as const;

/** A write refused because it would change the transaction's total (or its tax). */
export class QboTotalWouldChangeError extends QboApiError {
  constructor(message: string) {
    super(422, "TOTAL_WOULD_CHANGE", message, false);
    this.name = "QboTotalWouldChangeError";
  }
}
