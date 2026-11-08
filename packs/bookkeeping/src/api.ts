// The pack's API surface (ARCHITECTURE §12.1): its review cards, the back office's actions, the
// transactions report and the nightly import. apps/api mounts them under the platform's generic
// pack routes and does the sign-in, roles and client scope; these get one client's transaction or
// database.

import { type Db, ledgerAccount, type Tx, tenant, tenantPack, withTenant } from "@countersign/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { activeAccount, addNote, listAccounts } from "./accounts";
import { addRule, approve, bookByPerson, exclude, liveBooking } from "./bookings";
import { importFeeds } from "./feed";
import { PACK_ID } from "./ids";
import {
  asReview,
  type CardDecision,
  type PackActionHandler,
  PackRefusal,
  type PackReportHandler,
  type PackReviewHandler,
  ReviewError,
} from "./pack";
import { bankAccountLink, bankTxn, booking, bookingLine, bookingRule, LINK_MODES } from "./schema";

const Id = z.string().uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, yyyy-mm-dd");
const Money = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, "an amount, like 12.50");

export const BOOKINGS_REVIEW = "bookkeeping.bookings";
export const ACCOUNT_QUESTIONS = "bookkeeping.account-questions";

// ── Views ────────────────────────────────────────────────────────────────────────────────────────

/** One transaction with the booking that stands for it, as the card and the report show it. */
export async function txnView(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx
    .select({ t: bankTxn, l: bankAccountLink })
    .from(bankTxn)
    .innerJoin(
      bankAccountLink,
      and(
        eq(bankAccountLink.id, bankTxn.accountLinkId),
        eq(bankAccountLink.tenantId, bankTxn.tenantId),
      ),
    )
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, id)));
  if (!row) return null;
  const { t, l } = row;
  const live = await liveBooking(tx, tenantId, t.id);
  const lines = live
    ? await tx
        .select({ line: bookingLine, account: ledgerAccount.fullName })
        .from(bookingLine)
        .innerJoin(
          ledgerAccount,
          and(
            eq(ledgerAccount.id, bookingLine.ledgerAccountId),
            eq(ledgerAccount.tenantId, bookingLine.tenantId),
          ),
        )
        .where(and(eq(bookingLine.tenantId, tenantId), eq(bookingLine.bookingId, live.id)))
        .orderBy(asc(bookingLine.lineNo))
    : [];
  return {
    id: t.id,
    date: t.txnDate,
    amount: t.amount,
    currency: t.currency,
    direction: t.direction,
    payee: t.payee,
    description: t.description,
    status: t.status,
    account: { id: l.id, name: l.name, mask: l.mask, kind: l.kind },
    removedAfterPosting: (t.ext as { removedAfterPosting?: boolean }).removedAfterPosting === true,
    booking: live
      ? {
          id: live.id,
          kind: live.kind,
          status: live.status,
          decidedBy: live.decidedBy,
          confidence: live.confidence,
          reason: live.reason,
          alternatives: live.alternatives,
          memo: live.memo,
          qbo: live.qboId ? { entity: live.qboEntity, id: live.qboId } : null,
          lines: lines.map(({ line, account }) => ({
            ledgerAccountId: line.ledgerAccountId,
            account,
            amount: line.amount,
            classRef: line.classRef,
            description: line.description,
          })),
        }
      : null,
  };
}

// ── Cards ────────────────────────────────────────────────────────────────────────────────────────

const BookingsPayload = z.object({ bankTxnIds: z.array(Id).max(100) });
const QuestionsPayload = z.object({ ledgerAccountIds: z.array(Id).max(10) });

