// docs/plan.md §1.212: the Bookkeeper's golden world. The client's chart of accounts as QuickBooks'
// sync leaves it, its bank and card accounts on the feed with a week of transactions (as the feed's
// sync stores them), the purchases already in QuickBooks, the operator's rules and notes, and what
// a person booked before the run (approved, waiting to be written). Every id is fixed by the case
// (`ctx.id`), so the model's requests replay. Synthetic only (invariant 14).

import {
  connection,
  type LedgerKind,
  ledgerAccount,
  membership,
  rawRecord,
  transaction,
  withTenant,
} from "@countersign/db";
import { bankAccountLink, bankTxn, bookByPerson } from "@countersign/pack-bookkeeping";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { OPERATOR } from "../api.test-helper";
import type { WorldContext } from "./golden.test-helper";

const Money = z.string().regex(/^\d+(\.\d+)?$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The chart most cases use: QuickBooks id, name, type, classification, the platform's kind. */
export const GOLDEN_CHART: readonly [string, string, string, string, LedgerKind][] = [
  ["35", "Checking", "Bank", "asset", "bank"],
  ["36", "Savings", "Bank", "asset", "bank"],
  ["41", "Amex", "Credit Card", "liability", "card"],
  ["80", "Job Materials", "Cost of Goods Sold", "expense", "cost_of_goods"],
  ["84", "Shop Supplies", "Expense", "expense", "expense"],
  ["86", "Fuel", "Expense", "expense", "expense"],
  ["87", "Software", "Expense", "expense", "expense"],
  ["88", "Meals", "Expense", "expense", "expense"],
  ["89", "Bank Fees", "Expense", "expense", "expense"],
  ["400", "Sales", "Income", "revenue", "income"],
  ["410", "Interest Income", "Other Income", "revenue", "other_income"],
];

const FEED_ACCOUNTS = {
  checking: {
    id: "acc-checking",
    name: "Checking",
    mask: "0001",
    type: "depository",
    ledger: "Checking",
  },
  savings: {
    id: "acc-savings",
    name: "Savings",
    mask: "0002",
    type: "depository",
    ledger: "Savings",
  },
  amex: { id: "acc-amex", name: "Amex Gold", mask: "1009", type: "credit", ledger: "Amex" },
} as const;
type FeedAccount = keyof typeof FEED_ACCOUNTS;
const FeedAccountRef = z.enum(["checking", "savings", "amex"]);

export const BooksWorld = z.strictObject({
  /** The feed's accounts and how each books (all `book` unless named). */
  accounts: z
    .array(
      z.strictObject({
        account: FeedAccountRef,
        mode: z.enum(["book", "off"]).default("book"),
        bookFrom: Day.nullable().default(null),
      }),
    )
    .default([{ account: "checking" }, { account: "amex" }] as never),
  /** The week on the feed: `@txn:<ref>` in a case is the bank transaction's id. */
  feed: z
    .array(
      z.strictObject({
        ref: z.string().min(1),
        account: FeedAccountRef.default("checking"),
        amount: Money,
        direction: z.enum(["in", "out"]).default("out"),
        date: Day,
        payee: z.string().nullable().default(null),
        description: z.string().nullable().default(null),
        pending: z.boolean().default(false),
      }),
    )
    .min(1),
  /** Purchases already in QuickBooks, paid from the account with this QuickBooks id. */
  qboPurchases: z
    .array(
      z.strictObject({
        id: z.string(),
        total: Money,
        date: Day,
        account: z.string(),
        credit: z.boolean().default(false),
      }),
    )
    .default([]),
  /** The operator's rules: a payee to an account (by name). */
  rules: z
    .array(
      z.strictObject({
        payee: z.string(),
        direction: z.enum(["in", "out"]).default("out"),
        account: z.string(),
      }),
    )
    .default([]),
  /** The operator's notes on accounts (by name). */
  notes: z.array(z.strictObject({ account: z.string(), note: z.string() })).default([]),
  /** Booked by a person before the run: approved, waiting to be written to QuickBooks. */
  booked: z
    .array(
      z.strictObject({
        txn: z.string(),
        lines: z.array(z.strictObject({ account: z.string(), amount: Money.optional() })).min(1),
        why: z.string().optional(),
      }),
    )
    .default([]),
});
export type BooksWorld = z.infer<typeof BooksWorld>;

const ledger = (ctx: WorldContext, name: string) => {
  if (!GOLDEN_CHART.some(([, n]) => n === name)) throw new Error(`no account named ${name}`);
  return ctx.id(`account:${name}`);
};

/** Before the pack is switched on: the connections, the chart, the feed, QuickBooks' purchases. */
export async function seedBooks(ctx: WorldContext, raw: unknown): Promise<void> {
  const w = BooksWorld.parse(raw);
  const db = ctx.H.t.db;
  const tenantId = ctx.tenantId;
  await db.insert(connection).values([
    {
      id: ctx.id("qbo"),
      tenantId,
      connector: "qbo",
      status: "connected",
      externalAccountId: "golden-realm",
    },
    { id: ctx.id("feed"), tenantId, connector: "bankfeed", status: "connected" },
  ] as never);
  for (const [externalId, name, accountType, classification, kind] of GOLDEN_CHART) {
    await db.insert(ledgerAccount).values({
      id: ctx.id(`account:${name}`),
      tenantId,
      connectionId: ctx.id("qbo"),
      connector: "qbo",
      externalId,
      name,
      fullName: name,
      accountType,
      kind,
      classification: classification as "asset",
    });
  }
  for (const [i, f] of w.feed.entries()) {
    const a = FEED_ACCOUNTS[f.account];
    await db.insert(rawRecord).values({
      id: ctx.id(`raw:${f.ref}`),
      tenantId,
      connectionId: ctx.id("feed"),
      connector: "bankfeed",
      entityType: "Transaction",
      externalId: f.ref,
      externalVersion: `v1:${i + 1}`,
      payload: {
        id: f.ref,
        account: { id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: null },
        amount: { amount: f.amount, currency: "USD" },
        direction: f.direction,
        date: f.date,
        authorizedDate: null,
        pending: f.pending,
        pendingTransactionId: null,
        merchantName: f.payee,
        description: f.description,
        category: null,
        paymentChannel: null,
      },
    });
  }
  for (const p of w.qboPurchases) {
    await db.insert(transaction).values({
      id: ctx.id(`qbo:${p.id}`),
      tenantId,
      kind: p.credit ? "vendor_credit" : "purchase",
      connector: "qbo",
      txnDate: p.date,
      total: p.total,
      externalId: `Purchase:${p.id}`,
      ext: { qbo: { entity: "Purchase", id: p.id, accountId: p.account } },
    });
  }
}

/** With the pack on: read the feed, fix the transactions' ids, link the accounts, rules, notes. */
export async function booksAfterEnable(ctx: WorldContext, raw: unknown): Promise<void> {
  const w = BooksWorld.parse(raw);
  const { H, tenantId } = ctx;
  const act = async (name: string, body: unknown) => {
    const r = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${tenantId}/packs/bookkeeping/actions/${name}`,
      body,
    );
    if (r.status !== 200) throw new Error(`${name}: ${JSON.stringify(r.json)}`);
    return r.json;
  };
  await act("import", {});
  // The ids the import made are the world's own, so the model's requests replay. Nothing points
  // at a transaction yet.
  for (const f of w.feed) {
    await H.t.db
      .update(bankTxn)
      .set({ id: ctx.id(`txn:${f.ref}`) })
      .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.externalId, f.ref)));
  }
  for (const a of w.accounts) {
    const feed = FEED_ACCOUNTS[a.account as FeedAccount];
    const [link] = await H.t.db
      .select({ id: bankAccountLink.id })
      .from(bankAccountLink)
      .where(
        and(eq(bankAccountLink.tenantId, tenantId), eq(bankAccountLink.externalAccountId, feed.id)),
      );
    if (!link) continue;
    await act("link-account", {
      linkId: link.id,
      ledgerAccountId: ledger(ctx, feed.ledger),
      mode: a.mode,
      ...(a.bookFrom ? { bookFrom: a.bookFrom } : {}),
    });
  }
  for (const r of w.rules) {
    await act("add-rule", {
      payee: r.payee,
      direction: r.direction,
      ledgerAccountId: ledger(ctx, r.account),
    });
  }
  for (const n of w.notes) {
    await act("add-account-note", { ledgerAccountId: ledger(ctx, n.account), note: n.note });
  }
  if (w.booked.length > 0) {
    const [admin] = await H.t.db
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.role, "client_admin")));
    const userId = admin?.userId;
    if (!userId) throw new Error("no client admin");
    await withTenant(H.db, tenantId, async (tx) => {
      for (const b of w.booked) {
        await bookByPerson(
          tx,
          { tenantId, userId },
          {
            bankTxnId: ctx.id(`txn:${b.txn}`),
            lines: b.lines.map((l) => ({
              ledgerAccountId: ledger(ctx, l.account),
              ...(l.amount ? { amount: l.amount } : {}),
            })),
            ...(b.why ? { why: b.why } : {}),
          },
        );
      }
    });
  }
}
