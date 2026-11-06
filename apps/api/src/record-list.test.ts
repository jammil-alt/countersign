// The back office's Records page through the running app: what a client's QuickBooks connection
// brought in (stored the way sync stores it), with an upload beside it. Counts per kind, newest
// first, the search (memo, doc number, vendor, amount), the source filter, pagination, vendors and
// items (the latest version of each), and isolation: other clients, operators who don't serve the
// client, and client roles.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContentStore, createQboConnector } from "@countersign/connectors";
import { FAKE_QBO_CLIENT } from "@countersign/connectors/testing";
import { connection, rawRecord, transaction, vendor } from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { storeQboPage } from "./qbo/store";
import { containsPattern, searchAmount } from "./routes/record-list";

// biome-ignore lint/suspicious/noExplicitAny: response JSON in assertions
type J = any;

const h = await createApiHarness({
  connectors: () => [createQboConnector({ ...FAKE_QBO_CLIENT, environment: "sandbox" })],
});
afterAll(() => h?.close());

const INVOICE = readFileSync(resolve(DEFAULT_FIXTURE_DIR, "..", "invoices", "northline-20418.pdf"));
const SYNCED = new Date("2026-11-05T12:41:00.000Z");

const qboVendor = (id: string, name: string, extra: object = {}) => ({
  entityType: "Vendor",
  externalId: id,
  externalVersion: "0",
  payload: { Id: id, SyncToken: "0", DisplayName: name, Active: true, ...extra },
});

const qboItem = (id: string, version: string, extra: object) => ({
  entityType: "Item",
  externalId: id,
  externalVersion: version,
  payload: { Id: id, SyncToken: version, Type: "NonInventory", Active: true, ...extra },
});

function accountLine(id: string, amount: number, account: string) {
  return {
    Id: id,
    DetailType: "AccountBasedExpenseLineDetail",
    Amount: amount,
    AccountBasedExpenseLineDetail: { AccountRef: { value: "7", name: account } },
  };
}

function bill(id: string, fields: object) {
  return {
    entityType: "Bill",
    externalId: id,
    externalVersion: "0",
    payload: { Id: id, SyncToken: "0", CurrencyRef: { value: "USD" }, ...fields },
  };
}

