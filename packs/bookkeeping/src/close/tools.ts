// The Close pack's tools (docs/plan.md §1.232), named `close.*`. Each runs for one client in its own
// transaction (`withTenant`). They read or keep the pack's own records (`none`, `internal`); the
// write to QuickBooks is the connector's `qbo.journal.create`, an external tool behind approval
// (invariant 8), which the template's write step calls with `close.entries.ready`'s answer.

import { DecimalString, lazy, lazyObject } from "@countersign/core";
import { withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonSchemaOf, PackRefusal, type PackTool, type PackToolContext } from "../pack";
import { CLOSE_PACK_ID } from "./ids";
import { closePeriod } from "./schema";
import { checkClose, closeConnection, entryWritten, proposeEntry, readyEntries } from "./store";

/** A Close tool, named `close.<what>`, in the Bookkeeping area. */
function defineCloseTool<I extends z.ZodType, O extends z.ZodType>(def: {
  id: `${typeof CLOSE_PACK_ID}.${string}`;
  description: string;
  sideEffect: "none" | "internal";
  verb?: "update";
  summary?: string;
  entity?: string;
  input: I;
  output: O;
  run(input: z.output<I>, ctx: PackToolContext): Promise<z.input<O>>;
}): PackTool {
  return {
    spec: lazyObject({
      id: def.id,
      description: def.description,
      input: lazy(() => jsonSchemaOf(def.input)),
      output: lazy(() => jsonSchemaOf(def.output)),
      sideEffect: def.sideEffect,
      verb: def.sideEffect === "none" ? "read" : (def.verb ?? "create"),
      source: CLOSE_PACK_ID,
      ...(def.summary ? { summary: def.summary } : {}),
      area: "bookkeeping",
      ...(def.entity ? { entity: def.entity } : {}),
    }),
    input: def.input,
    output: def.output,
    run: async (input, ctx) => def.run(def.input.parse(input) as z.output<I>, ctx),
  };
}

const Id = z.uuid();
const Day = z.iso.date();
const Status = z.enum(["open", "done", "waived"]);

export const CheckOutputSchema = z.object({
  periodId: Id,
  month: z.string(),
  periodStart: Day,
  periodEnd: Day,
  status: z.enum(["open", "signed_off"]),
  summary: z.string(),
  open: z.number().int(),
  items: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      status: Status,
      summary: z.string().nullable(),
    }),
  ),
  proposed: z.number().int(),
  posted: z.number().int(),
  added: z.number().int(),
  readyToSignOff: z.boolean(),
});

export const checkTool = defineCloseTool({
  id: "close.check",
  description:
    "Opens the month's close for the client's QuickBooks company (last month unless one is named) and checks it again: each bank and card account reconciled, uncategorized transactions, bills and vendors entered twice, bank transactions not booked, and the journal entries to record. Proposes the reversals of last month's accruals, last month's recurring journals, and accruals for vendors that bill every month and haven't yet. Writes nothing to QuickBooks. A test run keeps nothing.",
  sideEffect: "internal",
  verb: "update",
  entity: "close_period",
  summary: "{{summary}}",
  input: z.object({
    /** The month to close (yyyy-mm); last month in the client's time zone when absent. */
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "a month, yyyy-mm")
      .optional(),
  }),
  output: CheckOutputSchema,
  async run(input, ctx) {
    return withTenant(ctx.db, ctx.tenantId, (tx) =>
      checkClose(
        tx,
        {
          tenantId: ctx.tenantId,
          agentVersionId: ctx.agentVersionId,
          runId: ctx.runId,
          mode: ctx.mode,
        },
        { month: input.month, today: new Date() },
      ),
    );
  },
});

const JournalLine = z.object({
  accountId: z.string(),
  posting: z.enum(["debit", "credit"]),
  amount: DecimalString,
  description: z.string().optional(),
});

export const readyTool = defineCloseTool({
  id: "close.entries.ready",
  description:
    "The month's proposed journal entries with no QuickBooks write laid out yet, each with the journal entry it becomes (qbo.journal.create's input).",
  sideEffect: "none",
  summary: "{{count}} journal entries to record",
  input: z.object({ periodId: Id }),
  output: z.object({
    count: z.number().int(),
    entries: z.array(
      z.object({
        entryId: Id,
        kind: z.enum(["accrual", "reversal", "recurring"]),
        memo: z.string(),
        amount: DecimalString,
        journal: z.object({
          txnDate: Day,
          currency: z.string(),
          expectedTotal: DecimalString,
          privateNote: z.string(),
          reference: z.string(),
          lines: z.array(JournalLine),
        }),
      }),
    ),
  }),
  async run(input, ctx) {
    const entries = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      readyEntries(tx, ctx.tenantId, input.periodId),
    );
    return { count: entries.length, entries };
  },
});

