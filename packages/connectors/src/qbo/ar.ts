// Accounts receivable tools (ARCHITECTURE §6.2 v0.12, docs/plan.md §1.41): live reads of invoices,
// customers and payments, QuickBooks' A/R aging report as of a date (with the receivables it rests
// on as sources), and the one AR write, `qbo.invoice.add_note`, which appends a dated line to an
// invoice's private note and touches nothing else. Invoice and customer text (notes, names) is
// client data and stays in tool results (invariant 9).

import { DecimalString, dec, qboAmount, toNumeric } from "@countersign/core";
import { z } from "zod";
import { defineReadTool, defineWriteTool, type ToolDefinition } from "../connector";
import { QboApiError, type QboClient, qboLiteral, qboRequestId } from "./api";
import { addNoteDisplay } from "./display";
import {
  QboCustomer,
  QboId,
  QboInvoice,
  QboPayment,
  SyncToken,
  toCustomer,
  toInvoice,
  toPayment,
} from "./records";
import { type ClientFor, IsoDate, notFound, Page, page, QBO_TOOLS, stale } from "./tool-kit";

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────

function invoiceQueryTool(clientFor: ClientFor): ToolDefinition {
  return defineReadTool({
    id: QBO_TOOLS.invoiceQuery,
    entity: "invoice",
    description:
      "Find invoices to customers in QuickBooks by id, customer, number or date; open or overdue only if asked. Each has its total, open balance, due date and SyncToken.",
    summary: "Found {{invoices.length}} invoices",
    input: z.object({
      ids: z.array(QboId).min(1).max(30).optional(),
      customerId: QboId.optional(),
      docNumber: z.string().min(1).max(21).optional(),
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      /** Only invoices with a balance still open. */
      open: z.boolean().optional(),
      /** Only open invoices due before this day (overdue as of it). */
      dueBefore: IsoDate.optional(),
      ...Page,
    }),
    output: z.object({ invoices: z.array(QboInvoice), more: z.boolean() }),
    async run(input, ctx) {
      const conds: string[] = [];
      if (input.ids) conds.push(`Id in (${input.ids.map(qboLiteral).join(", ")})`);
      // UNCHECKED (NOTES.md): Invoice filters on CustomerRef, Balance and DueDate.
      if (input.customerId) conds.push(`CustomerRef = ${qboLiteral(input.customerId)}`);
      if (input.docNumber) conds.push(`DocNumber = ${qboLiteral(input.docNumber)}`);
      if (input.from) conds.push(`TxnDate >= ${qboLiteral(input.from)}`);
      if (input.to) conds.push(`TxnDate <= ${qboLiteral(input.to)}`);
      if (input.open || input.dueBefore) conds.push(`Balance > '0'`);
      if (input.dueBefore) conds.push(`DueDate < ${qboLiteral(input.dueBefore)}`);
      const { rows, more } = await page(await clientFor(ctx), "Invoice", conds, input, toInvoice);
      return { invoices: rows, more };
    },
  });
}

function customerQueryTool(clientFor: ClientFor): ToolDefinition {
  return defineReadTool({
    id: QBO_TOOLS.customerQuery,
    entity: "customer",
    description:
      "Find customers in QuickBooks by name, or list them, with what each owes (open balance).",
    summary: "Found {{customers.length}} customers",
    input: z.object({
      ids: z.array(QboId).min(1).max(30).optional(),
      name: z.string().min(1).max(100).optional(),
      ...Page,
    }),
    output: z.object({ customers: z.array(QboCustomer), more: z.boolean() }),
    async run(input, ctx) {
      const conds: string[] = [];
      if (input.ids) conds.push(`Id in (${input.ids.map(qboLiteral).join(", ")})`);
      if (input.name) conds.push(`DisplayName like ${qboLiteral(`%${input.name}%`)}`);
      const { rows, more } = await page(
        await clientFor(ctx),
        "Customer",
        conds,
        input,
        toCustomer,
        "DisplayName",
      );
      return { customers: rows, more };
    },
  });
}