describe.skipIf(!h)("the back office's records list", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ids = { qbo: "", upload: "", qboB: "", webhookBill: "", northlineBill: "" };
  const list = (who: string | null, client: string, query = "") =>
    H.call(who, "GET", `/api/ops/clients/${client}/records${query}`);

  async function qboConnection(tenantId: string, realm: string, accountName: string) {
    const [row] = await H.t.db
      .insert(connection)
      .values({
        tenantId,
        connector: "qbo",
        status: "connected",
        externalAccountId: realm,
        config: { accountName },
      })
      .returning();
    if (!row) throw new Error("no connection");
    return row.id;
  }

  async function storePage(
    tenantId: string,
    connectionId: string,
    records: Parameters<typeof storeQboPage>[2]["records"],
    files = new Map(),
  ) {
    await H.t.db.transaction((tx) =>
      storeQboPage(tx, new ContentStore(H.objects), {
        tenantId,
        connectionId,
        records,
        files,
        cursor: {},
        initial: true,
        now: SYNCED,
      }),
    );
  }

  beforeAll(async () => {
    ids.qbo = await qboConnection(A(), "9341455", "Sandbox Company_US_1");
    ids.qboB = await qboConnection(H.B.tenantId, "9341999", "Other Company");

    await storePage(
      A(),
      ids.qbo,
      [
        qboVendor("56", "Cal Telephone", { PrintOnCheckName: "CalTel Billing" }),
        qboVendor("57", "Northline Panel Supply"),
        qboItem("11", "0", { Name: "Baltic birch", PurchaseCost: 40 }),
        qboItem("12", "0", { Name: "Oak board", Sku: "OAK-1", PurchaseCost: 12.5 }),
        bill("146", {
          TxnDate: "2026-11-05",
          DocNumber: "WH-1",
          PrivateNote: "Mezonas webhook test",
          TotalAmt: 123.45,
          VendorRef: { value: "56", name: "Cal Telephone" },
          Line: [accountLine("1", 123.45, "Telephone")],
        }),
        bill("147", {
          TxnDate: "2026-10-29",
          DocNumber: "20418",
          PrivateNote: "Sheet goods",
          TotalAmt: 9742.35,
          VendorRef: { value: "57", name: "Northline Panel Supply" },
          Line: [accountLine("1", 9000, "Materials"), accountLine("2", 742.35, "Freight")],
        }),
        {
          entityType: "Purchase",
          externalId: "90",
          externalVersion: "0",
          payload: {
            Id: "90",
            SyncToken: "0",
            TxnDate: "2026-10-01",
            TotalAmt: 50,
            PaymentType: "CreditCard",
            EntityRef: { value: "56", name: "Cal Telephone", type: "Vendor" },
            Line: [accountLine("1", 50, "Telephone")],
          },
        },
        {
          entityType: "VendorCredit",
          externalId: "3",
          externalVersion: "0",
          payload: {
            Id: "3",
            SyncToken: "0",
            TxnDate: "2026-10-15",
            TotalAmt: 25,
            VendorRef: { value: "57", name: "Northline Panel Supply" },
            Line: [accountLine("1", 25, "Materials")],
          },
        },
        {
          entityType: "Attachable",
          externalId: "500",
          externalVersion: "0",
          payload: {
            Id: "500",
            SyncToken: "0",
            FileName: "northline-20418.pdf",
            ContentType: "application/pdf",
            AttachableRef: [{ EntityRef: { value: "147", type: "Bill" } }],
          },
        },
      ],
      new Map([
        [
          "500",
          { bytes: new Uint8Array(INVOICE), mime: "application/pdf", filename: "invoice.pdf" },
        ],
      ]),
    );
    // A later sync renames an item: the list shows its latest version, once.
    await storePage(A(), ids.qbo, [
      qboItem("11", "1", { Name: "Birch plywood 3/4in", PurchaseCost: 42.5 }),
    ]);

    // An uploaded card statement row beside it, with a vendor made here (no tool behind it).
    const [up] = await H.t.db
      .insert(connection)
      .values({ tenantId: A(), connector: "upload", status: "connected" })
      .returning();
    const [v] = await H.t.db
      .insert(vendor)
      .values({ tenantId: A(), name: "Corner Hardware", normalizedName: "corner hardware" })
      .returning();
    if (!up || !v) throw new Error("seed failed");
    ids.upload = up.id;
    const [r] = await H.t.db
      .insert(rawRecord)
      .values({
        tenantId: A(),
        connectionId: up.id,
        connector: "upload",
        entityType: "Purchase",
        externalId: "row-1",
        payload: { cells: { Vendor: "Corner Hardware", Amount: "18.20" } },
      })
      .returning();
    await H.t.db.insert(transaction).values({
      tenantId: A(),
      kind: "purchase",
      connector: "upload",
      vendorId: v.id,
      txnDate: "2026-09-12",
      total: "18.20",
      currency: "USD",
      memo: "Screws",
      sourceRawRecordId: r?.id,
      externalId: "row-1",
    });

    // Client B has a bill with the same memo: it must never show under A.
    await storePage(H.B.tenantId, ids.qboB, [
      bill("146", {
        TxnDate: "2026-11-05",
        PrivateNote: "Mezonas webhook test",
        TotalAmt: 123.45,
        VendorRef: { value: "9", name: "Cal Telephone" },
      }),
    ]);
    await H.t.db.update(connection).set({ lastSyncAt: SYNCED }).where(eq(connection.id, ids.qbo));
  });

  it("lists the client's transactions newest first, with counts and where each came from", async () => {
    const res = await list(OPERATOR, A());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = res.json as J;
    expect(body.counts).toEqual({ transactions: 5, vendors: 3, items: 2 });
    expect(body.lastSyncAt).toBe(SYNCED.toISOString());
    expect(body.total).toBe(5);
    expect(body.page.kind).toBe("transactions");
    expect(body.page.rows.map((t: J) => t.memo)).toEqual([
      "Mezonas webhook test",
      "Sheet goods",
      null,
      null,
      "Screws",
    ]);
    const [webhook, northline] = body.page.rows;
    expect(webhook).toMatchObject({
      txnKind: "bill",
      txnDate: "2026-11-05",
      vendor: { name: "Cal Telephone" },
      docNumber: "WH-1",
      currency: "USD",
      lines: 1,
      attachments: 0,
      sourceId: ids.qbo,
      deleted: false,
    });
    expect(webhook.total).toBe("123.4500");
    expect(northline).toMatchObject({ docNumber: "20418", lines: 2, attachments: 1 });
    expect(body.page.rows.map((t: J) => t.txnKind)).toEqual([
      "bill",
      "bill",
      "vendor_credit",
      "purchase",
      "purchase",
    ]);
    expect(body.page.rows[4]).toMatchObject({ sourceId: ids.upload, docNumber: null });
    // Sources: the QuickBooks company by name, the upload; never client B's.
    const qbo = body.sources.find((s: J) => s.id === ids.qbo);
    expect(qbo).toMatchObject({
      connector: "qbo",
      connectorName: "QuickBooks Online",
      accountName: "Sandbox Company_US_1",
      externalAccountId: "9341455",
    });
    expect(body.sources.map((s: J) => s.id).sort()).toEqual([ids.qbo, ids.upload].sort());
    ids.webhookBill = webhook.id;
    ids.northlineBill = northline.id;
    // Each row opens the existing record page.
    const one = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/records/${webhook.id}`);
    expect((one.json as J).record).toMatchObject({
      kind: "transaction",
      memo: "Mezonas webhook test",
    });
  });

  it("finds a transaction by memo, doc number, vendor or amount", async () => {
    const memos = async (q: string) =>
      ((await list(OPERATOR, A(), `?q=${encodeURIComponent(q)}`)).json as J).page.rows.map(
        (t: J) => t.id,
      );
    expect(await memos("webhook TEST")).toEqual([ids.webhookBill]);
    expect(await memos("WH-1")).toEqual([ids.webhookBill]);
    expect(await memos("123.45")).toEqual([ids.webhookBill]);
    expect(await memos("$9,742.35")).toEqual([ids.northlineBill]);
    expect(await memos("northline")).toHaveLength(2);
    expect(await memos("%")).toEqual([]);
    const res = await list(OPERATOR, A(), "?q=webhook");
    // The counts stay the client's; the total is the search's.
    expect((res.json as J).counts.transactions).toBe(5);
    expect((res.json as J).total).toBe(1);
  });

  it("filters by source", async () => {
    const up = (await list(OPERATOR, A(), `?source=${ids.upload}`)).json as J;
    expect(up.counts).toEqual({ transactions: 1, vendors: 0, items: 0 });
    expect(up.page.rows.map((t: J) => t.memo)).toEqual(["Screws"]);
    expect(up.lastSyncAt).toBeNull();
    const qbo = (await list(OPERATOR, A(), `?source=${ids.qbo}`)).json as J;
    expect(qbo.counts).toEqual({ transactions: 4, vendors: 2, items: 2 });
    expect(qbo.lastSyncAt).toBe(SYNCED.toISOString());
    // Another client's connection names nothing here.
    const other = (await list(OPERATOR, A(), `?source=${ids.qboB}`)).json as J;
    expect(other.counts).toEqual({ transactions: 0, vendors: 0, items: 0 });
    expect(other.page.rows).toEqual([]);
  });

  it("pages through them", async () => {
    const all = ((await list(OPERATOR, A())).json as J).page.rows.map((t: J) => t.id);
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const page = (await list(OPERATOR, A(), `?limit=2&offset=${offset}`)).json as J;
      expect(page).toMatchObject({ total: 5, offset, limit: 2 });
      seen.push(...page.page.rows.map((t: J) => t.id));
    }
    expect(seen).toEqual(all);
    const past = (await list(OPERATOR, A(), "?offset=10")).json as J;
    expect(past.page.rows).toEqual([]);
    expect(past.total).toBe(5);
    expect((await list(OPERATOR, A(), "?limit=500")).status).toBe(400);
  });

  it("lists vendors with their source, and finds them by another name", async () => {
    const body = (await list(OPERATOR, A(), "?kind=vendors")).json as J;
    expect(body.page.kind).toBe("vendors");
    const byName = Object.fromEntries(body.page.rows.map((v: J) => [v.name, v]));
    expect(byName["Cal Telephone"]).toMatchObject({
      externalId: "56",
      sourceId: ids.qbo,
      syncedAt: expect.any(String),
      transactions: 2,
    });
    expect(byName["Corner Hardware"]).toMatchObject({
      sourceId: null,
      externalId: null,
      syncedAt: null,
      transactions: 1,
    });
    const found = (await list(OPERATOR, A(), "?kind=vendors&q=caltel")).json as J;
    expect(found.page.rows.map((v: J) => v.name)).toEqual(["Cal Telephone"]);
    const fromQbo = (await list(OPERATOR, A(), `?kind=vendors&source=${ids.qbo}`)).json as J;
    expect(fromQbo.page.rows.map((v: J) => v.name).sort()).toEqual([
      "Cal Telephone",
      "Northline Panel Supply",
    ]);
  });

  it("lists items at their latest version, and finds them by name or cost", async () => {
    const body = (await list(OPERATOR, A(), "?kind=items")).json as J;
    expect(body.total).toBe(2);
    const birch = body.page.rows.find((i: J) => i.externalId === "11");
    expect(birch).toMatchObject({
      name: "Birch plywood 3/4in",
      purchaseCost: "42.5000",
      type: "NonInventory",
      active: true,
      deleted: false,
      sourceId: ids.qbo,
    });
    const one = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/records/${birch.id}`);
    expect((one.json as J).record).toMatchObject({
      kind: "raw_record",
      entityType: "Item",
      externalVersion: "1",
    });
    const byName = (await list(OPERATOR, A(), "?kind=items&q=plywood")).json as J;
    expect(byName.page.rows.map((i: J) => i.externalId)).toEqual(["11"]);
    // The old name is history, not a match.
    expect(((await list(OPERATOR, A(), "?kind=items&q=baltic")).json as J).total).toBe(0);
    expect(((await list(OPERATOR, A(), "?kind=items&q=40")).json as J).total).toBe(0);
    const byCost = (await list(OPERATOR, A(), "?kind=items&q=12.50")).json as J;
    expect(byCost.page.rows.map((i: J) => i.sku)).toEqual(["OAK-1"]);
  });

  it("keeps each client's records to itself", async () => {
    const b = (await list(OPERATOR, H.B.tenantId)).json as J;
    expect(b.counts).toEqual({ transactions: 1, vendors: 1, items: 0 });
    expect(b.page.rows.map((t: J) => t.id)).not.toContain(ids.webhookBill);
    expect(b.sources.map((s: J) => s.id)).toEqual([ids.qboB]);
    // An operator who doesn't serve client A, and a client with nothing synced.
    expect((await list(OTHER_OPERATOR, A())).status).toBe(404);
    const c = (await list(OTHER_OPERATOR, H.C.tenantId)).json as J;
    expect(c.counts).toEqual({ transactions: 0, vendors: 0, items: 0 });
    expect(c.sources).toEqual([]);
  });

  it("is the operator's only", async () => {
    for (const who of [admin("a"), user("a")]) {
      expect((await list(who, A())).status).toBe(403);
      const asClient = await H.call(who, "GET", `/api/ops/clients/${A()}/records`, undefined, {
        "x-countersign-client": A(),
      });
      expect(asClient.status).toBe(403);
    }
    expect((await list(null, A())).status).toBe(401);
  });
});

