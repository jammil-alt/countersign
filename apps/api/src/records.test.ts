// Record pages and the back office's documents (docs/plan.md §1.16) through the running app: what a
// source id names in the portal and the back office (transaction, raw record, document, an
// extraction's document, vendor), client isolation for both surfaces, and the back office's list
// and document page with its 5-minute link.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import {
  docExtraction,
  document,
  rawRecord,
  transaction,
  transactionLine,
  vendor,
} from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";
import { defaultDeps } from "./http";
import { extractInBackground } from "./routes/documents";

// biome-ignore lint/suspicious/noExplicitAny: response JSON in assertions
type J = any;

const h = await createApiHarness();
afterAll(() => h?.close());

const INVOICE = readFileSync(resolve(DEFAULT_FIXTURE_DIR, "..", "invoices", "northline-20418.pdf"));

function forbiddenKeys(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(FORBIDDEN_PORTAL_FIELD.test(k) ? [`${at}.${k}`] : []),
    ...forbiddenKeys(v, `${at}.${k}`),
  ]);
}

describe.skipIf(!h)("record pages", () => {
  const H = h as NonNullable<typeof h>;
  const ids = { vendor: "", raw: "", txn: "", doc: "", extraction: "" };

  beforeAll(async () => {
    const A = H.A.tenantId;
    const [v] = await H.t.db
      .insert(vendor)
      .values({ tenantId: A, name: "Northline Panel Supply", normalizedName: "northline panel" })
      .returning();
    const [r] = await H.t.db
      .insert(rawRecord)
      .values({
        tenantId: A,
        connectionId: H.A.connectionId,
        connector: "upload",
        entityType: "Purchase",
        externalId: "row-1",
        payload: {
          cells: { Date: "10/29/2026", Vendor: "Northline Panel Supply", Amount: "9742.35" },
          file: { filename: "card.csv", row: 2 },
        },
      })
      .returning();
    const [t] = await H.t.db
      .insert(transaction)
      .values({
        tenantId: A,
        kind: "purchase",
        connector: "upload",
        vendorId: v?.id,
        txnDate: "2026-10-29",
        total: "9742.35",
        currency: "USD",
        memo: "Sheet goods",
        sourceRawRecordId: r?.id,
        externalId: "row-1",
      })
      .returning();
    if (!v || !r || !t) throw new Error("seed failed");
    await H.t.db.insert(transactionLine).values({
      tenantId: A,
      transactionId: t.id,
      lineNo: 1,
      detailType: "account",
      accountRef: "Materials",
      description: "Baltic birch 3/4in",
      amount: "9742.35",
    });

    const form = new FormData();
    form.append("files", new File([INVOICE], "northline-20418.pdf", { type: "application/pdf" }));
    const res = await H.app.request(
      "/api/uploads",
      { method: "POST", headers: { [DEV_USER_HEADER]: admin("a") }, body: form },
      H.env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    const docId = ((await res.json()) as J).results[0].document.id as string;
    await extractInBackground(
      {
        db: H.db,
        env: H.env,
        deps: {
          ...defaultDeps,
          objects: () => H.objects,
          extractionTransport: () => H.extraction.transport,
        },
      },
      A,
      [docId],
    );
    await H.t.db.update(document).set({ transactionId: t.id }).where(eq(document.id, docId));
    const [x] = await H.t.db
      .select()
      .from(docExtraction)
      .where(eq(docExtraction.documentId, docId));
    if (!x) throw new Error("not extracted");
    Object.assign(ids, { vendor: v.id, raw: r.id, txn: t.id, doc: docId, extraction: x.id });
  });

  it("shows a client its transaction: fields, lines, documents and where it came from", async () => {
    const res = await H.call(user("a"), "GET", `/api/records/${ids.txn}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const rec = (res.json as J).record;
    expect(rec).toMatchObject({
      kind: "transaction",
      id: ids.txn,
      txnKind: "purchase",
      connector: "upload",
      vendor: { id: ids.vendor, name: "Northline Panel Supply" },
      txnDate: "2026-10-29",
      currency: "USD",
      memo: "Sheet goods",
      rawRecordId: ids.raw,
      documents: [{ id: ids.doc, filename: "northline-20418.pdf" }],
    });
    expect(Number(rec.total)).toBe(9742.35);
    expect(rec.lines).toHaveLength(1);
    expect(rec.lines[0]).toMatchObject({ lineNo: 1, description: "Baltic birch 3/4in" });
    expect(forbiddenKeys(res.json)).toEqual([]);
  });

  it("shows the raw record as it arrived, with the transactions made from it", async () => {
    const res = await H.call(admin("a"), "GET", `/api/records/${ids.raw}`);
    expect(res.status).toBe(200);
    const rec = (res.json as J).record;
    expect(rec).toMatchObject({
      kind: "raw_record",
      connector: "upload",
      entityType: "Purchase",
      externalId: "row-1",
      isDeleted: false,
      payload: { cells: { Vendor: "Northline Panel Supply" }, file: { filename: "card.csv" } },
    });
    expect(rec.transactions.map((t: J) => t.id)).toEqual([ids.txn]);
  });

  it("names a document, and sends an extraction id to its document", async () => {
    const doc = await H.call(admin("a"), "GET", `/api/records/${ids.doc}`);
    expect((doc.json as J).record).toMatchObject({
      kind: "document",
      id: ids.doc,
      documentId: ids.doc,
      source: "upload",
    });
    const x = await H.call(admin("a"), "GET", `/api/records/${ids.extraction}`);
    expect((x.json as J).record).toMatchObject({
      kind: "document",
      id: ids.extraction,
      documentId: ids.doc,
    });
    // No model name or cost reaches the portal.
    expect(JSON.stringify(x.json)).not.toMatch(/claude|costUsd|"model"/);
  });

  it("shows a vendor with its recent transactions", async () => {
    const res = await H.call(admin("a"), "GET", `/api/records/${ids.vendor}`);
    expect((res.json as J).record).toMatchObject({
      kind: "vendor",
      name: "Northline Panel Supply",
      transactions: [{ id: ids.txn, txnKind: "purchase" }],
    });
  });

  it("keeps each client's records to itself, and 404s ids that are not records", async () => {
    for (const id of Object.values(ids)) {
      expect((await H.call(admin("b"), "GET", `/api/records/${id}`)).status).toBe(404);
    }
    expect((await H.call(admin("a"), "GET", `/api/records/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
    expect((await H.call(admin("a"), "GET", "/api/records/not-an-id")).status).toBe(400);
  });

  it("shows the operator a served client's records, by that client only", async () => {
    const path = (client: string, id: string) => `/api/ops/clients/${client}/records/${id}`;
    const ok = await H.call(OPERATOR, "GET", path(H.A.tenantId, ids.txn));
    expect(ok.status).toBe(200);
    expect((ok.json as J).record).toMatchObject({ kind: "transaction", id: ids.txn });
    // The right id under another served client: not there.
    expect((await H.call(OPERATOR, "GET", path(H.B.tenantId, ids.txn))).status).toBe(404);
    // An operator who doesn't serve client A.
    expect((await H.call(OTHER_OPERATOR, "GET", path(H.A.tenantId, ids.txn))).status).toBe(404);
  });

  it("lists a served client's documents for the operator and opens one with a 5-minute link", async () => {
    const list = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/documents`);
    expect(list.status).toBe(200);
    expect((list.json as J).documents.map((d: J) => d.id)).toEqual([ids.doc]);
    expect((list.json as J).documents[0]).toMatchObject({
      vendorName: "Northline Panel Supply",
      transactionId: ids.txn,
    });
    const empty = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.B.tenantId}/documents`);
    expect((empty.json as J).documents).toEqual([]);
    expect(
      (await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/documents`)).status,
    ).toBe(404);

    const one = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/documents/${ids.doc}`,
    );
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    const body = one.json as J;
    expect(body.document).toMatchObject({ id: ids.doc, status: "extracted" });
    expect(body.extraction).toMatchObject({ vendorName: "Northline Panel Supply" });
    const url = new URL(body.url);
    const file = await H.app.request(url.pathname, {}, H.env);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(INVOICE));
    expect(Date.parse(body.urlExpiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    // Under another client, or for an operator who doesn't serve A: not found.
    expect(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${H.B.tenantId}/documents/${ids.doc}`))
        .status,
    ).toBe(404);
    expect(
      (await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/documents/${ids.doc}`))
        .status,
    ).toBe(404);
  });
});
