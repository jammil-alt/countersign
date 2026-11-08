// Accounts receivable and create bill (ARCHITECTURE §6.2 v0.12, docs/plan.md §1.41, M18), against
// the fake QuickBooks: the AR reads, the aging report with its sources, the invoice note (the
// private note only, sparse, stale refused), create bill (duplicates and totals refused, created
// once across a retry) and the sync of customers, invoices and payments.

import { DEFAULT_PERMISSIONS, type JsonObject, mapQboInvoice } from "@countersign/core";
import { describe, expect, it } from "vitest";
import report from "../../../../fixtures/qbo/report-aged-receivable-detail.json";
import type { SyncedRecordServices, ToolContext, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode, parseUrl } from "../http";
import { captureBefore, executeWrite, runReadTool, ToolCallError } from "../invoke";
import { memoryLogger } from "../logger";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "../testing";
import {
  agingBucketOf,
  appendNote,
  createQboConnector,
  normalizeDocNumber,
  QBO_TOOLS,
  qboSyncPage,
  readAgingReport,
} from "./index";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const user = "0190f0c8-0000-7000-8000-0000000000a1";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const REDIRECT = "https://staging.mezonas.com/api/connections/qbo/callback";
const RECEIVABLE_130 = "0190f0c8-0000-7000-8000-000000000130";
const RECEIVABLE_133 = "0190f0c8-0000-7000-8000-000000000133";

/** A request's query parameters, decoded. */
const queryOf = (url: string) => formDecode(url.split("?")[1] ?? "");

/** What sync stored, as the platform answers it (apps/api reads the tables). */
function records(over: { bills?: { transactionId: string; externalId: string }[] } = {}) {
  const asked: unknown[] = [];
  const services: SyncedRecordServices = {
    async syncedBills(q) {
      asked.push(q);
      return over.bills ?? [];
    },
    async receivableIds(ids) {
      const known: Record<string, string> = { "130": RECEIVABLE_130, "133": RECEIVABLE_133 };
      const out: Record<string, string> = {};
      for (const id of ids) {
        const r = known[id];
        if (r) out[id] = r;
      }
      return out;
    },
  };
  return { services, asked };
}