function paymentQueryTool(clientFor: ClientFor): ToolDefinition {
  return defineReadTool({
    id: QBO_TOOLS.paymentQuery,
    entity: "payment",
    description:
      "Find payments received from customers in QuickBooks by id, customer or date, with the invoices each paid.",
    summary: "Found {{payments.length}} payments",
    input: z.object({
      ids: z.array(QboId).min(1).max(30).optional(),
      customerId: QboId.optional(),
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      ...Page,
    }),
    output: z.object({ payments: z.array(QboPayment), more: z.boolean() }),
    async run(input, ctx) {
      const conds: string[] = [];
      if (input.ids) conds.push(`Id in (${input.ids.map(qboLiteral).join(", ")})`);
      if (input.customerId) conds.push(`CustomerRef = ${qboLiteral(input.customerId)}`);
      if (input.from) conds.push(`TxnDate >= ${qboLiteral(input.from)}`);
      if (input.to) conds.push(`TxnDate <= ${qboLiteral(input.to)}`);
      const { rows, more } = await page(await clientFor(ctx), "Payment", conds, input, toPayment);
      return { payments: rows, more };
    },
  });
}

// ── The aging report ────────────────────────────────────────────────────────────────────────────

export const AGING_BUCKETS = [
  "current",
  "days_1_30",
  "days_31_60",
  "days_61_90",
  "days_91_plus",
] as const;
export const AgingBucket = z.enum(AGING_BUCKETS);
export type AgingBucket = z.infer<typeof AgingBucket>;

const BucketTotals = z.object({
  current: DecimalString,
  days_1_30: DecimalString,
  days_31_60: DecimalString,
  days_61_90: DecimalString,
  days_91_plus: DecimalString,
  total: DecimalString,
});
type BucketTotals = z.infer<typeof BucketTotals>;

const AgingInvoice = z.object({
  invoiceId: z.string(),
  /** Our receivable for it, when sync has stored it (cite it as a source). */
  receivableId: z.string().nullable(),
  docNumber: z.string().nullable(),
  customer: z.object({ id: z.string().nullable(), name: z.string() }),
  txnDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  amount: DecimalString.nullable(),
  balance: DecimalString,
  bucket: AgingBucket,
});
type AgingInvoice = z.infer<typeof AgingInvoice>;

export const AgingReport = z.object({
  asOf: z.string(),
  currency: z.string(),
  invoices: z.array(AgingInvoice),
  customers: z.array(
    z
      .object({ customer: z.object({ id: z.string().nullable(), name: z.string() }) })
      .extend(BucketTotals.shape),
  ),
  totals: BucketTotals,
  /** The receivables the report rests on (invariant 10). */
  sources: z.array(z.string()),
});
export type AgingReport = z.infer<typeof AgingReport>;

/** A section of QuickBooks' report → our bucket, by its title ("31 - 60 days past due"). */
// UNCHECKED (NOTES.md): the AgedReceivableDetail section titles.
export function agingBucketOf(title: string): AgingBucket | null {
  const t = title.trim().toLowerCase();
  if (t.startsWith("total") || t === "") return null;
  if (t.startsWith("current")) return "current";
  const from = /^(\d+)/.exec(t)?.[1];
  if (from === undefined) return null;
  const n = Number(from);
  if (n <= 1) return "days_1_30";
  if (n <= 31) return "days_31_60";
  if (n <= 61) return "days_61_90";
  return "days_91_plus";
}

