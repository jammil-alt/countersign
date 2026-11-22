// The AP pack's card and report (Plan entry §1.233). On the card, the week's approve-to-pay list:
// a person approves the ready bills together or one at a time, holds or rejects one with a reason,
// codes a line or takes a suggestion, confirms a proposed order, and marks an order received. A
// flagged bill is approved only with a note (human last). Nothing is paid: the list ends approved.
// The report is the client's weeks and one bill in full, for the portal and the back office: one
// client's, with no agent, prompt or cost (invariant 11).

import { type Tx, withTenant } from "@countersign/db";
import { z } from "zod";
import { type CardDecision, type PackReviewHandler, ReviewError } from "../api";
import {
  ApError,
  apConfig,
  billView,
  codableAccounts,
  decidePayList,
  nextPayDay,
  type PayListDecision,
  payListView,
  payWeeks,
  weekOf,
} from "./store";

export const AP_PAY_LIST_REVIEW = "ap.pay_list";

const Id = z.uuid();
const Week = z.iso.date();
const Payload = z.object({ week: Week });
const Note = z.string().trim().max(1000);
const Decision = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("approve"),
    input: z.strictObject({ billId: Id, note: Note.nullable().optional() }),
  }),
  z.strictObject({
    action: z.literal("hold"),
    input: z.strictObject({ billId: Id, note: Note.min(1) }),
  }),
  z.strictObject({
    action: z.literal("reject"),
    input: z.strictObject({ billId: Id, note: Note.min(1) }),
  }),
  z.strictObject({ action: z.literal("approve_ready"), input: z.strictObject({}) }),
  z.strictObject({
    action: z.literal("code_line"),
    input: z.strictObject({ billLineId: Id, ledgerAccountId: Id }),
  }),
  z.strictObject({ action: z.literal("take_proposal"), input: z.strictObject({ billLineId: Id }) }),
  z.strictObject({ action: z.literal("confirm_order"), input: z.strictObject({ billId: Id }) }),
  z.strictObject({ action: z.literal("not_this_order"), input: z.strictObject({ billId: Id }) }),
  z.strictObject({ action: z.literal("received"), input: z.strictObject({ billId: Id }) }),
]);

/** A pack's refusal as the card's 422; anything else is the route's error. */
async function asReview<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApError) throw new ReviewError(error.message);
    if (error instanceof z.ZodError) {
      throw new ReviewError(error.issues[0]?.message ?? "that decision isn't one this card takes");
    }
    throw error;
  }
}

export const AP_REVIEWS: Readonly<Record<string, PackReviewHandler>> = {
  [AP_PAY_LIST_REVIEW]: {
    async load(tx, tenantId, payload) {
      const p = Payload.parse(payload);
      return {
        list: await payListView(tx, tenantId, p.week),
        accounts: await codableAccounts(tx, tenantId),
      };
    },
    async decide(db, input) {
      if (input.testRun) return;
      await asReview(async () => {
        const p = Payload.parse(input.payload);
        const d = Decision.parse(input.decision as CardDecision) as PayListDecision;
        await withTenant(db, input.tenantId, (tx) =>
          decidePayList(tx, { tenantId: input.tenantId, userId: input.userId }, p.week, d),
        );
      });
    },
  },
};

/** The report's query: one week by its Monday; this week's list when absent. */
const Query = z.object({ week: Week.optional() });

export interface ApReportHandler {
  title: string;
  query: z.ZodType;
  json(
    tx: Tx,
    tenantId: string,
    today: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  csv(tx: Tx, tenantId: string, today: string, query: Record<string, unknown>): Promise<string>;
  item(tx: Tx, tenantId: string, id: string): Promise<Record<string, unknown> | null>;
}

async function billsReport(
  tx: Tx,
  tenantId: string,
  today: string,
  query: Record<string, unknown>,
) {
  const q = Query.parse(query);
  const cfg = await apConfig(tx, tenantId);
  const weeks = await payWeeks(tx, tenantId);
  const current = weekOf(nextPayDay(today, cfg.payDay));
  const week = q.week ?? current;
  return { weeks, current, list: await payListView(tx, tenantId, week) };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // A cell starting with a formula character is quoted and prefixed, so a spreadsheet reads text.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const AP_REPORTS: Readonly<Record<string, ApReportHandler>> = {
  bills: {
    title: "Bills to pay",
    query: Query,
    json: (tx, tenantId, today, query) => billsReport(tx, tenantId, today, query),
    async csv(tx, tenantId, today, query) {
      const r = await billsReport(tx, tenantId, today, query);
      const head = [
        "pay_day",
        "vendor",
        "invoice",
        "invoice_date",
        "due_date",
        "amount",
        "currency",
        "status",
        "ready",
        "order",
        "flags",
        "decided_by",
        "note",
      ];
      const rows = r.list.bills.map((b) =>
        [
          r.list.payDay,
          b.vendorName,
          b.invoiceNumber,
          b.invoiceDate,
          b.dueDate,
          b.amount,
          b.currency,
          b.status,
          b.ready ? "yes" : "no",
          b.order?.reference,
          b.flags.map((f) => f.message).join(" "),
          b.decidedBy,
          b.decisionNote,
        ]
          .map(csvCell)
          .join(","),
      );
      return `${[head.join(","), ...rows].join("\n")}\n`;
    },
    async item(tx, tenantId, id) {
      const parsed = Id.safeParse(id);
      if (!parsed.success) return null;
      try {
        return { bill: await billView(tx, tenantId, parsed.data) };
      } catch (error) {
        if (error instanceof ApError && error.code === "not_found") return null;
        throw error;
      }
    },
  },
};
