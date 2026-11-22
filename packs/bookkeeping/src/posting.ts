// B-4 (docs/plan.md §1.79): approved bookings into the accounting tool. The pack never writes there
// itself (invariant 8): `bookkeeping.booking.qbo-input` lays out the write a QuickBooks tool makes
// (`qbo.purchase.create`, `qbo.deposit.create`, `qbo.transfer.create`, each behind approval) and
// `bookkeeping.booking.posted` records what it became.

import { BANKING_TOOLS } from "@countersign/connectors";
import { dec } from "@countersign/core";
import {
  externalAction,
  ledgerAccount,
  type Tx,
  transaction,
  vendor,
  withTenant,
} from "@countersign/db";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { holdPaired, MONEY_KINDS, resentChain, resentWritten } from "./bookings";
import { defineTool, PackRefusal, type PackTool } from "./pack";
import { bankAccountLink, bankTxn, booking, bookingLine } from "./schema";

const Id = z.string().uuid();
const cents = (v: string) => dec(v).toFixed(2);

/** The reference records written before 2026-11-17 carry (`[Mezonas bk-<booking id>]`). */
export const bookingReference = (bookingId: string) => `bk-${bookingId}`;
/**
 * The reference a booking's record carries in the accounting tool (`[Mezonas bt-<bank transaction
 * id>]`): every booking of one bank transaction carries the same, so a write made for an earlier
 * booking of it and never recorded (a run stopped after the write) is found as already written,
 * not made again, when the transaction is booked again.
 */
// DECISION: per bank transaction rather than per booking, so the connector's own check ("a record
// with this reference is this action's earlier write") covers re-bookings with no new field on
// the write steps (whose versions are fixed).
export const txnReference = (bankTxnId: string) => `bt-${bankTxnId}`;
/** A record's mark in its memo, as POSIX patterns: the transaction's, and a booking's (before). */
const TXN_MARK = "\\[Mezonas bt-([0-9a-f-]{36})\\]";
const BOOKING_MARK = "\\[Mezonas bk-([0-9a-f-]{36})\\]";

export const readyTool = defineTool({
  id: "bookkeeping.bookings.ready",
  description:
    "Lists the bookings on accounts set to book that are proposed or approved and not in the accounting tool yet, oldest first, for the write steps (each write waits for a person's signature).",
  sideEffect: "none",
  entity: "booking",
  input: z.object({ limit: z.number().int().min(1).max(50).default(25) }),
  output: z.object({
    bookings: z.array(z.object({ bookingId: z.string(), kind: z.string() })),
    count: z.number(),
  }),
  async run(input, ctx) {
    const rows = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      tx
        .select({ id: booking.id, kind: booking.kind })
        .from(booking)
        .innerJoin(
          bankTxn,
          and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
        )
        .innerJoin(
          bankAccountLink,
          and(
            eq(bankAccountLink.id, bankTxn.accountLinkId),
            eq(bankAccountLink.tenantId, bankTxn.tenantId),
          ),
        )
        .where(
          and(
            eq(booking.tenantId, ctx.tenantId),
            // DECISION: a proposal (a rule's, or a model's at or above the threshold) is ready
            // too: the QuickBooks write waits for a person's signature (invariant 8), and that
            // signature is the approval. What a person must choose first is `needs_review`.
            inArray(booking.status, ["proposed", "approved"]),
            inArray(booking.kind, ["expense", "deposit", "transfer"]),
            inArray(bankTxn.status, ["proposed", "approved"]),
            eq(bankAccountLink.mode, "book"),
            // An earlier copy the bank removed and sent again: a person decides on the copy.
            sql`${bankTxn.ext} ->> 'resentAs' is null`,
          ),
        )
        .orderBy(asc(bankTxn.txnDate), asc(booking.id))
        .limit(input.limit),
    );
    return { bookings: rows.map((r) => ({ bookingId: r.id, kind: r.kind })), count: rows.length };
  },
});

