// Search figures through the platform (M45, docs/plan.md §1.75): the operator offers Search
// Console and Bing to a client and the client admin enters each one's key in the portal (stored
// write-only under the client's own key); the cron's search sync reads 16 months of final days
// from the fakes into raw records, the same twice, then only from a few days before the data's
// end; a failure is kept in our words without the key; the pack's nightly pass normalises the
// records for the site the operator pointed them at; and the Search report reaches the back office
// with the day the data runs to, for that client only.

import {
  createBingWebmasterConnector,
  createGscConnector,
  credentialKeysFromEnv,
  generateEncryptionKey,
  readSearchSyncState,
} from "@countersign/connectors";
import {
  bingDate,
  FAKE_BING,
  FAKE_GSC,
  type FakeSearchConsole,
  fakeBing,
  fakeSearchConsole,
} from "@countersign/connectors/testing";
import { routes } from "@countersign/core";
import { connection, rawRecord, tenant } from "@countersign/db";
import { searchPageDaily, searchQueryDaily } from "@countersign/pack-marketing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";
import { packNightly } from "./app";
import { credentialsFor } from "./runs/execute";
import { searchSyncTick, syncSearchConnection } from "./search-sync";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const NIGHT = new Date("2026-11-08T03:11:00Z");
const PACK_NIGHT = new Date("2026-11-08T03:41:00Z");

const gsc: FakeSearchConsole = await fakeSearchConsole({
  finalThrough: "2026-11-05",
  rows: [
    {
      day: "2025-07-10",
      query: "mezonas",
      url: "https://mezonas.com/",
      impressions: 2,
      clicks: 0,
      position: 40,
    },
    {
      day: "2026-10-20",
      query: "invoice agent",
      url: "https://mezonas.com/how-it-works",
      impressions: 30,
      clicks: 3,
      position: 12,
    },
    {
      day: "2026-11-04",
      query: "back office agents",
      url: "https://www.mezonas.com/",
      impressions: 50,
      clicks: 5,
      position: 9,
    },
    {
      day: "2026-11-06",
      query: "not final",
      url: "https://mezonas.com/",
      impressions: 9,
      clicks: 0,
      position: 3,
    },
  ],
});
const bing = fakeBing([
  {
    day: "2026-11-01",
    query: "mezonas",
    url: "https://mezonas.com/",
    impressions: 7,
    clicks: 1,
    position: 3,
  },
]);

const h = await createApiHarness({
  connectors: () => [
    createGscConnector({ fetch: () => gsc.fetch }),
    createBingWebmasterConnector({ fetch: () => bing.fetch }),
  ],
  env: { ENCRYPTION_KEY },
});
afterAll(() => h?.close());

