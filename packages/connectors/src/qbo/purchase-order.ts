// P-2: purchase orders in QuickBooks (docs/plan.md §1.64, M35). `qbo.purchaseorder.query` reads them
// with their lines; `qbo.purchaseorder.create` makes one behind approval like every write, with the
// rules of `qbo.bill.create`: refused when proposed and again before writing if its lines don't add
// up to the expected total, the vendor isn't the company's, a line's class or customer isn't, or a
// purchase order from the vendor with the same number is there. `requestid` comes from the
// action's key, so a retried write is answered, not repeated.

import { CurrencyCode, DecimalString, dec } from "@countersign/core";
import { z } from "zod";
import { defineReadTool, defineWriteTool, type ToolDefinition } from "../connector";
import { QboApiError, type QboClient, qboLiteral, qboRequestId } from "./api";
import { companyVendor, normalizeDocNumber } from "./bill-create";
import { purchaseOrderCreateDisplay } from "./display";
import { QboId, QboPoStatus, QboPurchaseOrder, toPurchaseOrder } from "./records";
import {
  addressLine,
  type ClientFor,
  IsoDate,
  lineRefsProblem,
  NewLine,
  Page,
  page,
  QBO_TOOLS,
  QboAddressInput,
  QboTotalWouldChangeError,
  RefNames,
  refNames,
  sum,
  wireAddress,
  wireLine,
} from "./tool-kit";

export const PurchaseOrderCreateInput = z
  .object({
    /** The vendor, by its QuickBooks id (`qbo.vendor.query`, or a new one's from `qbo.vendor.create`). */
    vendorId: QboId,
    /** The order's number; when given, a second order from the vendor with it is refused. */
    docNumber: z.string().trim().min(1).max(21).optional(),
    txnDate: IsoDate,
    /** The date the order is expected (QuickBooks' due date on a purchase order). */
    dueDate: IsoDate.optional(),
    currency: CurrencyCode.optional(),
    /** What the lines add up to; the order is refused if they don't. */
    expectedTotal: DecimalString,
    /** Where the vendor delivers, e.g. the shop or a job site. */
    shipTo: QboAddressInput.optional(),
    /** The order's private memo, for the company (the vendor doesn't see it). */
    memo: z.string().max(4000).optional(),
    lines: z.array(NewLine).min(1).max(250),
  })
  .refine((p) => p.dueDate === undefined || p.dueDate >= p.txnDate, {
    message: "the expected date can't be before the order's date",
    path: ["dueDate"],
  });
export type PurchaseOrderCreateInput = z.infer<typeof PurchaseOrderCreateInput>;

/** A purchase order refused because one like it is already in QuickBooks. */
export class QboDuplicatePurchaseOrderError extends QboApiError {
  constructor(message: string) {
    super(409, "DUPLICATE_PURCHASE_ORDER", message, false);
    this.name = "QboDuplicatePurchaseOrderError";
  }
}

function linesProblem(input: PurchaseOrderCreateInput): QboApiError | null {
  const total = sum(input.lines.map((l) => l.amount));
  if (!dec(total).equals(dec(input.expectedTotal))) {
    return new QboTotalWouldChangeError(
      `the lines add up to ${total}, not the ${input.expectedTotal} expected`,
    );
  }
  // decimal.js counts zero as positive: more than zero is the rule.
  if (!dec(input.expectedTotal).greaterThan(0)) {
    return new QboApiError(
      422,
      "EMPTY_PURCHASE_ORDER",
      "a purchase order's total must be more than zero",
      false,
    );
  }
  return null;
}

const PO_PAGE = 1000;
const PO_PAGES = 20;

/** Purchase orders in QuickBooks now from this vendor with this number (compared normalized). */
// DECISION: purchase orders aren't synced, so there is no stored copy to compare numbers with. The
// vendor's orders are read live (1,000 a page) and their numbers compared on letters and digits,
// as bills' are, so "PO 1001" finds "PO-1001". A vendor with more than 20,000 orders is refused
// rather than half checked.
async function livePurchaseOrders(
  client: QboClient,
  input: PurchaseOrderCreateInput,
): Promise<QboPurchaseOrder[]> {
  if (input.docNumber === undefined) return [];
  const want = normalizeDocNumber(input.docNumber);
  const found: QboPurchaseOrder[] = [];
  for (let p = 0; p < PO_PAGES; p++) {
    // UNCHECKED (NOTES.md): PurchaseOrder filtered by `VendorRef`.
    const { rows } = await client.query(
      `select * from PurchaseOrder where VendorRef = ${qboLiteral(input.vendorId)} orderby Id startposition ${p * PO_PAGE + 1} maxresults ${PO_PAGE}`,
      "PurchaseOrder",
    );
    for (const row of rows) {
      const po = toPurchaseOrder(row);
      if (normalizeDocNumber(po.docNumber ?? "") === want) found.push(po);
    }
    if (rows.length < PO_PAGE) return found;
  }
  throw new QboApiError(
    422,
    "TOO_MANY_PURCHASE_ORDERS",
    "this vendor has too many purchase orders to check for a duplicate",
    false,
  );
}