const Line = z.strictObject({
  ledgerAccountId: Id,
  amount: Money.optional(),
  classRef: z.string().max(64).nullable().optional(),
  description: z.string().max(200).nullable().optional(),
});
const BookingDecision = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("approve"), input: z.strictObject({ bankTxnId: Id }) }),
  z.strictObject({
    action: z.literal("book"),
    input: z.strictObject({
      bankTxnId: Id,
      lines: z.array(Line).min(1).max(20),
      vendorId: Id.nullable().optional(),
      memo: z.string().max(200).nullable().optional(),
      why: z.string().max(500).nullable().optional(),
      makeRule: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    action: z.literal("exclude"),
    input: z.strictObject({ bankTxnId: Id, why: z.string().max(500).nullable().optional() }),
  }),
]);
const QuestionDecision = z.strictObject({
  action: z.literal("answer"),
  input: z.strictObject({ ledgerAccountId: Id, answer: z.string().min(1).max(500) }),
});

export const BOOKKEEPING_REVIEWS: Readonly<Record<string, PackReviewHandler>> = {
  // The transactions the model wasn't sure of: each with its suggestion and the chart to pick from.
  [BOOKINGS_REVIEW]: {
    async load(tx, tenantId, payload) {
      const p = BookingsPayload.parse(payload);
      const txns = [];
      for (const id of p.bankTxnIds) {
        const v = await txnView(tx, tenantId, id);
        if (v) txns.push(v);
      }
      const accounts = await listAccounts(tx, tenantId);
      return {
        transactions: txns,
        accounts: accounts.map((a) => ({
          id: a.id,
          fullName: a.fullName,
          number: a.number,
          type: a.type,
          classification: a.classification,
          description: a.description,
          note: a.notes[0]?.note ?? null,
        })),
      };
    },
    async decide(db, input) {
      if (input.testRun) return;
      await asReview(async () => {
        const p = BookingsPayload.parse(input.payload);
        const d = BookingDecision.parse(input.decision as CardDecision);
        if (!p.bankTxnIds.includes(d.input.bankTxnId)) {
          throw new ReviewError("that transaction isn't part of this review");
        }
        const who = { tenantId: input.tenantId, userId: input.userId };
        await withTenant(db, input.tenantId, async (tx) => {
          if (d.action === "approve") await approve(tx, who, d.input.bankTxnId);
          else if (d.action === "book") await bookByPerson(tx, who, d.input);
          else await exclude(tx, who, d.input);
        });
      });
    },
  },
  // "What do you use this account for?": each answer is the client's note on the account.
  [ACCOUNT_QUESTIONS]: {
    async load(tx, tenantId, payload) {
      const p = QuestionsPayload.parse(payload);
      const accounts = await listAccounts(tx, tenantId, { ids: p.ledgerAccountIds });
      return {
        accounts: accounts.map((a) => ({
          id: a.id,
          fullName: a.fullName,
          number: a.number,
          type: a.type,
          description: a.description,
          notes: a.notes.filter((n) => n.source !== "agent"),
          examples: a.examples,
        })),
      };
    },
    async decide(db, input) {
      if (input.testRun) return;
      await asReview(async () => {
        const p = QuestionsPayload.parse(input.payload);
        const d = QuestionDecision.parse(input.decision as CardDecision);
        if (!p.ledgerAccountIds.includes(d.input.ledgerAccountId)) {
          throw new ReviewError("that account isn't part of this question");
        }
        await withTenant(db, input.tenantId, (tx) =>
          addNote(
            tx,
            input.tenantId,
            { ledgerAccountId: d.input.ledgerAccountId, note: d.input.answer },
            { source: "client", userId: input.userId },
          ),
        );
      });
    },
  },
};

// ── The back office's actions ────────────────────────────────────────────────────────────────────

/** Account types a bank or card account on the feed may book to. */
const LINKABLE_TYPES = ["Bank", "Credit Card", "Other Current Asset", "Other Current Liability"];