const Cell = z.looseObject({ value: z.string().optional(), id: z.string().optional() });
type ReportRow = {
  type?: string;
  Header?: { ColData?: z.infer<typeof Cell>[] };
  ColData?: z.infer<typeof Cell>[];
  Rows?: { Row?: ReportRow[] };
};
const ReportAnswer = z.looseObject({
  Header: z.looseObject({ Currency: z.string().optional() }).optional(),
  Columns: z
    .looseObject({
      Column: z.array(
        z.looseObject({
          ColTitle: z.string().optional(),
          MetaData: z.array(z.looseObject({ Name: z.string(), Value: z.string() })).optional(),
        }),
      ),
    })
    .optional(),
  Rows: z.looseObject({ Row: z.array(z.unknown()).optional() }).optional(),
});

function emptyTotals(): BucketTotals {
  return {
    current: "0.0000",
    days_1_30: "0.0000",
    days_31_60: "0.0000",
    days_61_90: "0.0000",
    days_91_plus: "0.0000",
    total: "0.0000",
  };
}

function addTo(t: BucketTotals, bucket: AgingBucket, amount: string) {
  t[bucket] = toNumeric(dec(t[bucket]).plus(dec(amount)));
  t.total = toNumeric(dec(t.total).plus(dec(amount)));
}

/**
 * QuickBooks' AgedReceivableDetail answer → each open invoice with its bucket and balance, totals
 * per customer and overall. Columns are found by their keys (`ColKey`), so their order doesn't
 * matter; rows that aren't invoices (credit memos, journal entries) are left out.
 */
// DECISION: the report lists every open A/R transaction; the tool keeps invoices only (ARCHITECTURE
// §6.2: "each open invoice and its bucket"), and its totals are those invoices' balances.
export function readAgingReport(
  answer: unknown,
  asOf: string,
): Omit<AgingReport, "sources" | "invoices"> & { invoices: Omit<AgingInvoice, "receivableId">[] } {
  const body = ReportAnswer.parse(answer);
  const keys = (body.Columns?.Column ?? []).map(
    (c) => c.MetaData?.find((m) => m.Name === "ColKey")?.Value ?? c.ColTitle ?? "",
  );
  const col = (key: string) => keys.indexOf(key);
  const at = {
    date: col("tx_date"),
    type: col("txn_type"),
    num: col("doc_num"),
    customer: col("cust_name"),
    due: col("due_date"),
    amount: col("subt_amount"),
    open: col("subt_open_bal"),
  };
  if (at.type < 0 || at.open < 0) {
    throw new QboApiError(
      502,
      "REPORT_SHAPE",
      "QuickBooks' aging report has no balance column",
      false,
    );
  }
  const invoices: Omit<AgingInvoice, "receivableId">[] = [];
  const walk = (rows: ReportRow[], bucket: AgingBucket | null) => {
    for (const row of rows) {
      const title = row.Header?.ColData?.[0]?.value;
      const here = title !== undefined ? (agingBucketOf(title) ?? bucket) : bucket;
      if (row.Rows?.Row) walk(row.Rows.Row, here);
      const cells = row.ColData;
      if (!cells || row.type === "Section" || here === null) continue;
      const cell = (i: number) => (i >= 0 ? cells[i] : undefined);
      const type = cell(at.type);
      if (type?.value !== "Invoice" || !type.id) continue;
      let balance: string;
      let amount: string | null;
      try {
        balance = qboAmount(cell(at.open)?.value);
        const a = cell(at.amount)?.value;
        amount = a ? qboAmount(a) : null;
      } catch {
        continue;
      }
      const date = (i: number) => {
        const v = cell(i)?.value;
        return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
      };
      invoices.push({
        invoiceId: type.id,
        docNumber: cell(at.num)?.value || null,
        customer: { id: cell(at.customer)?.id ?? null, name: cell(at.customer)?.value ?? "" },
        txnDate: date(at.date),
        dueDate: date(at.due),
        amount,
        balance,
        bucket: here,
      });
    }
  };
  walk((body.Rows?.Row ?? []) as ReportRow[], null);
  const totals = emptyTotals();
  const byCustomer = new Map<string, AgingReport["customers"][number]>();
  for (const inv of invoices) {
    addTo(totals, inv.bucket, inv.balance);
    const key = inv.customer.id ?? `name:${inv.customer.name}`;
    let c = byCustomer.get(key);
    if (!c) {
      c = { customer: inv.customer, ...emptyTotals() };
      byCustomer.set(key, c);
    }
    addTo(c, inv.bucket, inv.balance);
  }
  return {
    asOf,
    currency: (body.Header?.Currency ?? "USD").toUpperCase(),
    invoices,
    customers: [...byCustomer.values()],
    totals,
  };
}

