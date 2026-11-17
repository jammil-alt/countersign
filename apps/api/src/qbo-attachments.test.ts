// A first QuickBooks sync at a company with many large attachments (audit 2.3), against the fake:
// each step downloads files within its byte budget and stores them before the next, so the sync
// finishes, no file is downloaded twice, and a bill entered in QuickBooks meanwhile arrives while
// the attachments are still catching up.

import { ContentStore, createQboConnector, generateEncryptionKey } from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { connection, document, rawRecord, transaction } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { MAX_SYNC_PAGES, runQboSync } from "./qbo/sync";
import { credentialsFor } from "./runs/execute";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const NOW = new Date("2026-11-05T18:00:00.000Z");
const FILES = "https://qbo-files.fake.example/";
/** Forty phone photos of receipts, 200 KB each; a step may download 600 KB. */
const COUNT = 40;
const FILE_BYTES = 200_000;
const BUDGET = 600_000;

const clock = { now: NOW };
const qbo = fakeQbo({ now: () => clock.now });

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://staging.mezonas.test",
  },
  qboSync: new MemoryQboSyncInstances(),
  appDbMax: 1,
});
afterAll(() => h?.close());

/** A PDF of `size` bytes, different for each `n`. */
function pdf(n: number, size: number): Uint8Array {
  const head = `%PDF-1.4\n% receipt ${n}\n`;
  const tail = "\n%%EOF\n";
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(new TextEncoder().encode(head), 0);
  bytes.set(new TextEncoder().encode(tail), size - tail.length);
  return bytes;
}

