import {
  DEFAULT_PERMISSIONS,
  dec,
  type JsonObject,
  pickLocalized,
  ToolDisplay,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import cloudEvents from "../../../../fixtures/qbo/webhook-cloudevents.json";
import notification from "../../../../fixtures/qbo/webhook-notification.json";
import type { DocumentServices, WriteContext } from "../connector";
import { CredentialCipher, generateEncryptionKey, memoryTenantKeys } from "../credentials";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { captureBefore, executeWrite, runReadTool, ToolCallError } from "../invoke";
import { memoryLogger } from "../logger";
import { beginAuthorization, completeAuthorization } from "../oauth/flow";
import { ReconnectRequiredError } from "../oauth/tokens";
import { ConnectorRegistry } from "../registry";
import { fromUtf8, utf8 } from "../runtime";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo, QBO_FIXTURES } from "../testing";
import {
  createQboConnector,
  parseQboWebhook,
  QBO_TOOLS,
  QboStaleObjectError,
  QboTotalWouldChangeError,
  qboJson,
  qboSyncPage,
  qboWebhookSignature,
  RealmThrottle,
  verifyQboWebhook,
  wire,
} from "./index";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const user = "0190f0c8-0000-7000-8000-0000000000a1";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const DOC = "0190f0c8-0000-7000-8000-0000000000d1";
const REDIRECT = "https://staging.mezonas.com/api/connections/qbo/callback";
const INVOICE = utf8("%PDF-1.4\n% Northwest Plywood INV-20931\n%%EOF\n");

const fastSleep = async () => {};
type Row = Record<string, unknown> & { Id: string };

function setup(over: { now?: () => Date } = {}) {
  const qbo = fakeQbo({ now: over.now ?? (() => NOW) });
  const connector = createQboConnector({
    ...FAKE_QBO_CLIENT,
    environment: "sandbox",
    webhookVerifier: "verifier-token",
    fetch: qbo.fetch,
    sleep: fastSleep,
    now: () => NOW,
  });
  return { qbo, connector };
}

const documents: DocumentServices = {
  async read(id) {
    return id === DOC
      ? {
          id,
          bytes: INVOICE,
          filename: "nwp-INV-20931.pdf",
          mimeType: "application/pdf",
          sha256: "a".repeat(64),
        }
      : null;
  },
};

