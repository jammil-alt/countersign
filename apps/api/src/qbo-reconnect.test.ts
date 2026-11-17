// Signing in to QuickBooks again (audit 2.2): the same company keeps the connection, its sync point
// and its records as before; before any record is stored the company may change (its sync starts
// over); after, another company is refused and the connection is left as it was, while connected
// and once disconnected (its records are keyed by QuickBooks' per-company ids). The rule for every
// connector that names one account per connection is checked on its own.

import {
  createBankfeedConnector,
  createLinkedInConnector,
  createQboConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { connection, rawRecord, withTenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { accountChange } from "./routes/connections";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://staging.mezonas.test";
/** A second company the same Intuit user can pick. */
const OTHER_REALM = "4620816365171234567";
const qbo = fakeQbo({ codes: ["code-1", "code-2", "code-3", "code-4", "code-5"] });

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
    const r = await row();
    await H.settle();
    expect(r).toMatchObject({ status: "connected", externalAccountId: OTHER_REALM });
    // Its sync starts over for the new company.
    expect(r?.syncCursor).not.toHaveProperty("phase");
    expect(r?.syncCursor).toMatchObject({ running: { instanceId: "qbo-x" } });
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
    const other = await signIn("code-4", FAKE_QBO_REALM);
    expect(other.status, JSON.stringify(other.json)).toBe(409);
    expect(j(other.json).error).toMatchObject({ code: "different_company" });
    expect(await row()).toEqual(before);
  });

  it("refuses another company once disconnected too: its records are keyed by company ids", async () => {
    const off = await H.call(admin("a"), "DELETE", `/api/connections/${connectionId}`);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const before = await row();
    expect(before?.status).toBe("disconnected");
    const other = await signIn("code-5", FAKE_QBO_REALM);
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
    const pages = createLinkedInConnector({});
    expect(accountChange(pages, connected, as("urn:li:organization:2"))).toBe("same");
  });
});