async function setup(opts: { records?: SyncedRecordServices | null; now?: () => Date } = {}) {
  const qbo = fakeQbo({ now: opts.now ?? (() => NOW) });
  const connector = createQboConnector({
    ...FAKE_QBO_CLIENT,
    environment: "sandbox",
    fetch: qbo.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const grant = await connector.handleCallback?.(
    { code: "fixture-code", realmId: FAKE_QBO_REALM, state: "x" },
    { tenantId: tenant, userId: user, redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  const store = memoryCredentials(grant.credentials as JsonObject);
  const synced = opts.records === undefined ? records().services : opts.records;
  const ctx = (key = "run-1:step-1:0", now = NOW): WriteContext => ({
    tenantId: tenant,
    connection: {
      id: connectionId,
      tenantId: tenant,
      connector: "qbo",
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: store,
    logger: memoryLogger(),
    now: () => now,
    idempotencyKey: key,
    services: synced ? { records: synced } : {},
  });
  /** A proposal's context, as the runtime gives it: no action key yet. */
  const propose = (): ToolContext => {
    const { idempotencyKey: _key, ...rest } = ctx();
    return rest;
  };
  return { qbo, connector, ctx, propose };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("it was not refused");
}

describe("qbo: accounts receivable mapping", () => {
  it("maps invoices to receivables: open, paid and void, money in decimal", () => {
    const { qbo } = { qbo: fakeQbo() };
    expect(mapQboInvoice(qbo.get("Invoice", "132"))).toEqual({
      connector: "qbo",
      externalId: "132",
      docNumber: "1043",
      customerExternalId: "8",
      customerName: "Lakeside Builders",
      txnDate: "2026-10-20",
      dueDate: "2026-11-19",
      total: "2280.5000",
      balance: "2280.5000",
      currency: "USD",
      status: "open",
      privateNote: "Deposit received by check",
      ext: { qbo: { syncToken: "0", emailStatus: "NotSet", tax: null } },
    });
    expect(mapQboInvoice(qbo.get("Invoice", "131"))).toMatchObject({
      balance: "0.0000",
      status: "paid",
    });
    expect(mapQboInvoice(qbo.get("Invoice", "134"))).toMatchObject({ status: "void" });
  });
});

describe("qbo: accounts receivable reads", () => {
  it("finds open and overdue invoices, customers, and the invoices a payment paid", async () => {
    const s = await setup();
    const open = (await runReadTool(s.connector, QBO_TOOLS.invoiceQuery, { open: true }, s.ctx()))
      .output as { invoices: { id: string; balance: string }[] };
    expect(open.invoices.map((i) => i.id).sort()).toEqual(["130", "132", "133"]);
    const overdue = (
      await runReadTool(
        s.connector,
        QBO_TOOLS.invoiceQuery,
        { dueBefore: "2026-11-05", customerId: "8" },
        s.ctx(),
      )
    ).output as { invoices: { id: string; balance: string; customer: object }[] };
    expect(overdue.invoices).toEqual([
      expect.objectContaining({
        id: "130",
        balance: "5100.0000",
        customer: { id: "8", name: "Lakeside Builders" },
        lines: [expect.objectContaining({ amount: "5100.0000", qty: "1.0000" })],
      }),
    ]);
    const customers = (
      await runReadTool(s.connector, QBO_TOOLS.customerQuery, { name: "lake" }, s.ctx())
    ).output as { customers: unknown[] };
    expect(customers.customers).toEqual([
      expect.objectContaining({ id: "8", name: "Lakeside Builders", balance: "7380.5000" }),
    ]);
    const payments = (
      await runReadTool(s.connector, QBO_TOOLS.paymentQuery, { customerId: "7" }, s.ctx())
    ).output as { payments: unknown[] };
    expect(payments.payments).toEqual([
      expect.objectContaining({
        id: "501",
        total: "2400.0000",
        reference: "4471",
        applied: [{ invoiceId: "131", amount: "2400.0000" }],
      }),
    ]);
  });
});

describe("qbo: the aging report", () => {
  it("reads QuickBooks' report by its column keys: invoices only, buckets and totals", () => {
    const r = readAgingReport(report, "2026-11-05");
    expect(r.invoices.map((i) => [i.invoiceId, i.bucket, i.balance])).toEqual([
      ["132", "current", "2280.5000"],
      ["133", "days_1_30", "1840.0000"],
      ["130", "days_61_90", "5100.0000"],
    ]);
    expect(r.totals).toEqual({
      current: "2280.5000",
      days_1_30: "1840.0000",
      days_31_60: "0.0000",
      days_61_90: "5100.0000",
      days_91_plus: "0.0000",
      total: "9220.5000",
    });
    expect(r.customers.find((c) => c.customer.id === "8")).toMatchObject({
      current: "2280.5000",
      days_61_90: "5100.0000",
      total: "7380.5000",
    });
    expect(agingBucketOf("31 - 60 days past due")).toBe("days_31_60");
    expect(agingBucketOf("91 or more days past due")).toBe("days_91_plus");
    expect(agingBucketOf("Total for Current")).toBeNull();
  });

  it("reads the report live as of a day, with the receivables it rests on as sources", async () => {
    const s = await setup();
    const out = (
      await runReadTool(s.connector, QBO_TOOLS.agingReport, { asOf: "2026-11-05" }, s.ctx())
    ).output as {
      asOf: string;
      invoices: { invoiceId: string; receivableId: string | null; bucket: string }[];
      sources: string[];
    };
    expect(out.asOf).toBe("2026-11-05");
    expect(out.invoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ invoiceId: "130", receivableId: RECEIVABLE_130 }),
        expect.objectContaining({ invoiceId: "132", receivableId: null, bucket: "current" }),
      ]),
    );
    expect(out.sources.sort()).toEqual([RECEIVABLE_130, RECEIVABLE_133].sort());
    const call = s.qbo.apiCalls("GET", "reports").at(-1)?.url ?? "";
    const url = parseUrl(call);
    expect(url?.pathname.endsWith("/reports/AgedReceivableDetail")).toBe(true);
    expect(queryOf(call).report_date).toBe("2026-11-05");
  });

  it("refuses to report without the synced records its sources come from", async () => {
    const s = await setup({ records: null });
    expect(await refusal(runReadTool(s.connector, QBO_TOOLS.agingReport, {}, s.ctx()))).toMatch(
      /synced records/,
    );
  });
});

describe("qbo: a note on an invoice", () => {
  const input = { invoiceId: "132", note: "Called Pat;\n promised a check Friday", syncToken: "0" };

  it("adds a dated line to the private note only, once, with the old note as before", async () => {
    const s = await setup();
    const proposed = await captureBefore(s.connector, QBO_TOOLS.invoiceAddNote, input, s.ctx());
    expect(proposed.before).toEqual({
      id: "132",
      syncToken: "0",
      docNumber: "1043",
      customer: { id: "8", name: "Lakeside Builders" },
      privateNote: "Deposit received by check",
      privateNoteAfter:
        "Deposit received by check\n2026-11-05: Called Pat; promised a check Friday",
      balance: "2280.5000",
      currency: "USD",
      dueDate: "2026-11-19",
    });
    const written = await executeWrite(s.connector, QBO_TOOLS.invoiceAddNote, input, s.ctx());
    expect(written.output).toMatchObject({ id: "132", syncToken: "1", alreadyDone: false });
    const post = s.qbo.apiCalls("POST", "invoice");
    expect(post).toHaveLength(1);
    // The sparse body carries the private note and nothing else (the fake refuses anything more).
    expect(Object.keys(JSON.parse(post[0]?.body ?? "{}")).sort()).toEqual(
      ["Id", "PrivateNote", "SyncToken", "sparse"].sort(),
    );
    expect(queryOf(post[0]?.url ?? "").requestid).toMatch(/^[0-9a-f]{36}$/);
    const inv = s.qbo.get("Invoice", "132") as Record<string, unknown> & { Id: string };
    expect(inv?.PrivateNote).toBe(
      "Deposit received by check\n2026-11-05: Called Pat; promised a check Friday",
    );
    expect(inv?.TotalAmt).toBe(2280.5);
    expect(inv?.Balance).toBe(2280.5);

    // A retry after a lost answer finds its note and writes nothing (even a day later).
    const again = await executeWrite(
      s.connector,
      QBO_TOOLS.invoiceAddNote,
      input,
      s.ctx("run-1:step-1:0", new Date("2026-11-06T09:00:00.000Z")),
    );
    expect(again.output).toMatchObject({ alreadyDone: true });
    expect(s.qbo.apiCalls("POST", "invoice")).toHaveLength(1);
  });

  it("refuses a stale SyncToken and a note past QuickBooks' limit", async () => {
    const s = await setup();
    const inv = s.qbo.get("Invoice", "132") as Record<string, unknown> & { Id: string };
    s.qbo.put("Invoice", { ...inv, SyncToken: "1", PrivateNote: "Changed by a person" });
    expect(
      await refusal(executeWrite(s.connector, QBO_TOOLS.invoiceAddNote, input, s.ctx())),
    ).toMatch(/changed in QuickBooks since it was read/);
    expect(s.qbo.apiCalls("POST", "invoice")).toHaveLength(0);

    s.qbo.put("Invoice", { ...inv, SyncToken: "2", PrivateNote: "x".repeat(3990) });
    const long = { ...input, syncToken: "2" };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.invoiceAddNote, long, s.ctx())),
    ).toMatch(/at most 4000/);
    expect(appendNote(null, "2026-11-05: a")).toBe("2026-11-05: a");
  });
});

