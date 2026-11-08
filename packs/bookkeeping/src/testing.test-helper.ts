// A client for the pack's database tests: a user, a client agent version, a QuickBooks connection
// with a chart of accounts, a bank feed with its raw records as the feed's sync stores them, and
// QuickBooks purchases as its sync maps them. Written through the superuser connection (which
// bypasses RLS); the tests then act as cs_worker.

import type { AgentBundle } from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  type Db,
  type LedgerKind,
  ledgerAccount,
  membership,
  rawRecord,
  tenant,
  transaction,
  vendor,
} from "@countersign/db";

const BUNDLE: AgentBundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Bookkeeper", role: "bookkeeping", mission: "book" },
    kind: "functional",
    model: { id: "test-model", maxTokens: 1024 },
    instructions: "Book.",
    skills: [],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "suggest_only" },
    budgets: { maxSteps: 3, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [],
};

export interface FeedTxn {
  id: string;
  account?: { id: string; name?: string; mask?: string; type?: string };
  amount: string;
  direction?: "in" | "out";
  date: string;
  pending?: boolean;
  pendingTransactionId?: string | null;
  merchantName?: string | null;
  description?: string | null;
  category?: string | null;
}

export interface BooksFixture {
  tenantId: string;
  userId: string;
  agentVersionId: string;
  qboConnectionId: string;
  feedConnectionId: string;
  /** Ledger account ids by name. */
  accounts: Record<string, string>;
  /** A version of a transaction as the feed's sync stores it; answers the raw record id. */
  feed(t: FeedTxn, version?: string): Promise<string>;
  /** The feed dropped a transaction. */
  feedRemoved(id: string, accountId?: string): Promise<string>;
  /** A QuickBooks purchase as sync maps it, paid from the account with this QuickBooks id. */
  qboPurchase(p: {
    id: string;
    total: string;
    date: string;
    accountQboId: string;
    credit?: boolean;
  }): Promise<string>;
  vendor(name: string, qboId?: string): Promise<string>;
}

let counter = 0;

export const CHART: readonly [string, string, string, string, LedgerKind][] = [
  // QuickBooks id, name, QuickBooks' type, classification, the platform's kind
  ["35", "Checking", "Bank", "asset", "bank"],
  ["36", "Savings", "Bank", "asset", "bank"],
  ["41", "Amex", "Credit Card", "liability", "card"],
  ["80", "Job Materials", "Cost of Goods Sold", "expense", "cost_of_goods"],
  ["84", "Shop Supplies", "Expense", "expense", "expense"],
  ["86", "Fuel", "Expense", "expense", "expense"],
  ["87", "Software", "Expense", "expense", "expense"],
  ["400", "Sales", "Income", "revenue", "income"],
];

export async function insertBooks(db: Db, name: string): Promise<BooksFixture> {
  const n = ++counter;
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error("no tenant");
  const tenantId = t.id;
  const [u] = await db
    .insert(appUser)
    .values({ email: `owner${n}-${tenantId}@example.com`, name: `Owner ${n}` })
    .returning();
  if (!u) throw new Error("no user");
  await db.insert(membership).values({ tenantId, userId: u.id, role: "client_admin" });
  const [a] = await db
    .insert(agent)
    .values({ tenantId, kind: "client", slug: "bookkeeper", name: "Bookkeeper" })
    .returning();
  if (!a) throw new Error("no agent");
  const [av] = await db
    .insert(agentVersion)
    .values({
      tenantId,
      agentId: a.id,
      version: 1,
      bundle: BUNDLE,
      bundleHash: "h",
      status: "live",
      authorType: "operator",
    })
    .returning();
  if (!av) throw new Error("no agent version");
  const [qbo] = await db.insert(connection).values({ tenantId, connector: "qbo" }).returning();
  const [feedConn] = await db
    .insert(connection)
    .values({ tenantId, connector: "bankfeed" })
    .returning();
  if (!qbo || !feedConn) throw new Error("no connections");
  const accounts: Record<string, string> = {};
  for (const [externalId, accountName, accountType, classification, kind] of CHART) {
    const [row] = await db
      .insert(ledgerAccount)
      .values({
        tenantId,
        connectionId: qbo.id,
        connector: "qbo",
        externalId,
        name: accountName,
        fullName: accountName,
        accountType,
        kind,
        classification: classification as "asset",
      })
      .returning();
    if (!row) throw new Error("no account");
    accounts[accountName] = row.id;
  }
  let versions = 0;
  const books: BooksFixture = {
    tenantId,
    userId: u.id,
    agentVersionId: av.id,
    qboConnectionId: qbo.id,
    feedConnectionId: feedConn.id,
    accounts,
    async feed(f, version) {
      const account = f.account ?? {
        id: "acc-checking",
        name: "Checking",
        mask: "0001",
        type: "depository",
      };
      const payload = {
        id: f.id,
        account: {
          id: account.id,
          name: account.name ?? null,
          mask: account.mask ?? null,
          type: account.type ?? "depository",
          subtype: null,
        },
        amount: { amount: f.amount, currency: "USD" },
        direction: f.direction ?? "out",
        date: f.date,
        authorizedDate: null,
        pending: f.pending ?? false,
        pendingTransactionId: f.pendingTransactionId ?? null,
        merchantName: f.merchantName ?? null,
        description: f.description ?? null,
        category: f.category ?? null,
        paymentChannel: null,
      };
      const [row] = await db
        .insert(rawRecord)
        .values({
          tenantId,
          connectionId: feedConn.id,
          connector: "bankfeed",
          entityType: "Transaction",
          externalId: f.id,
          externalVersion: version ?? `v1:${++versions}`,
          payload,
        })
        .returning();
      if (!row) throw new Error("no raw record");
      return row.id;
    },
    async feedRemoved(id, accountId = "acc-checking") {
      const [row] = await db
        .insert(rawRecord)
        .values({
          tenantId,
          connectionId: feedConn.id,
          connector: "bankfeed",
          entityType: "Transaction",
          externalId: id,
          externalVersion: "removed",
          payload: { id, accountId, removed: true },
          isDeleted: true,
        })
        .returning();
      if (!row) throw new Error("no raw record");
      return row.id;
    },
    async qboPurchase(p) {
      const [row] = await db
        .insert(transaction)
        .values({
          tenantId,
          kind: p.credit ? "vendor_credit" : "purchase",
          connector: "qbo",
          txnDate: p.date,
          total: p.total,
          externalId: `Purchase:${p.id}`,
          ext: { qbo: { entity: "Purchase", id: p.id, accountId: p.accountQboId } },
        })
        .returning();
      if (!row) throw new Error("no transaction");
      return row.id;
    },
    async vendor(vendorName, qboId) {
      const [row] = await db
        .insert(vendor)
        .values({
          tenantId,
          name: vendorName,
          normalizedName: vendorName.toLowerCase(),
          externalRefs: qboId ? { qbo: qboId } : {},
        })
        .returning();
      if (!row) throw new Error("no vendor");
      return row.id;
    },
  };
  return books;
}

/** A card account on the feed. */
export const AMEX = { id: "acc-amex", name: "Amex Gold", mask: "1009", type: "credit" };
/** The checking account on the feed (the default). */
export const CHECKING = { id: "acc-checking", name: "Checking", mask: "0001", type: "depository" };
