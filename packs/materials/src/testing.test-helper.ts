// A client for the pack's database tests: a user, a client agent version (the decider an agent's
// matches record), vendors and invoices with lines. Written through the superuser connection,
// which bypasses RLS; the tests then act as cs_worker inside withTenant.

import { createHash, randomBytes } from "node:crypto";
import type { AgentBundle } from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  type Db,
  docExtraction,
  docLine,
  document,
  membership,
  tenant,
  transaction,
  vendor,
} from "@countersign/db";

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
  return {
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
      const ref = randomBytes(8).toString("hex");
      const [tx] = await db
        .insert(transaction)
        .values({
          tenantId,
          kind: "bill",
          connector: "upload",
          vendorId,
          txnDate: "2026-11-02",
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
          header: { vendorName: "Vendor" },
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
            extPrice: line.unitPrice ?? "10",
          })
          .returning();
        if (!dl) throw new Error("no doc line");
        ids.push(dl.id);
      }
      return ids;
    },
  };
}
