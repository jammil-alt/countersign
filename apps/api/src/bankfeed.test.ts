// v0.12 bankfeed (docs/plan.md §1.52): bank and card feeds through the API against a fake Plaid
// (nothing live). The client admin connects in Plaid Link through the generic sign-in routes (the
// start answers a Link token, the callback takes Link's public token with the signed state); the
// access token goes to the client's vault and into no response, the operator's included. The first
// sync stores what is there and announces nothing; Plaid's signed webhook starts a sync that
// announces new card charges and bank transactions once; a tampered webhook is refused; an item
// error asks the client to reconnect, which uses update mode on the same item; disconnect removes
// the item at Plaid and drops the token.

import {
  BANK_TRANSACTION_CREATED,
  BANKFEED_TRANSACTION_ENTITY,
  CARD_CHARGE_CREATED,
  createBankfeedConnector,
  generateEncryptionKey,
  PLAID_VERIFICATION_HEADER,
} from "@countersign/connectors";
import {
  FAKE_CHECKING,
  FAKE_PLAID,
  fakePlaid,
  fakePlaidTransaction,
} from "@countersign/connectors/testing";
import { connection, event, rawRecord } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { BANKFEED_CRON_MINUTE, bankfeedCron } from "./bankfeed/sync";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const plaid = fakePlaid();

const h = await createApiHarness({
  connectors: () => [createBankfeedConnector({ ...FAKE_PLAID, fetch: plaid.fetch })],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
  },
});
afterAll(() => h?.close());