describe.skipIf(!h)("search figures on the platform", () => {
  const H = h as ApiHarness;
  let siteId = "";
  let gscId = "";
  let bingId = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    credentials: credentialsFor(H.db, credentialKeysFromEnv({ ENCRYPTION_KEY })),
  });

  beforeAll(async () => {
    await H.t.db
      .update(tenant)
      .set({ settings: { connectors_offered: ["testkit", "gsc", "bing_webmaster"] } })
      .where(eq(tenant.id, H.A.tenantId));
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`))
        .status,
    ).toBe(200);
    const added = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/actions/add-site`,
      { domain: "mezonas.com", name: "mezonas.com" },
    );
    siteId = j(added.json).result.site.id;
  });

  it("is offered as a form, and the client admin's key is stored write-only", async () => {
    const access = j((await H.call(admin("a"), "GET", routes.portalAccess.path)).json);
    expect(access.setup.map((s: { connector: string }) => s.connector).sort()).toEqual([
      "bing_webmaster",
      "gsc",
    ]);
    const put = await H.call(admin("a"), "PUT", "/api/connections/gsc/credentials", {
      values: { property: FAKE_GSC.property, serviceAccountKey: gsc.serviceAccountKey },
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    gscId = j(put.json).item.connectionId;
    expect(JSON.stringify(put.json)).not.toContain("PRIVATE KEY");
    const putBing = await H.call(admin("a"), "PUT", "/api/connections/bing_webmaster/credentials", {
      values: { siteUrl: FAKE_BING.siteUrl, apiKey: FAKE_BING.apiKey },
    });
    expect(putBing.status).toBe(200);
    bingId = j(putBing.json).item.connectionId;
    // Client B has neither offered: it can't set one up.
    expect(
      (
        await H.call(admin("b"), "PUT", "/api/connections/gsc/credentials", {
          values: { property: FAKE_GSC.property, serviceAccountKey: gsc.serviceAccountKey },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("syncs within the hour of the key, then only at night", async () => {
    // 14:11: never synced, so both read now; 15:11: synced, so neither does.
    expect(await searchSyncTick(deps(), new Date("2026-11-07T14:11:00Z"))).toBe(2);
    expect(await searchSyncTick(deps(), new Date("2026-11-07T15:11:00Z"))).toBe(0);
    expect(await searchSyncTick(deps(), new Date("2026-11-07T15:12:00Z"))).toBe(0);
  });

  it("reads 16 months of final days into raw records, the same twice", async () => {
    gsc.queries.length = 0;
    // A fresh connection state: the first sync again.
    await H.t.db.update(connection).set({ syncCursor: {} }).where(eq(connection.id, gscId));
    const first = await syncSearchConnection(
      { ...deps(), now: () => NIGHT },
      {
        tenantId: H.A.tenantId,
        connectionId: gscId,
      },
    );
    expect(first).toMatchObject({ status: "ok", dataRunsTo: "2026-11-04" });
    expect(gsc.queries[0]?.from).toBe("2025-07-10");
    const stored = await H.t.db.select().from(rawRecord).where(eq(rawRecord.connectionId, gscId));
    expect(stored.every((r) => r.tenantId === H.A.tenantId && r.connector === "gsc")).toBe(true);
    expect(stored.some((r) => r.externalId === "2026-11-05")).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("PRIVATE KEY");

    const again = await syncSearchConnection(
      { ...deps(), now: () => NIGHT },
      {
        tenantId: H.A.tenantId,
        connectionId: gscId,
      },
    );
    expect(again).toMatchObject({ status: "ok", stored: 0, dataRunsTo: "2026-11-04" });
    // The second reads from three days before the data's end.
    expect(gsc.queries.at(-1)?.from).toBe("2026-11-01");
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, gscId));
    expect(readSearchSyncState(row?.syncCursor)).toMatchObject({
      dataRunsTo: "2026-11-04",
      lastError: null,
    });
  });

  it("keeps a failure in our words, keeping the day the data runs to", async () => {
    gsc.properties.delete(FAKE_GSC.property);
    const failed = await syncSearchConnection(
      { ...deps(), now: () => NIGHT },
      {
        tenantId: H.A.tenantId,
        connectionId: gscId,
      },
    );
    gsc.properties.add(FAKE_GSC.property);
    expect(failed).toMatchObject({
      status: "failed",
      dataRunsTo: "2026-11-04",
      error: "Search Console refused (403): is the service account a user on the property?",
    });
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, gscId));
    expect(JSON.stringify(row?.syncCursor)).not.toContain("PRIVATE");
  });

  it("normalises for the site in the pack's nightly pass, and reports it to the back office", async () => {
    for (const [provider, connectionId] of [
      ["google", gscId],
      ["bing", bingId],
    ] as const) {
      const set = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/clients/${H.A.tenantId}/packs/marketing/actions/set-search-source`,
        { siteId, provider, connectionId },
      );
      expect(set.status, JSON.stringify(set.json)).toBe(200);
    }
    // A's connection can't be pointed at from B.
    const refused = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.B.tenantId}/packs/marketing/actions/set-search-source`,
      { siteId, provider: "google", connectionId: gscId },
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);

    // The sync failed last: the source says so until a sync goes through.
    await syncSearchConnection(
      { ...deps(), now: () => NIGHT },
      { tenantId: H.A.tenantId, connectionId: gscId },
    );
    expect(await packNightly(H.db, H.platform.packs, PACK_NIGHT)).toBe(1);
    const queries = await H.t.db
      .select()
      .from(searchQueryDaily)
      .where(and(eq(searchQueryDaily.siteId, siteId), eq(searchQueryDaily.provider, "google")));
    expect(queries.map((r) => [r.day, r.query, r.path]).sort()).toEqual([
      ["2025-07-10", "mezonas", "/"],
      ["2026-10-20", "invoice agent", "/how-it-works"],
      ["2026-11-04", "back office agents", "/"],
    ]);
    const bingPages = await H.t.db
      .select()
      .from(searchPageDaily)
      .where(and(eq(searchPageDaily.siteId, siteId), eq(searchPageDaily.provider, "bing")));
    expect(bingPages.map((r) => [r.day, r.path, r.impressions])).toEqual([["2026-11-01", "/", 7]]);
    expect(bingDate("2026-11-01")).toContain("-0700");

    const report = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/search?provider=google&site=${siteId}`,
    );
    expect(report.status, JSON.stringify(report.json)).toBe(200);
    expect(j(report.json).report).toMatchObject({
      dataRunsTo: "2026-11-04",
      period: { to: "2026-11-04" },
      sources: [
        expect.objectContaining({ provider: "bing", lastError: null }),
        expect.objectContaining({ provider: "google", lastError: null }),
      ],
    });
    expect(forbiddenKeys(report.json)).toEqual([]);
    expect(JSON.stringify(report.json)).not.toContain(FAKE_BING.apiKey);
    const bad = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/search?provider=yahoo`,
    );
    expect(bad.status).toBe(400);
    const sources = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/search-sources`,
    );
    expect(j(sources.json).report.connections).toHaveLength(2);
    expect(JSON.stringify(sources.json)).not.toContain(FAKE_BING.apiKey);
    // Client B has the pack off: no Search report for it.
    const other = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.B.tenantId}/reports/marketing/search`,
    );
    expect(other.status).toBe(404);
  });
});