export const BOOKKEEPING_ACTIONS: Readonly<Record<string, PackActionHandler>> = {
  // Read the feed now rather than wait for the night.
  import: {
    input: z.strictObject({}),
    run: (db, ctx) =>
      withTenant(db, ctx.tenantId, async (tx) => ({ ...(await importFeeds(tx, ctx.tenantId)) })),
  },
  // A bank or card account on the feed: which ledger account it is, and whether it books.
  "link-account": {
    input: z.strictObject({
      linkId: Id,
      ledgerAccountId: Id.nullable(),
      mode: z.enum(LINK_MODES),
      bookFrom: Day.nullable().optional(),
    }),
    async run(db, ctx) {
      const input = ctx.input as {
        linkId: string;
        ledgerAccountId: string | null;
        mode: (typeof LINK_MODES)[number];
        bookFrom?: string | null;
      };
      return withTenant(db, ctx.tenantId, async (tx) => {
        if (input.mode !== "off" && !input.ledgerAccountId) {
          throw new PackRefusal(
            "say which ledger account this account books to before switching it on",
          );
        }
        if (input.ledgerAccountId) {
          const a = await activeAccount(tx, ctx.tenantId, input.ledgerAccountId);
          if (!LINKABLE_TYPES.includes(a.accountType)) {
            throw new PackRefusal(
              `${a.fullName} is a ${a.accountType} account, not a bank or card account`,
            );
          }
          const [taken] = await tx
            .select({ id: bankAccountLink.id })
            .from(bankAccountLink)
            .where(
              and(
                eq(bankAccountLink.tenantId, ctx.tenantId),
                eq(bankAccountLink.ledgerAccountId, input.ledgerAccountId),
                sql`${bankAccountLink.id} <> ${input.linkId}`,
              ),
            );
          if (taken)
            throw new PackRefusal(`${a.fullName} is already linked to another account on the feed`);
        }
        const [row] = await tx
          .update(bankAccountLink)
          .set({
            ledgerAccountId: input.ledgerAccountId,
            mode: input.mode,
            ...(input.bookFrom !== undefined ? { bookFrom: input.bookFrom } : {}),
            updatedBy: ctx.userId,
            updatedAt: sql`now()`,
          })
          .where(
            and(eq(bankAccountLink.tenantId, ctx.tenantId), eq(bankAccountLink.id, input.linkId)),
          )
          .returning();
        if (!row) throw new PackRefusal("that account isn't on this client's feed");
        return {
          link: {
            id: row.id,
            ledgerAccountId: row.ledgerAccountId,
            mode: row.mode,
            bookFrom: row.bookFrom,
          },
        };
      });
    },
  },
  "add-rule": {
    input: z.strictObject({
      payee: z.string().min(1).max(200),
      direction: z.enum(["in", "out"]),
      ledgerAccountId: Id,
      accountLinkId: Id.nullable().optional(),
      vendorId: Id.nullable().optional(),
      classRef: z.string().max(64).nullable().optional(),
      memo: z.string().max(200).nullable().optional(),
    }),
    async run(db, ctx) {
      const input = ctx.input as { payee: string } & Omit<
        Parameters<typeof addRule>[2],
        "payeeKey"
      >;
      const id = await withTenant(db, ctx.tenantId, (tx) =>
        addRule(
          tx,
          { tenantId: ctx.tenantId, userId: ctx.userId },
          { ...input, payeeKey: input.payee },
        ),
      );
      return { ruleId: id };
    },
  },
  "turn-off-rule": {
    input: z.strictObject({ ruleId: Id }),
    async run(db, ctx) {
      const { ruleId } = ctx.input as { ruleId: string };
      const [row] = await withTenant(db, ctx.tenantId, (tx) =>
        tx
          .update(bookingRule)
          .set({ active: false, updatedAt: sql`now()` })
          .where(and(eq(bookingRule.tenantId, ctx.tenantId), eq(bookingRule.id, ruleId)))
          .returning({ id: bookingRule.id }),
      );
      if (!row) throw new PackRefusal("that rule isn't this client's");
      return { ruleId: row.id, active: false };
    },
  },
  // The operator's own words on what an account is for (the client's come from the card).
  "add-account-note": {
    input: z.strictObject({ ledgerAccountId: Id, note: z.string().min(1).max(500) }),
    async run(db, ctx) {
      const input = ctx.input as { ledgerAccountId: string; note: string };
      const r = await withTenant(db, ctx.tenantId, (tx) =>
        addNote(tx, ctx.tenantId, input, { source: "operator", userId: ctx.userId }),
      );
      return { noteId: r.id };
    },
  },
};

