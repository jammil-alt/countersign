// The search area on a throwaway database, as the Worker's role (M45, docs/plan.md §1.75): the
// connectors' raw records (stored here as the platform's sync stores them) become the site's own
// daily rows, a day replaced whole and the newest version winning; twice is the same; another
// site's URLs are dropped and Bing's page-less queries kept apart; a source's state comes from its
// connection's sync; the figures (totals, close to page one, losing ground, small samples, the day
// the data runs to) answer for the report and the tool; and one client never reads, points at or
// imports another's (invariant 1).

import {
  type RawRecordInput,
  SEARCH_ENTITY,
  type SearchEntity,
  type SearchRow,
  type SearchSyncState,
  searchDayRecord,
} from "@countersign/connectors";
import { closeDb, connection, createDb, type Db, rawRecord, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKETING_HANDLERS, MARKETING_REPORTS } from "../manifest";
import { searchPageDaily, searchQueryDaily, searchSource } from "../schema";
import { insertMarketingClient, type MarketingClient } from "../testing.test-helper";
import { searchFigures } from "./figures";
import { SEARCH_FIGURES_TOOL } from "./index";
import { mergeRows, NO_PAGE, normaliseClient, pathOf, searchNightly } from "./normalise";
import { importSearch, searchSources, setSearchSource } from "./sources";

const online = await databaseAvailable();

const workerUrl = (url: string) => {
  const u = new URL(url);
  u.searchParams.set("options", "-c role=cs_worker");
  return u.toString();
};

const NOW = new Date("2026-11-08T03:41:00Z");
const TODAY = "2026-11-08";

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("pure parts", () => {
  it("keeps the site's own paths only", () => {
    expect(pathOf("https://www.mezonas.com/how-it-works/?ref=x#a", "mezonas.com")).toBe(
      "/how-it-works",
    );
    expect(pathOf("http://mezonas.com/", "mezonas.com")).toBe("/");
    expect(pathOf("https://elsewhere.example/", "mezonas.com")).toBeNull();
    expect(pathOf("https://mezonas.com.evil.example/", "mezonas.com")).toBeNull();
    expect(pathOf("https://mezonas.com/*", "mezonas.com")).toBeNull();
    expect(pathOf("not a url", "mezonas.com")).toBeNull();
  });

  it("merges rows on the same path, positions by impressions", () => {
    expect(
      mergeRows([
        { path: "/", impressions: 30, clicks: 3, position: 4 },
        { path: "/", impressions: 10, clicks: 1, position: 8 },
        { path: "/a", impressions: 1, clicks: 0, position: null },
      ]),
    ).toEqual([
      { path: "/", impressions: 40, clicks: 4, position: 5 },
      { path: "/a", impressions: 1, clicks: 0, position: null },
    ]);
  });
});