/** Signs in through the fake (so its tokens are live) and gives a call context over the result. */
async function signedIn(s: ReturnType<typeof setup>) {
  const grant = await s.connector.handleCallback?.(
    { code: "fixture-code", realmId: FAKE_QBO_REALM, state: "x" },
    { tenantId: tenant, userId: user, redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  const store = memoryCredentials(grant.credentials as JsonObject);
  const ctx = (key = "run-1:step-1:0"): WriteContext => ({
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
    now: () => NOW,
    idempotencyKey: key,
    services: { documents },
  });
  return { grant, store, ctx };
}

describe("qbo connector: manifest and sign-in", () => {
  it("fills every summary from fields its tool's output has", () => {
    const { connector } = setup();
    for (const t of connector.manifest.tools) {
      if (!t.summary) continue;
      const props = Object.keys((t.output as { properties?: object }).properties ?? {});
      const refs = [...pickLocalized(t.summary).matchAll(/\{\{\s*([A-Za-z0-9_-]+)/g)].map(
        (m) => m[1],
      );
      for (const r of refs) expect(props, `${t.id} summary uses {{${r}}}`).toContain(r);
    }
  });

  it("declares twelve reads and ten approval-gated writes, no delete", () => {
    const { connector } = setup();
    new ConnectorRegistry([connector]);
    expect(connector.manifest.auth).toBe("oauth2");
    expect(connector.manifest.tools.map((t) => [t.id, t.sideEffect, t.verb])).toEqual([
      [QBO_TOOLS.purchaseQuery, "none", "read"],
      [QBO_TOOLS.billQuery, "none", "read"],
      [QBO_TOOLS.vendorQuery, "none", "read"],
      [QBO_TOOLS.itemQuery, "none", "read"],
      [QBO_TOOLS.attachableList, "none", "read"],
      [QBO_TOOLS.billUpdateLines, "external", "update"],
      [QBO_TOOLS.purchaseUpdateLines, "external", "update"],
      [QBO_TOOLS.billUpdateMemo, "external", "update"],
      [QBO_TOOLS.purchaseUpdateMemo, "external", "update"],
      [QBO_TOOLS.itemUpdatePurchaseCost, "external", "update"],
      [QBO_TOOLS.attachableUpload, "external", "create"],
      // v0.12: accounts receivable and create bill.
      [QBO_TOOLS.invoiceQuery, "none", "read"],
      [QBO_TOOLS.customerQuery, "none", "read"],
      [QBO_TOOLS.paymentQuery, "none", "read"],
      [QBO_TOOLS.agingReport, "none", "read"],
      [QBO_TOOLS.invoiceAddNote, "external", "update"],
      [QBO_TOOLS.billCreate, "external", "create"],
      // P-2: QuickBooks ingredients.
      [QBO_TOOLS.accountQuery, "none", "read"],
      [QBO_TOOLS.classQuery, "none", "read"],
      [QBO_TOOLS.vendorCreate, "external", "create"],
      [QBO_TOOLS.purchaseOrderCreate, "external", "create"],
      [QBO_TOOLS.purchaseOrderQuery, "none", "read"],
    ]);
    // The record types the v0.12 tools name (ToolSpec.entity), for per-entity permissions.
    const entity = (id: string) => connector.manifest.tools.find((t) => t.id === id)?.entity;
    expect(entity(QBO_TOOLS.invoiceAddNote)).toBe("invoice");
    expect(entity(QBO_TOOLS.billCreate)).toBe("bill");
    expect(entity(QBO_TOOLS.agingReport)).toBe("invoice");
    // Create bill declares its amount for approver rules.
    expect(connector.manifest.tools.find((t) => t.id === QBO_TOOLS.billCreate)?.amount).toEqual({
      path: "expectedTotal",
      currencyPath: "currency",
      currency: "USD",
    });
    expect(connector.manifest.tools.every((t) => t.verb !== "delete")).toBe(true);
    // Every write says how it reads on an approval card, in all six languages, and shows no
    // guard (the SyncToken, the expected total, the line ids it replaces) to the person signing.
    const writes = connector.manifest.tools.filter((t) => t.sideEffect === "external");
    for (const t of writes) {
      const display = ToolDisplay.parse(t.display);
      const texts = [
        display.name,
        ...(display.description ? [display.description] : []),
        ...display.fields.map((f) => f.label),
      ];
      for (const text of texts) {
        expect(Object.keys(text as object).sort(), t.id).toEqual(
          ["de", "en", "es", "fr", "it", "pt-BR"].sort(),
        );
      }
      const shown = display.fields.flatMap((f) => [f.now, f.after]).filter(Boolean);
      // A new bill's expected total is its total, not a guard on a record that exists.
      const guards =
        t.id === QBO_TOOLS.billCreate || t.id === QBO_TOOLS.purchaseOrderCreate
          ? /syncToken|\.id\b|Ids?\b/
          : /syncToken|expectedTotal|\.id\b|Ids?\b/;
      expect(shown.join(" "), t.id).not.toMatch(guards);
    }
    expect(createQboConnector().isConfigured?.()).toBe(false);
    expect(connector.isConfigured?.()).toBe(true);
  });

  it("signs in: accounting scope only, state passed, code exchanged, tokens encrypted", async () => {
    const { qbo, connector } = setup();
    const begun = await beginAuthorization({
      connector,
      tenantId: tenant,
      userId: user,
      redirectUri: REDIRECT,
      stateSecret: "s".repeat(32),
      now: NOW,
    });
    const [base, query = ""] = begun.redirectUrl.split("?");
    const q = formDecode(query);
    expect(base).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(q).toEqual({
      client_id: FAKE_QBO_CLIENT.clientId,
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      redirect_uri: REDIRECT,
      state: begun.state,
    });

    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      memoryTenantKeys(),
    );
    const done = await completeAuthorization({
      connector,
      params: { code: "fixture-code", state: begun.state, realmId: FAKE_QBO_REALM },
      session: { tenantId: tenant, userId: user },
      connectionId,
      redirectUri: REDIRECT,
      stateSecret: "s".repeat(32),
      cipher,
      now: NOW,
    });
    expect(done.grant).toEqual({
      externalAccountId: FAKE_QBO_REALM,
      config: { accountName: "Harbor Millwork (sandbox)", environment: "sandbox", country: "US" },
    });
    const sealed = JSON.stringify(done.credentials);
    expect(sealed).not.toContain(QBO_FIXTURES.tokenCode.refresh_token);
    expect(sealed).not.toContain(QBO_FIXTURES.tokenCode.access_token);
    expect(
      await cipher.decrypt(done.credentials, { tenantId: tenant, connectionId }),
    ).toMatchObject({
      accessToken: QBO_FIXTURES.tokenCode.access_token,
      refreshToken: QBO_FIXTURES.tokenCode.refresh_token,
      realmId: FAKE_QBO_REALM,
      environment: "sandbox",
    });
    const exchange = qbo.requests.find((r) => r.url.includes("/oauth2/v1/tokens/bearer"));
    expect(exchange?.headers.authorization).toMatch(/^Basic /);
    expect(exchange?.body).toContain("grant_type=authorization_code");
    expect(exchange?.body).toContain(`redirect_uri=${encodeURIComponent(REDIRECT)}`);
    // The secret goes in the Basic header only, never the body.
    expect(exchange?.body).not.toContain(FAKE_QBO_CLIENT.clientSecret);
  });

  it("refuses a callback without a company or with a used code", async () => {
    const { connector } = setup();
    const req = { tenantId: tenant, userId: user, redirectUri: REDIRECT };
    await expect(connector.handleCallback?.({ code: "fixture-code" }, req)).rejects.toThrow(
      /realmId/,
    );
    await expect(
      connector.handleCallback?.({ code: "fixture-code", realmId: "abc" }, req),
    ).rejects.toThrow(/realmId/);
    await expect(
      connector.handleCallback?.({ code: "used", realmId: FAKE_QBO_REALM }, req),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("refreshes on a 401, stores the new refresh token, and asks to reconnect when Intuit refuses", async () => {
    const s = setup();
    const { store, ctx } = await signedIn(s);
    s.qbo.expireAccessTokens();
    const out = await runReadTool(s.connector, QBO_TOOLS.vendorQuery, { name: "plywood" }, ctx());
    expect((out.output as { vendors: { name: string }[] }).vendors.map((v) => v.name)).toEqual([
      "Northwest Plywood Supply",
    ]);
    expect(store.current()).toMatchObject({
      accessToken: QBO_FIXTURES.tokenRefresh.access_token,
      refreshToken: QBO_FIXTURES.tokenRefresh.refresh_token,
    });
    expect(store.writes).toBe(1);
    // A second expiry: the rotated refresh token works, the first one would not.
    s.qbo.expireAccessTokens();
    await runReadTool(s.connector, QBO_TOOLS.itemQuery, {}, ctx());
    expect(store.writes).toBe(2);
    expect(s.qbo.refreshToken).toBe((store.current() as { refreshToken: string }).refreshToken);
    // Revoked at Intuit: the next refresh is refused and the client must sign in again.
    s.qbo.revoked.push(s.qbo.refreshToken as string);
    s.qbo.expireAccessTokens();
    await expect(runReadTool(s.connector, QBO_TOOLS.itemQuery, {}, ctx())).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
  });

  it("refreshes before expiry without waiting for a 401", async () => {
    const s = setup();
    const { store, ctx } = await signedIn(s);
    await store.set({ ...(store.current() as JsonObject), expiresAt: "2026-11-05T18:01:00.000Z" });
    await runReadTool(s.connector, QBO_TOOLS.vendorQuery, {}, ctx());
    expect(s.qbo.requests.filter((r) => r.url.includes("tokens/bearer"))).toHaveLength(2);
    // The sign-in read the company with the first token; the query used the refreshed one.
    expect(s.qbo.apiCalls().at(-1)?.headers.authorization).toBe(
      `Bearer ${QBO_FIXTURES.tokenRefresh.access_token}`,
    );
  });

  it("refuses a connection made in the other environment, or for another company", async () => {
    const s = setup();
    const { store, ctx } = await signedIn(s);
    const prod = createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "production",
      fetch: s.qbo.fetch,
    });
    await expect(runReadTool(prod, QBO_TOOLS.vendorQuery, {}, ctx())).rejects.toThrow(/sandbox/);
    const other = ctx();
    other.connection = { ...other.connection, externalAccountId: "123" };
    await expect(runReadTool(s.connector, QBO_TOOLS.vendorQuery, {}, other)).rejects.toThrow(
      /not this connection/,
    );
    expect(store.current()).not.toBeNull();
  });

  it("revokes the refresh token with the app's Basic auth", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    await s.connector.revoke?.(ctx());
    const call = s.qbo.requests.find((r) => r.url.includes("/oauth2/tokens/revoke"));
    expect(call?.headers.authorization).toMatch(/^Basic /);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      token: QBO_FIXTURES.tokenCode.refresh_token,
    });
    expect(s.qbo.refreshToken).toBeNull();
  });
});

describe("qbo connector: read tools", () => {
  it("queries bills with lines and money as decimal strings, and pages with `more`", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const out = (await runReadTool(s.connector, QBO_TOOLS.billQuery, { vendorId: "57" }, ctx()))
      .output as { bills: { id: string; total: string; lines: unknown[] }[]; more: boolean };
    expect(out.more).toBe(false);
    expect(out.bills).toHaveLength(1);
    expect(out.bills[0]).toMatchObject({
      entity: "Bill",
      id: "146",
      syncToken: "2",
      total: "961.2500",
      vendor: { id: "57", name: "Cascade Hardwoods" },
      lines: [
        {
          id: "1",
          detailType: "item",
          item: { id: "22", name: "White oak 4/4 FAS" },
          qty: "95.0000",
          unitPrice: "8.7500",
          amount: "831.2500",
        },
        { id: "2", detailType: "account", account: { id: "81", name: "Freight In" } },
      ],
    });
    const page = (await runReadTool(s.connector, QBO_TOOLS.purchaseQuery, { limit: 2 }, ctx()))
      .output as { purchases: unknown[]; more: boolean };
    expect(page.purchases).toHaveLength(2);
    expect(page.more).toBe(true);
    const query = decodeURIComponent(s.qbo.apiCalls("GET", "query").at(-1)?.url ?? "");
    expect(query).toContain("maxresults 3");
    expect(query).toContain("minorversion=75");
  });

  it("finds items and attachments, and escapes quotes in what an agent types", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const items = (await runReadTool(s.connector, QBO_TOOLS.itemQuery, { name: "birch" }, ctx()))
      .output as { items: { name: string; purchaseCost: string }[] };
    expect(items.items).toEqual([
      expect.objectContaining({ name: "Baltic birch 3/4in 5x5", purchaseCost: "64.0000" }),
    ]);
    await runReadTool(s.connector, QBO_TOOLS.vendorQuery, { name: "O'Brien' or 1=1" }, ctx());
    expect(decodeURIComponent(s.qbo.apiCalls("GET", "query").at(-1)?.url ?? "")).toContain(
      "DisplayName like '%O\\'Brien\\' or 1=1%'",
    );
    const att = (
      await runReadTool(
        s.connector,
        QBO_TOOLS.attachableList,
        { entity: "Bill", entityId: "146" },
        ctx(),
      )
    ).output as { attachments: { fileName: string }[] };
    expect(att.attachments.map((a) => a.fileName)).toEqual(["cascade-77812.pdf"]);
    await expect(
      runReadTool(s.connector, QBO_TOOLS.billQuery, { vendorId: "56' or '1'='1" }, ctx()),
    ).rejects.toBeInstanceOf(ToolCallError);
  });

  it("waits and retries when QuickBooks throttles", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    s.qbo.throttleNext(2);
    const out = (await runReadTool(s.connector, QBO_TOOLS.vendorQuery, {}, ctx())).output as {
      vendors: unknown[];
    };
    expect(out.vendors).toHaveLength(3);
    s.qbo.throttleNext(10);
    await expect(runReadTool(s.connector, QBO_TOOLS.vendorQuery, {}, ctx())).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });

  it("never puts a token in a tool's output", async () => {
    const s = setup();
    const { ctx, store } = await signedIn(s);
    const outputs = await Promise.all(
      [
        QBO_TOOLS.billQuery,
        QBO_TOOLS.purchaseQuery,
        QBO_TOOLS.vendorQuery,
        QBO_TOOLS.itemQuery,
      ].map((t) => runReadTool(s.connector, t, {}, ctx())),
    );
    const text = JSON.stringify(outputs);
    const c = store.current() as { accessToken: string; refreshToken: string };
    expect(text).not.toContain(c.accessToken);
    expect(text).not.toContain(c.refreshToken);
  });
});