function agingReportTool(clientFor: ClientFor): ToolDefinition {
  return defineReadTool({
    id: QBO_TOOLS.agingReport,
    entity: "invoice",
    description:
      "QuickBooks' accounts receivable aging report as of a day (today if not given): each open invoice with its open balance and how overdue it is (current, 1-30, 31-60, 61-90, 91+ days), with totals per customer. Cite `sources`.",
    summary: "{{invoices.length}} open invoices, {{totals.total}} owed",
    input: z.object({ asOf: IsoDate.optional(), customerId: QboId.optional() }),
    output: AgingReport,
    async run(input, ctx) {
      const records = ctx.services?.records;
      // The report's sources are our receivables: without the synced records there are none.
      if (!records) throw new Error("synced records are not available to this call");
      const asOf = input.asOf ?? ctx.now().toISOString().slice(0, 10);
      const client: QboClient = await clientFor(ctx);
      // UNCHECKED (NOTES.md): the report's name, `report_date`, `aging_method` and `customer`.
      const answer = await client.get("/reports/AgedReceivableDetail", {
        report_date: asOf,
        aging_method: "Report_Date",
        ...(input.customerId ? { customer: input.customerId } : {}),
      });
      const report = readAgingReport(answer, asOf);
      const ids = await records.receivableIds([
        ...new Set(report.invoices.map((i) => i.invoiceId)),
      ]);
      const invoices = report.invoices.map((i) => ({
        ...i,
        receivableId: ids[i.invoiceId] ?? null,
      }));
      return {
        ...report,
        invoices,
        sources: [
          ...new Set(invoices.map((i) => i.receivableId).filter((x): x is string => x !== null)),
        ],
      };
    },
  });
}

// ── The invoice's private note ──────────────────────────────────────────────────────────────────

/** QuickBooks' limit on PrivateNote. */
// UNCHECKED (NOTES.md): 4000 characters.
export const QBO_PRIVATE_NOTE_MAX = 4000;

/** A note as one line: line breaks and runs of spaces become one space. */
// DECISION: the note is one line, so the private note stays one dated line per note.
export function noteLine(day: string, note: string): string {
  return `${day}: ${note.replace(/\s+/g, " ").trim()}`;
}

/** The private note after appending a line (on a new line, unless it was empty). */
export function appendNote(current: string | null, line: string): string {
  const now = current?.replace(/\s+$/, "") ?? "";
  return now ? `${now}\n${line}` : line;
}

const AddNoteBefore = z.object({
  id: z.string(),
  syncToken: z.string(),
  docNumber: z.string().nullable(),
  customer: z.object({ id: z.string(), name: z.string().nullable() }),
  privateNote: z.string().nullable(),
  /** What the private note reads after the change, for the approval card. */
  privateNoteAfter: z.string(),
  balance: DecimalString,
  currency: z.string(),
  dueDate: z.string().nullable(),
});

function tooLong(id: string, length: number): QboApiError {
  return new QboApiError(
    422,
    "NOTE_TOO_LONG",
    `invoice ${id}'s private note would be ${length} characters; QuickBooks keeps at most ${QBO_PRIVATE_NOTE_MAX}`,
    false,
  );
}

