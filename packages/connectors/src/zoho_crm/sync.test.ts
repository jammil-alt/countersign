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
  ZOHO_FULL_READ_SINCE,
  ZOHO_MAX_PAGE,
  ZOHO_SYNCED_MODULES,
  type ZohoSyncCursor,
  zohoChannelId,
  zohoCursorFor,
  zohoDeletedRecords,
  zohoNotifyToken,
  zohoPageRequest,
  zohoRawRecord,
  zohoSinceHeader,
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
    // A first sync lists each module once, and reads no deletions (we hold nothing yet).
    expect(pages).toHaveLength(ZOHO_SYNCED_MODULES.length);
    expect(pages.every((p) => p.initial)).toBe(true);
    const records = pages.flatMap((p) => p.records);
    // 2026-11-24: the first sync reads every record, the January deal too.
    expect(records.map((r) => [r.entityType, r.externalId, r.externalVersion])).toEqual([
      ["Deals", "5725767000000411009", "2026-01-01T10:00:00+00:00"],
      ["Deals", "5725767000000411001", "2026-10-30T10:00:00+00:00"],
      ["Deals", "5725767000000411002", "2026-11-01T10:00:00+00:00"],
    ]);
    expect(records[0]?.payload).not.toHaveProperty("$state");
    const list = zoho.apiCalls().find((r) => r.url.includes("/crm/v8/Deals?"));
    expect(list?.url).toContain("sort_by=Modified_Time");
    expect(list?.url).toContain("fields=");
    // A full read sends no window.
    expect(list?.headers).not.toHaveProperty("if-modified-since");
    expect(zoho.apiCalls().some((r) => r.url.includes("/deleted"))).toBe(false);
    // The next pass starts where this one began, and is news.
    const next = readZohoSyncCursor(stored);
    expect(next).toMatchObject({
      module: 0,
      page: 1,
      since: "2026-11-06T11:59:00.000Z",
      from: "2026-11-06T11:59:00.000Z",
      initial: false,
      full: true,
    });
    zoho.state.listed.Leads = [
      { id: "5843104000000424672", Last_Name: "Lee", Modified_Time: "2026-11-06T12:30:00+00:00" },
    ];
    const later = await c.syncPage(ctx(new Date("2026-11-06T13:00:00.000Z")), stored);
    expect(later.initial).toBe(false);
    expect(later.records.map((r) => r.externalId)).toEqual(["5843104000000424672"]);
    const leadsList = zoho
      .apiCalls()
      .filter((r) => r.url.includes("/crm/v8/Leads?"))
      .at(-1);
    expect(leadsList?.headers["if-modified-since"]).toBe("2026-11-06T11:59:00+00:00");
  });

  it("reads each module's deleted records after its list, on every pass but the first", async () => {
    const zoho = fakeZoho();
    zoho.state.listed.Deals = [deal("5725767000000411001", "2026-10-30T10:00:00+00:00")];
    const c = createZohoCrmConnector({ clientId: "id", clientSecret: "secret", fetch: zoho.fetch });
    let stored: unknown = null;
    for (let i = 0; i < 10; i++) {
      const page = await c.syncPage(ctx(), stored);
      stored = { zoho: page.next };
      if (page.done) break;
    }
    zoho.state.deleted.Deals = [
      { id: "5725767000000411001", deleted_time: "2026-11-06T12:10:00+00:00" },
      { id: "5725767000000411000", deleted_time: "2026-11-01T09:00:00+00:00" },
    ];
    const pages = [];
    for (let i = 0; i < 20; i++) {
      const page = await c.syncPage(ctx(new Date("2026-11-06T13:00:00.000Z")), stored);
      pages.push(page);
      stored = { zoho: page.next };
      if (page.done) break;
    }
    // A list and a list of deletions per module.
    expect(pages).toHaveLength(ZOHO_SYNCED_MODULES.length * 2);
    // Only the deletion inside the pass's window.
    expect(pages.flatMap((p) => p.deleted)).toEqual([
      { entityType: "Deals", externalId: "5725767000000411001" },
    ]);
    const call = zoho.apiCalls().find((r) => r.url.includes("/crm/v8/Deals/deleted?"));
    expect(call?.url).toContain("type=all");
    expect(call?.headers["if-modified-since"]).toBe("2026-11-06T11:59:00+00:00");
    expect(zohoDeletedRecords("Leads", [{ id: "../x" }, "nope", { id: 42 }])).toEqual([
      { entityType: "Leads", externalId: "42" },
    ]);
  });

  it("skips the deletions Zoho refuses, so the changes keep coming", async () => {
    const zoho = fakeZoho();
    zoho.state.deletedRefused = true;
    const c = createZohoCrmConnector({ clientId: "id", clientSecret: "secret", fetch: zoho.fetch });
    const cursor: ZohoSyncCursor = {
      ...startZohoSync(NOW),
      initial: false,
      phase: "deleted",
      since: "2026-11-06T09:00:00.000Z",
      from: "2026-11-06T09:00:00.000Z",
    };
    const page = await c.syncPage(ctx(), { zoho: cursor });
    expect(page.deleted).toEqual([]);
    expect(page.next).toMatchObject({ module: 1, page: 1 });
    expect(page.next.phase).toBeUndefined();
  });

  it("reads everything once, quietly, for a connection whose first sync read 90 days", () => {
    const old: ZohoSyncCursor = {
      v: 1,
      module: 2,
      since: "2026-11-06T09:00:00.000Z",
      page: 1,
      next: "2026-11-06T10:00:00.000Z",
      initial: false,
    };
    const cursor = zohoCursorFor({ zoho: old }, NOW, "");
    expect(cursor).toMatchObject({
      module: 0,
      since: ZOHO_FULL_READ_SINCE,
      from: ZOHO_FULL_READ_SINCE,
      full: true,
      initial: false,
      quietUntil: "2026-11-06T09:00:00.000Z",
    });
    expect(zohoSinceHeader(cursor.since)).toBeNull();
    // Its pages carry the quiet line; the pass after it doesn't.
    const page = afterZohoPage(cursor, { records: [], more: false }, NOW);
    expect(page.quietUntil).toBe("2026-11-06T09:00:00.000Z");
    const end = afterZohoPage(
      { ...cursor, module: 3, phase: "deleted" },
      { records: [], more: false },
      NOW,
    );
    expect(end.done).toBe(true);
    expect(end.next.quietUntil).toBeUndefined();
    expect(end.next.full).toBe(true);
    // Read in full already: kept as it is.
    expect(zohoCursorFor({ zoho: end.next }, NOW, "")).toEqual(end.next);
    // A 90-day first sync still under way starts again as a full one, still history.
    expect(zohoCursorFor({ zoho: { ...old, initial: true } }, NOW, "")).toEqual(startZohoSync(NOW));
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

  it("starts the next module from the pass's window, not one a deep module moved", () => {
    const pass: ZohoSyncCursor = {
      v: 1,
      module: 0,
      since: "2026-11-06T09:00:00.000Z",
      from: "2026-11-06T09:00:00.000Z",
      page: ZOHO_MAX_PAGE,
      next: "2026-11-06T11:59:00.000Z",
      initial: false,
      full: true,
    };
    const rec = zohoRawRecord("Leads", deal("1", "2026-11-06T10:30:00+00:00"));
    const moved = afterZohoPage(pass, { records: rec ? [rec] : [], more: true }, NOW);
    expect(moved.next).toMatchObject({ module: 0, since: "2026-11-06T10:30:00.000Z", page: 1 });
    // Its list is over: the deletions, over the pass's whole window.
    const listed = afterZohoPage(moved.next, { records: [], more: false }, NOW);
    expect(listed.next).toMatchObject({ module: 0, phase: "deleted", page: 1 });
    expect(zohoPageRequest(listed.next)).toMatchObject({
      deleted: true,
      since: "2026-11-06T09:00:00.000Z",
    });
    const contacts = afterZohoPage(listed.next, { records: [], deleted: [], more: false }, NOW);
    expect(contacts.next).toMatchObject({ module: 1, page: 1, since: "2026-11-06T09:00:00.000Z" });
    expect(contacts.next.phase).toBeUndefined();
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