describe("qbo connector: throttle", () => {
  it("holds a realm to its per-minute limit and its concurrency", async () => {
    let t = 0;
    const waits: number[] = [];
    const th = new RealmThrottle({
      concurrency: 2,
      perMinute: 3,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    let active = 0;
    let peak = 0;
    const job = () =>
      th.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
      });
    await Promise.all([job(), job(), job(), job()]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(waits).toEqual([60_000]);
  });
});

describe("qbo connector: itemizing lines", () => {
  const itemize = {
    id: "145",
    syncToken: "0",
    expectedTotal: "1352.75",
    replaceLineIds: ["1"],
    lines: [
      {
        itemId: "21",
        description: "Baltic birch 18mm 5x5 B/BB",
        qty: "18",
        unitPrice: "64.00",
        amount: "1152.00",
      },
      { itemId: "23", qty: "50", unitPrice: "3.2", amount: "160.00" },
      { accountId: "81", description: "Fuel surcharge", amount: "40.75" },
    ],
  };

  it("captures the before state, writes once with a request id, and keeps the total", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const proposed = await captureBefore(s.connector, QBO_TOOLS.billUpdateLines, itemize, ctx());
    expect(proposed.before).toMatchObject({
      id: "145",
      syncToken: "0",
      total: "1352.7500",
      lines: [{ id: "1", detailType: "account", amount: "1352.7500" }],
      // The names of the items and accounts the new lines use, for the approval card: those the
      // record names, the rest read from QuickBooks (the fake company has no accounts to read).
      names: {
        items: { "21": "Baltic birch 3/4in 5x5" },
        accounts: { "80": "Job Materials" },
      },
    });
    const written = await executeWrite(s.connector, QBO_TOOLS.billUpdateLines, itemize, ctx());
    expect(written.output).toEqual({
      entity: "Bill",
      id: "145",
      syncToken: "1",
      total: "1352.7500",
      lineCount: 3,
      alreadyDone: false,
    });
    expect(written.summary).toBe("Itemized the bill into 3 lines; total unchanged at 1352.75");
    expect(written.before).toMatchObject({ syncToken: "0", lines: [{ id: "1" }] });
    const posts = s.qbo.apiCalls("POST", "bill");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toMatch(/requestid=[0-9a-f]{36}/);
    const body = JSON.parse(posts[0]?.body ?? "{}");
    expect(body).toMatchObject({ Id: "145", SyncToken: "0", sparse: true });
    // Amounts go out as JSON numbers written from their decimal text.
    expect(posts[0]?.body).toContain('"Amount":1152');
    expect(posts[0]?.body).toContain('"UnitPrice":3.2');
    // New lines keep the job and billable status of the line they replace.
    expect(body.Line[0].ItemBasedExpenseLineDetail).toMatchObject({
      ItemRef: { value: "21" },
      CustomerRef: { value: "7", name: "Henderson kitchen" },
      BillableStatus: "Billable",
    });
    const after = s.qbo.get("Bill", "145");
    expect(after?.TotalAmt).toBe(1352.75);
    expect(after?.Line).toHaveLength(3);

    // The same action again (a retried step): recognised, nothing written.
    const again = await executeWrite(s.connector, QBO_TOOLS.billUpdateLines, itemize, ctx());
    expect(again.output).toMatchObject({ alreadyDone: true, syncToken: "1" });
    expect(s.qbo.apiCalls("POST", "bill")).toHaveLength(1);
  });

  it("refuses when the total would change, before writing anything", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const short = { ...itemize, lines: itemize.lines.slice(0, 2) };
    // Refused when proposed (no one is asked to approve it) and again when run.
    await expect(
      captureBefore(s.connector, QBO_TOOLS.billUpdateLines, short, ctx()),
    ).rejects.toBeInstanceOf(QboTotalWouldChangeError);
    await expect(
      executeWrite(s.connector, QBO_TOOLS.billUpdateLines, short, ctx()),
    ).rejects.toBeInstanceOf(QboTotalWouldChangeError);
    await expect(
      executeWrite(
        s.connector,
        QBO_TOOLS.billUpdateLines,
        { ...itemize, expectedTotal: "1400.00" },
        ctx(),
      ),
    ).rejects.toThrow(/total is 1352.7500, not the 1400.00 expected/);
    const taxed = s.qbo.get("Bill", "145");
    s.qbo.put("Bill", { ...(taxed as Row), SyncToken: "0", TxnTaxDetail: { TotalTax: 12.5 } });
    await expect(
      executeWrite(s.connector, QBO_TOOLS.billUpdateLines, itemize, ctx()),
    ).rejects.toThrow(/has tax/);
    expect(s.qbo.apiCalls("POST")).toHaveLength(0);
  });

  it("refuses lines whose amount isn't qty × unit price, and unknown lines", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const bad = {
      ...itemize,
      lines: [{ itemId: "21", qty: "18", unitPrice: "64.00", amount: "1352.75" }],
    };
    await expect(
      executeWrite(s.connector, QBO_TOOLS.billUpdateLines, bad, ctx()),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      executeWrite(
        s.connector,
        QBO_TOOLS.billUpdateLines,
        { ...itemize, replaceLineIds: ["9"] },
        ctx(),
      ),
    ).rejects.toThrow(/no line 9/);
  });

  it("fails cleanly on a stale SyncToken and leaves QuickBooks as it was", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const bill = s.qbo.get("Bill", "145");
    // Someone edits the bill in QuickBooks after the agent read it.
    s.qbo.put("Bill", { ...(bill as Row), SyncToken: "1", PrivateNote: "edited by Ana" });
    await expect(
      executeWrite(s.connector, QBO_TOOLS.billUpdateLines, itemize, ctx()),
    ).rejects.toBeInstanceOf(QboStaleObjectError);
    expect(s.qbo.apiCalls("POST")).toHaveLength(0);
    expect(s.qbo.get("Bill", "145")?.Line).toHaveLength(1);
  });

  it("maps QuickBooks' own stale-object refusal (5010) the same way", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const bill = s.qbo.get("Bill", "145") as Row;
    // Raced: changed between our read and our write (the fake bumps the token under us).
    const original = s.qbo.fetch;
    let readOnce = false;
    const racing = createQboConnector({
      ...FAKE_QBO_CLIENT,
      fetch: async (url, init) => {
        const res = await original(url, init);
        if (!readOnce && url.includes("/bill/145")) {
          readOnce = true;
          s.qbo.put("Bill", { ...(bill as Row), SyncToken: "5" });
        }
        return res;
      },
      sleep: fastSleep,
    });
    const handler = racing.tools[QBO_TOOLS.billUpdateLines];
    if (handler?.kind !== "write") throw new Error("not a write");
    await expect(handler.run(itemize, ctx(), null)).rejects.toMatchObject({ code: "5010" });
  });

  it("itemizes a purchase, carrying its payment fields", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    await executeWrite(
      s.connector,
      QBO_TOOLS.purchaseUpdateLines,
      {
        id: "201",
        syncToken: "0",
        expectedTotal: "214.60",
        replaceLineIds: ["1"],
        lines: [
          { itemId: "23", qty: "67", unitPrice: "3.20", amount: "214.40" },
          { accountId: "81", amount: "0.20" },
        ],
      },
      ctx(),
    );
    const body = JSON.parse(s.qbo.apiCalls("POST", "purchase")[0]?.body ?? "{}");
    expect(body).toMatchObject({ PaymentType: "CreditCard", AccountRef: { value: "35" } });
    expect(s.qbo.get("Purchase", "201")?.TotalAmt).toBe(214.6);
  });
});