export const writtenTool = defineCloseTool({
  id: "close.entry.written",
  description:
    "Records what an entry's QuickBooks write became: its journal entry id, or, when the write wasn't made, what the person decided.",
  sideEffect: "internal",
  verb: "update",
  entity: "close_entry",
  summary: "Recorded the entry as {{status}}",
  input: z.object({ entryId: Id, qboId: z.string().min(1).nullable().optional() }),
  output: z.object({ status: z.string() }),
  async run(input, ctx) {
    if (ctx.mode === "test") return { status: input.qboId ? "posted" : "proposed" };
    return withTenant(ctx.db, ctx.tenantId, (tx) =>
      entryWritten(tx, ctx.tenantId, input.entryId, input.qboId ?? null),
    );
  },
});

export const proposeTool = defineCloseTool({
  id: "close.entry.propose",
  description:
    "Proposes one journal entry for the month's close (an accrual or a recurring journal): its date, memo, why, balanced debit and credit lines to the client's accounts (ledger account ids), and the records it rests on. Refused without sources or when the lines don't balance. Nothing is written to QuickBooks until a person signs its write.",
  sideEffect: "internal",
  entity: "close_entry",
  summary: "Proposed a journal entry: {{memo}}",
  input: z.object({
    periodId: Id,
    kind: z.enum(["accrual", "recurring"]),
    /** Stable across months for a recurring journal (`recurring:<name>`). */
    key: z
      .string()
      .regex(/^[a-z0-9:_-]{3,80}$/)
      .optional(),
    txnDate: Day,
    /** An accrual reverses on this day (usually the next month's first). */
    reverseOn: Day.optional(),
    memo: z.string().min(1).max(400),
    reason: z.string().min(1).max(500),
    lines: z
      .array(
        z.object({
          ledgerAccountId: Id,
          posting: z.enum(["debit", "credit"]),
          amount: DecimalString,
          description: z.string().max(200).optional(),
        }),
      )
      .min(2)
      .max(20),
    /** Record ids the entry rests on (invariant 10). */
    sources: z.array(z.string().min(1)).min(1).max(50),
  }),
  output: z.object({ entryId: Id.nullable(), memo: z.string(), proposed: z.boolean() }),
  async run(input, ctx) {
    return withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const [p] = await tx
        .select()
        .from(closePeriod)
        .where(and(eq(closePeriod.id, input.periodId), eq(closePeriod.tenantId, ctx.tenantId)));
      if (!p) throw new PackRefusal(`close ${input.periodId} isn't this client's`);
      if (p.status === "signed_off") throw new PackRefusal("that month is signed off");
      if (input.txnDate < p.periodStart || input.txnDate > p.periodEnd) {
        throw new PackRefusal(`the entry's date isn't in ${p.periodStart} to ${p.periodEnd}`);
      }
      const conn = await closeConnection(tx, ctx.tenantId);
      if (!conn || conn.id !== p.connectionId) {
        throw new PackRefusal("that month's QuickBooks company isn't connected");
      }
      const entry = {
        tenantId: ctx.tenantId,
        periodId: p.id,
        kind: input.kind,
        entryKey:
          input.key ??
          `${input.kind}:${input.memo
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 60)}`,
        proposedBy: "model" as const,
        txnDate: input.txnDate,
        reverseOn: input.kind === "accrual" ? (input.reverseOn ?? null) : null,
        currency: p.currency,
        memo: input.memo,
        reason: input.reason,
        sources: input.sources,
        agentVersionId: ctx.agentVersionId,
        runId: ctx.runId,
        lines: input.lines,
      };
      if (ctx.mode === "test") return { entryId: null, memo: input.memo, proposed: false };
      const id = await proposeEntry(tx, entry, p.connectionId);
      return { entryId: id, memo: input.memo, proposed: id !== null };
    });
  },
});

export const CLOSE_TOOLS: readonly PackTool[] = [checkTool, readyTool, writtenTool, proposeTool];
