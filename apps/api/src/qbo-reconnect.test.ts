// Signing in to QuickBooks again (audit 2.2): the same company keeps the connection, its sync point
// and its records as before; before any record is stored the company may change (its sync starts
// over); after, another company is refused and the connection is left as it was, while connected
// and once disconnected (its records are keyed by QuickBooks' per-company ids). The rule for every
// connector that names one account per connection is checked on its own.

import {
  ContentStore,
  createBankfeedConnector,
  createLinkedInConnector,
  createQboConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { connection, externalAction, rawRecord, vendor, withTenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { storeQboPage } from "./qbo/store";
import { accountChange } from "./routes/connections";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://staging.mezonas.test";
/** A second company the same Intuit user can pick. */
const OTHER_REALM = "4620816365171234567";
const qbo = fakeQbo({ codes: Array.from({ length: 8 }, (_, i) => `code-${i + 1}`) });

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      // The fake serves one company; the other one answers as it does.
      fetch: (url, init) => qbo.fetch(url.replaceAll(OTHER_REALM, FAKE_QBO_REALM), init),
      sleep: async () => {},
    }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
  },
  qboSync: new MemoryQboSyncInstances(),
  appDbMax: 1,
});
afterAll(() => h?.close());

describe.skipIf(!h)("signing in to QuickBooks again", () => {
  const H = h as ApiHarness;
  let connectionId = "";

  async function signIn(code: string, realmId: string) {
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    return H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code, state, realmId },
    });
  }

  const row = async () => {
    const [r] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    return r;
  };

  beforeAll(async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const first = await signIn("code-1", FAKE_QBO_REALM);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    connectionId = j(first.json).connection.connection.id;
    await H.settle();
  });

  it("keeps the connection and its sync point when the same company signs in again", async () => {
    const cursor = { v: 1, phase: "cdc", changedSince: "2026-11-01T00:00:00.000Z" };
    await H.t.db
      .update(connection)
      .set({ syncCursor: cursor })
      .where(eq(connection.id, connectionId));
    const again = await signIn("code-2", FAKE_QBO_REALM);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(j(again.json).connection.connection.id).toBe(connectionId);
    await H.settle();
    expect(await row()).toMatchObject({
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      syncCursor: cursor,
    });
  });

  it("changes the company while the connection has stored no QuickBooks records", async () => {
    // A sync is running (its claim stays); nothing stored yet: the wrong company was picked.
    await H.t.db
      .update(connection)
      .set({
        syncCursor: {
          v: 1,
          phase: "initial",
          entity: "Vendor",
          start: 1,
          sinceDate: "2026-08-07",
          changedSince: "2026-11-05T17:59:00.000Z",
          running: { instanceId: "qbo-x", reason: "connected", at: "2026-11-05T18:00:00.000Z" },
        },
      })
      .where(eq(connection.id, connectionId));
    const other = await signIn("code-3", OTHER_REALM);
    expect(other.status, JSON.stringify(other.json)).toBe(200);
    // Read once the sign-in's background work is done: before that, whether the sync it starts
    // has taken over the old claim yet depends on timing.
    await H.settle();
    const r = await row();
    expect(r).toMatchObject({ status: "connected", externalAccountId: OTHER_REALM });
    // Its sync starts over for the new company, and that sync holds the claim now (the old one
    // was stale).
    expect(r?.syncCursor).not.toHaveProperty("phase");
    const running = (r?.syncCursor as { running?: { instanceId?: string } } | null)?.running;
    expect(running?.instanceId).toMatch(/^qbo-/);
    expect(running?.instanceId).not.toBe("qbo-x");
  });

  it("drops a page read from the first company before the switch", async () => {
    const before = await row();
    const out = await withTenant(H.db, H.A.tenantId, (tx) =>
      storeQboPage(tx, new ContentStore(H.objects), {
        tenantId: H.A.tenantId,
        connectionId,
        records: [
          {
            entityType: "Vendor",
            externalId: "56",
            externalVersion: "0",
            payload: { Id: "56", SyncToken: "0", DisplayName: "Northwest Plywood Supply" },
          },
        ],
        files: new Map(),
        cursor: { v: 1, phase: "cdc", changedSince: "2026-11-05T17:59:00.000Z" },
        initial: true,
        now: new Date(),
        // The step began on the first company.
        externalAccountId: FAKE_QBO_REALM,
      }),
    );
    expect(out).toMatchObject({ dropped: true, stored: 0 });
    expect(
      await H.t.db.select().from(rawRecord).where(eq(rawRecord.connectionId, connectionId)),
    ).toEqual([]);
    expect(await row()).toEqual(before);
  });

  it("refuses to change the company while a sync of it is running", async () => {
    const running = { instanceId: "qbo-y", reason: "cron", at: new Date().toISOString() };
    await H.t.db
      .update(connection)
      .set({ syncCursor: { running } })
      .where(eq(connection.id, connectionId));
    const other = await signIn("code-4", FAKE_QBO_REALM);
    expect(other.status, JSON.stringify(other.json)).toBe(409);
    expect(j(other.json).error).toMatchObject({ code: "sync_running" });
    expect((await row())?.externalAccountId).toBe(OTHER_REALM);
    await H.t.db
      .update(connection)
      .set({ syncCursor: null })
      .where(eq(connection.id, connectionId));
  });

  it("refuses another company once a vendor or a write holds QuickBooks ids", async () => {
    // A vendor the purchasing agent made in QuickBooks names its id.
    const [v] = await withTenant(H.db, H.A.tenantId, (tx) =>
      tx
        .insert(vendor)
        .values({
          tenantId: H.A.tenantId,
          name: "Cascade Hardwoods",
          normalizedName: "cascade hardwoods",
          externalRefs: { qbo: "57" },
        })
        .returning({ id: vendor.id }),
    );
    const byVendor = await signIn("code-5", FAKE_QBO_REALM);
    expect(byVendor.status, JSON.stringify(byVendor.json)).toBe(409);
    expect(j(byVendor.json).error).toMatchObject({ code: "different_company" });
    await withTenant(H.db, H.A.tenantId, (tx) =>
      tx
        .update(vendor)
        .set({ externalRefs: {} })
        .where(eq(vendor.id, v?.id ?? "")),
    );
    // A write made in the company through this connection.
    await withTenant(H.db, H.A.tenantId, (tx) =>
      tx.insert(externalAction).values({
        tenantId: H.A.tenantId,
        connectionId,
        tool: "qbo.vendor.create",
        idempotencyKey: "reconnect-test",
      }),
    );
    const byWrite = await signIn("code-6", FAKE_QBO_REALM);
    expect(byWrite.status, JSON.stringify(byWrite.json)).toBe(409);
    expect(j(byWrite.json).error).toMatchObject({ code: "different_company" });
    expect((await row())?.externalAccountId).toBe(OTHER_REALM);
  });

  it("refuses another company once records are stored, and leaves the connection as it was", async () => {
    await withTenant(H.db, H.A.tenantId, (tx) =>
      tx.insert(rawRecord).values({
        tenantId: H.A.tenantId,
        connectionId,
        connector: "qbo",
        entityType: "Vendor",
        externalId: "56",
        externalVersion: "0",
        payload: { Id: "56", SyncToken: "0" },
      }),
    );
    const before = await row();
    const other = await signIn("code-7", FAKE_QBO_REALM);
    expect(other.status, JSON.stringify(other.json)).toBe(409);
    expect(j(other.json).error).toMatchObject({ code: "different_company" });
    expect(await row()).toEqual(before);
  });

  it("refuses another company once disconnected too: its records are keyed by company ids", async () => {
    const off = await H.call(admin("a"), "DELETE", `/api/connections/${connectionId}`);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const before = await row();
    expect(before?.status).toBe("disconnected");
    const other = await signIn("code-8", FAKE_QBO_REALM);
    expect(other.status, JSON.stringify(other.json)).toBe(409);
    expect(j(other.json).error).toMatchObject({ code: "different_company" });
    expect(await row()).toEqual(before);
  });
});