describe.skipIf(!h)("bank and card feeds through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  /** Every response read, to look for a token in any of them. */
  const seen: string[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    return res;
  };
  let connId = "";
  let itemId = "";
  const publicTokens: string[] = [];

  const row = async () => {
    const [r] = await H.t.db.select().from(connection).where(eq(connection.id, connId));
    if (!r) throw new Error("no connection");
    return r;
  };
  const eventsOf = (type: string) =>
    H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, A()), eq(event.type, type)));
  const cron = (minute = BANKFEED_CRON_MINUTE) =>
    bankfeedCron(
      H.env,
      { db: H.db, instances: H.instances, platform: H.platform },
      new Date(Date.UTC(2026, 10, 6, 15, minute)),
    );
  const webhook = async (tenant: string, body: unknown, tamper = false) => {
    const text = JSON.stringify(body, null, 2);
    const signed = await plaid.signWebhook(text);
    return call(
      null,
      "POST",
      `/api/connections/bankfeed/webhook/${tenant}`,
      tamper ? `${text} ` : text,
      {
        "content-type": "application/json",
        [PLAID_VERIFICATION_HEADER]: signed.jwt,
      },
    );
  };

  async function connect() {
    const start = await call(admin("a"), "POST", "/api/connections/bankfeed/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const { redirectUrl, link } = j(start.json);
    expect(redirectUrl).toBeNull();
    expect(link).toMatchObject({ provider: "plaid", token: expect.any(String) });
    const publicToken = plaid.issuePublicToken();
    publicTokens.push(publicToken);
    const done = await call(admin("a"), "POST", "/api/connections/bankfeed/callback", {
      params: { public_token: publicToken, state: link.state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return { link, publicToken, connection: j(done.json).connection };
  }

  it("is offered and connected by the client admin in Plaid Link", async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "bankfeed"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    // A client user can't connect the business's bank.
    const refused = await call(user("a"), "POST", "/api/connections/bankfeed/authorize");
    expect(refused.status).toBe(403);

    const { link, publicToken, connection: conn } = await connect();
    const body = plaid.linkTokens.get(link.token);
    expect(body).toMatchObject({
      products: ["transactions"],
      webhook: `${ORIGIN}/api/connections/bankfeed/webhook/${A()}`,
      redirect_uri: `${ORIGIN}/connections/bankfeed/callback`,
    });
    expect(JSON.stringify(body)).not.toContain("example.com");
    itemId = plaid.itemOf(publicToken)?.itemId ?? "";
    expect(conn.connection).toMatchObject({ status: "connected", externalAccountId: itemId });
    expect(conn.connection.accountName).toBe("First Platypus Bank");
    connId = conn.connection.id;
    const r = await row();
    expect(r.permissions).toMatchObject({ read: "auto", create: "approval", delete: "off" });
    // The token is in the vault, encrypted: not in the row as text.
    expect(JSON.stringify(r.credentialsEncrypted)).not.toContain(plaid.accessTokens()[0]);
  });

  it("stores the first sync and announces none of it", async () => {
    plaid.add(
      itemId,
      fakePlaidTransaction("old-1", { amount: 55.1 }),
      fakePlaidTransaction("old-2", { amount: -300, account_id: FAKE_CHECKING }),
    );
    expect(await cron(BANKFEED_CRON_MINUTE + 1)).toBeNull();
    expect(await cron()).toEqual({ connections: 1, stored: 2 });
    const stored = await H.t.db
      .select()
      .from(rawRecord)
      .where(
        and(
          eq(rawRecord.connectionId, connId),
          eq(rawRecord.entityType, BANKFEED_TRANSACTION_ENTITY),
        ),
      );
    expect(stored.map((s) => s.externalId).sort()).toEqual(["old-1", "old-2"]);
    expect(j(stored.find((s) => s.externalId === "old-2")?.payload)).toMatchObject({
      amount: { amount: "300.0000", currency: "USD" },
      direction: "in",
    });
    expect(await eventsOf(CARD_CHARGE_CREATED)).toHaveLength(0);
    expect(await eventsOf(BANK_TRANSACTION_CREATED)).toHaveLength(0);
    expect((await row()).syncCursor).toMatchObject({ plaid: true, itemId, announcing: true });
  });

  it("syncs on Plaid's signed webhook and announces each new transaction once", async () => {
    plaid.add(
      itemId,
      fakePlaidTransaction("card-1", { amount: 412.5, pending: true }),
      fakePlaidTransaction("dep-1", { amount: -1250, account_id: FAKE_CHECKING }),
    );
    const res = await webhook(A(), {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: itemId,
      environment: "sandbox",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toEqual({ outcome: "sync" });
    await H.settle();
    const charges = await eventsOf(CARD_CHARGE_CREATED);
    expect(charges.map((e) => j(e.payload).transaction.id)).toEqual(["card-1"]);
    expect(j(charges[0]?.payload)).toMatchObject({
      connectionId: connId,
      transaction: { amount: { amount: "412.5000" }, direction: "out", pending: true },
    });
    const deposits = await eventsOf(BANK_TRANSACTION_CREATED);
    expect(deposits.map((e) => j(e.payload).transaction.direction)).toEqual(["in"]);

    // The pending charge posts under a new id, its amount changes and the old id is removed: new
    // versions are stored, nothing is announced again.
    plaid.remove(itemId, "card-1");
    plaid.add(
      itemId,
      fakePlaidTransaction("card-1p", { amount: 415, pending_transaction_id: "card-1" }),
    );
    plaid.modify(
      itemId,
      fakePlaidTransaction("dep-1", { amount: -1250.25, account_id: FAKE_CHECKING }),
    );
    await cron();
    expect(await eventsOf(CARD_CHARGE_CREATED)).toHaveLength(1);
    expect(await eventsOf(BANK_TRANSACTION_CREATED)).toHaveLength(1);
    const versions = await H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.connectionId, connId), eq(rawRecord.externalId, "dep-1")));
    expect(versions).toHaveLength(2);
    const removed = await H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.connectionId, connId), eq(rawRecord.externalId, "card-1")));
    expect(removed.map((r) => [r.externalVersion === "removed", r.isDeleted]).sort()).toEqual([
      [false, false],
      [true, true],
    ]);
  });

  it("refuses a tampered webhook, and ignores another client's", async () => {
    const body = {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: itemId,
    };
    const tampered = await webhook(A(), body, true);
    expect(tampered.status).toBe(401);
    const unsigned = await call(
      null,
      "POST",
      `/api/connections/bankfeed/webhook/${A()}`,
      JSON.stringify(body),
      { "content-type": "application/json" },
    );
    expect(unsigned.status).toBe(401);
    // The item is A's; B's URL finds nothing in B.
    const other = await webhook(H.B.tenantId, body);
    expect(j(other.json)).toEqual({ outcome: "ignored" });
  });

  it("puts the connection in error when the bank needs the client's sign-in, and reconnects on the same item", async () => {
    plaid.setError(itemId, "ITEM_LOGIN_REQUIRED");
    const res = await webhook(A(), {
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: itemId,
      error: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" },
    });
    expect(j(res.json)).toEqual({ outcome: "attention" });
    await H.settle();
    expect((await row()).status).toBe("error");
    const list = await call(admin("a"), "GET", "/api/connections");
    const mine = j(list.json).connections.find(
      (c: { connector: string }) => c.connector === "bankfeed",
    );
    expect(mine.connection.status).toBe("error");

    const start = await call(admin("a"), "POST", "/api/connections/bankfeed/authorize");
    const { link } = j(start.json);
    expect(plaid.linkTokens.get(link.token)).toMatchObject({
      access_token: plaid.accessTokens()[0],
    });
    expect(plaid.linkTokens.get(link.token)).not.toHaveProperty("products");
    plaid.setError(itemId, null);
    const done = await call(admin("a"), "POST", "/api/connections/bankfeed/callback", {
      params: { public_token: plaid.issuePublicToken(), state: link.state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(j(done.json).connection.connection).toMatchObject({
      status: "connected",
      externalAccountId: itemId,
    });
    expect(plaid.items.size).toBe(1);
  });

  it("never shows the operator (or anyone) a token", async () => {
    for (const path of [`/api/ops/clients/${A()}/connections`, `/api/ops/clients/${A()}`]) {
      const res = await call(OPERATOR, "GET", path);
      expect(res.status, path).toBe(200);
    }
    await call(admin("a"), "GET", "/api/connections");
    const all = seen.join("\n");
    for (const token of [...plaid.accessTokens(), ...publicTokens]) {
      expect(all).not.toContain(token);
    }
    expect(all).not.toContain(FAKE_PLAID.secret);
  });

  it("disconnect removes the item at Plaid and drops the token", async () => {
    const res = await call(admin("a"), "DELETE", `/api/connections/${connId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(plaid.items.get(itemId)?.removed).toBe(true);
    const r = await row();
    expect(r.status).toBe("disconnected");
    expect(r.credentialsEncrypted).toBeNull();
  });
});