function duplicate(input: PurchaseOrderCreateInput): QboDuplicatePurchaseOrderError {
  return new QboDuplicatePurchaseOrderError(
    `a purchase order ${input.docNumber} from this vendor is already in QuickBooks`,
  );
}

/** The order this change would make is the one there: same vendor, number, total and lines. */
// DECISION: as for a new bill, a retry after QuickBooks took the order but the answer was lost
// finds it (same vendor, number, total and line count) and reports it done. Without a number there
// is nothing to find it by: QuickBooks' `requestid` alone keeps the retry from writing twice.
function samePurchaseOrder(p: QboPurchaseOrder, input: PurchaseOrderCreateInput): boolean {
  return dec(p.total).equals(dec(input.expectedTotal)) && p.lines.length === input.lines.length;
}

/** The accounts payable account the order is kept in, when QuickBooks has one for its currency. */
// DECISION: QuickBooks names an A/P account on a purchase order (NOTES.md: whether it is required).
// We send the company's one active A/P account in the order's currency (USD unless given); with
// none, or more than one, we send none and QuickBooks uses its default or says why it can't.
async function payablesAccount(
  client: QboClient,
  currency: string,
): Promise<{ value: string } | null> {
  const { rows } = await client.query(
    "select * from Account where AccountType = 'Accounts Payable' and Active = true maxresults 100",
    "Account",
  );
  const mine = rows.filter((r) => {
    const c = (r as { CurrencyRef?: { value?: unknown } }).CurrencyRef?.value;
    return typeof c !== "string" || c.toUpperCase() === currency;
  });
  const only = mine.length === 1 ? (mine[0] as { Id?: unknown }) : null;
  return typeof only?.Id === "string" ? { value: only.Id } : null;
}