describe("a sign-in to another account (every connector)", () => {
  type Who = Parameters<typeof accountChange>[0];
  const mail = { manifest: { id: "gmail" } } as Who;
  const books = { manifest: { id: "qbo" } } as Who;
  const property = { manifest: { id: "gsc_oauth" }, accountMayChange: true } as Who;
  const as = (externalAccountId: string | null, accountIds?: string[]) => ({
    externalAccountId,
    config: accountIds ? { accountIds } : {},
  });
  const connected = { status: "connected" as const, ...as("ana@example.com") };
  const failing = { status: "error" as const, ...as("ana@example.com") };
  const disconnected = { status: "disconnected" as const, ...as("ana@example.com") };

  it("keeps the same account, a first sign-in and an account the connection never named", () => {
    expect(accountChange(mail, connected, as("Ana@Example.com"))).toBe("same");
    expect(accountChange(mail, undefined, as("bo@example.com"))).toBe("same");
    expect(
      accountChange(mail, { ...connected, externalAccountId: null }, as("bo@example.com")),
    ).toBe("same");
    expect(accountChange(mail, connected, as(null))).toBe("same");
  });

  it("refuses another account while the connection holds the first one's sign-in", () => {
    expect(accountChange(mail, connected, as("bo@example.com"))).toBe("refuse_connected");
    expect(accountChange(mail, failing, as("bo@example.com"))).toBe("refuse_connected");
  });

  it("starts afresh on a disconnected connection; QuickBooks only before it stored records", () => {
    expect(accountChange(mail, disconnected, as("bo@example.com"))).toBe("other_account");
    for (const status of ["connected", "disconnected"] as const) {
      const row = { status, ...as("1") };
      expect(accountChange(books, row, as("2"))).toBe("refuse_company");
      expect(accountChange(books, row, as("2"), false)).toBe("other_account");
      expect(accountChange(books, row, as("1"))).toBe("same");
    }
  });

  it("matches an account by any of its stable ids, stored before or not", () => {
    // A Microsoft account renamed: its object id stays.
    const renamed = { status: "connected" as const, ...as("pat@shop.example", ["ms:t1:o1"]) };
    expect(accountChange(mail, renamed, as("pat.lee@shop.example", ["ms:t1:o1"]))).toBe("same");
    expect(accountChange(mail, renamed, as("kim@shop.example", ["ms:t1:o2"]))).toBe(
      "refuse_connected",
    );
    // A connection stored before the ids were kept: its account id still matches.
    expect(accountChange(mail, connected, as("ana@example.com", ["ms:t1:o1"]))).toBe("same");
    // Zoho: the user's organizations, in another order, the stored first among them.
    const zoho = { status: "connected" as const, ...as("700") };
    expect(accountChange(mail, zoho, as("800", ["700", "800"]))).toBe("same");
    expect(accountChange(mail, zoho, as("900", ["900"]))).toBe("refuse_connected");
  });

  it("lets a connector whose account id names what it reads change it", () => {
    expect(accountChange(property, connected, as("sc-domain:example.com"))).toBe("same");
    const bank = createBankfeedConnector();
    expect(accountChange(bank, connected, as("item-2"))).toBe("same");
  });

  it("matches LinkedIn on any page the person runs, and refuses a wholly different set", () => {
    const pages = createLinkedInConnector({});
    const mine = {
      status: "connected" as const,
      ...as("urn:li:organization:1", ["urn:li:organization:1", "urn:li:organization:2"]),
    };
    const reordered = as("urn:li:organization:2", [
      "urn:li:organization:2",
      "urn:li:organization:3",
    ]);
    expect(accountChange(pages, mine, reordered)).toBe("same");
    expect(accountChange(pages, mine, as("urn:li:organization:9", ["urn:li:organization:9"]))).toBe(
      "refuse_connected",
    );
  });
});
