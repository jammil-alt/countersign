// The read reports (M44, docs/plan.md §1.74) on a throwaway database, as the Worker's role: the
// Sandbox's sample traffic through the real nightly build, then each report's figures checked
// against each other and against a small day built by hand; small samples, unbuilt days and today
// marked; queries that don't parse refused; one client never sees another's figures.

import { type Db, tenant, withTenant } from "@countersign/db";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fillSampleTraffic, SAMPLE_DAYS, sampleTraffic } from "../demo";
import { MARKETING_REPORTS } from "../manifest";
import { PackRefusal } from "../pack";
import { overview } from "../reports";
import { siteEvent } from "../schema";
import { sitesReport } from "../sites";
import { insertMarketingClient, type MarketingClient } from "../testing.test-helper";
import { audienceReport } from "./audience";
import { journeysReport } from "./journeys";
import { PageQuery, pageReport, pagesReport } from "./pages";
import { halfReadTo, medianBand, PeriodQuery, resolveRange, toCsv } from "./range";
import { buildDay } from "./rollup";
import { sourcesReport } from "./sources";
import { VisitQuery, VisitsQuery, visitReport, visitsReport } from "./visits";

const online = await databaseAvailable();
const NOW = new Date("2026-11-08T12:00:00Z");
const TODAY = "2026-11-08";

describe("report helpers", () => {
  it("reads the median as a band, and how far half the readers got", () => {
    expect(medianBand([0, 0, 0, 0, 0, 0])).toBeNull();
    expect(medianBand([1, 1, 5, 0, 0, 0])).toEqual({ band: 2, fromSeconds: 30, toSeconds: 60 });
    expect(medianBand([0, 0, 0, 0, 0, 3])).toEqual({ band: 5, fromSeconds: 240, toSeconds: null });
    expect(halfReadTo(10, [9, 6, 5, 1])).toBe(3);
    expect(halfReadTo(10, [4, 0, 0, 0])).toBe(0);
    expect(halfReadTo(0, [0, 0, 0, 0])).toBe(0);
  });

  it("writes CSV that a spreadsheet won't run", () => {
    expect(
      toCsv([
        ["a", "b"],
        ["=SUM(A1)", 'say "hi", then'],
        [null, 3],
      ]),
    ).toBe(`a,b\n'=SUM(A1),"say ""hi"", then"\n,3\n`);
  });

  it("takes 7, 28 or 90 days and refuses anything else", () => {
    expect(PeriodQuery.safeParse({ period: "7" }).success).toBe(true);
    expect(PeriodQuery.safeParse({ period: "14" }).success).toBe(false);
    expect(PeriodQuery.safeParse({ from: "2026-11-05", to: "2026-11-01" }).success).toBe(false);
    expect(PeriodQuery.safeParse({ client: "x" }).success).toBe(false);
    expect(PageQuery.safeParse({}).success).toBe(false);
    expect(PageQuery.safeParse({ path: "/how-it-works" }).success).toBe(true);
    expect(VisitsQuery.safeParse({ source: "nowhere" }).success).toBe(false);
    expect(
      VisitsQuery.safeParse({ source: "referral/news.ycombinator.com", goal: "yes" }).success,
    ).toBe(true);
    expect(VisitQuery.safeParse({ day: TODAY, visit: "nothex" }).success).toBe(false);
  });

  it("makes the same sample every time, each event on its own day", () => {
    const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
    const a = sampleTraffic(days, "sample.example.com");
    const b = sampleTraffic(days, "sample.example.com");
    expect(a).toEqual(b);
    expect(a.visits).toBeGreaterThan(100);
    for (const e of a.events) expect(e.at.slice(0, 10)).toBe(e.day);
    expect(new Set(a.events.map((e) => e.kind))).toEqual(
      new Set(["view", "engage", "click", "form_seen"]),
    );
  });

  it("registers every read report with its query", () => {
    for (const name of [
      "overview",
      "pages",
      "page",
      "sources",
      "journeys",
      "audience",
      "visits",
      "visit",
    ]) {
      expect(MARKETING_REPORTS[name]?.query, name).toBeDefined();
    }
    expect(MARKETING_REPORTS.sites?.query).toBeUndefined();
  });
});