export function purchaseOrderCreateTool(clientFor: ClientFor): ToolDefinition {
  return defineWriteTool({
    id: QBO_TOOLS.purchaseOrderCreate,
    entity: "purchase_order",
    description:
      "Create a purchase order in QuickBooks: vendor, optional number, dates (the order's and when it is expected), lines (an item with qty and unit price, or an account; a class or customer per line if the company uses them), the expected total, where to ship and a memo. It stays open and isn't sent to the vendor. Refused if the lines don't add up, the vendor isn't the company's, or an order from the vendor with the same number is there.",
    verb: "create",
    // R5: no void or archive tool yet, and delete stays off (docs/plan.md §9 follow-ups).
    undo: { kind: "none" },
    summary: "Created purchase order {{docNumber}} for {{total}}",
    amount: { path: "expectedTotal", currencyPath: "currency", currency: "USD" },
    display: purchaseOrderCreateDisplay,
    input: PurchaseOrderCreateInput,
    output: z.object({
      id: z.string(),
      syncToken: z.string(),
      docNumber: z.string().nullable(),
      total: DecimalString,
      status: z.string().nullable(),
      lineCount: z.number().int(),
      alreadyDone: z.boolean(),
    }),
    // DECISION: a new order has no prior state; `before` keeps what the approval card names it by:
    // the vendor as QuickBooks has it, the names of the lines' items, accounts, classes and
    // customers, and the ship-to address on one line.
    beforeSchema: z.object({
      vendor: z.object({ id: z.string(), name: z.string() }),
      names: RefNames,
      shipTo: z.string().nullable(),
    }),
    async before(input, ctx) {
      const problem = linesProblem(input);
      if (problem) throw problem;
      const client = await clientFor(ctx);
      const vendor = await companyVendor(client, input.vendorId);
      const refs = await lineRefsProblem(client, input.lines);
      if (refs) throw refs;
      const live = await livePurchaseOrders(client, input);
      const names = async () => ({
        vendor,
        names: await refNames(client, [], input.lines, ctx),
        shipTo: addressLine(input.shipTo),
      });
      // As for a new bill: only right before writing is an order like this one our own write.
      if ("idempotencyKey" in ctx && live.some((p) => samePurchaseOrder(p, input))) return names();
      if (live.length > 0) throw duplicate(input);
      return names();
    },
    async run(input, ctx) {
      const problem = linesProblem(input);
      if (problem) throw problem;
      const client = await clientFor(ctx);
      await companyVendor(client, input.vendorId);
      const refs = await lineRefsProblem(client, input.lines);
      if (refs) throw refs;
      const out = (p: QboPurchaseOrder, alreadyDone: boolean) => ({
        id: p.id,
        syncToken: p.syncToken,
        docNumber: p.docNumber,
        total: p.total,
        status: p.status,
        lineCount: p.lines.length,
        alreadyDone,
      });
      const live = await livePurchaseOrders(client, input);
      const ours = live.find((p) => samePurchaseOrder(p, input));
      if (ours) {
        ctx.logger.info("purchase order already created", { id: ours.id });
        return out(ours, true);
      }
      if (live.length > 0) throw duplicate(input);
      const payables = await payablesAccount(client, input.currency ?? "USD");
      const body = {
        VendorRef: { value: input.vendorId },
        ...(payables ? { APAccountRef: payables } : {}),
        ...(input.docNumber === undefined ? {} : { DocNumber: input.docNumber }),
        TxnDate: input.txnDate,
        ...(input.dueDate === undefined ? {} : { DueDate: input.dueDate }),
        ...(input.currency === undefined ? {} : { CurrencyRef: { value: input.currency } }),
        ...(input.memo === undefined ? {} : { PrivateNote: input.memo }),
        ...(input.shipTo === undefined ? {} : { ShipAddr: wireAddress(input.shipTo) }),
        Line: input.lines.map((l) => wireLine(l, {})),
      };
      ctx.logger.info("creating a purchase order", {
        vendorId: input.vendorId,
        lines: input.lines.length,
      });
      const answer = (await client.post("/purchaseorder", body, {
        requestid: await qboRequestId(ctx.idempotencyKey),
      })) as Record<string, unknown>;
      const po = toPurchaseOrder(answer.PurchaseOrder);
      if (!dec(po.total).equals(dec(input.expectedTotal))) {
        // QuickBooks added something (tax) to the order: a person looks at it.
        throw new QboApiError(
          502,
          "TOTAL_CHANGED",
          `QuickBooks made purchase order ${po.id} total ${po.total}, not ${input.expectedTotal}; check it`,
          false,
        );
      }
      return out(po, false);
    },
  });
}

export function purchaseOrderQueryTool(clientFor: ClientFor): ToolDefinition {
  return defineReadTool({
    id: QBO_TOOLS.purchaseOrderQuery,
    entity: "purchase_order",
    description:
      "Find purchase orders in QuickBooks by id, number, vendor, status (Open or Closed) or date, with their lines.",
    summary: "Found {{purchaseOrders.length}} purchase orders",
    input: z.object({
      ids: z.array(QboId).min(1).max(30).optional(),
      docNumber: z.string().trim().min(1).max(21).optional(),
      vendorId: QboId.optional(),
      status: QboPoStatus.optional(),
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      ...Page,
    }),
    output: z.object({ purchaseOrders: z.array(QboPurchaseOrder), more: z.boolean() }),
    async run(input, ctx) {
      const conds: string[] = [];
      if (input.ids) conds.push(`Id in (${input.ids.map(qboLiteral).join(", ")})`);
      if (input.docNumber) conds.push(`DocNumber = ${qboLiteral(input.docNumber)}`);
      // UNCHECKED (NOTES.md): PurchaseOrder filtered by VendorRef and POStatus.
      if (input.vendorId) conds.push(`VendorRef = ${qboLiteral(input.vendorId)}`);
      if (input.status) conds.push(`POStatus = ${qboLiteral(input.status)}`);
      if (input.from) conds.push(`TxnDate >= ${qboLiteral(input.from)}`);
      if (input.to) conds.push(`TxnDate <= ${qboLiteral(input.to)}`);
      const client = await clientFor(ctx);
      const { rows, more } = await page(client, "PurchaseOrder", conds, input, toPurchaseOrder);
      return { purchaseOrders: rows, more };
    },
  });
}
