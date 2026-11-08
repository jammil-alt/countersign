// B-4 (docs/plan.md §1.79): approved bookings into the accounting tool. The pack never writes there
// itself (invariant 8): `bookkeeping.booking.qbo-input` lays out the write a QuickBooks tool makes
// (`qbo.purchase.create`, `qbo.deposit.create`, `qbo.transfer.create`, each behind approval) and
// `bookkeeping.booking.posted` records what it became.

import { BANKING_TOOLS } from "@countersign/connectors";
import { dec } from "@countersign/core";
import { ledgerAccount, type Tx, vendor, withTenant } from "@countersign/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { MONEY_KINDS } from "./bookings";
import { defineTool, PackRefusal, type PackTool } from "./pack";
import { bankAccountLink, bankTxn, booking, bookingLine } from "./schema";

const Id = z.string().uuid();
const cents = (v: string) => dec(v).toFixed(2);

/** The reference a booking's record carries in the accounting tool (`[Mezonas bk-<id>]`). */
export const bookingReference = (bookingId: string) => `bk-${bookingId}`;

export const readyTool = defineTool({
  id: "bookkeeping.bookings.ready",
  description:
    "Lists the bookings on accounts set to book that are proposed or approved and not in the accounting tool yet, oldest first, for the write steps (each write waits for a person's signature).",
  sideEffect: "none",
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
  const reference = bookingReference(b.id);
  const sources = [b.id, t.rawRecordId];
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
      sources,
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
      sources,
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
    sources,
  };
}

export const qboInputTool = defineTool({
  id: "bookkeeping.booking.qbo-input",
  description:
    "Lays out one approved booking as the QuickBooks write it needs: `entity` says which (purchase, deposit or transfer) and that field holds the write's input.",
  sideEffect: "none",
  input: z.object({ bookingId: Id }),
  output: z.object({
    entity: Entity,
    tool: z.string(),
    purchase: PurchaseInput.nullable(),
    deposit: DepositInput.nullable(),
    transfer: TransferInput.nullable(),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    return withTenant(ctx.db, ctx.tenantId, (tx) => qboInput(tx, ctx.tenantId, input.bookingId));
  },
});

const QBO_ENTITY = { purchase: "Purchase", deposit: "Deposit", transfer: "Transfer" } as const;

export const postedTool = defineTool({
  id: "bookkeeping.booking.posted",
  description:
    "Records what a booking became in QuickBooks (its id), or, with no id, that the write didn't happen and why: the transaction goes back to a person.",
  sideEffect: "internal",
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
      return { recorded: true, status, sources: [b.id, ...(input.qboId ? [input.qboId] : [])] };
    });
  },
});

export const POSTING_TOOLS: readonly PackTool[] = [readyTool, qboInputTool, postedTool];