const PurchaseInput = z.object({
  accountId: z.string(),
  paymentType: z.enum(["Cash", "Check", "CreditCard"]),
  credit: z.boolean(),
  vendorId: z.string().optional(),
  txnDate: z.string(),
  currency: z.string(),
  expectedTotal: z.string(),
  privateNote: z.string().optional(),
  reference: z.string(),
  lines: z.array(
    z.object({
      accountId: z.string(),
      amount: z.string(),
      description: z.string().optional(),
      classId: z.string().optional(),
    }),
  ),
});
const DepositInput = PurchaseInput.omit({ paymentType: true, credit: true, vendorId: true });
const TransferInput = z.object({
  fromAccountId: z.string(),
  toAccountId: z.string(),
  amount: z.string(),
  txnDate: z.string(),
  privateNote: z.string().optional(),
  reference: z.string(),
});

const Entity = z.enum(["purchase", "deposit", "transfer"]);

/** One proposed or approved booking as the QuickBooks write it needs. */
export async function qboInput(tx: Tx, tenantId: string, bookingId: string) {
  const [row] = await tx
    .select({ b: booking, t: bankTxn, l: bankAccountLink })
    .from(booking)
    .innerJoin(
      bankTxn,
      and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
    )
    .innerJoin(
      bankAccountLink,
      and(
        eq(bankAccountLink.id, bankTxn.accountLinkId),
        eq(bankAccountLink.tenantId, bankTxn.tenantId),
      ),
    )
    .where(and(eq(booking.tenantId, tenantId), eq(booking.id, bookingId)));
  if (!row) throw new PackRefusal(`booking ${bookingId} isn't one of this client's`);
  const { b, t, l } = row;
  if (b.status !== "approved" && b.status !== "proposed") {
    throw new PackRefusal(`booking ${b.id} is ${b.status}: nothing to write`);
  }
  if (t.status !== "approved" && t.status !== "proposed") {
    throw new PackRefusal(`transaction ${t.id} is ${t.status}: a person decides it first`);
  }
  if (typeof (t.ext as { resentAs?: unknown }).resentAs === "string") {
    throw new PackRefusal(
      `transaction ${t.id} was removed and sent again by the bank: a person decides the new copy`,
    );
  }
  // A copy the bank sent again: a record written for any earlier copy is this money's too.
  const ids = await resentChain(tx, tenantId, t.id);
  if (l.mode !== "book" || !l.ledgerAccountId) {
    throw new PackRefusal(
      `${l.name ?? "this account"} isn't set to book: approve and add it yourself`,
    );
  }
  const ledger = async (id: string) => {
    const [a] = await tx
      .select()
      .from(ledgerAccount)
      .where(and(eq(ledgerAccount.tenantId, tenantId), eq(ledgerAccount.id, id)));
    if (!a?.active) throw new PackRefusal(`account ${id} is no longer active`);
    if (a.connector !== "qbo") throw new PackRefusal(`${a.fullName} isn't a QuickBooks account`);
    return a;
  };
  const money = await ledger(l.ledgerAccountId);
  const lines = await tx
    .select()
    .from(bookingLine)
    .where(and(eq(bookingLine.tenantId, tenantId), eq(bookingLine.bookingId, b.id)))
    .orderBy(asc(bookingLine.lineNo));
  const lineAccounts: Awaited<ReturnType<typeof ledger>>[] = [];
  for (const line of lines) lineAccounts.push(await ledger(line.ledgerAccountId));
  const memo = (b.memo ?? t.payee ?? "").trim().slice(0, 200) || undefined;
  const reference = txnReference(t.id);
  const sources = [b.id, t.rawRecordId];
  // The marks a write of this money carries, this transaction's first, then its earlier copies':
  // what the read of QuickBooks before a write looks for (`qbo.banking.find`, §1.187).
  const references = [t.id, ...ids.filter((id) => id !== t.id)].slice(0, 20).map(txnReference);
  const common = { txnDate: t.txnDate, references, sources };
  // A record already written for this transaction, of any kind, synced back: under its reference
  // (a write nobody recorded, perhaps for a booking of another kind since) or under the old
  // per-booking reference of one of its bookings. It is in the accounting tool already, and isn't
  // written again.
  const [written] = await tx
    .select({ ext: transaction.ext })
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        sql`coalesce((${transaction.ext} -> 'qbo' ->> 'deleted')::boolean, false) = false`,
        or(
          sql`substring(coalesce(${transaction.memo}, '') from ${TXN_MARK}::text) in (${sql.join(
            ids.map((id) => sql`${id}::text`),
            sql`, `,
          )})`,
          sql`substring(coalesce(${transaction.memo}, '') from ${BOOKING_MARK}::text) in (select e.id::text from ${booking} e where e.tenant_id = ${tenantId} and e.bank_txn_id::text in (${sql.join(
            ids.map((id) => sql`${id}::text`),
            sql`, `,
          )}))`,
        ),
      ),
    )
    .limit(1);
  if (written) {
    const q = (written.ext as { qbo?: { entity?: string; id?: string } }).qbo ?? {};
    throw new PackRefusal(
      `this transaction is already in QuickBooks (${q.entity ?? "record"} ${q.id ?? ""}): leave it out, or change that record there`,
    );
  }
  if (b.kind === "transfer") {
    const other = lineAccounts[0];
    if (!other || lines.length !== 1) throw new PackRefusal("a transfer has one line");
    const [from, to] = t.direction === "out" ? [money, other] : [other, money];
    return {
      entity: "transfer" as const,
      tool: BANKING_TOOLS.transferCreate,
      purchase: null,
      deposit: null,
      transfer: {
        fromAccountId: from.externalId,
        toAccountId: to.externalId,
        amount: cents(t.amount),
        txnDate: t.txnDate,
        ...(memo ? { privateNote: memo } : {}),
        reference,
      },
      ...common,
    };
  }
  const wireLines = lines.map((line, i) => ({
    accountId: lineAccounts[i]?.externalId ?? "",
    amount: cents(line.amount),
    ...(line.description ? { description: line.description } : {}),
    ...(line.classRef ? { classId: line.classRef } : {}),
  }));
  const isCard = money.kind === "card";
  // Money back onto a card (a refund) is a card credit in QuickBooks, not a deposit.
  if (b.kind === "expense" || (b.kind === "deposit" && isCard)) {
    let vendorId: string | undefined;
    if (b.vendorId) {
      const [v] = await tx
        .select({ refs: vendor.externalRefs })
        .from(vendor)
        .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, b.vendorId)));
      const ref = (v?.refs as { qbo?: unknown } | undefined)?.qbo;
      if (typeof ref === "string") vendorId = ref;
    }
    return {
      entity: "purchase" as const,
      tool: BANKING_TOOLS.purchaseCreate,
      purchase: {
        accountId: money.externalId,
        paymentType: isCard ? ("CreditCard" as const) : ("Cash" as const),
        credit: t.direction === "in",
        ...(vendorId ? { vendorId } : {}),
        txnDate: t.txnDate,
        currency: t.currency,
        expectedTotal: cents(t.amount),
        ...(memo ? { privateNote: memo } : {}),
        reference,
        lines: wireLines,
      },
      deposit: null,
      transfer: null,
      ...common,
    };
  }
  if (!MONEY_KINDS.includes(money.kind)) {
    throw new PackRefusal(`${money.fullName} can't take a deposit`);
  }
  return {
    entity: "deposit" as const,
    tool: BANKING_TOOLS.depositCreate,
    purchase: null,
    deposit: {
      accountId: money.externalId,
      txnDate: t.txnDate,
      currency: t.currency,
      expectedTotal: cents(t.amount),
      ...(memo ? { privateNote: memo } : {}),
      reference,
      lines: wireLines.map(({ accountId, amount, description, classId }) => ({
        accountId,
        amount,
        ...(description ? { description } : {}),
        ...(classId ? { classId } : {}),
      })),
    },
    transfer: null,
    ...common,
  };
}

