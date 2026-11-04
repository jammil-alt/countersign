import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { WriteContext } from "../connector";
import { CredentialCipher, generateEncryptionKey } from "../credentials";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite, runReadTool } from "../invoke";
import { memoryLogger } from "../logger";
import { beginAuthorization, completeAuthorization } from "../oauth/flow";
import { ReconnectRequiredError } from "../oauth/tokens";
import { ConnectorRegistry } from "../registry";
import { fakeZoho, ZOHO_FIXTURES } from "../testing";
import {
  createZohoCrmConnector,
  isZohoAccountsServer,
  mapZohoRecord,
  ZOHO_SCOPES,
  ZOHO_TOOLS,
  ZohoApiError,
} from "./index";

const NOW = new Date("2026-11-04T15:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const user = "0190f0c8-0000-7000-8000-0000000000a1";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const STATE_SECRET = "s".repeat(32);
const LEAD = "5843104000000424672";

function creds(over: Record<string, unknown> = {}): JsonObject {
  return {
    accessToken: ZOHO_FIXTURES.tokenCode.access_token,
    refreshToken: ZOHO_FIXTURES.tokenCode.refresh_token,
    expiresAt: "2026-11-04T16:00:00.000Z",
    accountsServer: "https://accounts.zoho.eu",
    apiDomain: "https://www.zohoapis.eu",
    ...over,
  } as JsonObject;
}

function ctx(credentials: JsonObject | null, now = NOW) {
  const store = memoryCredentials(credentials);
  const c: WriteContext = {
    tenantId: tenant,
    connection: {
      id: connectionId,
      tenantId: tenant,
      connector: "zoho_crm",
      status: "connected",
      externalAccountId: "20087654321",
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: store,
    logger: memoryLogger(),
    now: () => now,
    idempotencyKey: "run-1:create:0",
  };
  return { c, store };
}

const options = (fetch: ReturnType<typeof fakeZoho>["fetch"]) => ({
  clientId: "1000.CLIENTID",
  clientSecret: "client-secret",
  fetch,
});

describe("zoho_crm connector", () => {
  it("declares reads and approval-gated writes, no delete, and narrow scopes", () => {
    const c = createZohoCrmConnector();
    new ConnectorRegistry([c]);
    expect(c.manifest.auth).toBe("oauth2");
    expect(c.manifest.tools.map((t) => [t.id, t.sideEffect, t.verb])).toEqual([
      [ZOHO_TOOLS.search, "none", "read"],
      [ZOHO_TOOLS.get, "none", "read"],
      [ZOHO_TOOLS.create, "external", "create"],
      [ZOHO_TOOLS.update, "external", "update"],
      [ZOHO_TOOLS.note, "external", "create"],
      [ZOHO_TOOLS.task, "external", "create"],
    ]);
    expect(ZOHO_SCOPES.some((s) => /DELETE|ALL/.test(s))).toBe(false);
    expect(c.isConfigured?.()).toBe(false);
    expect(createZohoCrmConnector({ clientId: "x", clientSecret: "y" }).isConfigured?.()).toBe(
      true,
    );
  });

  it("signs in: state checked, code exchanged at the client's data center, tokens encrypted", async () => {
    const zoho = fakeZoho();
    const connector = createZohoCrmConnector(options(zoho.fetch));
    const redirectUri = "https://app.mezonas.com/connections/zoho_crm/callback";
    const begun = await beginAuthorization({
      connector,
      tenantId: tenant,
      userId: user,
      redirectUri,
      stateSecret: STATE_SECRET,
      now: NOW,
    });
    expect(begun.redirectUrl.startsWith("https://accounts.zoho.com/oauth/v2/auth?")).toBe(true);
    expect(begun.redirectUrl).toContain("access_type=offline");
    expect(begun.redirectUrl).toContain(`state=${encodeURIComponent(begun.state)}`);
    expect(begun.redirectUrl).toContain(encodeURIComponent("ZohoCRM.modules.leads.READ"));

    const cipher = await CredentialCipher.create({ current: generateEncryptionKey() });
    const done = await completeAuthorization({
      connector,
      params: {
        code: "fixture-code",
        state: begun.state,
        location: "eu",
        "accounts-server": "https://accounts.zoho.eu",
      },
      session: { tenantId: tenant, userId: user },
      connectionId,
      redirectUri,
      stateSecret: STATE_SECRET,
      cipher,
      now: NOW,
    });
    expect(done.grant).toEqual({
      externalAccountId: "20087654321",
      config: {
        dataCenter: "eu",
        apiDomain: "https://www.zohoapis.eu",
        orgName: "Harbor Millwork",
      },
    });
    expect(JSON.stringify(done.credentials)).not.toContain(ZOHO_FIXTURES.tokenCode.refresh_token);
    const opened = await cipher.decrypt(done.credentials, { tenantId: tenant, connectionId });
    expect(opened).toMatchObject({
      accessToken: ZOHO_FIXTURES.tokenCode.access_token,
      refreshToken: ZOHO_FIXTURES.tokenCode.refresh_token,
      accountsServer: "https://accounts.zoho.eu",
      apiDomain: "https://www.zohoapis.eu",
    });
    const exchange = zoho.requests.find((r) => r.url === "https://accounts.zoho.eu/oauth/v2/token");
    expect(exchange?.body).toContain("grant_type=authorization_code");
    expect(exchange?.body).toContain("client_secret=client-secret");
  });

  it("never sends the code or secret to an accounts server it doesn't know", async () => {
    const zoho = fakeZoho();
    const connector = createZohoCrmConnector(options(zoho.fetch));
    const params = { code: "fixture-code", "accounts-server": "https://accounts.evil.example" };
    await expect(
      connector.handleCallback?.(params, {
        tenantId: tenant,
        userId: user,
        redirectUri: "https://x.example/cb",
      }),
    ).rejects.toThrow(/accounts server/);
    expect(zoho.requests).toHaveLength(0);
    expect(isZohoAccountsServer("https://accounts.zoho.com.evil.example")).toBe(false);
    expect(isZohoAccountsServer("https://accounts.zoho.com.au")).toBe(true);
    await expect(
      connector.handleCallback?.(
        { code: "used-code", "accounts-server": "https://accounts.zoho.eu" },
        { tenantId: tenant, userId: user, redirectUri: "https://x.example/cb" },
      ),
    ).rejects.toThrow(/invalid_code/);
  });

  it("searches and gets records, mapped and validated, dropping Zoho's $ keys", async () => {
    const zoho = fakeZoho();
    const connector = createZohoCrmConnector(options(zoho.fetch));
    const { c } = ctx(creds());
    const found = await runReadTool(
      connector,
      ZOHO_TOOLS.search,
      { module: "Leads", email: "pat@example.com" },
      c,
    );
    expect(found.summary).toBe("Found 1 Leads");
    expect(found.output).toEqual({
      module: "Leads",
      moreRecords: false,
      records: [
        expect.objectContaining({
          id: LEAD,
          module: "Leads",
          modifiedTime: "2026-11-02T09:00:00+00:00",
          fields: expect.objectContaining({ Last_Name: "Lee", Email: "pat@example.com" }),
        }),
      ],
    });
    expect(JSON.stringify(found.output)).not.toContain("$approval_state");
    const call = zoho.apiCalls()[0];
    expect(call?.url).toContain("/crm/v8/Leads/search?");
    expect(call?.url).toContain("email=pat%40example.com");
    expect(call?.headers.authorization).toBe(
      `Zoho-oauthtoken ${ZOHO_FIXTURES.tokenCode.access_token}`,
    );

    const none = await runReadTool(
      connector,
      ZOHO_TOOLS.search,
      { module: "Leads", word: "nobody" },
      c,
    );
    expect(none.output).toMatchObject({ records: [] });
    const got = await runReadTool(connector, ZOHO_TOOLS.get, { module: "Leads", id: LEAD }, c);
    expect(got.output).toMatchObject({ record: { id: LEAD } });
    const missing = await runReadTool(connector, ZOHO_TOOLS.get, { module: "Leads", id: "1" }, c);
    expect(missing.output).toEqual({ record: null });
    await expect(
      runReadTool(connector, ZOHO_TOOLS.search, { module: "Leads", email: "a@b.c", word: "x" }, c),
    ).rejects.toThrow(/invalid input/);
    expect(() => mapZohoRecord("Leads", { Last_Name: "no id" })).toThrow();
  });

  it("refreshes an expiring token at the client's accounts server and persists it", async () => {
    const zoho = fakeZoho();
    const connector = createZohoCrmConnector(options(zoho.fetch));
    const { c, store } = ctx(creds({ expiresAt: "2026-11-04T15:01:00.000Z" }));
    await runReadTool(connector, ZOHO_TOOLS.get, { module: "Leads", id: LEAD }, c);
    expect(zoho.requests[0]?.url).toBe("https://accounts.zoho.eu/oauth/v2/token");
    expect(store.writes).toBe(1);
    expect(store.current()).toMatchObject({
      accessToken: ZOHO_FIXTURES.tokenRefresh.access_token,
      // Zoho's refresh tokens don't rotate: the old one is kept.
      refreshToken: ZOHO_FIXTURES.tokenCode.refresh_token,
      expiresAt: "2026-11-04T16:00:00.000Z",
    });
    expect(zoho.apiCalls()[0]?.headers.authorization).toBe(
      `Zoho-oauthtoken ${ZOHO_FIXTURES.tokenRefresh.access_token}`,
    );
  });

  it("refreshes once on a 401, and asks for a reconnect when the grant is gone", async () => {
    const zoho = fakeZoho({ acceptAccessTokens: [ZOHO_FIXTURES.tokenRefresh.access_token] });
    const connector = createZohoCrmConnector(options(zoho.fetch));
    const { c } = ctx(creds());
    await runReadTool(connector, ZOHO_TOOLS.get, { module: "Leads", id: LEAD }, c);
    expect(zoho.apiCalls()).toHaveLength(2);

    const revoked = fakeZoho({ acceptAccessTokens: [] });
    revoked.failRefreshes();
    const again = createZohoCrmConnector(options(revoked.fetch));
    await expect(
      runReadTool(again, ZOHO_TOOLS.get, { module: "Leads", id: LEAD }, ctx(creds()).c),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it("creates a record, adds a note and a task once each, through executeWrite", async () => {
    const zoho = fakeZoho();
    const connector = createZohoCrmConnector(options(zoho.fetch));
    const { c } = ctx(creds());
    const created = await executeWrite(
      connector,
      ZOHO_TOOLS.create,
      { module: "Leads", fields: { Last_Name: "Okafor", Company: "Okafor Joinery" } },
      c,
    );
    expect(created).toMatchObject({
      before: null,
      output: { module: "Leads", id: "5843104000000425001" },
    });
    const post = zoho.apiCalls().find((r) => r.method === "POST");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      data: [{ Last_Name: "Okafor", Company: "Okafor Joinery" }],
    });

    const note = await executeWrite(
      connector,
      ZOHO_TOOLS.note,
      { module: "Leads", recordId: LEAD, title: "Call", content: "Asked for a quote." },
      c,
    );
    expect(note.output).toEqual({ module: "Leads", recordId: LEAD, id: "5843104000000426010" });
    const task = await executeWrite(
      connector,
      ZOHO_TOOLS.task,
      { subject: "Send quote", dueDate: "2026-11-10", module: "Deals", recordId: "123" },
      c,
    );
    expect(task.output).toEqual({ id: "5843104000000427020" });
    const taskBody = JSON.parse(zoho.apiCalls().at(-1)?.body ?? "");
    expect(taskBody.data[0]).toEqual({
      Subject: "Send quote",
      Due_Date: "2026-11-10",
      What_Id: { id: "123" },
      $se_module: "Deals",
    });
    await expect(
      executeWrite(
        connector,
        ZOHO_TOOLS.create,
        { module: "Leads", fields: { Company: "No name" } },
        c,
      ),
    ).rejects.toThrow(/required field not found/);
    await expect(
      executeWrite(connector, ZOHO_TOOLS.create, { module: "Leads", fields: { id: "1" } }, c),
    ).rejects.toThrow(/invalid input/);
  });

  it("updates with the fields' before state, and refuses when the record changed since it was read", async () => {
    const zoho = fakeZoho();
    const connector = createZohoCrmConnector(options(zoho.fetch));
    const { c } = ctx(creds());
    const input = {
      module: "Leads",
      id: LEAD,
      fields: { Lead_Status: "Contacted" },
      expectedModifiedTime: "2026-11-02T09:00:00+00:00",
    };
    const proposed = await captureBefore(connector, ZOHO_TOOLS.update, input, c);
    expect(proposed.before).toEqual({
      id: LEAD,
      modifiedTime: "2026-11-02T09:00:00+00:00",
      fields: { Lead_Status: "Not Contacted" },
    });
    const done = await executeWrite(connector, ZOHO_TOOLS.update, input, c);
    expect(done.output).toEqual({
      module: "Leads",
      id: LEAD,
      modifiedTime: "2026-11-04T15:05:00+00:00",
    });
    // The record has changed now: the same read-time is stale.
    await expect(executeWrite(connector, ZOHO_TOOLS.update, input, c)).rejects.toThrow(
      /changed since/,
    );
    expect(zoho.apiCalls().filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("marks rate limits retryable", async () => {
    const zoho = fakeZoho({ rateLimitNext: 1 });
    const connector = createZohoCrmConnector(options(zoho.fetch));
    const err = await runReadTool(
      connector,
      ZOHO_TOOLS.get,
      { module: "Leads", id: LEAD },
      ctx(creds()).c,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZohoApiError);
    expect(err).toMatchObject({ status: 429, code: "TOO_MANY_REQUESTS", retryable: true });
  });
});
