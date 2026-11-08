// Migration 0037 and measuring a site end to end on a throwaway database: the tables match the
// pack's schema and force RLS; a beacon from the site's own pages is stored, anything else is
// dropped or counted; the nightly build makes visits and totals, as the Worker's role; retention
// deletes what it should; and one client never sees or writes another's figures (invariant 1).

import { appUser, type Db, tenant, tenantPack, withTenant } from "@countersign/db";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from "@countersign/db/testing";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { overview } from "../reports";
import * as schema from "../schema";
import { MARKETING_TABLES, site, siteDailyTotal, siteEvent, siteSalt, siteVisit } from "../schema";
import { addSite, updateSite } from "../sites";
import { type CollectRequest, collect } from "./collect";
import { buildDay, nightly, sweep } from "./rollup";

const online = await databaseAvailable();
const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const VIEW = "3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b";
const VIEW2 = "4f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1c";
const DAY = "2026-11-05";
const AT = new Date(`${DAY}T14:20:00Z`);

async function client(db: Db, name: string) {
  const [t] = await db.insert(tenant).values({ name }).returning();
  const [u] = await db
    .insert(appUser)
    .values({ email: `${name.toLowerCase().replace(/\W/g, "")}-${Date.now()}@example.com`, name })
    .returning();
  if (!t || !u) throw new Error("no client");
  await db.insert(tenantPack).values({ tenantId: t.id, pack: "marketing", version: "0.1.0" });
  return { tenantId: t.id, userId: u.id };
}

const beacon = (events: unknown[]) => JSON.stringify({ events });

