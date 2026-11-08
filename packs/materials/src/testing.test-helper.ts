// A client for the pack's database tests: a user, a client agent version (the decider an agent's
// matches record), vendors and invoices with lines. Written through the superuser connection,
// which bypasses RLS; the tests then act as cs_worker inside withTenant.

import { createHash, randomBytes } from "node:crypto";
import type { AgentBundle } from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  contact,
  type Db,
  docExtraction,
  docLine,
  document,
  membership,
  rawRecord,
  tenant,
  transaction,
  transactionLine,
  vendor,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";

const BUNDLE: AgentBundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Pia", role: "purchasing", mission: "match lines" },
    kind: "functional",
    model: { id: "test-model", maxTokens: 1024 },
    instructions: "Match lines.",
    skills: [],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "suggest_only" },
    budgets: { maxSteps: 3, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [],
};

export interface InvoiceLine {
  description: string;
  sku?: string | null;
  qty?: string;
  uom?: string | null;
  unitPrice?: string;
}

export interface ShopFixture {
  tenantId: string;
  userId: string;
  agentVersionId: string;
  vendor(name: string): Promise<string>;
  /** One invoice from a vendor; answers its doc line ids in order. */
  invoice(vendorId: string, lines: readonly InvoiceLine[]): Promise<string[]>;
  /** The same, dated, with freight and surcharges; answers the document and its line ids. */
  invoiceDoc(
    vendorId: string,
    lines: readonly InvoiceLine[],
    options?: InvoiceOptions,
  ): Promise<{ documentId: string; extractionId: string; lineIds: string[] }>;
  /** P-5: a contact in the client's directory. */
  contact(name: string): Promise<string>;
  /**
   * P-5: a QuickBooks bill as sync stores it: a raw record (Bill, its QBO payload) and the
   * transaction mapped from it, with its lines. A later `syncToken` is the bill's next version.
   */
  qboBill(bill: QboBillFixture): Promise<{ rawRecordId: string; transactionId: string }>;
}

export interface QboBillFixture {
  id: string;
  vendorId: string;
  vendorQboId?: string;
  date: string;
  syncToken?: string;
  lines: (
    | { id: string; item: string; description?: string; qty: number; unitPrice: number }
    | { id: string; account: string; description?: string; amount: number }
  )[];
}

export interface InvoiceOptions {
  /** yyyy-mm-dd: the invoice date. */
  date?: string;
  freight?: string;
  surcharges?: { label: string; amount: string }[];
}

let counter = 0;