describe.skipIf(!online)("the read reports (M44)", () => {
  let t: TestDatabase;
  let S: MarketingClient;
  let B: MarketingClient;
  let sampleSite: string;

  const as = <T>(
    client: MarketingClient,
    fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>,
  ) =>
    withTenant(t.db, client.tenantId, async (tx) => {
      await asWorker(tx);
      return fn(tx);
    });

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    S = await insertMarketingClient(t.db, "Sandbox", "sandbox.example.com");
    await t.db
      .update(tenant)
      .set({ settings: { sandbox: true }, timezone: "America/Chicago" })
      .where(eq(tenant.id, S.tenantId));
    B = await insertMarketingClient(t.db, "Other client", "other.example.com");
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("refuses sample traffic for any client but the Sandbox", async () => {
    const other = fillSampleTraffic(t.db as Db, {
      tenantId: B.tenantId,
      userId: B.userId,
      now: NOW,
    });
    await expect(other).rejects.toBeInstanceOf(PackRefusal);
    await expect(other).rejects.toMatchObject({ code: "not_sandbox" });
    const unknown = fillSampleTraffic(t.db, {
      tenantId: S.tenantId,
      userId: S.userId,
      siteId: B.siteId,
      now: NOW,
    });
    await expect(unknown).rejects.toMatchObject({ code: "unknown_site" });
  });

  it("fills the Sandbox's last 28 days, the same again when run twice", async () => {
    const first = await fillSampleTraffic(t.db, {
      tenantId: S.tenantId,
      userId: S.userId,
      now: NOW,
    });
    const again = await fillSampleTraffic(t.db, {
      tenantId: S.tenantId,
      userId: S.userId,
      now: NOW,
    });
    expect(again).toEqual(first);
    expect(first.siteId).toBe(S.siteId);
    expect(first.days).toBe(SAMPLE_DAYS);
    expect(first.visits).toBeGreaterThan(SAMPLE_DAYS * 30);
    sampleSite = first.siteId;
  });

  it("gives the overview for the period, with every day and the one before", async () => {
    const o = await as(S, (tx) => overview(tx, S.tenantId, TODAY, {}));
    expect(o.range).toMatchObject({
      from: "2026-10-11",
      to: "2026-11-07",
      days: 28,
      period: 28,
      includesToday: false,
      dataThrough: "2026-11-07",
    });
    expect(o.daily).toHaveLength(28);
    expect(o.daily.every((d) => d.built)).toBe(true);
    expect(o.daily.reduce((a, d) => a + d.visits, 0)).toBe(o.totals.visits);
    expect(o.totals.smallSample).toBe(false);
    expect(o.totals.medianEngaged).not.toBeNull();
    expect(o.previousTotals.visits).toBe(0);
    expect(o.site?.id).toBe(sampleSite);
    expect(o.filtered).toBeGreaterThan(0);

    const week = await as(S, (tx) => overview(tx, S.tenantId, TODAY, { period: "7" }));
    expect([week.range.from, week.range.to, week.daily.length]).toEqual([
      "2026-11-01",
      "2026-11-07",
      7,
    ]);
    expect(week.previousTotals.visits).toBeGreaterThan(0);
    // A range reaching today says so, and today isn't built.
    const now = await as(S, (tx) =>
      overview(tx, S.tenantId, TODAY, { from: "2026-11-06", to: TODAY }),
    );
    expect(now.range.includesToday).toBe(true);
    expect(now.daily.map((d) => d.built)).toEqual([true, true, false]);
  });

  it("adds up pages, one page's readers, and its clicks", async () => {
    const o = await as(S, (tx) => overview(tx, S.tenantId, TODAY, {}));
    const p = await as(S, (tx) => pagesReport(tx, S.tenantId, TODAY, {}));
    expect(p.pages.reduce((a, r) => a + r.entries, 0)).toBe(o.totals.visits);
    expect(p.pages.reduce((a, r) => a + r.exits, 0)).toBe(o.totals.visits);
    expect(p.pages.reduce((a, r) => a + r.views, 0)).toBe(o.totals.views);
    const home = p.pages.find((r) => r.path === "/");
    expect(home?.medianEngaged).not.toBeNull();
    expect(home?.halfReadTo).toBeGreaterThanOrEqual(0);
    expect(Number(home?.exitRate)).toBeGreaterThan(0);

    const how = await as(S, (tx) => pageReport(tx, S.tenantId, TODAY, { path: "/how-it-works" }));
    expect(how.page?.views).toBe(p.pages.find((r) => r.path === "/how-it-works")?.views);
    expect(how.reach).toHaveLength(4);
    expect(how.engaged.reduce((a, n) => a + n, 0)).toBe(how.page?.views);
    expect(
      how.cameFrom.some((f) => f.kind === "source" && f.key === "referral/news.ycombinator.com"),
    ).toBe(true);
    expect(how.wentNext.some((f) => f.kind === "left")).toBe(true);
    expect(how.clicks.length).toBeGreaterThan(0);
    const none = await as(S, (tx) => pageReport(tx, S.tenantId, TODAY, { path: "/nowhere" }));
    expect([none.page, none.cameFrom]).toEqual([null, []]);
  });

  it("groups sources, opens a campaign by its links, and a referrer in depth", async () => {
    const o = await as(S, (tx) => overview(tx, S.tenantId, TODAY, {}));
    const s = await as(S, (tx) =>
      sourcesReport(tx, S.tenantId, TODAY, {
        campaign: "newsletter-nov",
        referrer: "news.ycombinator.com",
      }),
    );
    expect(s.groups.reduce((a, g) => a + g.visits, 0)).toBe(o.totals.visits);
    const referral = s.groups.find((g) => g.group === "referral");
    expect(referral?.names.map((n) => n.name)).toContain("news.ycombinator.com");
    expect(s.campaign?.links.map((l) => l.content).sort()).toEqual(["body", "footer", "lead"]);
    expect(s.campaign?.utmMedium).toBe("email");
    expect(s.referrer?.visits).toBe(
      referral?.names.find((n) => n.name === "news.ycombinator.com")?.visits,
    );
    expect(s.referrer?.landedOn[0]?.path).toBe("/how-it-works");
    expect(s.referrer?.addresses[0]?.path).toBe("/item");
    const only = await as(S, (tx) => sourcesReport(tx, S.tenantId, TODAY, { group: "search" }));
    expect(only.groups.map((g) => g.group)).toEqual(["search"]);
  });

  it("follows journeys to the goal and the funnel by entry page", async () => {
    const o = await as(S, (tx) => overview(tx, S.tenantId, TODAY, {}));
    const j = await as(S, (tx) => journeysReport(tx, S.tenantId, TODAY, {}));
    expect(j.visits).toBe(o.totals.visits);
    expect(j.paths.length).toBeLessThanOrEqual(12);
    expect(j.paths.reduce((a, p) => a + p.visits, 0) + j.other.visits).toBe(o.totals.visits);
    expect(j.best?.goals).toBeGreaterThan(0);
    expect(j.funnel.reduce((a, f) => a + f.landed, 0)).toBe(o.totals.visits);
    expect(j.funnel.reduce((a, f) => a + f.goals, 0)).toBe(o.totals.goals);
    for (const f of j.funnel) expect(f.sawForm).toBeGreaterThanOrEqual(f.goals);
    expect(j.lastPage.reduce((a, l) => a + l.visits, 0)).toBe(o.totals.goals);
  });

  it("places the audience, by the client's hours, and opens a country into regions and cities", async () => {
    const o = await as(S, (tx) => overview(tx, S.tenantId, TODAY, {}));
    const a = await as(S, (tx) => audienceReport(tx, S.tenantId, TODAY, {}));
    expect(a.timeZone).toBe("America/Chicago");
    expect(a.level).toBe("country");
    expect(a.heatmap.flat().reduce((x, n) => x + n, 0)).toBe(o.totals.visits);
    expect(a.places.reduce((x, p) => x + p.visits, 0)).toBe(o.totals.visits);
    expect(a.device.map((d) => d.key)).toContain("phone");
    expect(a.language.length).toBeGreaterThan(1);
    const us = await as(S, (tx) => audienceReport(tx, S.tenantId, TODAY, { country: "US" }));
    expect(us.level).toBe("region");
    expect(us.places.map((p) => p.key)).toContain("Texas");
    const texas = await as(S, (tx) =>
      audienceReport(tx, S.tenantId, TODAY, { country: "US", region: "Texas" }),
    );
    expect(texas.places.map((p) => p.key).sort()).toEqual(["Austin", "Dallas"]);
  });

  it("lists visits by filter and page, and shows one visit's steps without a time", async () => {
    const o = await as(S, (tx) => overview(tx, S.tenantId, TODAY, {}));
    const all = await as(S, (tx) => visitsReport(tx, S.tenantId, TODAY, {}));
    expect(all.total).toBe(o.totals.visits);
    expect(all.visits).toHaveLength(50);
    expect(all.visits[0]?.day).toBe("2026-11-07");
    const second = await as(S, (tx) => visitsReport(tx, S.tenantId, TODAY, { page: "2" }));
    expect(second.visits[0]?.visit).not.toBe(all.visits[0]?.visit);
    const goals = await as(S, (tx) => visitsReport(tx, S.tenantId, TODAY, { goal: "yes" }));
    expect(goals.total).toBe(o.totals.goals);
    expect(goals.visits.every((v) => v.reachedGoal && v.goal)).toBe(true);
    const hn = await as(S, (tx) =>
      visitsReport(tx, S.tenantId, TODAY, {
        source: "referral/news.ycombinator.com",
        entry: "/how-it-works",
        path: "/how-it-works",
        country: "US",
        day: "2026-11-04",
      }),
    );
    expect(hn.total).toBeGreaterThan(0);
    expect(hn.visits.every((v) => v.day === "2026-11-04" && v.country === "US")).toBe(true);

    const pick = all.visits.find((v) => v.views > 1) ?? all.visits[0];
    if (!pick) throw new Error("no visit");
    const one = await as(S, (tx) =>
      visitReport(tx, S.tenantId, TODAY, { day: pick.day, visit: pick.visit }),
    );
    expect(one.visit?.visit).toBe(pick.visit);
    expect(one.steps?.filter((s) => s.kind === "view").length).toBe(pick.views);
    const text = JSON.stringify({ visit: one.visit, steps: one.steps });
    expect(text).not.toMatch(/\d{2}:\d{2}/);
    expect(text).not.toMatch(/"(at|startedAt|endedAt|started_at|ended_at)"/);
    const missing = await as(S, (tx) =>
      visitReport(tx, S.tenantId, TODAY, { day: pick.day, visit: "0".repeat(32) }),
    );
    expect(missing.visit).toBeNull();
  });

  it("lists the client's sites and whether figures are coming in", async () => {
    const r = await as(S, (tx) => sitesReport(tx, S.tenantId, TODAY));
    expect(r.sites).toHaveLength(1);
    expect(r.sites[0]).toMatchObject({ dataThrough: "2026-11-07", lastEventDay: "2026-11-07" });
    expect(r.sites[0]?.visitsLast7).toBeGreaterThan(0);
  });

  it("marks a small day built by hand, figure by figure", async () => {
    const day = "2026-11-06";
    const view = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const base = { tenantId: B.tenantId, siteId: B.siteId, day, path: "/" };
    const at = (m: number) => new Date(`${day}T15:${String(m).padStart(2, "0")}:00Z`);
    await t.db.insert(siteEvent).values([
      {
        ...base,
        at: at(1),
        visit: "a".repeat(32),
        viewId: view(1),
        kind: "view",
        sourceGroup: "direct",
        device: "desktop",
      },
      {
        ...base,
        at: at(2),
        visit: "a".repeat(32),
        viewId: view(1),
        kind: "engage",
        engagedMs: 45_000,
        scroll: 4,
      },
      {
        ...base,
        at: at(3),
        visit: "b".repeat(32),
        viewId: view(2),
        kind: "view",
        sourceGroup: "search",
        sourceName: "google",
        device: "phone",
      },
      {
        ...base,
        at: at(4),
        visit: "b".repeat(32),
        viewId: view(2),
        kind: "engage",
        engagedMs: 5_000,
        scroll: 1,
      },
      {
        ...base,
        at: at(5),
        visit: "c".repeat(32),
        viewId: view(3),
        kind: "view",
        sourceGroup: "direct",
        device: "desktop",
      },
      {
        ...base,
        at: at(6),
        visit: "c".repeat(32),
        viewId: view(3),
        kind: "engage",
        engagedMs: 50_000,
        scroll: 2,
      },
    ]);
    await withTenant(t.db, B.tenantId, (tx) =>
      buildDay(tx, { tenantId: B.tenantId, siteId: B.siteId, day }),
    );
    const p = await as(B, (tx) => pagesReport(tx, B.tenantId, TODAY, { period: "7" }));
    expect(p.pages).toEqual([
      {
        path: "/",
        views: 3,
        entries: 3,
        exits: 3,
        exitRate: "1.0000",
        goals: 0,
        formSeen: 0,
        medianEngaged: { band: 2, fromSeconds: 30, toSeconds: 60 },
        halfReadTo: 2,
        smallSample: true,
      },
    ]);
    const o = await as(B, (tx) => overview(tx, B.tenantId, TODAY, { period: "7" }));
    expect(o.totals).toMatchObject({
      visits: 3,
      bounces: 1,
      bounceRate: "0.3333",
      smallSample: true,
    });
    expect(o.range.dataThrough).toBe(day);
    expect(o.daily.filter((d) => d.built).map((d) => d.day)).toEqual([day]);
  });

  it("never shows one client another's figures", async () => {
    // The Sandbox's site asked for by another client is no site at all.
    const o = await as(B, (tx) => overview(tx, B.tenantId, TODAY, { site: sampleSite }));
    expect([o.site, o.totals.visits, o.sites.map((s) => s.id)]).toEqual([null, 0, [B.siteId]]);
    const v = await as(B, (tx) => visitsReport(tx, B.tenantId, TODAY, { site: sampleSite }));
    expect(v.total).toBe(0);
    const r = await as(B, (tx) => resolveRange(tx, B.tenantId, TODAY, { site: sampleSite }));
    expect(r.dataThrough).toBeNull();
    // And with a client's own site id but the other's tenant, RLS shows nothing.
    const crossed = await as(B, (tx) => pagesReport(tx, S.tenantId, TODAY, {}));
    expect(crossed.pages).toEqual([]);
  });
});
