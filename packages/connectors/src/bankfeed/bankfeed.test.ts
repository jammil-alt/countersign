// The bankfeed connector against a fake Plaid (docs/plan.md §1.52): Link tokens ask for
// `transactions` only, with an opaque user id, the webhook and the redirect URI; reconnecting uses
// update mode on the same item; the public token is exchanged and the access token kept only in
// the client's encrypted credentials; an item with a money-moving product is removed and refused;
// sync pages with Plaid's cursor (restarting after a mid-pagination change) and maps added,
// modified and removed; amounts are decimals with a direction; Plaid's webhook JWT is checked
// (valid, tampered body, stale iat, unknown key, other algorithms); an item that needs the
// client's sign-in asks for a reconnect; disconnect removes the item; there are no write tools.
import { DEFAULT_PERMISSIONS, decideToolCall } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionContext, ConnectionRef } from "../connector";
import { CredentialCipher, generateEncryptionKey, memoryTenantKeys } from "../credentials";
import { memoryCredentials } from "../credentials-accessor";
import { runReadTool, ToolCallError } from "../invoke";
import { noopLogger } from "../logger";
import { beginLinkAuthorization, completeAuthorization } from "../oauth/flow";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { connectionDefaults } from "../permissions";
import { toBase64Url, utf8 } from "../runtime";
import {
  FAKE_CARD,
  FAKE_CHECKING,
  FAKE_INSTITUTION,
  FAKE_PLAID,
  fakePlaid,
  fakePlaidTransaction,
} from "./fake";
import {
  BANK_TRANSACTION_CREATED,
  BANKFEED_TOOLS,
  type BankfeedSyncResult,
  bankfeedEventFor,
  bankfeedVersion,
  CARD_CHARGE_CREATED,
  createBankfeedConnector,
  isBankfeedConnector,
  mapPlaidTransaction,
  PLAID_HOSTS,
  PLAID_PRODUCTS,
  PLAID_VERIFICATION_HEADER,
  PlaidKeyCache,
  plaidClientUserId,
  plaidEnvironment,
  plaidWebhookAction,
  verifyPlaidWebhook,
} from "./index";

const TENANT = "0192f7a0-0000-7000-8000-0000000000aa";
const REDIRECT = "https://staging.mezonas.com/connections/bankfeed/callback";
const WEBHOOK = `https://staging.mezonas.com/api/connections/bankfeed/webhook/${TENANT}`;
const NOW = new Date("2026-11-06T15:00:00.000Z");

function setup(plaid = fakePlaid()) {
  const connector = createBankfeedConnector({ ...FAKE_PLAID, fetch: plaid.fetch, now: () => NOW });
  return { plaid, connector };
}

function ctxFor(
  credentials: ReturnType<typeof memoryCredentials>,
  over: Partial<ConnectionRef> = {},
): ConnectionContext {
  return {
    tenantId: TENANT,
    connection: {
      id: "0192f7a0-0000-7000-8000-000000000003",
      tenantId: TENANT,
      connector: "bankfeed",
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: {},
      ...over,
    },
    credentials,
    logger: noopLogger,
    now: () => NOW,
  };
}