describe.skipIf(!h)("a first QuickBooks sync with many large attachments", () => {
  const H = h as ApiHarness;
  let connectionId = "";

  beforeAll(async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    connectionId = j(done.json).connection.connection.id;
    await H.settle();
    // Attached in October: the initial sync's history.
    clock.now = new Date("2026-10-20T12:00:00.000Z");
    for (let i = 0; i < COUNT; i++) {
      qbo.attachFile("Bill", "146", {
        fileName: `receipt-${i}.pdf`,
        bytes: pdf(i, FILE_BYTES),
        contentType: "application/pdf",
      });
    }
    clock.now = NOW;
  });

  const deps = () => ({
    db: H.db,
    platform: H.platform,
    content: new ContentStore(H.objects),
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    now: () => NOW,
    attachmentBytesPerStep: BUDGET,
  });
  const fileCalls = () => qbo.requests.filter((r) => r.url.startsWith(FILES));
  const docs = () =>
    H.t.db
      .select()
      .from(document)
      .where(and(eq(document.tenantId, H.A.tenantId), eq(document.connectionId, connectionId)));
  const bill147 = () =>
    H.t.db
      .select()
      .from(transaction)
      .where(and(eq(transaction.tenantId, H.A.tenantId), eq(transaction.externalId, "Bill:147")));

  it("finishes within its budget a step, files once each, and new bills come meanwhile", async () => {
    const perStep: number[] = [];
    let billArrivedWith: number | null = null;
    const runner = {
      async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const before = fileCalls().length;
        const out = await fn();
        if (name.startsWith("page-")) {
          perStep.push(fileCalls().length - before);
          const stored = (await docs()).length;
          // Once some files are in, a bill is entered in QuickBooks.
          if (stored > 0 && !qbo.get("Bill", "147")) {
            clock.now = new Date(NOW.getTime() + 1000);
            qbo.put("Bill", {
              Id: "147",
              SyncToken: "0",
              TxnDate: "2026-11-05",
              VendorRef: { value: "56", name: "Northwest Plywood Supply" },
              Line: [
                {
                  Id: "1",
                  Amount: 704,
                  DetailType: "AccountBasedExpenseLineDetail",
                  AccountBasedExpenseLineDetail: { AccountRef: { value: "80" } },
                },
              ],
              TotalAmt: 704,
            });
            clock.now = NOW;
          }
          if (billArrivedWith === null && (await bill147()).length > 0) billArrivedWith = stored;
        }
        return out;
      },
    };
    const result = await runQboSync(
      { ...deps(), now: () => new Date(NOW.getTime() + 2000) },
      { tenantId: H.A.tenantId, connectionId, reason: "connected" },
      runner,
    );
    expect(result.skipped).toBeUndefined();
    expect(result.pages).toBeLessThan(MAX_SYNC_PAGES);
    // Every receipt and the fixture's invoice, each downloaded once.
    expect((await docs()).length).toBe(COUNT + 1);
    expect(fileCalls()).toHaveLength(COUNT + 1);
    // No step downloaded more than its budget, and the files took several steps.
    expect(Math.max(...perStep) * FILE_BYTES).toBeLessThanOrEqual(BUDGET);
    expect(perStep.filter((n) => n > 0).length).toBeGreaterThanOrEqual(COUNT / 3);
    // The bill came by CDC while attachments were still coming in.
    expect(billArrivedWith).not.toBeNull();
    expect(billArrivedWith as unknown as number).toBeLessThan(COUNT + 1);

    // Again: nothing is downloaded twice.
    const again = await runQboSync(
      deps(),
      { tenantId: H.A.tenantId, connectionId, reason: "operator" },
      { do: (_n, fn) => fn() },
    );
    expect(again.documents).toBe(0);
    expect(fileCalls()).toHaveLength(COUNT + 1);
  });

  it("reads business data first in every sync, and skips a file that keeps failing", async () => {
    const later = (s: number) => new Date(NOW.getTime() + s * 1000);
    clock.now = later(10);
    const broken = qbo.attachFile("Bill", "146", {
      fileName: "broken.pdf",
      bytes: pdf(900, 2000),
      contentType: "application/pdf",
    });
    const fine = qbo.attachFile("Bill", "146", {
      fileName: "fine.pdf",
      bytes: pdf(901, 2000),
      contentType: "application/pdf",
    });
    qbo.failFile(broken);
    clock.now = NOW;
    const tries = () => qbo.requests.filter((r) => r.url.startsWith(`${FILES}${broken}`)).length;
    const once = { do: <T>(_n: string, fn: () => Promise<T>) => fn() };
    const sync = (at: number) =>
      runQboSync(
        { ...deps(), now: () => later(at) },
        { tenantId: H.A.tenantId, connectionId, reason: "operator" },
        once,
      );
    const cursorOf = async () => {
      const [c] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
      return c?.syncCursor as { attachments?: { failures?: object; skipped?: unknown[] } };
    };
    // The file fails: the sync fails at its attachment page, and the failure is counted.
    await expect(sync(20)).rejects.toThrow();
    expect(tries()).toBe(1);
    // The step's own retry, half a minute later, fails too but counts nothing more.
    await expect(sync(50)).rejects.toThrow();
    expect(tries()).toBe(2);
    expect((await cursorOf()).attachments?.failures).toMatchObject({ [broken]: { n: 1 } });
    // Meanwhile a bill is entered: the next sync reads it first, then fails on the file again.
    clock.now = later(60);
    qbo.put("Bill", {
      Id: "148",
      SyncToken: "0",
      TxnDate: "2026-11-05",
      VendorRef: { value: "56", name: "Northwest Plywood Supply" },
      Line: [
        {
          Id: "1",
          Amount: 12,
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: { AccountRef: { value: "80" } },
        },
      ],
      TotalAmt: 12,
    });
    clock.now = NOW;
    await expect(sync(20 * 60)).rejects.toThrow();
    const bill148 = await H.t.db
      .select()
      .from(transaction)
      .where(and(eq(transaction.tenantId, H.A.tenantId), eq(transaction.externalId, "Bill:148")));
    expect(bill148).toHaveLength(1);
    expect(tries()).toBe(3);
    // Its third counted failure: the attachment is stored without its file, and the sync goes on.
    const third = await sync(40 * 60);
    expect(third.skipped).toBeUndefined();
    expect(third.skippedFiles).toBe(1);
    expect(tries()).toBe(4);
    const ids = async () =>
      (await docs()).map((d) => (d.meta as { attachableId?: string }).attachableId);
    expect(await ids()).toContain(fine);
    expect(await ids()).not.toContain(broken);
    const [raw] = await H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.connectionId, connectionId), eq(rawRecord.externalId, broken)));
    expect(raw).toBeDefined();
    expect((await cursorOf()).attachments?.skipped).toMatchObject([{ id: broken }]);
    expect((await cursorOf()).attachments?.failures ?? {}).not.toHaveProperty(broken);
    // Not tried again that day.
    await sync(41 * 60);
    expect(tries()).toBe(4);
    // A day later its file is tried again, and now it comes.
    qbo.failFile(broken, 0);
    await sync(41 * 60 + 86_400 + 30);
    expect(tries()).toBe(5);
    expect(await ids()).toContain(broken);
    expect((await cursorOf()).attachments?.skipped ?? []).toEqual([]);
  });
});
