// Two weeks of figures for one site, for the agent set's tests: the last 7 finished days at 15
// visits a day (105) against 10 a day (70) the week before, two pages, a goal a day this week,
// and Google search figures through yesterday (/pricing seen 40 times a day, clicked once).
// Written through the superuser connection, which bypasses RLS.

import type { Db } from "@countersign/db";
import {
  ENGAGED_BANDS,
  searchPageDaily,
  searchQueryDaily,
  searchSource,
  siteDailyPage,
  siteDailyTotal,
} from "../schema";

export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number, now = new Date()) =>
  dayOf(new Date(Date.parse(`${dayOf(now)}T00:00:00Z`) - n * 86_400_000));

const bands = (n: number) => Array.from({ length: ENGAGED_BANDS }, (_, i) => (i === 2 ? n : 0));

export async function seedTwoWeeks(
  db: Db,
  c: { tenantId: string; siteId: string },
): Promise<{ searchSourceId: string }> {
  for (let ago = 1; ago <= 14; ago++) {
    const day = daysAgo(ago);
    const thisWeek = ago <= 7;
    const visits = thisWeek ? 15 : 10;
    const goals = thisWeek ? 1 : 0;
    await db.insert(siteDailyTotal).values({
      tenantId: c.tenantId,
      siteId: c.siteId,
      day,
      dimension: "all",
      key: "",
      visits,
      views: visits * 2,
      goals,
      bounces: 5,
      engagedMs: visits * 40_000,
      engagedBands: bands(visits),
    });
    await db.insert(siteDailyTotal).values({
      tenantId: c.tenantId,
      siteId: c.siteId,
      day,
      dimension: "source",
      key: "search/google",
      visits,
      views: visits * 2,
      goals,
      bounces: 5,
      engagedMs: visits * 40_000,
      engagedBands: bands(visits),
    });
    for (const [path, views] of [
      ["/", visits],
      ["/pricing", visits],
    ] as const) {
      await db.insert(siteDailyPage).values({
        tenantId: c.tenantId,
        siteId: c.siteId,
        day,
        path,
        views,
        entries: path === "/" ? visits : 0,
        exits: 3,
        goals: path === "/" ? goals : 0,
        formSeen: 0,
        engagedMs: views * 40_000,
        engagedBands: bands(views),
        scrollReached: [views, views, 2, 1],
      });
    }
    await db.insert(searchPageDaily).values({
      tenantId: c.tenantId,
      siteId: c.siteId,
      provider: "google",
      day,
      path: "/pricing",
      impressions: 40,
      clicks: 1,
      position: "9.00",
    });
    await db.insert(searchQueryDaily).values({
      tenantId: c.tenantId,
      siteId: c.siteId,
      provider: "google",
      day,
      query: "approval workflow pricing",
      path: "/pricing",
      impressions: 40,
      clicks: 1,
      position: "9.00",
    });
  }
  const [s] = await db
    .insert(searchSource)
    .values({
      tenantId: c.tenantId,
      siteId: c.siteId,
      provider: "google",
      dataRunsTo: daysAgo(1),
      lastImportedAt: new Date(),
    })
    .returning({ id: searchSource.id });
  if (!s) throw new Error("no search source");
  return { searchSourceId: s.id };
}
