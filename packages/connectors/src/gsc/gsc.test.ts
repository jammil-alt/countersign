// Google Search Console and Bing Webmaster Tools against their fakes (M45, docs/plan.md §1.75):
// the service account signs in for read-only figures; a sync reads final days only, a month at a
// time, 16 months back the first time and from a few days before the data's end after; one record
// per day and dimension set, versioned by what it says; failures come back in our words, never
// quoting the key.

import type { JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { FAKE_BING, fakeBing } from "../bing_webmaster/fake";
import { bingDay, createBingWebmasterConnector } from "../bing_webmaster/index";
import type { ConnectionContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { memoryLogger } from "../logger";
import { FAKE_GSC, fakeSearchConsole } from "./fake";
import { createGscConnector, isGscProperty } from "./index";
import {
  addDays,
  planSearchSync,
  readSearchDayPayload,
  readSearchSyncState,
  SEARCH_ENTITY,
  SEARCH_HISTORY_DAYS,
  SearchImportError,
  searchConnectorOf,
  searchDayRecord,
} from "./records";

const NOW = new Date("2026-11-08T03:11:00Z");
const TODAY = "2026-11-08";

function ctx(credentials: JsonObject | null, connector = "gsc"): ConnectionContext {
  return {
    tenantId: "00000000-0000-4000-8000-0000000000a1",
    connection: {
      id: "00000000-0000-4000-8000-0000000000c1",
      tenantId: "00000000-0000-4000-8000-0000000000a1",
      connector,
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: {},
    },
    credentials: memoryCredentials(credentials),
    logger: memoryLogger(),
    now: () => NOW,
  };
}

const row = (day: string, query: string, path: string, impressions: number, position = 9) => ({
  day,
  query,
  url: `https://mezonas.com${path}`,
  impressions,
  clicks: Math.floor(impressions / 10),
  position,
});

describe("Google Search Console", () => {
  it("is an API-key connector with no tools and a write-only key", () => {
    const c = createGscConnector();
    expect(c.manifest).toMatchObject({ id: "gsc", auth: "api_key", tools: [] });
    expect(c.manifest.credentialFields?.map((f) => [f.name, f.secret])).toEqual([
      ["property", false],
      ["serviceAccountKey", true],
    ]);
    expect(searchConnectorOf(c)?.search.provider).toBe("google");
    expect(isGscProperty("sc-domain:mezonas.com")).toBe(true);
    expect(isGscProperty("https://mezonas.com/")).toBe(true);
    expect(isGscProperty("mezonas.com")).toBe(false);
  });

  it("reads final days only, a month at a time, one record per day and dimension set", async () => {
    const gsc = await fakeSearchConsole({
      finalThrough: "2026-11-05",
      rows: [
        row("2026-10-20", "invoice agent", "/", 40, 12),
        row("2026-10-20", "invoice agent", "/how-it-works", 10, 15),
        row("2026-11-04", "back office agents", "/", 60, 8.4),
        row("2026-11-06", "not final yet", "/", 5),
      ],
    });
    const c = createGscConnector({ fetch: () => gsc.fetch });
    const span = { from: "2026-10-01", to: addDays(TODAY, -1), today: TODAY, first: false };
    const read = await c.search.read(
      ctx({ property: FAKE_GSC.property, serviceAccountKey: gsc.serviceAccountKey }),
      span,
    );
    expect(read.lastDay).toBe("2026-11-04");
    // Oct 1 to Oct 20 (the first month's last day with figures), then Nov 1 to Nov 4: two each.
    expect(read.records).toHaveLength((20 + 4) * 2);
    const days = new Set(read.records.map((r) => r.externalId));
    expect(days.has("2026-11-05")).toBe(false);
    expect(days.has("2026-11-06")).toBe(false);
    const query = read.records.find(
      (r) => r.externalId === "2026-10-20" && r.entityType === SEARCH_ENTITY.queryPage,
    );
    const payload = readSearchDayPayload(query?.payload);
    expect(payload?.rows).toEqual([
      {
        query: "invoice agent",
        url: "https://mezonas.com/",
        impressions: 40,
        clicks: 4,
        position: 12,
      },
      {
        query: "invoice agent",
        url: "https://mezonas.com/how-it-works",
        impressions: 10,
        clicks: 1,
        position: 15,
      },
    ]);
    const empty = read.records.find((r) => r.externalId === "2026-10-05");
    expect(readSearchDayPayload(empty?.payload)?.rows).toEqual([]);
    // Two months, two dimension sets each; final data asked for; never the key in a URL.
    expect(gsc.queries.map((q) => [q.from, q.to, q.dimensions.length])).toEqual([
      ["2026-10-01", "2026-10-31", 2],
      ["2026-10-01", "2026-10-31", 3],
      ["2026-11-01", "2026-11-07", 2],
      ["2026-11-01", "2026-11-07", 3],
    ]);
    expect(gsc.urls.join(" ")).not.toContain("PRIVATE");
  });

  it("stores the same day the same way twice, and a revised day as a new version", async () => {
    const a = await searchDayRecord({
      entity: SEARCH_ENTITY.page,
      provider: "google",
      property: "sc-domain:mezonas.com",
      day: "2026-11-01",
      rows: [
        { url: "https://mezonas.com/b", impressions: 2, clicks: 0, position: 3 },
        { url: "https://mezonas.com/a", impressions: 1, clicks: 0, position: 4 },
      ],
      truncated: false,
    });
    const b = await searchDayRecord({
      entity: SEARCH_ENTITY.page,
      provider: "google",
      property: "sc-domain:mezonas.com",
      day: "2026-11-01",
      rows: [
        { url: "https://mezonas.com/a", impressions: 1, clicks: 0, position: 4 },
        { url: "https://mezonas.com/b", impressions: 2, clicks: 0, position: 3 },
      ],
      truncated: false,
    });
    expect(a.externalVersion).toBe(b.externalVersion);
    expect(a.externalVersion).toMatch(/^[0-9a-f]{32}$/);
    const c = await searchDayRecord({
      entity: SEARCH_ENTITY.page,
      provider: "google",
      property: "sc-domain:mezonas.com",
      day: "2026-11-01",
      rows: [{ url: "https://mezonas.com/a", impressions: 5, clicks: 1, position: 4 }],
      truncated: false,
    });
    expect(c.externalVersion).not.toBe(a.externalVersion);
  });

  it("plans 16 months the first time, then a few days before the data's end", () => {
    const first = planSearchSync(null, NOW);
    expect(first).toEqual({
      from: addDays(TODAY, -SEARCH_HISTORY_DAYS),
      to: "2026-11-07",
      today: TODAY,
      first: true,
    });
    const state = {
      v: 1 as const,
      dataRunsTo: "2026-11-04",
      lastRunAt: NOW.toISOString(),
      lastOkAt: NOW.toISOString(),
      lastError: null,
    };
    expect(planSearchSync(state, NOW)).toMatchObject({ from: "2026-11-01", first: false });
    expect(readSearchSyncState({ search: state, other: 1 })).toEqual(state);
    expect(readSearchSyncState({ search: { v: 2 } })).toBeNull();
    expect(readSearchSyncState(null)).toBeNull();
  });

  it("says what went wrong in our words, never with the key", async () => {
    const gsc = await fakeSearchConsole({ rows: [row("2026-11-01", "q", "/", 1)] });
    const c = createGscConnector({ fetch: () => gsc.fetch });
    const span = planSearchSync(null, NOW);
    const fails = async (creds: JsonObject | null) => {
      try {
        await c.search.read(ctx(creds), span);
      } catch (e) {
        expect(e).toBeInstanceOf(SearchImportError);
        return (e as SearchImportError).reason;
      }
      throw new Error("expected a failure");
    };
    expect(await fails(null)).toBe("no key has been entered for this connection");
    expect(
      await fails({ property: "mezonas.com", serviceAccountKey: gsc.serviceAccountKey }),
    ).toMatch(/isn't one Search Console names/);
    expect(await fails({ property: FAKE_GSC.property, serviceAccountKey: "{not json" })).toBe(
      "the service account key is not JSON",
    );
    const stranger = await fails({
      property: FAKE_GSC.property,
      serviceAccountKey: gsc.strangerKey,
    });
    expect(stranger).toBe("Google refused the service account key (400)");
    const other = await fails({
      property: "sc-domain:elsewhere.example",
      serviceAccountKey: gsc.serviceAccountKey,
    });
    expect(other).toMatch(/is the service account a user on the property/);
    gsc.failNext(429);
    expect(
      await fails({ property: FAKE_GSC.property, serviceAccountKey: gsc.serviceAccountKey }),
    ).toMatch(/limiting requests/);
    gsc.failNext(500);
    const reason = await fails({
      property: FAKE_GSC.property,
      serviceAccountKey: gsc.serviceAccountKey,
    });
    expect(reason).toBe("Search Console answered 500");
    expect(reason).not.toContain("PRIVATE KEY");
  });
});

describe("Bing Webmaster Tools", () => {
  const brow = (day: string, query: string, path: string, impressions: number) => ({
    day,
    query,
    url: `https://mezonas.com${path}`,
    impressions,
    clicks: 1,
    position: 6,
  });

  it("reads Bing's days, leaving the last two out, with queries kept without their pages", async () => {
    const bing = fakeBing([
      brow("2026-11-01", "mezonas", "/", 10),
      brow("2026-11-01", "mezonas", "/pricing", 5),
      brow("2026-11-03", "agents for invoices", "/", 7),
      brow("2026-11-07", "too fresh", "/", 9),
    ]);
    const c = createBingWebmasterConnector({ fetch: () => bing.fetch });
    expect(c.manifest).toMatchObject({ id: "bing_webmaster", auth: "api_key", tools: [] });
    const read = await c.search.read(
      ctx({ siteUrl: FAKE_BING.siteUrl, apiKey: FAKE_BING.apiKey }, "bing_webmaster"),
      planSearchSync(null, NOW),
    );
    expect(read.lastDay).toBe("2026-11-03");
    expect(read.records.map((r) => `${r.externalId} ${r.entityType}`)).toEqual([
      "2026-11-01 search.page_day",
      "2026-11-01 search.query_day",
      "2026-11-02 search.page_day",
      "2026-11-02 search.query_day",
      "2026-11-03 search.page_day",
      "2026-11-03 search.query_day",
    ]);
    const q = readSearchDayPayload(read.records[1]?.payload);
    expect(q?.rows).toEqual([{ query: "mezonas", impressions: 15, clicks: 2, position: 6 }]);
    expect(bing.calls).toEqual(["GetQueryStats", "GetPageStats"]);
  });

  it("reads Microsoft's dates at their own offset", () => {
    expect(bingDay("/Date(1399100400000-0700)/")).toBe("2014-05-03");
    expect(bingDay("/Date(1762560000000)/")).toBe("2025-11-08");
    expect(bingDay("2026-11-01")).toBeNull();
  });

  it("refuses a bad key or site in our words", async () => {
    const bing = fakeBing([]);
    const c = createBingWebmasterConnector({ fetch: () => bing.fetch });
    const span = planSearchSync(null, NOW);
    await expect(
      c.search.read(ctx({ siteUrl: FAKE_BING.siteUrl, apiKey: "wrong" }, "bing_webmaster"), span),
    ).rejects.toThrow("Bing refused the API key (401)");
    await expect(
      c.search.read(
        ctx({ siteUrl: "https://elsewhere.example/", apiKey: FAKE_BING.apiKey }, "bing_webmaster"),
        span,
      ),
    ).rejects.toThrow(/is the site URL as Bing lists it/);
    await expect(
      c.search.read(ctx({ siteUrl: "mezonas", apiKey: FAKE_BING.apiKey }, "bing_webmaster"), span),
    ).rejects.toThrow(/isn't one Bing names/);
  });
});