async function connected(plaid = fakePlaid()) {
  const { connector } = setup(plaid);
  const publicToken = plaid.issuePublicToken();
  const grant = await connector.handleCallback?.(
    { public_token: publicToken, state: "s" },
    { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  const item = plaid.itemOf(publicToken);
  if (!item) throw new Error("no item");
  const credentials = memoryCredentials(grant.credentials);
  return { plaid, connector, grant, item, credentials, ctx: ctxFor(credentials) };
}

async function sync(
  connector: ReturnType<typeof createBankfeedConnector>,
  ctx: ConnectionContext,
  cursor: string | null,
  opts?: { count?: number; maxPages?: number },
): Promise<BankfeedSyncResult> {
  const r = await connector.transactionsSync(ctx, cursor, opts);
  if ("skipped" in r) throw new Error("skipped");
  return r;
}

describe("bankfeed: the manifest", () => {
  it("is read only: two read tools, no writes, approval stays the default", () => {
    const { connector } = setup();
    const m = connector.manifest;
    expect(m.id).toBe("bankfeed");
    expect(m.auth).toBe("oauth2");
    expect(m.tools.map((t) => [t.id, t.sideEffect, t.verb, t.entity])).toEqual([
      [BANKFEED_TOOLS.transactions, "none", "read", "transaction"],
      [BANKFEED_TOOLS.accounts, "none", "read", "account"],
    ]);
    expect(m.tools.some((t) => t.sideEffect !== "none")).toBe(false);
    expect(m.permissionEntities?.map((e) => [e.id, e.verbs])).toEqual([
      ["transaction", ["read"]],
      ["account", ["read"]],
    ]);
    // Nothing loosens the platform's defaults: writes would wait for approval, delete is off.
    expect(m.defaultPermissions).toBeUndefined();
    const matrix = connectionDefaults(m);
    expect(matrix).toMatchObject({ read: "auto", create: "approval", delete: "off" });
    expect(
      decideToolCall({ sideEffect: "external", verb: "create", matrix, agentMode: "act" }),
    ).toBe("approval");
    expect(m.events?.map((e) => e.type)).toEqual([CARD_CHARGE_CREATED, BANK_TRANSACTION_CREATED]);
    expect(m.sharedNamespaces).toEqual(["card", "bank"]);
    expect(PLAID_PRODUCTS).toEqual(["transactions"]);
    expect(isBankfeedConnector(connector)).toBe(true);
  });

  it("signs in only when the client id and secret are set; reads PLAID_ENV leniently", () => {
    expect(createBankfeedConnector({}).isConfigured?.()).toBe(false);
    expect(createBankfeedConnector({ clientId: "x" }).isConfigured?.()).toBe(false);
    expect(setup().connector.isConfigured?.()).toBe(true);
    expect(plaidEnvironment(undefined)).toBe("sandbox");
    expect(plaidEnvironment(" Production ")).toBe("production");
    expect(plaidEnvironment("development")).toBe("sandbox");
  });
});

describe("bankfeed: connecting with Plaid Link", () => {
  it("makes a Link token for transactions only, with an opaque user, the webhook and the redirect", async () => {
    const { plaid, connector } = setup();
    const { link, state } = await beginLinkAuthorization({
      connector,
      tenantId: TENANT,
      userId: "u1",
      redirectUri: REDIRECT,
      webhookUrl: WEBHOOK,
      language: "es",
      stateSecret: "state-secret-".repeat(4),
    });
    expect(link).toMatchObject({
      provider: "plaid",
      token: expect.stringMatching(/^link-sandbox-/),
    });
    expect(state.length).toBeGreaterThan(20);
    const body = plaid.linkTokens.get(link.token);
    expect(body).toMatchObject({
      client_name: "Mezonas",
      products: ["transactions"],
      country_codes: ["US"],
      language: "es",
      webhook: WEBHOOK,
      redirect_uri: REDIRECT,
      transactions: { days_requested: 90 },
    });
    const userId = (body?.user as { client_user_id: string } | undefined)?.client_user_id;
    expect(userId).toBe(await plaidClientUserId(TENANT));
    expect(userId).not.toContain(TENANT);
    expect(userId).not.toContain("@");
    // The client id and secret go in Plaid's headers, never in a body.
    const req = plaid.requests.at(-1);
    expect(req?.headers["plaid-client-id"]).toBe(FAKE_PLAID.clientId);
    expect(JSON.stringify(req?.body)).not.toContain(FAKE_PLAID.secret);
    expect(body).not.toHaveProperty("access_token");
  });

  it("reaches only the environment's host", async () => {
    const prod = fakePlaid("production");
    const connector = createBankfeedConnector({
      ...FAKE_PLAID,
      environment: "production",
      fetch: prod.fetch,
    });
    await connector.beginLink?.({
      tenantId: TENANT,
      userId: "u1",
      redirectUri: REDIRECT,
      webhookUrl: WEBHOOK,
    });
    expect(prod.linkTokens.size).toBe(1);
    expect(PLAID_HOSTS.production).toBe("https://production.plaid.com");
  });

  it("exchanges the public token; the access token is only in the encrypted credentials", async () => {
    const plaid = fakePlaid();
    const { connector } = setup(plaid);
    const secret = "state-secret-".repeat(4);
    const { state } = await beginLinkAuthorization({
      connector,
      tenantId: TENANT,
      userId: "u1",
      redirectUri: REDIRECT,
      webhookUrl: WEBHOOK,
      stateSecret: secret,
    });
    const publicToken = plaid.issuePublicToken();
    const keys = memoryTenantKeys();
    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      keys,
    );
    const done = await completeAuthorization({
      connector,
      params: { public_token: publicToken, state },
      session: { tenantId: TENANT, userId: "u1" },
      connectionId: "0192f7a0-0000-7000-8000-000000000003",
      redirectUri: REDIRECT,
      stateSecret: secret,
      cipher,
    });
    const item = plaid.itemOf(publicToken);
    expect(done.grant.externalAccountId).toBe(item?.itemId);
    expect(done.grant.config).toMatchObject({
      accountName: FAKE_INSTITUTION.name,
      institutionId: FAKE_INSTITUTION.id,
      accounts: [
        { id: FAKE_CHECKING, name: "Business Checking", mask: "0000", type: "depository" },
        { id: FAKE_CARD, name: "Business Card", mask: "3333", type: "credit" },
      ],
    });
    // The grant's visible parts and the envelope hold no token.
    const visible = JSON.stringify(done.grant) + JSON.stringify(done.credentials);
    expect(visible).not.toContain(item?.accessToken);
    expect(visible).not.toContain(publicToken);
    const opened = await cipher.decrypt(done.credentials, {
      tenantId: TENANT,
      connectionId: "0192f7a0-0000-7000-8000-000000000003",
    });
    expect(opened).toEqual({ accessToken: item?.accessToken, itemId: item?.itemId });
  });

  it("refuses a callback with no public token", async () => {
    const { connector } = setup();
    await expect(
      connector.handleCallback?.(
        { state: "s" },
        { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
      ),
    ).rejects.toThrow("no public token");
  });

  it("removes and refuses an item that carries a money-moving product", async () => {
    const plaid = fakePlaid();
    const { connector } = setup(plaid);
    const publicToken = plaid.issuePublicToken({ products: ["transactions", "auth"] });
    await expect(
      connector.handleCallback?.(
        { public_token: publicToken },
        { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
      ),
    ).rejects.toBeInstanceOf(SignInRefusedError);
    expect(plaid.itemOf(publicToken)?.removed).toBe(true);
  });

  it("reconnects in update mode on the same item, keeping its token", async () => {
    const { plaid, connector, item, credentials, ctx } = await connected();
    plaid.setError(item.itemId, "ITEM_LOGIN_REQUIRED");
    const link = await connector.beginLink?.({
      tenantId: TENANT,
      userId: "u1",
      redirectUri: REDIRECT,
      webhookUrl: WEBHOOK,
      reconnect: ctx,
    });
    const body = plaid.linkTokens.get(link?.token ?? "");
    expect(body).toMatchObject({ access_token: item.accessToken });
    expect(body).not.toHaveProperty("products");
    // The client signs in again in Link; the item works again.
    plaid.setError(item.itemId, null);
    const grant = await connector.handleCallback?.(
      { public_token: plaid.issuePublicToken() },
      { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT, existing: ctx },
    );
    expect(grant?.externalAccountId).toBe(item.itemId);
    expect(grant?.credentials).toEqual(credentials.current());
    expect(plaid.items.size).toBe(1);
  });

  it("starts a new item when the old one is gone at Plaid", async () => {
    const { plaid, connector, item, ctx } = await connected();
    item.removed = true;
    const link = await connector.beginLink?.({
      tenantId: TENANT,
      userId: "u1",
      redirectUri: REDIRECT,
      webhookUrl: WEBHOOK,
      reconnect: ctx,
    });
    expect(plaid.linkTokens.get(link?.token ?? "")).toMatchObject({ products: ["transactions"] });
    const grant = await connector.handleCallback?.(
      { public_token: plaid.issuePublicToken() },
      { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT, existing: ctx },
    );
    expect(grant?.externalAccountId).not.toBe(item.itemId);
  });

  it("disconnect removes the item at Plaid", async () => {
    const { plaid, connector, item, ctx } = await connected();
    await connector.revoke?.(ctx);
    expect(plaid.items.get(item.itemId)?.removed).toBe(true);
    expect(plaid.requests.at(-1)?.path).toBe("/item/remove");
  });
});

describe("bankfeed: transactions", () => {
  it("maps Plaid's sign to a positive decimal amount and a direction", () => {
    const accounts = new Map([
      [FAKE_CARD, { account_id: FAKE_CARD, type: "credit", name: "Card" } as never],
      [FAKE_CHECKING, { account_id: FAKE_CHECKING, type: "depository" } as never],
    ]);
    const charge = mapPlaidTransaction(fakePlaidTransaction("t1", { amount: 0.1 + 0.2 }), accounts);
    // 0.30000000000000004 as text, rounded to numeric(14,4): never float arithmetic on money.
    expect(charge.amount).toEqual({ amount: "0.3000", currency: "USD" });
    expect(charge.direction).toBe("out");
    expect(bankfeedEventFor(charge)).toBe(CARD_CHARGE_CREATED);
    const refund = mapPlaidTransaction(
      fakePlaidTransaction("t2", { amount: -1250.5, account_id: FAKE_CHECKING }),
      accounts,
    );
    expect(refund.amount.amount).toBe("1250.5000");
    expect(refund.direction).toBe("in");
    expect(bankfeedEventFor(refund)).toBe(BANK_TRANSACTION_CREATED);
    const loan = mapPlaidTransaction(
      fakePlaidTransaction("t3", { account_id: "unknown-account" }),
      accounts,
    );
    expect(loan.account.type).toBeNull();
    expect(bankfeedEventFor(loan)).toBeNull();
    const crypto = mapPlaidTransaction(
      fakePlaidTransaction("t4", { iso_currency_code: null, unofficial_currency_code: "doge" }),
      accounts,
    );
    expect(crypto.amount.currency).toBe("XXX");
  });

  it("pages with the cursor and reads added, modified and removed", async () => {
    const { plaid, connector, item, ctx } = await connected();
    plaid.add(
      item.itemId,
      fakePlaidTransaction("t1", { amount: 412.5 }),
      fakePlaidTransaction("t2", { amount: -20, account_id: FAKE_CHECKING }),
      fakePlaidTransaction("t3", { pending: true }),
    );
    const first = await sync(connector, ctx, null, { count: 2 });
    expect(first.added.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(first.more).toBe(false);
    expect(first.updateStatus).toBe("HISTORICAL_UPDATE_COMPLETE");
    const syncCalls = plaid.requests.filter((r) => r.path === "/transactions/sync");
    expect(syncCalls.map((r) => r.body.cursor ?? null)).toEqual([null, `cur:${item.itemId}:2`]);
    expect(first.nextCursor).toBe(`cur:${item.itemId}:3`);

    plaid.modify(item.itemId, fakePlaidTransaction("t1", { amount: 415 }));
    plaid.remove(item.itemId, "t3");
    plaid.add(item.itemId, fakePlaidTransaction("t4", { pending_transaction_id: "t3" }));
    const second = await sync(connector, ctx, first.nextCursor);
    expect(second.modified.map((t) => [t.id, t.amount.amount])).toEqual([["t1", "415.0000"]]);
    expect(second.removed).toEqual([{ id: "t3", accountId: FAKE_CARD }]);
    expect(second.added.map((t) => [t.id, t.pendingTransactionId])).toEqual([["t4", "t3"]]);
    // A version per content: the change is a new version, the same content the same one.
    const [v1, v2] = await Promise.all([
      bankfeedVersion(first.added[0] as never),
      bankfeedVersion(second.modified[0] as never),
    ]);
    expect(v1).not.toBe(v2);
    expect(await bankfeedVersion(first.added[0] as never)).toBe(v1);
  });

  it("stops after maxPages and says there is more", async () => {
    const { plaid, connector, item, ctx } = await connected();
    plaid.add(item.itemId, ...["a", "b", "c", "d", "e"].map((id) => fakePlaidTransaction(id)));
    const r = await sync(connector, ctx, null, { count: 2, maxPages: 2 });
    expect(r.added).toHaveLength(4);
    expect(r.more).toBe(true);
    const rest = await sync(connector, ctx, r.nextCursor, { count: 2 });
    expect(rest.added.map((t) => t.id)).toEqual(["e"]);
  });

  it("restarts the pass from its cursor when Plaid's data changes mid-pagination", async () => {
    const { plaid, connector, item, ctx } = await connected();
    plaid.add(item.itemId, ...["a", "b", "c"].map((id) => fakePlaidTransaction(id)));
    plaid.mutateDuringNextPage();
    const r = await sync(connector, ctx, null, { count: 2 });
    expect(r.added.map((t) => t.id)).toEqual(["a", "b", "c"]);
    const cursors = plaid.requests
      .filter((q) => q.path === "/transactions/sync")
      .map((q) => q.body.cursor ?? null);
    expect(cursors).toEqual([null, `cur:${item.itemId}:2`, null, `cur:${item.itemId}:2`]);
  });

  it("keeps no cursor while Plaid's first pull isn't ready", async () => {
    const { connector, item, ctx } = await connected();
    item.updateStatus = "NOT_READY";
    const r = await sync(connector, ctx, null);
    expect(r).toMatchObject({ added: [], nextCursor: null, updateStatus: "NOT_READY" });
  });

  it("asks for a reconnect when the item needs the client's sign-in", async () => {
    const { plaid, connector, item, ctx } = await connected();
    plaid.setError(item.itemId, "ITEM_LOGIN_REQUIRED");
    await expect(connector.transactionsSync(ctx, null)).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
    await expect(
      runReadTool(connector, BANKFEED_TOOLS.transactions, {}, ctx),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    // The error names Plaid's code, never the token.
    const error = await connector.transactionsSync(ctx, null).catch((e: Error) => e);
    expect(String(error)).toContain("ITEM_LOGIN_REQUIRED");
    expect(String(error)).not.toContain(item.accessToken);
  });

  it("reads nothing when the client turned transactions off", async () => {
    const { plaid, connector, item, credentials } = await connected();
    plaid.add(item.itemId, fakePlaidTransaction("t1"));
    const off = ctxFor(credentials, {
      permissions: { ...DEFAULT_PERMISSIONS, entities: { transaction: { read: "off" } } },
    });
    expect(await connector.transactionsSync(off, null)).toEqual({ skipped: "permission_off" });
    await expect(
      runReadTool(connector, BANKFEED_TOOLS.transactions, {}, off),
    ).rejects.toBeInstanceOf(ToolCallError);
    expect(plaid.requests.some((r) => r.path === "/transactions/sync")).toBe(false);
  });

  it("finds transactions and accounts through the read tools", async () => {
    const { plaid, connector, item, ctx } = await connected();
    plaid.add(
      item.itemId,
      fakePlaidTransaction("t1", { date: "2026-11-01", amount: 99.99 }),
      fakePlaidTransaction("t2", { date: "2026-11-05", account_id: FAKE_CHECKING, amount: -5 }),
      fakePlaidTransaction("old", { date: "2026-08-01" }),
    );
    const page = (await runReadTool(connector, BANKFEED_TOOLS.transactions, { pageSize: 1 }, ctx))
      .output as { transactions: { id: string }[]; total: number; nextOffset: number | null };
    expect(page.transactions.map((t) => t.id)).toEqual(["t2"]);
    expect(page.total).toBe(2);
    expect(page.nextOffset).toBe(1);
    const get = plaid.requests.at(-1);
    expect(get?.body).toMatchObject({ start_date: "2026-10-07", end_date: "2026-11-06" });
    const card = (
      await runReadTool(connector, BANKFEED_TOOLS.transactions, { accountId: FAKE_CARD }, ctx)
    ).output as { transactions: { id: string; amount: { amount: string } }[] };
    expect(card.transactions.map((t) => [t.id, t.amount.amount])).toEqual([["t1", "99.9900"]]);
    const accounts = (await runReadTool(connector, BANKFEED_TOOLS.accounts, {}, ctx)).output as {
      accounts: { id: string; balances: { current: string | null; limit: string | null } }[];
    };
    expect(accounts.accounts.map((a) => [a.id, a.balances.current, a.balances.limit])).toEqual([
      [FAKE_CHECKING, "10310.5500", null],
      [FAKE_CARD, "412.5000", "5000.0000"],
    ]);
    await expect(
      runReadTool(connector, BANKFEED_TOOLS.transactions, { accountId: "../x" }, ctx),
    ).rejects.toBeInstanceOf(ToolCallError);
  });
});

describe("bankfeed: Plaid's webhook", () => {
  const BODY = JSON.stringify(
    {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-000001",
      initial_update_complete: true,
      historical_update_complete: true,
      environment: "sandbox",
    },
    null,
    2,
  );
  const nowS = Math.floor(NOW.getTime() / 1000);

  async function check(plaid: ReturnType<typeof fakePlaid>, jwt: string, body: Uint8Array) {
    const { connector } = setup(plaid);
    return connector.verifyWebhook?.({ [PLAID_VERIFICATION_HEADER]: jwt }, body);
  }

  it("accepts a webhook Plaid signed, and caches the key", async () => {
    const plaid = fakePlaid();
    const { connector } = setup(plaid);
    const signed = await plaid.signWebhook(BODY, { iat: nowS - 10 });
    expect(
      await connector.verifyWebhook?.({ [PLAID_VERIFICATION_HEADER]: signed.jwt }, signed.body),
    ).toBe(true);
    const again = await plaid.signWebhook(BODY, { iat: nowS - 5 });
    expect(
      await connector.verifyWebhook?.({ [PLAID_VERIFICATION_HEADER]: again.jwt }, again.body),
    ).toBe(true);
    expect(plaid.keyLookups()).toBe(1);
  });

  it("refuses a tampered body", async () => {
    const plaid = fakePlaid();
    const signed = await plaid.signWebhook(BODY, { iat: nowS });
    const tampered = utf8(BODY.replace("item-000001", "item-000002"));
    expect(await check(plaid, signed.jwt, tampered)).toBe(false);
    // Whitespace counts: the hash is over the bytes as sent.
    expect(await check(plaid, signed.jwt, utf8(JSON.stringify(JSON.parse(BODY))))).toBe(false);
  });

  it("refuses a stale or future iat, before asking Plaid for a key", async () => {
    const plaid = fakePlaid();
    const stale = await plaid.signWebhook(BODY, { iat: nowS - 301 });
    expect(await check(plaid, stale.jwt, stale.body)).toBe(false);
    const future = await plaid.signWebhook(BODY, { iat: nowS + 301 });
    expect(await check(plaid, future.jwt, future.body)).toBe(false);
    expect(plaid.keyLookups()).toBe(0);
  });

  it("refuses an unknown key, asking Plaid once", async () => {
    const plaid = fakePlaid();
    const { connector } = setup(plaid);
    const signed = await plaid.signWebhook(BODY, { iat: nowS, kid: "not-a-plaid-key" });
    const headers = { [PLAID_VERIFICATION_HEADER]: signed.jwt };
    expect(await connector.verifyWebhook?.(headers, signed.body)).toBe(false);
    expect(await connector.verifyWebhook?.(headers, signed.body)).toBe(false);
    expect(plaid.keyLookups()).toBe(1);
  });

  it("refuses other algorithms, a forged signature, junk and a missing header", async () => {
    const plaid = fakePlaid();
    const keys = new PlaidKeyCache(async () => null);
    const signed = await plaid.signWebhook(BODY, { iat: nowS });
    const [h, p, s] = signed.jwt.split(".") as [string, string, string];
    const none = `${toBase64Url(utf8(JSON.stringify({ alg: "none", kid: plaid.keyId })))}.${p}.`;
    const hs = `${toBase64Url(utf8(JSON.stringify({ alg: "HS256", kid: plaid.keyId })))}.${p}.${s}`;
    const verify = (jwt: string | undefined) =>
      verifyPlaidWebhook({ jwt, body: signed.body, keys, now: NOW });
    expect(await verify(none)).toEqual({ ok: false, reason: "algorithm" });
    expect(await verify(hs)).toEqual({ ok: false, reason: "algorithm" });
    expect(await verify(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(await verify("a.b")).toEqual({ ok: false, reason: "malformed" });
    expect(await verify(`${h}.${p}.${"A".repeat(5000)}`)).toEqual({
      ok: false,
      reason: "malformed",
    });
    // Another body's claims under the same signature.
    const other = await plaid.signWebhook("{}", { iat: nowS });
    const [, p2] = other.jwt.split(".") as [string, string];
    expect(await check(plaid, `${h}.${p2}.${s}`, utf8("{}"))).toBe(false);
  });

  it("is refused where Plaid isn't configured", async () => {
    const plaid = fakePlaid();
    const signed = await plaid.signWebhook(BODY, { iat: nowS });
    const connector = createBankfeedConnector({ fetch: plaid.fetch, now: () => NOW });
    expect(
      await connector.verifyWebhook?.({ [PLAID_VERIFICATION_HEADER]: signed.jwt }, signed.body),
    ).toBe(false);
  });

  it("turns a verified body into what to do", () => {
    expect(plaidWebhookAction(JSON.parse(BODY))).toEqual({ kind: "sync", itemId: "item-000001" });
    expect(
      plaidWebhookAction({
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: "item-1",
        error: { error_code: "ITEM_LOGIN_REQUIRED" },
      }),
    ).toEqual({ kind: "attention", itemId: "item-1", code: "ITEM_LOGIN_REQUIRED" });
    expect(
      plaidWebhookAction({
        webhook_type: "ITEM",
        webhook_code: "PENDING_EXPIRATION",
        item_id: "i",
      }),
    ).toEqual({ kind: "ignore" });
    expect(plaidWebhookAction({ webhook_type: "TRANSACTIONS", webhook_code: "x" })).toEqual({
      kind: "ignore",
    });
  });
});