export async function insertShop(db: Db, name: string): Promise<ShopFixture> {
  const n = ++counter;
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error("no tenant");
  const tenantId = t.id;
  const [u] = await db
    .insert(appUser)
    .values({ email: `buyer${n}-${tenantId}@example.com`, name: `Buyer ${n}` })
    .returning();
  if (!u) throw new Error("no user");
  await db.insert(membership).values({ tenantId, userId: u.id, role: "client_admin" });
  const [a] = await db
    .insert(agent)
    .values({ tenantId, kind: "client", slug: "pia", name: "Pia" })
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

  const vendors = new Map<string, string>();
  let qboConnectionId: string | null = null;
  let contacts = 0;
  const shop: ShopFixture = {
    tenantId,
    userId: u.id,
    agentVersionId: av.id,
    async vendor(vendorName) {
      const known = vendors.get(vendorName);
      if (known) return known;
      const [v] = await db
        .insert(vendor)
        .values({ tenantId, name: vendorName, normalizedName: vendorName.toLowerCase() })
        .returning();
      if (!v) throw new Error("no vendor");
      vendors.set(vendorName, v.id);
      return v.id;
    },
    async invoice(vendorId, lines) {
      return (await shop.invoiceDoc(vendorId, lines)).lineIds;
    },
    async invoiceDoc(vendorId, lines, options = {}) {
      const ref = randomBytes(8).toString("hex");
      const [tx] = await db
        .insert(transaction)
        .values({
          tenantId,
          kind: "bill",
          connector: "upload",
          vendorId,
          txnDate: options.date ?? "2026-11-02",
          total: "100.0000",
          externalId: ref,
        })
        .returning();
      if (!tx) throw new Error("no transaction");
      const sha = createHash("sha256").update(ref).digest("hex");
      const [d] = await db
        .insert(document)
        .values({
          tenantId,
          transactionId: tx.id,
          source: "upload",
          storageKey: `tenants/${tenantId}/content/${sha.slice(0, 2)}/${sha}`,
          mimeType: "application/pdf",
          filename: `${ref}.pdf`,
          sizeBytes: 10,
          sha256: sha,
        })
        .returning();
      if (!d) throw new Error("no document");
      const [ex] = await db
        .insert(docExtraction)
        .values({
          tenantId,
          documentId: d.id,
          model: "test-model",
          header: { vendorName: "Vendor", ...(options.date ? { invoiceDate: options.date } : {}) },
          freight: options.freight ?? "0",
          surcharges: options.surcharges ?? [],
          subtotal: "100",
          total: "100",
          linesSum: "100",
          totalsMatch: true,
        })
        .returning();
      if (!ex) throw new Error("no extraction");
      const ids: string[] = [];
      for (const [i, line] of lines.entries()) {
        const [dl] = await db
          .insert(docLine)
          .values({
            tenantId,
            extractionId: ex.id,
            lineNo: i + 1,
            vendorSku: line.sku ?? null,
            rawDescription: line.description,
            qty: line.qty ?? "1",
            uomRaw: line.uom ?? null,
            unitPrice: line.unitPrice ?? "10",
            extPrice: String(Number(line.unitPrice ?? "10") * Number(line.qty ?? "1")),
          })
          .returning();
        if (!dl) throw new Error("no doc line");
        ids.push(dl.id);
      }
      return { documentId: d.id, extractionId: ex.id, lineIds: ids };
    },
    async contact(contactName) {
      const [c] = await db
        .insert(contact)
        .values({
          tenantId,
          name: contactName,
          phone: `+1555${String(++contacts).padStart(7, "0")}`,
        })
        .returning();
      if (!c) throw new Error("no contact");
      return c.id;
    },
    async qboBill(bill) {
      if (!qboConnectionId) {
        const [conn] = await db
          .insert(connection)
          .values({ tenantId, connector: "qbo", status: "connected", externalAccountId: "realm-1" })
          .returning();
        if (!conn) throw new Error("no connection");
        qboConnectionId = conn.id;
      }
      const payload = {
        Id: bill.id,
        SyncToken: bill.syncToken ?? "0",
        TxnDate: bill.date,
        VendorRef: { value: bill.vendorQboId ?? "56", name: "Vendor" },
        TotalAmt: 0,
        Line: bill.lines.map((l, i) =>
          "item" in l
            ? {
                Id: l.id,
                LineNum: i + 1,
                ...(l.description ? { Description: l.description } : {}),
                Amount: l.qty * l.unitPrice,
                DetailType: "ItemBasedExpenseLineDetail",
                ItemBasedExpenseLineDetail: {
                  ItemRef: { value: `${i + 10}`, name: l.item },
                  Qty: l.qty,
                  UnitPrice: l.unitPrice,
                },
              }
            : {
                Id: l.id,
                LineNum: i + 1,
                ...(l.description ? { Description: l.description } : {}),
                Amount: l.amount,
                DetailType: "AccountBasedExpenseLineDetail",
                AccountBasedExpenseLineDetail: { AccountRef: { value: "7", name: l.account } },
              },
        ),
      };
      const [raw] = await db
        .insert(rawRecord)
        .values({
          tenantId,
          connectionId: qboConnectionId,
          connector: "qbo",
          entityType: "Bill",
          externalId: bill.id,
          externalVersion: bill.syncToken ?? "0",
          payload,
        })
        .returning();
      if (!raw) throw new Error("no raw record");
      const externalId = `Bill:${bill.id}`;
      const [existing] = await db
        .select()
        .from(transaction)
        .where(and(eq(transaction.tenantId, tenantId), eq(transaction.externalId, externalId)));
      let txId = existing?.id;
      if (existing) {
        await db
          .update(transaction)
          .set({ sourceRawRecordId: raw.id })
          .where(eq(transaction.id, existing.id));
      } else {
        const [tx] = await db
          .insert(transaction)
          .values({
            tenantId,
            kind: "bill",
            connector: "qbo",
            vendorId: bill.vendorId,
            txnDate: bill.date,
            total: "0",
            externalId,
            sourceRawRecordId: raw.id,
          })
          .returning();
        if (!tx) throw new Error("no transaction");
        txId = tx.id;
        for (const [i, l] of bill.lines.entries()) {
          await db.insert(transactionLine).values({
            tenantId,
            transactionId: tx.id,
            lineNo: i + 1,
            detailType: "item" in l ? "item" : "account",
            itemRef: "item" in l ? l.item : null,
            accountRef: "item" in l ? null : l.account,
            description: l.description ?? null,
            amount: String("item" in l ? l.qty * l.unitPrice : l.amount),
          });
        }
      }
      return { rawRecordId: raw.id, transactionId: txId as string };
    },
  };
  return shop;
}
