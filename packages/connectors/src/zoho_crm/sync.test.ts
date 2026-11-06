// v0.14 W4-B: Zoho CRM's cursor poll and notifications (docs/plan.md §1.9 "Sync (W4-B)"), against
// the fake Zoho. No live call.

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { memoryLogger } from "../logger";
import { fakeZoho, ZOHO_FIXTURES } from "../testing";
import { createZohoCrmConnector } from "./index";
import {
  afterZohoPage,
  parseZohoNotification,
  readZohoSyncCursor,
  startZohoSync,
  verifyZohoNotification,
  ZOHO_MAX_PAGE,
  ZOHO_SYNCED_MODULES,
  type ZohoSyncCursor,
  zohoChannelId,
  zohoNotifyToken,
  zohoRawRecord,
} from "./sync";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const SECRET = "s".repeat(32);

function ctx(now = NOW): ConnectionContext {
  return {
    tenantId: "0190f0c8-0000-7000-8000-000000000001",
    connection: {
      id: connectionId,
      tenantId: "0190f0c8-0000-7000-8000-000000000001",
      connector: "zoho_crm",
      status: "connected",
      externalAccountId: "20087654321",
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: memoryCredentials({
      accessToken: ZOHO_FIXTURES.tokenCode.access_token,
      refreshToken: ZOHO_FIXTURES.tokenCode.refresh_token,
      expiresAt: "2026-11-06T13:00:00.000Z",
      accountsServer: "https://accounts.zoho.eu",
      apiDomain: "https://www.zohoapis.eu",
    } as JsonObject),
    logger: memoryLogger(),
    now: () => now,
  };
}

const deal = (id: string, modified: string) => ({
  id,
  Deal_Name: `Deal ${id}`,
  Stage: "Qualification",
  Modified_Time: modified,
  $state: "save",
});

describe("zoho_crm sync", () => {
  it("reads every module from the cursor, oldest first, and stores each record's version", async () => {
    const zoho = fakeZoho();
    zoho.state.listed.Deals = [
      deal("5725767000000411002", "2026-11-01T10:00:00+00:00"),
      deal("5725767000000411001", "2026-10-30T10:00:00+00:00"),
      deal("5725767000000411009", "2026-01-01T10:00:00+00:00"),
    ];
    const c = createZohoCrmConnector({ clientId: "id", clientSecret: "secret", fetch: zoho.fetch });
    let stored: unknown = null;
    const pages = [];
    for (let i = 0; i < 10; i++) {
      const page = await c.syncPage(ctx(), stored);
      pages.push(page);
      stored = { zoho: page.next };
      if (page.done) break;
    }
    expect(pages).toHaveLength(ZOHO_SYNCED_MODULES.length);
    expect(pages.every((p) => p.initial)).toBe(true);
    const records = pages.flatMap((p) => p.records);
    // The first sync reads 90 days back: the January deal is older.
    expect(records.map((r) => [r.entityType, r.externalId, r.externalVersion])).toEqual([
      ["Deals", "5725767000000411001", "2026-10-30T10:00:00+00:00"],
      ["Deals", "5725767000000411002", "2026-11-01T10:00:00+00:00"],
    ]);
    expect(records[0]?.payload).not.toHaveProperty("$state");
    const list = zoho.apiCalls().find((r) => r.url.includes("/crm/v8/Deals?"));
    expect(list?.url).toContain("sort_by=Modified_Time");
    expect(list?.url).toContain("fields=");
    expect(list?.headers["if-modified-since"]).toBe("2026-08-08T12:00:00+00:00");
    // The next pass starts where this one began, and is news.
    const next = readZohoSyncCursor(stored);
    expect(next).toMatchObject({
      module: 0,
      page: 1,
      since: "2026-11-06T11:59:00.000Z",
      initial: false,
    });
    zoho.state.listed.Leads = [
      { id: "5843104000000424672", Last_Name: "Lee", Modified_Time: "2026-11-06T12:30:00+00:00" },
    ];
    const later = await c.syncPage(ctx(new Date("2026-11-06T13:00:00.000Z")), stored);
    expect(later.initial).toBe(false);
    expect(later.records.map((r) => r.externalId)).toEqual(["5843104000000424672"]);
  });

  it("pages within a window, then moves the window on by time past the deepest page", () => {
    const cursor: ZohoSyncCursor = { ...startZohoSync(NOW), module: 3 };
    const rec = (t: string) => zohoRawRecord("Deals", deal("1", t));
    const page = afterZohoPage(
      cursor,
      { records: [rec("2026-11-01T00:00:00+00:00")].filter((r) => r !== null), more: true },
      NOW,
    );
    expect(page.next).toMatchObject({ module: 3, page: 2 });
    const deep = afterZohoPage(
      { ...cursor, page: ZOHO_MAX_PAGE },
      { records: [rec("2026-11-02T08:00:00+00:00")].filter((r) => r !== null), more: true },
      NOW,
    );
    expect(deep.next).toMatchObject({ module: 3, page: 1, since: "2026-11-02T08:00:00.000Z" });
    const last = afterZohoPage(cursor, { records: [], more: false }, NOW);
    expect(last.done).toBe(true);
    expect(last.next).toMatchObject({ module: 0, since: cursor.next, initial: false });
  });

  it("refuses records that aren't Zoho's and cursors that don't read", () => {
    expect(zohoRawRecord("Leads", { id: "../etc" })).toBeNull();
    expect(zohoRawRecord("Leads", "nope")).toBeNull();
    expect(readZohoSyncCursor({ zoho: { v: 2 } })).toBeNull();
    expect(readZohoSyncCursor(null)).toBeNull();
  });

  it("turns notifications on with the connection's channel and token", async () => {
    const zoho = fakeZoho();
    const c = createZohoCrmConnector({ clientId: "id", clientSecret: "secret", fetch: zoho.fetch });
    const token = await zohoNotifyToken(SECRET, connectionId);
    await c.watch(ctx(), { notifyUrl: "https://app.mezonas.test/api/hooks/zoho", token });
    expect(zoho.state.watches).toEqual([
      {
        watch: [
          {
            channel_id: zohoChannelId(connectionId),
            events: ["Leads.all", "Contacts.all", "Accounts.all", "Deals.all"],
            channel_expiry: "2026-11-07T11:00:00+00:00",
            token,
            notify_url: "https://app.mezonas.test/api/hooks/zoho",
          },
        ],
      },
    ]);
  });
});

describe("zoho_crm notifications", () => {
  it("accept only the connection's own channel and token", async () => {
    const token = await zohoNotifyToken(SECRET, connectionId);
    expect(token).toHaveLength(48);
    const n = parseZohoNotification({
      channel_id: zohoChannelId(connectionId),
      token,
      module: "Deals",
      operation: "update",
      ids: ["5725767000000411001"],
    });
    if (!n) throw new Error("no notification");
    expect(await verifyZohoNotification(n, { secret: SECRET, connectionId })).toBe(true);
    const other = "0190f0c8-0000-7000-8000-0000000000c2";
    expect(await verifyZohoNotification(n, { secret: SECRET, connectionId: other })).toBe(false);
    expect(await verifyZohoNotification(n, { secret: "t".repeat(32), connectionId })).toBe(false);
    expect(
      await verifyZohoNotification({ ...n, token: undefined }, { secret: SECRET, connectionId }),
    ).toBe(false);
    expect(parseZohoNotification({ ids: [] })).toBeNull();
  });
});