export const qboInputTool = defineTool({
  id: "bookkeeping.booking.qbo-input",
  description:
    "Lays out one approved booking as the QuickBooks write it needs: `entity` says which (purchase, deposit or transfer) and that field holds the write's input.",
  sideEffect: "none",
  entity: "booking",
  input: z.object({ bookingId: Id }),
  output: z.object({
    entity: Entity,
    tool: z.string(),
    purchase: PurchaseInput.nullable(),
    deposit: DepositInput.nullable(),
    transfer: TransferInput.nullable(),
    /** The bank transaction's day, and the marks a write of it carries (its own first). */
    txnDate: z.string(),
    references: z.array(z.string()),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    return withTenant(ctx.db, ctx.tenantId, (tx) => qboInput(tx, ctx.tenantId, input.bookingId));
  },
});

/** A write that is made or will be: laid out for a signature, signed, being made or made. */
const MADE_OR_WAITING = sql`${externalAction.status} in ('proposed', 'approved', 'executing', 'done')`;
/** A write that is done, or may be: laid out for a signature, signed, being made, made or unsure. */
const LIVE_WRITE = sql`(${MADE_OR_WAITING} or (${externalAction.status} = 'failed' and coalesce((${externalAction.error} ->> 'notWritten')::boolean, false) = false))`;

/**
 * docs/plan.md §1.187: right before a booking's write, the other copies of its bank transaction
 * (the chain the bank re-sent it along) are read again. One posted, or one whose write is laid
 * out for a signature, signed, being made, made or perhaps made, is this money already: this
 * copy's write is refused, with why for the person, and nothing is written. So is a write of this
 * same transaction for an earlier booking of it (a person booked it again while that write
 * waited): every booking of one transaction carries its mark.
 */
// DECISION: a copy's write waiting for a signature refuses this one too. A check at the moment of
// signing would come too late for the copy signed second, and the earlier copy's write, once made,
// is recorded for this copy as well (`resentWritten`); turned down, this copy goes ahead on the
// next run. A write the platform knows was not sent (`notWritten`) or that was turned down is
// no write. By the write's mark (`[Mezonas bt-<id>]` in its input), so no column is added.
// DECISION (review, §1.187): this transaction's own mark counts too, for a write laid out for a
// signature, signed, being made or made: a person who books the transaction again (a transfer now,
// not a deposit) while the first booking's write waits would otherwise sign two records of two
// kinds, which the connector's same-kind check can't see. A failed write of its own mark doesn't
// refuse: the next run's read of QuickBooks (`find`) and the connector's check cover a retry of it.
export async function writeCheck(tx: Tx, tenantId: string, bookingId: string) {
  const [row] = await tx
    .select({ b: booking, t: bankTxn })
    .from(booking)
    .innerJoin(
      bankTxn,
      and(eq(bankTxn.id, booking.bankTxnId), eq(bankTxn.tenantId, booking.tenantId)),
    )
    .where(and(eq(booking.tenantId, tenantId), eq(booking.id, bookingId)));
  if (!row) throw new PackRefusal(`booking ${bookingId} isn't one of this client's`);
  const { b, t } = row;
  if (b.status !== "approved" && b.status !== "proposed") {
    throw new PackRefusal(`booking ${b.id} is ${b.status}: nothing to write`);
  }
  const sources = [b.id, t.rawRecordId];
  const others = (await resentChain(tx, tenantId, t.id)).filter((id) => id !== t.id);
  if (others.length > 0) {
    const [posted] = await tx
      .select({ qboEntity: booking.qboEntity, qboId: booking.qboId })
      .from(booking)
      .where(
        and(
          eq(booking.tenantId, tenantId),
          inArray(booking.bankTxnId, others),
          eq(booking.status, "posted"),
        ),
      )
      .limit(1);
    if (posted) {
      const what = posted.qboEntity && posted.qboId ? ` (${posted.qboEntity} ${posted.qboId})` : "";
      throw new PackRefusal(
        `An earlier copy of this transaction is already in QuickBooks${what}: this copy isn't written again`,
      );
    }
  }
  const own = txnReference(t.id);
  const marks = others.map((id) => txnReference(id));
  const markIn = (refs: string[]) =>
    or(
      inArray(sql<string>`${externalAction.input} ->> 'reference'`, refs),
      inArray(sql<string>`${externalAction.editedInput} ->> 'reference'`, refs),
    );
  const [write] = await tx
    .select({
      status: externalAction.status,
      qboId: sql<string | null>`${externalAction.result} ->> 'id'`,
      own: sql<boolean>`(coalesce(${externalAction.input} ->> 'reference', '') = ${own} or coalesce(${externalAction.editedInput} ->> 'reference', '') = ${own})`,
    })
    .from(externalAction)
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        inArray(externalAction.tool, Object.values(BANKING_TOOLS)),
        or(
          and(markIn([own]), MADE_OR_WAITING),
          ...(marks.length > 0 ? [and(markIn(marks), LIVE_WRITE)] : []),
        ),
      ),
    )
    .orderBy(asc(externalAction.createdAt))
    .limit(1);
  if (!write) return { clear: true as const, sources };
  const [who, me] = write.own
    ? ["This transaction's write from an earlier run", "this booking"]
    : ["An earlier copy of this transaction", "this copy"];
  const why =
    write.status === "proposed"
      ? `is waiting for a signature: sign or turn down that one first, and ${me} waits until then`
      : write.status === "done"
        ? `was written to QuickBooks${write.qboId ? ` (${write.qboId})` : ""}: ${me} isn't written again`
        : write.status === "failed"
          ? `may have reached QuickBooks: check there before ${me} is written`
          : `is being written to QuickBooks: ${me} isn't written too`;
  throw new PackRefusal(`${who} ${why}`);
}