function addNoteTool(clientFor: ClientFor): ToolDefinition {
  return defineWriteTool({
    id: QBO_TOOLS.invoiceAddNote,
    entity: "invoice",
    description:
      "Add a dated line to a QuickBooks invoice's private note (only people in the company see it). Nothing else on the invoice changes.",
    verb: "update",
    summary: "Added a note to invoice {{docNumber}}",
    display: addNoteDisplay,
    input: z.object({
      invoiceId: QboId,
      note: z.string().trim().min(1).max(1000),
      /** The SyncToken the agent read: the write is refused if the invoice changed since. */
      syncToken: SyncToken,
    }),
    output: z.object({
      id: z.string(),
      syncToken: z.string(),
      docNumber: z.string().nullable(),
      privateNote: z.string().nullable(),
      alreadyDone: z.boolean(),
    }),
    beforeSchema: AddNoteBefore,
    async before(input, ctx) {
      const raw = await (await clientFor(ctx)).read("Invoice", input.invoiceId);
      if (!raw) return null;
      const inv = toInvoice(raw);
      const after = appendNote(
        inv.privateNote,
        noteLine(ctx.now().toISOString().slice(0, 10), input.note),
      );
      if (inv.syncToken === input.syncToken && after.length > QBO_PRIVATE_NOTE_MAX) {
        throw tooLong(inv.id, after.length);
      }
      return {
        id: inv.id,
        syncToken: inv.syncToken,
        docNumber: inv.docNumber,
        customer: inv.customer,
        privateNote: inv.privateNote,
        privateNoteAfter: after,
        balance: inv.balance,
        currency: inv.currency,
        dueDate: inv.dueDate,
      };
    },
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const raw = await client.read("Invoice", input.invoiceId);
      if (!raw) throw notFound("Invoice", input.invoiceId);
      const inv = toInvoice(raw);
      const line = noteLine(ctx.now().toISOString().slice(0, 10), input.note);
      const out = (i: typeof inv, alreadyDone: boolean) => ({
        id: i.id,
        syncToken: i.syncToken,
        docNumber: i.docNumber,
        privateNote: i.privateNote,
        alreadyDone,
      });
      if (inv.syncToken !== input.syncToken) {
        // DECISION: a retry after QuickBooks took the note but the answer was lost finds the note
        // as the private note's last line (any day): nothing more to do. Anything else is stale.
        const last = (inv.privateNote ?? "").trimEnd().split("\n").at(-1) ?? "";
        if (last.replace(/^\d{4}-\d{2}-\d{2}: /, "") === line.replace(/^\d{4}-\d{2}-\d{2}: /, "")) {
          ctx.logger.info("note already added", { id: inv.id });
          return out(inv, true);
        }
        throw stale("Invoice", input.invoiceId, input.syncToken, inv.syncToken);
      }
      const note = appendNote(inv.privateNote, line);
      if (note.length > QBO_PRIVATE_NOTE_MAX) throw tooLong(inv.id, note.length);
      // Only the private note: a sparse update with nothing else, so no other field can move.
      const answer = (await client.post(
        "/invoice",
        { Id: inv.id, SyncToken: inv.syncToken, sparse: true, PrivateNote: note },
        { requestid: await qboRequestId(ctx.idempotencyKey) },
      )) as Record<string, unknown>;
      const after = toInvoice(answer.Invoice);
      if (
        !dec(after.total).equals(dec(inv.total)) ||
        !dec(after.balance).equals(dec(inv.balance))
      ) {
        throw new QboApiError(
          502,
          "INVOICE_CHANGED",
          `QuickBooks changed invoice ${inv.id}'s amounts while adding a note; check it`,
          false,
        );
      }
      return out(after, false);
    },
  });
}

/** The AR tools: four reads and the note. */
export function qboArTools(clientFor: ClientFor): ToolDefinition[] {
  return [
    invoiceQueryTool(clientFor),
    customerQueryTool(clientFor),
    paymentQueryTool(clientFor),
    agingReportTool(clientFor),
    addNoteTool(clientFor),
  ];
}