describe("qbo connector: memo, purchase cost, attachments", () => {
  it("updates a memo once, with its before state", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const input = { id: "146", syncToken: "2", memo: "Itemized from invoice 77812" };
    const out = await executeWrite(s.connector, QBO_TOOLS.billUpdateMemo, input, ctx());
    expect(out.before).toMatchObject({ memo: null, syncToken: "2", total: "961.2500" });
    expect(out.output).toMatchObject({ memo: input.memo, syncToken: "3", alreadyDone: false });
    const again = await executeWrite(s.connector, QBO_TOOLS.billUpdateMemo, input, ctx());
    expect(again.output).toMatchObject({ alreadyDone: true });
    expect(s.qbo.apiCalls("POST", "bill")).toHaveLength(1);
    expect(JSON.parse(s.qbo.apiCalls("POST", "bill")[0]?.body ?? "{}")).toEqual({
      Id: "146",
      SyncToken: "2",
      sparse: true,
      PrivateNote: input.memo,
    });
  });

  it("updates an item's purchase cost as a decimal", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const out = await executeWrite(
      s.connector,
      QBO_TOOLS.itemUpdatePurchaseCost,
      { id: "21", syncToken: "3", purchaseCost: "66.40" },
      ctx(),
    );
    expect(out.before).toEqual({
      id: "21",
      syncToken: "3",
      name: "Baltic birch 3/4in 5x5",
      purchaseCost: "64.0000",
    });
    expect(out.output).toMatchObject({ purchaseCost: "66.4000", syncToken: "4" });
    expect(s.qbo.apiCalls("POST", "item")[0]?.body).toContain('"PurchaseCost":66.4');
    await expect(
      executeWrite(
        s.connector,
        QBO_TOOLS.itemUpdatePurchaseCost,
        { id: "21", syncToken: "3", purchaseCost: "70.00" },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(QboStaleObjectError);
  });

  it("attaches a stored document once, and only one of this client's", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const input = { documentId: DOC, entity: "Bill", entityId: "145" };
    const out = await executeWrite(s.connector, QBO_TOOLS.attachableUpload, input, ctx());
    // The bill's number and vendor and the file being attached name the change on its card.
    expect(out.before).toEqual({
      entity: "Bill",
      entityId: "145",
      docNumber: "INV-20931",
      vendor: { id: "56", name: "Northwest Plywood Supply" },
      attachments: [],
      adding: {
        fileName: "nwp-INV-20931.pdf",
        size: INVOICE.length,
        contentType: "application/pdf",
      },
    });
    expect(out.output).toMatchObject({
      fileName: "nwp-INV-20931.pdf",
      entity: "Bill",
      entityId: "145",
      alreadyDone: false,
    });
    const id = (out.output as { attachableId: string }).attachableId;
    expect(s.qbo.fileOf(id)).toEqual(INVOICE);
    const upload = s.qbo.apiCalls("POST", "upload")[0];
    expect(upload?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload?.url).toMatch(/requestid=/);
    const again = await executeWrite(s.connector, QBO_TOOLS.attachableUpload, input, ctx("other"));
    expect(again.output).toMatchObject({ attachableId: id, alreadyDone: true });
    expect(s.qbo.apiCalls("POST", "upload")).toHaveLength(1);
    await expect(
      executeWrite(
        s.connector,
        QBO_TOOLS.attachableUpload,
        { ...input, documentId: "0190f0c8-0000-7000-8000-0000000000d2" },
        ctx(),
      ),
    ).rejects.toThrow(/not this client's/);
  });

  it("writes amounts as JSON numbers from their text", () => {
    expect(qboJson({ Amount: wire("1152.0000"), Qty: wire("0.3333"), Name: "x" })).toBe(
      '{"Amount":1152,"Qty":0.3333,"Name":"x"}',
    );
    expect(dec("0.1").plus(dec("0.2")).toString()).toBe("0.3");
  });
});