describe("qbo: create a bill", () => {
  const bill = {
    vendorId: "58",
    docNumber: "PHF-3301",
    txnDate: "2026-11-04",
    dueDate: "2026-12-04",
    expectedTotal: "212.50",
    privateNote: "Pacific Hardware invoice PHF-3301",
    lines: [
      {
        itemId: "23",
        description: "Euro hinge 110",
        qty: "50",
        unitPrice: "3.25",
        amount: "162.50",
      },
      { accountId: "81", description: "Freight", amount: "50.00" },
    ],
  };

  it("names the vendor, items and accounts for the card, and creates the bill once", async () => {
    const r = records();
    const s = await setup({ records: r.services });
    const proposed = await captureBefore(s.connector, QBO_TOOLS.billCreate, bill, s.propose());
    expect(proposed.before).toEqual({
      vendor: { id: "58", name: "Pacific Hardware & Finishes" },
      names: {
        items: { "23": "Euro hinge 110 degree" },
        accounts: { "81": "Job Materials:Freight In" },
      },
    });
    expect(r.asked).toEqual([{ vendorExternalId: "58", docNumber: "PHF-3301" }]);
    const written = await executeWrite(s.connector, QBO_TOOLS.billCreate, bill, s.ctx());
    expect(written.output).toMatchObject({
      docNumber: "PHF-3301",
      total: "212.5000",
      lineCount: 2,
      syncToken: "0",
      alreadyDone: false,
    });
    const id = (written.output as { id: string }).id;
    const created = s.qbo.get("Bill", id);
    expect(created).toMatchObject({
      VendorRef: { value: "58" },
      DocNumber: "PHF-3301",
      TxnDate: "2026-11-04",
      DueDate: "2026-12-04",
      PrivateNote: "Pacific Hardware invoice PHF-3301",
      TotalAmt: 212.5,
    });
    const post = s.qbo.apiCalls("POST", "bill");
    expect(post).toHaveLength(1);
    expect(queryOf(post[0]?.url ?? "").requestid).toMatch(/^[0-9a-f]{36}$/);
    // Amounts went out as JSON numbers written from their decimal text.
    expect(post[0]?.body).toContain('"Amount":162.5');

    // The same action again (a retried step): the bill is found, not created twice.
    const again = await executeWrite(s.connector, QBO_TOOLS.billCreate, bill, s.ctx());
    expect(again.output).toMatchObject({ id, alreadyDone: true });
    expect(s.qbo.apiCalls("POST", "bill")).toHaveLength(1);
    // And it is now a duplicate for any other proposal.
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.billCreate, bill, s.propose())),
    ).toMatch(/already in QuickBooks \(found live\)/);
  });

  it("refuses lines that don't add up, a vendor not the company's, and duplicates", async () => {
    const s = await setup();
    const off = { ...bill, expectedTotal: "213.00" };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.billCreate, off, s.propose())),
    ).toMatch(/add up to 212.5000, not the 213.00 expected/);
    expect(await refusal(executeWrite(s.connector, QBO_TOOLS.billCreate, off, s.ctx()))).toMatch(
      /add up/,
    );
    const stranger = { ...bill, vendorId: "999" };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.billCreate, stranger, s.propose())),
    ).toMatch(/isn't one of this company's vendors/);
    // A bill already there in QuickBooks, found live by its number.
    const live = { ...bill, vendorId: "56", docNumber: "INV-20931" };
    expect(
      await refusal(captureBefore(s.connector, QBO_TOOLS.billCreate, live, s.propose())),
    ).toMatch(/already in QuickBooks \(found live\)/);
    // A synced bill with the same vendor and number.
    const synced = await setup({
      records: records({ bills: [{ transactionId: "t-1", externalId: "Bill:145" }] }).services,
    });
    expect(
      await refusal(captureBefore(synced.connector, QBO_TOOLS.billCreate, bill, synced.propose())),
    ).toMatch(/already in QuickBooks \(synced\)/);
    expect(
      await refusal(executeWrite(synced.connector, QBO_TOOLS.billCreate, bill, synced.ctx())),
    ).toMatch(/synced/);
    // Without the synced records the check can't be made: refused.
    const blind = await setup({ records: null });
    expect(
      await refusal(captureBefore(blind.connector, QBO_TOOLS.billCreate, bill, blind.propose())),
    ).toMatch(/synced records/);
    expect(s.qbo.apiCalls("POST", "bill")).toHaveLength(0);
    expect(normalizeDocNumber("INV-20931")).toBe(normalizeDocNumber("inv 20931"));
  });

  it("validates its input: an item line must be qty × unit price", async () => {
    const s = await setup();
    const bad = {
      ...bill,
      lines: [{ itemId: "23", qty: "50", unitPrice: "3.25", amount: "160.00" }],
      expectedTotal: "160.00",
    };
    await expect(
      captureBefore(s.connector, QBO_TOOLS.billCreate, bad, s.propose()),
    ).rejects.toBeInstanceOf(ToolCallError);
  });
});

