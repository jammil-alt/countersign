// `qbo.bill.create` (ARCHITECTURE §6.2 v0.12, docs/plan.md §1.41): a new bill from a vendor's
// invoice, behind approval like every write. Refused when proposed, and again right before writing,
// if its lines don't add up to the expected total, the vendor isn't one of the company's, or a bill
// from the same vendor with the same number already exists (synced, or found live). QuickBooks'
// `requestid` comes from the action's key, so a retried write is answered, not repeated.

import { CurrencyCode, DecimalString, dec } from "@countersign/core";
import { z } from "zod";
import { defineWriteTool, type ToolContext, type ToolDefinition } from "../connector";
import { QboApiError, type QboClient, qboLiteral, qboRequestId } from "./api";
import { billCreateDisplay } from "./display";
import { QboId, type QboTxn, toTxn, toVendor } from "./records";
import {
  type ClientFor,
  IsoDate,
  lineRefsProblem,
  NewLine,
  QBO_STAND_IN,
  QBO_TOOLS,
  QboTotalWouldChangeError,
  RefNames,
  refNames,
  sum,
  wireLine,
} from "./tool-kit";

export const BillCreateInput = z.object({
  /** The vendor, by its QuickBooks id (`qbo.vendor.query`). */
  vendorId: QboId,
  /** The vendor's invoice number, as the bill's number. */
  docNumber: z.string().trim().min(1).max(21),
  txnDate: IsoDate,
  dueDate: IsoDate.optional(),
  currency: CurrencyCode.optional(),
  /** What the lines add up to; the bill is refused if they don't. */
  expectedTotal: DecimalString,
  /** The bill's private note (memo). */
  privateNote: z.string().max(4000).optional(),
  lines: z.array(NewLine).min(1).max(250),
});
export type BillCreateInput = z.infer<typeof BillCreateInput>;

/** A bill refused because one like it is already in QuickBooks. */
export class QboDuplicateBillError extends QboApiError {
  constructor(message: string) {
    super(409, "DUPLICATE_BILL", message, false);
    this.name = "QboDuplicateBillError";
  }
}