// ── Reports ──────────────────────────────────────────────────────────────────────────────────────

const REPORT_ROWS = 200;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // A leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function transactionsReport(tx: Tx, tenantId: string) {
  const counts = await tx
    .select({ status: bankTxn.status, n: sql<number>`count(*)::int` })
    .from(bankTxn)
    .where(eq(bankTxn.tenantId, tenantId))
    .groupBy(bankTxn.status);
  const rows = await tx
    .select({ t: bankTxn, l: bankAccountLink })
    .from(bankTxn)
    .innerJoin(
      bankAccountLink,
      and(
        eq(bankAccountLink.id, bankTxn.accountLinkId),
        eq(bankAccountLink.tenantId, bankTxn.tenantId),
      ),
    )
    .where(and(eq(bankTxn.tenantId, tenantId), sql`${bankTxn.status} <> 'removed'`))
    .orderBy(desc(bankTxn.txnDate), desc(bankTxn.id))
    .limit(REPORT_ROWS);
  const live = rows.length
    ? await tx
        .select({ txnId: booking.bankTxnId, kind: booking.kind, account: ledgerAccount.fullName })
        .from(booking)
        .leftJoin(
          bookingLine,
          and(
            eq(bookingLine.bookingId, booking.id),
            eq(bookingLine.tenantId, booking.tenantId),
            eq(bookingLine.lineNo, 1),
          ),
        )
        .leftJoin(
          ledgerAccount,
          and(
            eq(ledgerAccount.id, bookingLine.ledgerAccountId),
            eq(ledgerAccount.tenantId, booking.tenantId),
          ),
        )
        .where(
          and(
            eq(booking.tenantId, tenantId),
            inArray(
              booking.bankTxnId,
              rows.map((r) => r.t.id),
            ),
            inArray(booking.status, ["proposed", "approved", "posted"]),
          ),
        )
    : [];
  const byTxn = new Map(live.map((b) => [b.txnId, b]));
  const links = await tx
    .select({ l: bankAccountLink, a: ledgerAccount.fullName })
    .from(bankAccountLink)
    .leftJoin(
      ledgerAccount,
      and(
        eq(ledgerAccount.id, bankAccountLink.ledgerAccountId),
        eq(ledgerAccount.tenantId, bankAccountLink.tenantId),
      ),
    )
    .where(eq(bankAccountLink.tenantId, tenantId))
    .orderBy(asc(bankAccountLink.name), asc(bankAccountLink.id));
  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    accounts: links.map(({ l, a }) => ({
      id: l.id,
      name: l.name,
      mask: l.mask,
      kind: l.kind,
      mode: l.mode,
      bookFrom: l.bookFrom,
      ledgerAccountId: l.ledgerAccountId,
      ledgerAccount: a,
    })),
    transactions: rows.map(({ t, l }) => {
      const b = byTxn.get(t.id);
      return {
        id: t.id,
        date: t.txnDate,
        account: l.name,
        mask: l.mask,
        payee: t.payee,
        direction: t.direction,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        kind: b?.kind ?? null,
        bookedTo: b?.account ?? null,
      };
    }),
  };
}