describe("qbo sync", () => {
  it("reads every entity page by page, then CDC: new, changed and deleted records, attachments too", async () => {
    let now = NOW;
    const s = setup({ now: () => now });
    const { ctx } = await signedIn(s);
    const client = await s.connector.client(ctx());
    let cursor = null;
    const seen: string[] = [];
    let pages = 0;
    for (;;) {
      const page = await qboSyncPage(client, cursor, { now, pageSize: 2 });
      pages += 1;
      expect(page.initial).toBe(true);
      seen.push(...page.records.map((r) => `${r.entityType}:${r.externalId}:${r.externalVersion}`));
      cursor = page.next;
      if (cursor.phase === "cdc") break;
    }
    expect(pages).toBeGreaterThan(6);
    expect(seen).toEqual(
      expect.arrayContaining([
        "Vendor:56:0",
        "Item:21:3",
        "Purchase:201:0",
        "Bill:146:2",
        "VendorCredit:301:0",
        "Attachable:5000000000000401:0",
        // v0.12: customers whole, invoices and payments for 365 days.
        "Customer:8:2",
        "Invoice:130:1",
        "Invoice:134:3",
        "Payment:501:0",
      ]),
    );
    expect(seen).not.toContain("Invoice:120:1");
    expect(new Set(seen).size).toBe(seen.length);
    const queries = s.qbo
      .apiCalls("GET", "query")
      .map((r) => decodeURIComponent(r.url.replace(/\+/g, " ")));
    const initialQuery = queries.find((u) => u.includes("from Bill")) ?? "";
    expect(initialQuery).toContain("TxnDate >= '2026-08-07'");
    expect(queries.find((u) => u.includes("from Invoice"))).toContain("TxnDate >= '2025-11-05'");
    expect(queries.find((u) => u.includes("from Payment"))).toContain("TxnDate >= '2025-11-05'");
    expect(queries.find((u) => u.includes("from Customer"))).not.toContain("where");

    // Later: a bill comes in with its invoice attached, a purchase is deleted, a bill changes.
    now = new Date("2026-11-05T18:15:00.000Z");
    s.qbo.put("Bill", {
      Id: "147",
      SyncToken: "0",
      TxnDate: "2026-11-04",
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
    s.qbo.remove("Purchase", "202");
    const page = await qboSyncPage(client, cursor, { now });
    expect(page.done).toBe(true);
    expect(page.initial).toBe(false);
    expect(
      page.records.map((r) => [
        r.entityType,
        r.externalId,
        r.externalVersion,
        r.isDeleted ?? false,
      ]),
    ).toEqual([
      ["Purchase", "202", "deleted", true],
      ["Bill", "147", "0", false],
    ]);
    const cdcCall = s.qbo.apiCalls("GET", "cdc").at(-1)?.url ?? "";
    expect(decodeURIComponent(cdcCall)).toContain(
      "entities=Vendor,Item,Customer,Purchase,Bill,VendorCredit,Invoice,Payment,Attachable",
    );
    expect(page.next).toEqual({
      v: 1,
      phase: "cdc",
      ar: true,
      changedSince: "2026-11-05T18:14:00.000Z",
    });
  });

  it("starts over when CDC would look back more than 30 days", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const client = await s.connector.client(ctx());
    const page = await qboSyncPage(
      client,
      { v: 1, phase: "cdc", changedSince: "2026-09-01T00:00:00.000Z" },
      { now: NOW },
    );
    expect(page.initial).toBe(true);
    expect(s.qbo.apiCalls("GET", "cdc")).toHaveLength(0);
  });

  it("downloads an attachment through its short-lived link", async () => {
    const s = setup();
    const { ctx } = await signedIn(s);
    const refs = await s.connector.fetchAttachments?.(ctx(), "Bill", "146");
    expect(refs).toEqual([
      {
        externalId: "5000000000000401",
        filename: "cascade-77812.pdf",
        mime: "application/pdf",
        size: 1180,
      },
    ]);
    const file = await s.connector.downloadAttachment?.(ctx(), refs?.[0] as never);
    expect(fromUtf8(file?.bytes ?? new Uint8Array())).toContain("Cascade Hardwoods invoice 77812");
    // The presigned link gets no bearer token.
    const fileCall = s.qbo.requests.find((r) => r.url.startsWith("https://qbo-files.fake.example"));
    expect(fileCall?.headers.authorization).toBeUndefined();
  });
});

describe("qbo webhooks", () => {
  const body = utf8(JSON.stringify(notification));

  it("accepts Intuit's signature and refuses a wrong or missing one", async () => {
    const sig = await qboWebhookSignature("verifier-token", body);
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await verifyQboWebhook("verifier-token", sig, body)).toBe(true);
    expect(
      await verifyQboWebhook("verifier-token", sig, utf8(`${JSON.stringify(notification)} `)),
    ).toBe(false);
    expect(await verifyQboWebhook("other-token", sig, body)).toBe(false);
    expect(await verifyQboWebhook("verifier-token", null, body)).toBe(false);
    expect(await verifyQboWebhook(undefined, sig, body)).toBe(false);
    const { connector } = setup();
    expect(await connector.verifyWebhook?.({ "intuit-signature": sig }, body)).toBe(true);
    expect(await connector.verifyWebhook?.({ "intuit-signature": `${sig}x` }, body)).toBe(false);
  });

  it("reads which companies changed, in both payload shapes", () => {
    expect(parseQboWebhook(notification)).toEqual([
      { realmId: "9130357766900456", entities: ["Bill", "Purchase"] },
    ]);
    expect(parseQboWebhook(cloudEvents)).toEqual([
      { realmId: "9130357766900456", entities: ["Bill"] },
    ]);
    expect(parseQboWebhook({ hello: "world" })).toBeNull();
    expect(
      parseQboWebhook({ eventNotifications: [{ realmId: "../etc", dataChangeEvent: {} }] }),
    ).toEqual([]);
  });
});