describe.skipIf(!online)("measuring a site (migration 0037)", () => {
  let t: TestDatabase;
  let A: { tenantId: string; userId: string; siteId: string };
  let B: { tenantId: string; userId: string; siteId: string };

  const request = (over: Partial<CollectRequest> = {}): CollectRequest => ({
    tenantId: A.tenantId,
    siteId: A.siteId,
    body: beacon([
      { k: "view", id: VIEW, p: "/", r: "https://www.google.com/", q: "?utm_source=x&gclid=1" },
    ]),
    ip: "203.0.113.7",
    userAgent: UA,
    origin: "https://www.mezonas.com",
    acceptLanguage: "en-US,en;q=0.9",
    optedOut: false,
    cf: { country: "US", region: "Texas", city: "Dallas", timezone: "America/Chicago" },
    now: AT,
    ...over,
  });

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const a = await client(t.db, "Mezonas");
    const b = await client(t.db, "Other client");
    const sa = await addSite(t.db, {
      ...a,
      input: { domain: "https://www.Mezonas.com/", name: "mezonas.com", goals: ["hero-talk"] },
    });
    const sb = await addSite(t.db, {
      ...b,
      input: { domain: "other.example.com", name: "Other", goals: [] },
    });
    A = { ...a, siteId: sa.id };
    B = { ...b, siteId: sb.id };
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("match the pack's Drizzle schema, are the pack's, and force RLS", async () => {
    const cols = await t.db.$client<
      { table_name: string; column_name: string; is_nullable: string }[]
    >`
      select table_name, column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name in ${t.db.$client([...MARKETING_TABLES])}`;
    const actual = new Map(cols.map((c) => [`${c.table_name}.${c.column_name}`, c.is_nullable]));
    const expected = new Set<string>();
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const key = `${config.name}.${column.name}`;
        expected.add(key);
        expect(actual.get(key), key).toBe(column.notNull ? "NO" : "YES");
      }
    }
    expect([...actual.keys()].filter((k) => !expected.has(k))).toEqual([]);
    expect(tables.map((x) => getTableConfig(x).name).sort()).toEqual([...MARKETING_TABLES].sort());
    const rows = await t.db.$client<{ relname: string; forced: boolean; owner: string }[]>`
      select c.relname, c.relforcerowsecurity as forced, obj_description(c.oid, 'pg_class') as owner
      from pg_class c where c.relname in ${t.db.$client([...MARKETING_TABLES])}`;
    expect(rows).toHaveLength(MARKETING_TABLES.length);
    for (const r of rows)
      expect([r.relname, r.forced, r.owner]).toEqual([r.relname, true, "pack:marketing"]);
  });

  it("keeps a site's domain without www, once per client", async () => {
    const [row] = await t.db.select().from(site).where(sql`${site.id} = ${A.siteId}`);
    expect(row?.domain).toBe("mezonas.com");
    await expect(
      addSite(t.db, { ...A, input: { domain: "mezonas.com", name: "Again", goals: [] } }),
    ).rejects.toMatchObject({ code: "site_exists" });
    await expect(
      addSite(t.db, { ...A, input: { domain: "not a domain", name: "x", goals: [] } }),
    ).rejects.toMatchObject({ code: "invalid_domain" });
  });

  it("stores a view from the site's own page with its source and place, and no address", async () => {
    expect(await collect(t.db, request())).toEqual({ outcome: "stored", events: 1 });
    const [e] = await t.db.select().from(siteEvent).where(sql`${siteEvent.siteId} = ${A.siteId}`);
    expect(e).toMatchObject({
      tenantId: A.tenantId,
      kind: "view",
      path: "/",
      sourceGroup: "campaign",
      utmSource: "x",
      referrerHost: "google.com",
      country: "US",
      city: "Dallas",
      device: "desktop",
      browser: "Chrome",
      language: "en-US",
    });
    expect(e?.visit).toMatch(/^[0-9a-f]{32}$/);
    // Nothing of the address or the user agent is anywhere in the row.
    expect(JSON.stringify(e)).not.toContain("203.0.113.7");
    expect(JSON.stringify(e)).not.toContain("Macintosh");
  });

  it("drops what isn't the site's or a person's, and counts what it drops", async () => {
    expect(await collect(t.db, request({ origin: "https://evil.example" }))).toEqual({
      outcome: "wrong_origin",
    });
    expect(await collect(t.db, request({ origin: null }))).toEqual({ outcome: "wrong_origin" });
    expect(await collect(t.db, request({ siteId: B.siteId }))).toEqual({
      outcome: "unknown_site",
    });
    expect(await collect(t.db, request({ optedOut: true }))).toEqual({ outcome: "opted_out" });
    expect(await collect(t.db, request({ userAgent: "curl/8.7.1" }))).toEqual({
      outcome: "dropped",
      reason: "user_agent",
    });
    expect(await collect(t.db, request({ body: "{" }))).toEqual({
      outcome: "dropped",
      reason: "malformed",
    });
    expect(
      await collect(t.db, request({ body: beacon([{ k: "view", id: VIEW, p: "/", wd: true }]) })),
    ).toEqual({ outcome: "dropped", reason: "webdriver" });
    const bots = await t.db.$client<{ reason: string; requests: number }[]>`
      select reason, requests from site_bot_daily where site_id = ${A.siteId} order by reason`;
    expect(bots).toEqual([
      { reason: "malformed", requests: 1 },
      { reason: "user_agent", requests: 1 },
      { reason: "webdriver", requests: 1 },
    ]);
  });

  it("a site switched off takes nothing", async () => {
    await updateSite(t.db, { tenantId: A.tenantId, input: { siteId: A.siteId, status: "off" } });
    expect(await collect(t.db, request())).toEqual({ outcome: "unknown_site" });
    await updateSite(t.db, { tenantId: A.tenantId, input: { siteId: A.siteId, status: "on" } });
  });

  it("builds a day's visits and totals as the Worker's role, with the goal and times to the hour", async () => {
    await collect(
      t.db,
      request({
        body: beacon([
          { k: "engage", id: VIEW, p: "/", ms: 42_000, s: 3 },
          { k: "view", id: VIEW2, p: "/privacy" },
          { k: "click", id: VIEW2, p: "/privacy", n: "hero-talk", y: 10 },
        ]),
        now: new Date(`${DAY}T14:35:00Z`),
      }),
    );
    // Another visitor: one page, nothing else, a bounce.
    await collect(
      t.db,
      request({ ip: "198.51.100.2", body: beacon([{ k: "view", id: VIEW2, p: "/terms" }]) }),
    );

    const visits = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return buildDay(tx, { tenantId: A.tenantId, siteId: A.siteId, day: DAY });
    });
    expect(visits).toBe(2);
    const rows = await t.db.select().from(siteVisit).where(sql`${siteVisit.siteId} = ${A.siteId}`);
    const reader = rows.find((r) => r.views === 2);
    expect(reader).toMatchObject({
      entryPath: "/",
      exitPath: "/privacy",
      pages: ["/", "/privacy"],
      reachedGoal: true,
      goal: "hero-talk",
      bounced: false,
      engagedMs: 42_000,
    });
    expect(reader?.startedAt.toISOString()).toBe(`${DAY}T14:00:00.000Z`);
    expect(rows.find((r) => r.views === 1)).toMatchObject({ bounced: true, reachedGoal: false });

    const [all] = await t.db
      .select()
      .from(siteDailyTotal)
      .where(sql`${siteDailyTotal.siteId} = ${A.siteId} and ${siteDailyTotal.dimension} = 'all'`);
    expect(all).toMatchObject({ visits: 2, views: 3, goals: 1, bounces: 1 });

    // Twice gives the same rows.
    await withTenant(t.db, A.tenantId, (tx) =>
      buildDay(tx, { tenantId: A.tenantId, siteId: A.siteId, day: DAY }),
    );
    expect(
      await t.db.select().from(siteVisit).where(sql`${siteVisit.siteId} = ${A.siteId}`),
    ).toHaveLength(2);
  });

  it("answers the overview from the totals, small samples marked", async () => {
    const o = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return overview(tx, A.tenantId, "2026-11-08");
    });
    expect(o.totals).toMatchObject({ visits: 2, goals: 1, goalRate: "0.5000", smallSample: true });
    expect(o.pages[0]).toMatchObject({ path: "/" });
    expect(o.sites.map((s) => s.domain)).toEqual(["mezonas.com"]);
    expect(o.filtered).toBe(3);
  });

  it("keeps one client's figures from another, as the Worker's role", async () => {
    const seen = await withTenant(t.db, B.tenantId, async (tx) => {
      await asWorker(tx);
      return {
        sites: (await tx.select().from(site)).map((s) => s.tenantId),
        events: (await tx.select().from(siteEvent)).length,
        visits: (await tx.select().from(siteVisit)).length,
      };
    });
    expect(seen).toEqual({ sites: [B.tenantId], events: 0, visits: 0 });
    const write = withTenant(t.db, B.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.insert(siteSalt).values({
        tenantId: A.tenantId,
        siteId: A.siteId,
        day: "2026-11-06",
        salt: "a".repeat(64),
      });
    });
    await expect(write).rejects.toThrow();
  });

  it("runs nightly over every client with the pack on, then deletes past retention", async () => {
    const result = await nightly(t.db, new Date("2026-11-07T03:41:00Z"));
    expect(result.clients).toBe(2);
    expect(result.built.filter((b) => b.siteId === A.siteId).map((b) => b.day)).toEqual([DAY]);
    // Today's salt is gone once its day is over.
    expect(result.swept.salts).toBeGreaterThan(0);
    expect(await t.db.select().from(siteSalt)).toEqual([]);

    // 91 days later the events go; the visits stay 13 months.
    const later = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return sweep(tx, A.tenantId, "2027-02-04");
    });
    expect(later.events).toBeGreaterThan(0);
    expect(later.visits).toBe(0);
    const much = await withTenant(t.db, A.tenantId, (tx) => sweep(tx, A.tenantId, "2027-12-06"));
    expect(much.visits).toBe(2);
  });
});