export const BOOKKEEPING_REPORTS: Readonly<Record<string, PackReportHandler>> = {
  transactions: {
    title: "Bank transactions",
    json: async (tx, tenantId) => ({ ...(await transactionsReport(tx, tenantId)) }),
    async csv(tx, tenantId) {
      const r = await transactionsReport(tx, tenantId);
      const head = [
        "date",
        "account",
        "payee",
        "direction",
        "amount",
        "currency",
        "status",
        "booked_to",
      ];
      const lines = r.transactions.map((t) =>
        [t.date, t.account, t.payee, t.direction, t.amount, t.currency, t.status, t.bookedTo]
          .map(csvCell)
          .join(","),
      );
      return `${[head.join(","), ...lines].join("\n")}\n`;
    },
    item: async (tx, tenantId, id) => {
      const t = await txnView(tx, tenantId, id);
      return t ? { transaction: t } : null;
    },
  },
  // The chart of accounts with what each is for (back office; the portal reads it on the card).
  accounts: {
    title: "Chart of accounts",
    json: async (tx, tenantId) => ({
      accounts: await listAccounts(tx, tenantId, { inactive: true }),
    }),
    async csv(tx, tenantId) {
      const accounts = await listAccounts(tx, tenantId, { inactive: true });
      const head = ["number", "account", "type", "active", "description", "note"];
      const lines = accounts.map((a) =>
        [a.number, a.fullName, a.type, a.active, a.description, a.notes[0]?.note ?? null]
          .map(csvCell)
          .join(","),
      );
      return `${[head.join(","), ...lines].join("\n")}\n`;
    },
  },
  // Rules: the client's and the learned ones (back office).
  rules: {
    title: "Booking rules",
    async json(tx, tenantId) {
      const rows = await tx
        .select({ r: bookingRule, a: ledgerAccount.fullName })
        .from(bookingRule)
        .innerJoin(
          ledgerAccount,
          and(
            eq(ledgerAccount.id, bookingRule.ledgerAccountId),
            eq(ledgerAccount.tenantId, bookingRule.tenantId),
          ),
        )
        .where(eq(bookingRule.tenantId, tenantId))
        .orderBy(desc(bookingRule.active), asc(bookingRule.payeeKey));
      return {
        rules: rows.map(({ r, a }) => ({
          id: r.id,
          payee: r.payeeKey,
          direction: r.direction,
          account: a,
          ledgerAccountId: r.ledgerAccountId,
          accountLinkId: r.accountLinkId,
          source: r.source,
          active: r.active,
          hits: r.hits,
        })),
      };
    },
    async csv(tx, tenantId) {
      const r = (await BOOKKEEPING_REPORTS.rules?.json(tx, tenantId, "")) as {
        rules: {
          payee: string;
          direction: string;
          account: string;
          source: string;
          active: boolean;
          hits: number;
        }[];
      };
      const head = ["payee", "direction", "account", "source", "active", "hits"];
      const lines = r.rules.map((x) =>
        [x.payee, x.direction, x.account, x.source, x.active, x.hits].map(csvCell).join(","),
      );
      return `${[head.join(","), ...lines].join("\n")}\n`;
    },
  },
};

// ── The nightly import ───────────────────────────────────────────────────────────────────────────

export const BOOKKEEPING_NIGHTLY = {
  /** DECISION: 04:16 UTC, a minute no other pass uses, after the feed's hourly sync at :26. */
  hour: 4,
  minute: 16,
  async run(
    db: Db,
    _now: Date,
    onError: (tenantId: string, error: unknown) => void = () => {},
  ): Promise<{ clients: number; added: number }> {
    const clients = await db.select({ id: tenant.id }).from(tenant);
    const out = { clients: 0, added: 0 };
    for (const c of clients) {
      try {
        await withTenant(db, c.id, async (tx) => {
          const [on] = await tx
            .select({ pack: tenantPack.pack })
            .from(tenantPack)
            .where(and(eq(tenantPack.tenantId, c.id), eq(tenantPack.pack, PACK_ID)));
          if (!on) return;
          out.clients += 1;
          out.added += (await importFeeds(tx, c.id)).added;
        });
      } catch (error) {
        onError(c.id, error);
      }
    }
    return out;
  },
};