describe.skipIf(!online)("search figures (migration 0038)", () => {
  let t: TestDatabase;
  let worker: Db;
  let A: MarketingClient & { gsc: string; bing: string };
  let B: MarketingClient & { gsc: string };

  const conn = async (tenantId: string, connector: string) => {
    const [c] = await t.db
      .insert(connection)
      .values({
        tenantId,
        connector,
        status: "connected",
        config: { vault: { fields: { property: { set: true, value: "sc-domain:mezonas.com" } } } },
      })
      .returning();
    if (!c) throw new Error("no connection");
    return c.id;
  };

  /** What the platform's sync does: store raw records and the sync's state on the connection. */
  const synced = async (
    m: { tenantId: string },
    connectionId: string,
    records: RawRecordInput[],
    state: Partial<SearchSyncState> = {},
  ) => {
    for (const r of records) {
      await t.db
        .insert(rawRecord)
        .values({
          tenantId: m.tenantId,
          connectionId,
          connector: "gsc",
          entityType: r.entityType,
          externalId: r.externalId,
          externalVersion: r.externalVersion,
          payload: r.payload,
        })
        .onConflictDoNothing();
    }
    const full: SearchSyncState = {
      v: 1,
      dataRunsTo: null,
      lastRunAt: NOW.toISOString(),
      lastOkAt: NOW.toISOString(),
      lastError: null,
      ...state,
    };
    await t.db
      .update(connection)
      .set({ syncCursor: { search: full } })
      .where(eq(connection.id, connectionId));
  };

  const record = (
    entity: SearchEntity,
    day: string,
    rows: SearchRow[],
    provider: "google" | "bing" = "google",
  ) =>
    searchDayRecord({
      entity,
      provider,
      property: provider === "google" ? "sc-domain:mezonas.com" : "https://mezonas.com/",
      day,
      rows,
      truncated: false,
    });

  const q = (
    query: string,
    path: string,
    impressions: number,
    position: number,
    host = "mezonas.com",
  ) => ({
    query,
    url: `https://${host}${path}`,
    impressions,
    clicks: Math.floor(impressions / 10),
    position,
  });
  const p = (path: string, impressions: number, position: number) => ({
    url: `https://www.mezonas.com${path}`,
    impressions,
    clicks: Math.floor(impressions / 10),
    position,
  });

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    worker = createDb(workerUrl(t.url), { max: 2 });
    const a = await insertMarketingClient(t.db, "Mezonas", "mezonas.com");
    const b = await insertMarketingClient(t.db, "Other client", "other.example.com");
    A = {
      ...a,
      gsc: await conn(a.tenantId, "gsc"),
      bing: await conn(a.tenantId, "bing_webmaster"),
    };
    B = { ...b, gsc: await conn(b.tenantId, "gsc") };
  });
  afterAll(async () => {
    if (worker) await closeDb(worker);
    await t?.drop();
  });

  it("refuses a connection of another client or of the wrong kind", async () => {
    await expect(
      setSearchSource(worker, {
        tenantId: A.tenantId,
        input: { siteId: A.siteId, provider: "google", connectionId: B.gsc },
      }),
    ).rejects.toMatchObject({ code: "unknown_connection" });
    await expect(
      setSearchSource(worker, {
        tenantId: A.tenantId,
        input: { siteId: A.siteId, provider: "google", connectionId: A.bing },
      }),
    ).rejects.toMatchObject({ code: "wrong_connection" });
    await expect(
      setSearchSource(worker, {
        tenantId: A.tenantId,
        input: { siteId: B.siteId, provider: "google", connectionId: A.gsc },
      }),
    ).rejects.toMatchObject({ code: "unknown_site" });
  });

  it("normalises the synced days into the site's own rows, as the Worker", async () => {
    // 16 months of history: the first and the last day of it, then the recent weeks.
    const first = addDays(TODAY, -486);
    const records = [
      await record(SEARCH_ENTITY.page, first, [p("/", 3, 30)]),
      await record(SEARCH_ENTITY.queryPage, first, [q("mezonas", "/", 3, 30)]),
    ];
    for (let i = 0; i < 56; i++) {
      const day = addDays("2026-11-04", -i);
      const recent = i < 28;
      records.push(
        await record(SEARCH_ENTITY.page, day, [
          p("/", 20, 5),
          p("/how-it-works", 10, recent ? 14 : 9),
          p("/how-it-works/", 2, recent ? 14 : 9),
        ]),
        await record(SEARCH_ENTITY.queryPage, day, [
          q("back office agents", "/", 15, 9),
          q("invoice agent", "/how-it-works", 8, recent ? 15 : 9),
          q("invoice agent", "/how-it-works", 2, recent ? 15 : 9, "www.mezonas.com"),
          q("someone else", "/", 50, 1, "elsewhere.example"),
        ]),
      );
    }
    await synced(A, A.gsc, records, { dataRunsTo: "2026-11-04" });

    const set = await setSearchSource(worker, {
      tenantId: A.tenantId,
      input: { siteId: A.siteId, provider: "google", connectionId: A.gsc },
      now: NOW,
    });
    expect(set.imported?.days).toBe(records.length);
    expect(set.source).toMatchObject({
      provider: "google",
      connectionId: A.gsc,
      dataRunsTo: "2026-11-04",
      lastError: null,
    });
    const pages = await t.db
      .select()
      .from(searchPageDaily)
      .where(and(eq(searchPageDaily.siteId, A.siteId), eq(searchPageDaily.day, "2026-11-04")));
    expect(pages.map((r) => [r.path, r.impressions, r.position]).sort()).toEqual([
      ["/", 20, "5.00"],
      ["/how-it-works", 12, "14.00"],
    ]);
    const queries = await t.db
      .select()
      .from(searchQueryDaily)
      .where(and(eq(searchQueryDaily.siteId, A.siteId), eq(searchQueryDaily.day, "2026-11-04")));
    // Another site's row dropped; the www. and bare rows of one page merged.
    expect(queries.map((r) => [r.query, r.path, r.impressions]).sort()).toEqual([
      ["back office agents", "/", 15],
      ["invoice agent", "/how-it-works", 10],
    ]);
    expect(queries.every((r) => r.tenantId === A.tenantId)).toBe(true);
    const oldest = await t.db
      .select()
      .from(searchPageDaily)
      .where(and(eq(searchPageDaily.siteId, A.siteId), eq(searchPageDaily.day, first)));
    expect(oldest).toHaveLength(1);
  });

  it("is the same twice, and a revised day replaces the old one whole", async () => {
    const count = async () =>
      (await t.db.select().from(searchQueryDaily).where(eq(searchQueryDaily.siteId, A.siteId)))
        .length;
    const before = await count();
    await withTenant(worker, A.tenantId, (tx) =>
      normaliseClient(tx, A.tenantId, new Date(NOW.getTime() + 60_000)),
    );
    await importSearch(worker, { tenantId: A.tenantId, input: {}, now: NOW });
    expect(await count()).toBe(before);

    // Google revised Nov 4: one query left. The newer version wins, the day is replaced whole.
    await new Promise((r) => setImmediate(r));
    await synced(
      A,
      A.gsc,
      [await record(SEARCH_ENTITY.queryPage, "2026-11-04", [q("back office agents", "/", 99, 9)])],
      { dataRunsTo: "2026-11-04" },
    );
    const result = await searchNightly(worker, new Date(NOW.getTime() + 86_400_000));
    expect(result.clients).toBe(2);
    const day = await t.db
      .select()
      .from(searchQueryDaily)
      .where(and(eq(searchQueryDaily.siteId, A.siteId), eq(searchQueryDaily.day, "2026-11-04")));
    expect(day.map((r) => [r.query, r.impressions])).toEqual([["back office agents", 99]]);
  });

  it("keeps a sync's failure in our words, and the day the data runs to", async () => {
    await synced(A, A.gsc, [], {
      dataRunsTo: "2026-11-04",
      lastError: "Search Console refused (403): is the service account a user on the property?",
    });
    await importSearch(worker, { tenantId: A.tenantId, input: { provider: "google" }, now: NOW });
    const s = await withTenant(worker, A.tenantId, (tx) => searchSources(tx, A.tenantId));
    expect(s.sources).toEqual([
      expect.objectContaining({
        provider: "google",
        dataRunsTo: "2026-11-04",
        lastError: "Search Console refused (403): is the service account a user on the property?",
      }),
    ]);
    expect(s.connections.map((c) => [c.provider, c.property])).toEqual([
      ["google", "sc-domain:mezonas.com"],
      ["bing", null],
    ]);
    await synced(A, A.gsc, [], { dataRunsTo: "2026-11-04" });
    await importSearch(worker, { tenantId: A.tenantId, input: {}, now: NOW });
  });

  it("keeps Bing's queries without their pages apart from the pages", async () => {
    await synced(
      A,
      A.bing,
      [
        await record(
          SEARCH_ENTITY.query,
          "2026-11-01",
          [{ query: "mezonas", impressions: 4, clicks: 1, position: 2 }],
          "bing",
        ),
        await record(SEARCH_ENTITY.page, "2026-11-01", [p("/", 4, 2)], "bing"),
      ],
      { dataRunsTo: "2026-11-01" },
    );
    await setSearchSource(worker, {
      tenantId: A.tenantId,
      input: { siteId: A.siteId, provider: "bing", connectionId: A.bing },
      now: NOW,
    });
    const rows = await t.db
      .select()
      .from(searchQueryDaily)
      .where(and(eq(searchQueryDaily.siteId, A.siteId), eq(searchQueryDaily.provider, "bing")));
    expect(rows.map((r) => [r.query, r.path])).toEqual([["mezonas", NO_PAGE]]);
  });

  it("answers the figures: totals, close to page one, losing ground, marks", async () => {
    const f = await withTenant(worker, A.tenantId, (tx) =>
      searchFigures(tx, A.tenantId, TODAY, { provider: "google" }),
    );
    expect(f.dataRunsTo).toBe("2026-11-04");
    expect(f.period).toEqual({ from: "2026-10-08", to: "2026-11-04" });
    expect(f.previous).toEqual({ from: "2026-09-10", to: "2026-10-07" });
    expect(f.cappedToData).toBe(false);
    expect(f.totals.impressions).toBe(32 * 28);
    expect(f.totals.smallSample).toBe(false);
    expect(f.totals.ctr).toMatch(/^0\.\d{4}$/);
    expect(f.daily).toHaveLength(28);
    expect(f.queries[0]).toMatchObject({ query: "back office agents", topPage: "/" });
    expect(f.closeToPageOne.map((x) => x.query)).toEqual(["back office agents", "invoice agent"]);
    expect(f.losingGround).toEqual([
      expect.objectContaining({
        path: "/how-it-works",
        position: 14,
        previousPosition: 9,
        query: { query: "invoice agent", position: 15, previousPosition: 9 },
      }),
    ]);
    expect(f.sources.map((s) => s.provider)).toEqual(["bing", "google"]);
    // "Both" ends on the earlier provider's day; a period past the data is cut back and says so.
    const both = await withTenant(worker, A.tenantId, (tx) =>
      searchFigures(tx, A.tenantId, TODAY, {}),
    );
    expect(both.dataRunsTo).toBe("2026-11-01");
    const past = await withTenant(worker, A.tenantId, (tx) =>
      searchFigures(tx, A.tenantId, TODAY, {
        provider: "google",
        from: "2026-11-01",
        to: "2026-11-07",
      }),
    );
    expect(past).toMatchObject({
      cappedToData: true,
      period: { from: "2026-11-01", to: "2026-11-04" },
    });
    const first = addDays(TODAY, -486);
    const small = await withTenant(worker, A.tenantId, (tx) =>
      searchFigures(tx, A.tenantId, TODAY, { provider: "google", from: first, to: first }),
    );
    expect(small.totals).toMatchObject({ impressions: 3, smallSample: true });
  });

  it("serves the report and the agents' tool, with the sources to cite", async () => {
    const report = MARKETING_REPORTS.search;
    if (!report) throw new Error("no search report");
    const json = await withTenant(worker, A.tenantId, (tx) =>
      report.json(tx, A.tenantId, TODAY, { provider: "google" }),
    );
    expect(json).toMatchObject({ dataRunsTo: "2026-11-04" });
    const csv = await withTenant(worker, A.tenantId, (tx) =>
      report.csv(tx, A.tenantId, TODAY, { provider: "google" }),
    );
    expect(csv.split("\n")[0]).toBe(
      "query,impressions,clicks,ctr,position,previous_position,top_page",
    );
    const tool = MARKETING_HANDLERS[SEARCH_FIGURES_TOOL];
    expect(tool?.spec).toMatchObject({ sideEffect: "none", verb: "read", source: "marketing" });
    const out = (await tool?.run(
      { provider: "google" },
      {
        tenantId: A.tenantId,
        agentVersionId: A.agentVersionId,
        runId: A.runId,
        mode: "live",
        settings: {},
        db: worker,
        llm: null,
      },
    )) as { sources: { id: string }[]; queries: unknown[] };
    expect(tool?.output.safeParse(out).success).toBe(true);
    expect(out.sources.length).toBe(2);
    expect(out.queries.length).toBeLessThanOrEqual(25);
    await expect(async () =>
      tool?.run(
        { provider: "yahoo" },
        {
          tenantId: A.tenantId,
          agentVersionId: A.agentVersionId,
          runId: A.runId,
          mode: "live",
          settings: {},
          db: worker,
          llm: null,
        },
      ),
    ).rejects.toThrow();
  });

  it("never gives one client another's figures", async () => {
    // B's own connection has synced nothing it could normalise into A's site.
    const theirs = await withTenant(worker, B.tenantId, (tx) =>
      searchFigures(tx, B.tenantId, TODAY, {}),
    );
    expect(theirs.totals.impressions).toBe(0);
    expect(theirs.site?.id).toBe(B.siteId);
    await expect(
      withTenant(worker, B.tenantId, (tx) =>
        searchFigures(tx, B.tenantId, TODAY, { site: A.siteId }),
      ),
    ).rejects.toMatchObject({ code: "unknown_site" });
    const seen = await withTenant(worker, B.tenantId, (tx) =>
      tx.select().from(searchQueryDaily).where(eq(searchQueryDaily.siteId, A.siteId)),
    );
    expect(seen).toEqual([]);
    const sources = await withTenant(worker, B.tenantId, (tx) => tx.select().from(searchSource));
    expect(sources).toEqual([]);
    // B's own source, on B's connection, which has synced nothing: B's import brings in nothing.
    await setSearchSource(worker, {
      tenantId: B.tenantId,
      input: { siteId: B.siteId, provider: "google", connectionId: B.gsc },
      now: NOW,
    });
    const b = await importSearch(worker, { tenantId: B.tenantId, input: {}, now: NOW });
    expect(b.imported.map((r) => r.days)).toEqual([0]);
  });
});