export const writeCheckTool = defineTool({
  id: "bookkeeping.booking.write-check",
  description:
    "Right before a booking's QuickBooks write: refuses it when another copy of the same bank transaction (sent again by the bank) is already posted, or a write of that copy or of this transaction for an earlier booking is waiting for a signature, signed or made.",
  sideEffect: "none",
  entity: "booking",
  input: z.object({ bookingId: Id }),
  output: z.object({ clear: z.literal(true), sources: z.array(z.string()) }),
  async run(input, ctx) {
    return withTenant(ctx.db, ctx.tenantId, (tx) => writeCheck(tx, ctx.tenantId, input.bookingId));
  },
});

const QBO_ENTITY = { purchase: "Purchase", deposit: "Deposit", transfer: "Transfer" } as const;

export const postedTool = defineTool({
  id: "bookkeeping.booking.posted",
  description:
    "Records what a booking became in QuickBooks (its id), or, with no id, that the write didn't happen and why: the transaction goes back to a person.",
  sideEffect: "internal",
  entity: "booking",
  verb: "update",
  summary: "Recorded the booking as {{status}}",
  input: z.object({
    bookingId: Id,
    entity: Entity,
    qboId: z
      .string()
      .regex(/^\d{1,32}$/)
      .nullable()
      .optional(),
    error: z.string().max(500).nullable().optional(),
  }),
  output: z.object({
    recorded: z.boolean(),
    status: z.enum(["posted", "failed"]),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const status = input.qboId ? ("posted" as const) : ("failed" as const);
    if (ctx.mode === "test") return { recorded: false, status, sources: [input.bookingId] };
    return withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const [b] = await tx
        .select()
        .from(booking)
        .where(and(eq(booking.tenantId, ctx.tenantId), eq(booking.id, input.bookingId)));
      if (!b) throw new PackRefusal(`booking ${input.bookingId} isn't one of this client's`);
      if (b.status === "posted" && b.qboId === (input.qboId ?? null)) {
        return { recorded: false, status: "posted" as const, sources: [b.id] };
      }
      // Laid out for a signature before the bank sent the transaction again, and written after
      // all: what was written is recorded, and the copy with it.
      if (
        b.status === "superseded" &&
        input.qboId &&
        (await resentWritten(tx, ctx, b.bankTxnId, b, {
          entity: QBO_ENTITY[input.entity],
          id: input.qboId,
        }))
      ) {
        return { recorded: true, status, sources: [b.id, input.qboId] };
      }
      if (b.status !== "approved" && b.status !== "proposed") {
        throw new PackRefusal(`booking ${b.id} is ${b.status}: nothing to record`);
      }
      // No id: the write was declined or failed; a person decides the transaction on the card.
      await tx
        .update(booking)
        .set(
          input.qboId
            ? {
                status: "posted",
                qboEntity: QBO_ENTITY[input.entity],
                qboId: input.qboId,
                postedAt: sql`now()`,
                decidedAt: b.decidedAt ?? sql`now()`,
              }
            : {
                status: "failed",
                error: (input.error ?? "Not written: declined or refused").slice(0, 500),
                decidedAt: sql`now()`,
              },
        )
        .where(and(eq(booking.tenantId, ctx.tenantId), eq(booking.id, b.id)));
      await tx
        .update(bankTxn)
        .set({ status: input.qboId ? "posted" : "needs_review", updatedAt: sql`now()` })
        .where(and(eq(bankTxn.tenantId, ctx.tenantId), eq(bankTxn.id, b.bankTxnId)));
      // A transfer not written: its other side waits for a person with it.
      if (!input.qboId) await holdPaired(tx, ctx.tenantId, { id: b.bankTxnId }, "not_written");
      return { recorded: true, status, sources: [b.id, ...(input.qboId ? [input.qboId] : [])] };
    });
  },
});

export const POSTING_TOOLS: readonly PackTool[] = [
  readyTool,
  qboInputTool,
  writeCheckTool,
  postedTool,
];