// v0.12 W1-H: the portal's list (docs/plan.md §1.43): the same list, for the client's own records.
describe.skipIf(!h)("the portal's records list", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;

  it("lists the client's own records, the back office's view of them", async () => {
    for (const who of [admin("a"), user("a")]) {
      const res = await H.call(who, "GET", "/api/records");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const ops = (await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/records`)).json as J;
      expect(res.json).toEqual(ops);
    }
    const vendors = (await H.call(admin("a"), "GET", "/api/records?kind=vendors&q=telephone"))
      .json as J;
    expect(vendors.page.rows.map((v: J) => v.name)).toEqual(["Cal Telephone"]);
    const paged = (await H.call(admin("a"), "GET", "/api/records?offset=1&limit=2")).json as J;
    expect([paged.offset, paged.limit, paged.page.rows.length]).toEqual([1, 2, 2]);
    // Nothing a portal response may not carry (invariant 11).
    expect(forbiddenKeys(paged)).toEqual([]);
  });

  it("shows each client its own records only, and only to its people", async () => {
    const a = (await H.call(admin("a"), "GET", "/api/records")).json as J;
    const b = (await H.call(admin("b"), "GET", "/api/records")).json as J;
    expect(b.counts.transactions).toBe(1);
    const aIds = a.page.rows.map((t: J) => t.id);
    for (const t of b.page.rows) expect(aIds).not.toContain(t.id);
    expect(JSON.stringify(b)).not.toContain("Sheet goods");
    // Naming another client in the header gets none of its records.
    const asA = await H.call(admin("b"), "GET", "/api/records", undefined, {
      "x-countersign-client": A(),
    });
    expect(asA.status).not.toBe(200);
    for (const id of aIds) expect(JSON.stringify(asA.json)).not.toContain(id);
    expect((await H.call(null, "GET", "/api/records")).status).toBe(401);
    expect((await H.call(admin("a"), "GET", "/api/records?kind=bundles")).status).toBe(400);
  });
});

describe("search helpers", () => {
  it("takes the user's wildcards literally", () => {
    expect(containsPattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });

  it("reads an amount from a search, or none", () => {
    expect(searchAmount("$1,234.5")).toBe("1234.5000");
    expect(searchAmount("123.45")).toBe("123.4500");
    expect(searchAmount("WH-1")).toBeNull();
    expect(searchAmount("1.23456")).toBeNull();
    expect(searchAmount("")).toBeNull();
  });
});