/** Letters and digits only, lower case: "INV-20931" and "inv 20931" are the same number. */
// DECISION: document numbers are compared on their letters and digits, as the Bill clerk's match
// does (docs/plan.md §1.30), so a number typed with a different dash or case is still a duplicate.
export function normalizeDocNumber(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function linesProblem(input: BillCreateInput): QboApiError | null {
  const total = sum(input.lines.map((l) => l.amount));
  if (!dec(total).equals(dec(input.expectedTotal))) {
    return new QboTotalWouldChangeError(
      `the lines add up to ${total}, not the ${input.expectedTotal} expected`,
    );
  }
  // P-2: decimal.js counts zero as positive; a total of zero is refused too.
  if (!dec(input.expectedTotal).greaterThan(0)) {
    return new QboApiError(422, "EMPTY_BILL", "a bill's total must be more than zero", false);
  }
  return null;
}

/** The vendor as QuickBooks has it, or a refusal: unknown or inactive isn't the company's. */
export async function companyVendor(
  client: QboClient,
  id: string,
): Promise<{ id: string; name: string }> {
  const raw = await client.read("Vendor", id);
  const v = raw ? toVendor(raw) : null;
  if (!v?.active) {
    throw new QboApiError(
      422,
      "UNKNOWN_VENDOR",
      `vendor ${id} isn't one of this company's vendors in QuickBooks`,
      false,
    );
  }
  return { id: v.id, name: v.name };
}

/** Bills in QuickBooks now from this vendor with this number (compared normalized). */
async function liveBills(client: QboClient, input: BillCreateInput): Promise<QboTxn[]> {
  // UNCHECKED (NOTES.md): `DocNumber =` on Bill matches exactly; the vendor is compared here.
  const { rows } = await client.query(
    `select * from Bill where DocNumber = ${qboLiteral(input.docNumber)} maxresults 100`,
    "Bill",
  );
  const want = normalizeDocNumber(input.docNumber);
  return rows
    .map((r) => toTxn("Bill", r))
    .filter(
      (b) => b.vendor?.id === input.vendorId && normalizeDocNumber(b.docNumber ?? "") === want,
    );
}

/** The synced bills a duplicate would be (the call needs the synced records). */
async function syncedBills(ctx: ToolContext, input: BillCreateInput) {
  const records = ctx.services?.records;
  if (!records) throw new Error("synced records are not available to this call");
  return records.syncedBills({ vendorExternalId: input.vendorId, docNumber: input.docNumber });
}

function duplicate(input: BillCreateInput, where: string): QboDuplicateBillError {
  return new QboDuplicateBillError(
    `a bill ${input.docNumber} from this vendor is already in QuickBooks (${where})`,
  );
}

/** The bill this change would make is the one there: same vendor, number, total and lines. */
// DECISION: a retry after QuickBooks took the bill but the answer was lost finds that bill, the
// same in vendor, number, total and line count; it is reported done, not created again. A bill with
// the same vendor and number that differs is a duplicate and is refused.
function sameBill(b: QboTxn, input: BillCreateInput): boolean {
  return dec(b.total).equals(dec(input.expectedTotal)) && b.lines.length === input.lines.length;
}

export function billCreateTool(clientFor: ClientFor): ToolDefinition {
  return defineWriteTool({
    id: QBO_TOOLS.billCreate,
    entity: "bill",
    description:
      "Create a bill in QuickBooks from a vendor's invoice: vendor, number, dates, lines (an account, or an item with qty and unit price) and the expected total. Refused if the lines don't add up, the vendor isn't the company's, or the bill is already there.",
    verb: "create",
    // R5: none until a qbo.bill.void tool is registered; delete stays off (docs/plan.md §9).
    undo: { kind: "none" },
    summary: "Created bill {{docNumber}} for {{total}}",
    amount: { path: "expectedTotal", currencyPath: "currency", currency: "USD" },
    display: billCreateDisplay,
    input: BillCreateInput,
    output: z.object({
      id: z.string(),
      syncToken: z.string(),
      docNumber: z.string().nullable(),
      total: DecimalString,
      lineCount: z.number().int(),
      alreadyDone: z.boolean(),
    }),
    testOutput: (input) => ({
      ...QBO_STAND_IN,
      docNumber: input.docNumber,
      total: input.expectedTotal,
      lineCount: input.lines.length,
    }),
    // DECISION: a new bill has no prior state; `before` keeps what the approval card names it by
    // (the vendor as QuickBooks has it, the names of the lines' items and accounts).
    beforeSchema: z.object({
      vendor: z.object({ id: z.string(), name: z.string() }),
      names: RefNames,
    }),
    async before(input, ctx) {
      const problem = linesProblem(input);
      if (problem) throw problem;
      const client = await clientFor(ctx);
      const vendor = await companyVendor(client, input.vendorId);
      // P-2: the lines' classes and customers are the company's, and active.
      const refs = await lineRefsProblem(client, input.lines);
      if (refs) throw refs;
      const live = await liveBills(client, input);
      const names = async () => ({ vendor, names: await refNames(client, [], input.lines, ctx) });
      // DECISION: the before state is read twice: when the change is proposed (a plain call
      // context) and right before it is written (the write's context, which carries the action's
      // key). Only then is a bill exactly like this one this action's own earlier write, which
      // `run` reports done; when proposed it is a duplicate like any other.
      if ("idempotencyKey" in ctx && live.some((b) => sameBill(b, input))) return names();
      if ((await syncedBills(ctx, input)).length > 0) throw duplicate(input, "synced");
      if (live.length > 0) throw duplicate(input, "found live");
      return names();
    },
    async run(input, ctx) {
      const problem = linesProblem(input);
      if (problem) throw problem;
      const client = await clientFor(ctx);
      await companyVendor(client, input.vendorId);
      const refs = await lineRefsProblem(client, input.lines);
      if (refs) throw refs;
      const out = (b: QboTxn, alreadyDone: boolean) => ({
        id: b.id,
        syncToken: b.syncToken,
        docNumber: b.docNumber,
        total: b.total,
        lineCount: b.lines.length,
        alreadyDone,
      });
      const live = await liveBills(client, input);
      const ours = live.find((b) => sameBill(b, input));
      if (ours) {
        ctx.logger.info("bill already created", { id: ours.id });
        return out(ours, true);
      }
      if (live.length > 0) throw duplicate(input, "found live");
      if ((await syncedBills(ctx, input)).length > 0) throw duplicate(input, "synced");
      const body = {
        VendorRef: { value: input.vendorId },
        DocNumber: input.docNumber,
        TxnDate: input.txnDate,
        ...(input.dueDate ? { DueDate: input.dueDate } : {}),
        ...(input.currency ? { CurrencyRef: { value: input.currency } } : {}),
        ...(input.privateNote ? { PrivateNote: input.privateNote } : {}),
        Line: input.lines.map((l) => wireLine(l, {})),
      };
      ctx.logger.info("creating a bill", { vendorId: input.vendorId, lines: input.lines.length });
      const answer = (await client.post("/bill", body, {
        requestid: await qboRequestId(ctx.idempotencyKey),
      })) as Record<string, unknown>;
      const bill = toTxn("Bill", answer.Bill);
      if (!dec(bill.total).equals(dec(input.expectedTotal))) {
        // QuickBooks added something (tax) to the bill: a person looks at it.
        throw new QboApiError(
          502,
          "TOTAL_CHANGED",
          `QuickBooks made bill ${bill.id} total ${bill.total}, not ${input.expectedTotal}; check it`,
          false,
        );
      }
      return out(bill, false);
    },
  });
}