describe("qbo sync: customers, invoices and payments", () => {
  it("brings a payment and its invoice's new balance by CDC", async () => {
    let now = NOW;
    const s = await setup({ now: () => now });
    const client = await s.connector.client(s.ctx());
    let cursor = null;
    for (let i = 0; i < 100; i++) {
      const page = await qboSyncPage(client, cursor, { now });
      cursor = page.next;
      if (cursor.phase === "cdc") break;
    }
    now = new Date("2026-11-05T18:15:00.000Z");
    s.qbo.receivePayment("133", "1840");
    const page = await qboSyncPage(client, cursor, { now });
    expect(page.records.map((r) => [r.entityType, r.externalId, r.externalVersion])).toEqual([
      ["Invoice", "133", "1"],
      ["Payment", "601", "0"],
    ]);
    const inv = page.records.find((r) => r.entityType === "Invoice");
    expect(mapQboInvoice(inv?.payload)).toMatchObject({ balance: "0.0000", status: "paid" });
  });

  it("reads the AR entities once for a connection already on CDC, then CDC from where it was", async () => {
    const s = await setup();
    const client = await s.connector.client(s.ctx());
    const old = { v: 1 as const, phase: "cdc" as const, changedSince: "2026-11-05T17:00:00.000Z" };
    const seen: string[] = [];
    let cursor: Parameters<typeof qboSyncPage>[1] = old;
    for (let i = 0; i < 20; i++) {
      const page = await qboSyncPage(client, cursor, { now: NOW });
      expect(page.initial).toBe(true);
      seen.push(...new Set(page.records.map((r) => r.entityType)));
      cursor = page.next;
      if (cursor.phase === "cdc") break;
    }
    // B-2: the chart of accounts is read once too, after the AR entities.
    expect([...new Set(seen)]).toEqual(["Customer", "Invoice", "Payment", "Account"]);
    expect(cursor).toEqual({ ...old, ar: true, accounts: true });
  });

  it("B-2: reads the chart of accounts once for a connection already on CDC with its AR read", async () => {
    const s = await setup();
    const client = await s.connector.client(s.ctx());
    const old = {
      v: 1 as const,
      phase: "cdc" as const,
      changedSince: "2026-11-05T17:00:00.000Z",
      ar: true,
    };
    const page = await qboSyncPage(client, old, { now: NOW });
    expect(page.initial).toBe(true);
    expect(new Set(page.records.map((r) => r.entityType))).toEqual(new Set(["Account"]));
    expect(page.next).toEqual({ ...old, accounts: true });
  });

  it("B-2: an AR backfill stored before accounts were synced reads the accounts after it", async () => {
    const s = await setup();
    const client = await s.connector.client(s.ctx());
    const inProgress = {
      v: 1 as const,
      phase: "initial" as const,
      entity: "Payment" as const,
      start: 1,
      sinceDate: "2026-08-07",
      changedSince: "2026-11-05T17:00:00.000Z",
      entities: ["Customer" as const, "Invoice" as const, "Payment" as const],
    };
    const end = await qboSyncPage(client, inProgress, { now: NOW });
    expect(end.next).toMatchObject({ phase: "cdc", ar: true, accounts: false });
    const next = await qboSyncPage(client, end.next, { now: NOW });
    expect(new Set(next.records.map((r) => r.entityType))).toEqual(new Set(["Account"]));
    expect(next.next).toMatchObject({ phase: "cdc", ar: true, accounts: true });
  });
});
