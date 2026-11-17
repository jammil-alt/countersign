// Signing in to QuickBooks again (audit 2.2): the same company keeps the connection, its sync point
// and its records as before; another company is refused, and the connection is left as it was,
// while connected and once disconnected (its records are keyed by QuickBooks' per-company ids).
// The rule for every connector that names one account per connection is checked on its own.

import { createQboConnector, generateEncryptionKey } from "@countersign/connectors";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "@countersign/connectors/testing";
import { connection } from "@countersign/db";
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
const qbo = fakeQbo({ codes: ["code-1", "code-2", "code-3", "code-4"] });

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

  it("refuses another company while connected, and leaves the connection as it was", async () => {
    const before = await row();
    const other = await signIn("code-3", OTHER_REALM);
    expect(other.status, JSON.stringify(other.json)).toBe(409);
    expect(j(other.json).error).toMatchObject({ code: "different_company" });
    expect(await row()).toEqual(before);
  });

  it("refuses another company once disconnected too: its records are keyed by company ids", async () => {
    const off = await H.call(admin("a"), "DELETE", `/api/connections/${connectionId}`);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const before = await row();
    expect(before?.status).toBe("disconnected");
    const other = await signIn("code-4", OTHER_REALM);
    expect(other.status, JSON.stringify(other.json)).toBe(409);
    expect(j(other.json).error).toMatchObject({ code: "different_company" });
    expect(await row()).toEqual(before);
  });
});

describe("a sign-in to another account (every connector)", () => {
  const mail = { manifest: { id: "gmail" } } as Parameters<typeof accountChange>[0];
  const books = { manifest: { id: "qbo" } } as Parameters<typeof accountChange>[0];
  const property = { manifest: { id: "gsc_oauth" }, accountMayChange: true } as Parameters<
    typeof accountChange
  >[0];
  const connected = { status: "connected", externalAccountId: "ana@example.com" } as const;
  const failing = { status: "error", externalAccountId: "ana@example.com" } as const;
  const disconnected = { status: "disconnected", externalAccountId: "ana@example.com" } as const;

  it("keeps the same account, a first sign-in and an account the connection never named", () => {
    expect(accountChange(mail, connected, "Ana@Example.com")).toBe("same");
    expect(accountChange(mail, undefined, "bo@example.com")).toBe("same");
    expect(accountChange(mail, { ...connected, externalAccountId: null }, "bo@example.com")).toBe(
      "same",
    );
    expect(accountChange(mail, connected, null)).toBe("same");
  });

  it("refuses another account while the connection holds the first one's sign-in", () => {
    expect(accountChange(mail, connected, "bo@example.com")).toBe("refuse_connected");
    expect(accountChange(mail, failing, "bo@example.com")).toBe("refuse_connected");
  });

  it("starts afresh on a disconnected connection, except QuickBooks, which always refuses", () => {
    expect(accountChange(mail, disconnected, "bo@example.com")).toBe("other_account");
    for (const status of ["connected", "disconnected"] as const) {
      expect(accountChange(books, { status, externalAccountId: "1" }, "2")).toBe("refuse_company");
    }
  });

  it("lets a connector whose account id names what it reads change it", () => {
    expect(accountChange(property, connected, "sc-domain:example.com")).toBe("same");
  });
});
