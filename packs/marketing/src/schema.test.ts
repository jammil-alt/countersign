// Migrations 0037 and 0038 as the pack sees them: every one of its tables matches this pack's
// Drizzle schema, is marked as the pack's, forces row-level security and gives the runtime only
// the privileges named here; history is kept by triggers (invariant 3); and one client never
// reads or writes another's rows, nor points a row at another's (invariant 1).

import { type Tx, withTenant, withTenants } from "@countersign/db";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from "@countersign/db/testing";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";
import {
  claimsVersion,
  contentPage,
  contentPublish,
  contentRedirect,
  contentVersion,
  forumReply,
  forumThread,
  MARKETING_IMMUTABLE,
  MARKETING_TABLES,
  type MarketingTable,
  marketingReport,
  marketingReportAction,
  searchPageDaily,
  searchQueryDaily,
  searchSource,
  siteBotDaily,
  siteDailyClick,
  siteDailyPage,
  siteDailyTotal,
  siteEvent,
  siteSalt,
  siteVisit,
} from "./schema";
import { insertMarketingClient, type MarketingClient } from "./testing.test-helper";

const online = await databaseAvailable();
const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

/** What the runtime may do to each table, besides SELECT and INSERT (which it has on all). */
const RUNTIME: Record<MarketingTable, { update: boolean; delete: boolean }> = {
  site: { update: true, delete: false },
  site_salt: { update: false, delete: true },
  site_event: { update: false, delete: true },
  site_visit: { update: false, delete: true },
  site_daily_page: { update: false, delete: true },
  site_daily_click: { update: false, delete: true },
  site_daily_total: { update: false, delete: true },
  site_bot_daily: { update: true, delete: true },
  search_source: { update: true, delete: false },
  search_query_daily: { update: false, delete: true },
  search_page_daily: { update: false, delete: true },
  content_page: { update: true, delete: false },
  content_version: { update: false, delete: false },
  content_publish: { update: false, delete: false },
  content_redirect: { update: true, delete: false },
  claims_version: { update: false, delete: false },
  marketing_report: { update: true, delete: false },
  marketing_report_action: { update: true, delete: false },
  forum_thread: { update: true, delete: false },
  forum_reply: { update: true, delete: false },
};

/** A change to a column the trigger keeps fixed, per immutable table. */
const FIXED_CHANGE: Partial<Record<MarketingTable, string>> = {
  content_page: "path = path || '-moved'",
  content_version: "title = title || ' again'",
  content_publish: "action = 'unpublish'",
  claims_version: "version = version + 100",
  marketing_report: "period_to = period_to + 1",
  marketing_report_action: "text = text || ' again'",
  forum_reply: "body = body || ' again'",
};

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

async function tenantIdsIn(tx: Tx, table: string): Promise<string[]> {
  const rows = await tx.execute<{ t: string }>(
    sql.raw(`select tenant_id::text as t from ${table}`),
  );
  return [...rows].map((r) => r.t);
}

describe.skipIf(!online)("marketing tables (migrations 0037, 0038)", () => {
  let t: TestDatabase;
  let A: MarketingClient;
  let B: MarketingClient;
  const ids = new Map<string, { pageId: string; versionId: string; threadId: string }>();

  /** One row of the client in each of the pack's tables. */
  async function seed(c: MarketingClient) {
    const db = t.db;
    const day = "2026-11-05";
    const base = { tenantId: c.tenantId, siteId: c.siteId, day };
    await db.insert(siteSalt).values({ ...base, salt: "a".repeat(64) });
    const visit = "b".repeat(32);
    await db.insert(siteEvent).values({
      ...base,
      at: new Date(`${day}T10:00:00Z`),
      visit,
      viewId: "3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b",
      kind: "view",
      path: "/",
      sourceGroup: "direct",
      device: "desktop",
    });
    await db.insert(siteVisit).values({
      ...base,
      visit,
      startedAt: new Date(`${day}T10:00:00Z`),
      endedAt: new Date(`${day}T10:00:00Z`),
      entryPath: "/",
      exitPath: "/",
      pages: ["/"],
      views: 1,
      clicks: 0,
      engagedMs: 0,
      sourceGroup: "direct",
      device: "desktop",
      sawForm: false,
      reachedGoal: false,
      bounced: true,
    });
    const bands = [1, 0, 0, 0, 0, 0];
    await db.insert(siteDailyPage).values({
      ...base,
      path: "/",
      views: 1,
      entries: 1,
      exits: 1,
      goals: 0,
      formSeen: 0,
      engagedMs: 0,
      engagedBands: bands,
      scrollReached: [0, 0, 0, 0],
    });
    await db
      .insert(siteDailyClick)
      .values({ ...base, path: "/", target: "hero-talk", clicks: 1, position: 10 });
    await db.insert(siteDailyTotal).values({
      ...base,
      dimension: "all",
      key: "",
      visits: 1,
      views: 1,
      goals: 0,
      bounces: 1,
      engagedMs: 0,
      engagedBands: bands,
    });
    await db.insert(siteBotDaily).values({ ...base, reason: "user_agent", requests: 1 });
    await db.insert(searchSource).values({
      tenantId: c.tenantId,
      siteId: c.siteId,
      provider: "google",
      connectionId: c.connectionId,
      dataRunsTo: day,
    });
    const search = { ...base, provider: "google" as const, impressions: 10, clicks: 1 };
    await db
      .insert(searchQueryDaily)
      .values({ ...search, query: "back office agents", path: "/", position: "4.50" });
    await db.insert(searchPageDaily).values({ ...search, path: "/", position: "4.50" });
    const [page] = await db
      .insert(contentPage)
      .values({
        tenantId: c.tenantId,
        siteId: c.siteId,
        path: "/guides/approvals",
        createdByUserId: c.userId,
      })
      .returning();
    if (!page) throw new Error("no page");
    const [version] = await db
      .insert(contentVersion)
      .values({
        tenantId: c.tenantId,
        pageId: page.id,
        version: 1,
        title: "Approvals, on by default",
        description: "How approvals work.",
        bodyMd: "# Approvals\n\nOn by default.",
        targetQueries: ["approvals"],
        authorAgentVersionId: c.agentVersionId,
        runId: c.runId,
        why: "Queries about approvals with no page.",
      })
      .returning();
    if (!version) throw new Error("no version");
    await db
      .update(contentPage)
      .set({ status: "published", liveVersionId: version.id })
      .where(sql`${contentPage.id} = ${page.id}`);
    await db.insert(contentPublish).values({
      tenantId: c.tenantId,
      pageId: page.id,
      versionId: version.id,
      action: "publish",
      externalActionId: c.externalActionId,
      byUserId: c.userId,
    });
    await db.insert(contentRedirect).values({
      tenantId: c.tenantId,
      siteId: c.siteId,
      fromPath: "/guides/old",
      toPath: "/guides/approvals",
      createdByUserId: c.userId,
    });
    await db.insert(claimsVersion).values({
      tenantId: c.tenantId,
      version: 1,
      body: { may: ["Approval is on by default."], never: ["HIPAA compliant"] },
      createdByUserId: c.userId,
    });
    const [report] = await db
      .insert(marketingReport)
      .values({
        tenantId: c.tenantId,
        siteId: c.siteId,
        kind: "weekly",
        periodFrom: "2026-11-02",
        periodTo: "2026-11-08",
        body: { summary: "1 visit." },
        sources: [{ kind: "site.figures", from: "2026-11-02", to: "2026-11-08" }],
        agentVersionId: c.agentVersionId,
        runId: c.runId,
      })
      .returning();
    if (!report) throw new Error("no report");
    await db
      .insert(marketingReportAction)
      .values({ tenantId: c.tenantId, reportId: report.id, idx: 0, text: "Write a guide." });
    const [thread] = await db
      .insert(forumThread)
      .values({
        tenantId: c.tenantId,
        source: "hackernews",
        externalId: `hn-${c.tenantId}`,
        url: "https://news.ycombinator.com/item?id=1",
        title: "Ask HN: approvals for agents?",
        outcome: "drafted",
        agentVersionId: c.agentVersionId,
        runId: c.runId,
      })
      .returning();
    if (!thread) throw new Error("no thread");
    await db.insert(forumReply).values({
      tenantId: c.tenantId,
      threadId: thread.id,
      agentVersionId: c.agentVersionId,
      runId: c.runId,
      body: "I work at Mezonas. We keep approval on by default.",
      posterUserId: c.userId,
    });
    ids.set(c.tenantId, { pageId: page.id, versionId: version.id, threadId: thread.id });
  }

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertMarketingClient(t.db, "Mezonas", "mezonas.com");
    B = await insertMarketingClient(t.db, "Other client", "other.example.com");
    await seed(A);
    await seed(B);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("match the pack's Drizzle schema, are the pack's, and force RLS with a policy", async () => {
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
    for (const table of tables) {
      const tenant = getTableConfig(table).columns.find((c) => c.name === "tenant_id");
      expect(tenant?.notNull, getTableConfig(table).name).toBe(true);
    }
    const rows = await t.db.$client<
      { relname: string; forced: boolean; rls: boolean; owner: string; policies: number }[]
    >`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        obj_description(c.oid, 'pg_class') as owner,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c where c.relname in ${t.db.$client([...MARKETING_TABLES])}`;
    expect(rows).toHaveLength(MARKETING_TABLES.length);
    for (const r of rows) {
      expect([r.relname, r.rls, r.forced, r.owner]).toEqual([
        r.relname,
        true,
        true,
        "pack:marketing",
      ]);
      expect(r.policies, r.relname).toBeGreaterThan(0);
    }
  });

  it("give the runtime only what each table needs: no DELETE on history", async () => {
    const can = async (table: string, privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
      )[0]?.ok;
    for (const table of MARKETING_TABLES) {
      expect(await can(table, "SELECT"), `${table} SELECT`).toBe(true);
      expect(await can(table, "INSERT"), `${table} INSERT`).toBe(true);
      expect(await can(table, "UPDATE"), `${table} UPDATE`).toBe(RUNTIME[table].update);
      expect(await can(table, "DELETE"), `${table} DELETE`).toBe(RUNTIME[table].delete);
      expect(await can(table, "TRUNCATE"), `${table} TRUNCATE`).toBe(false);
    }
    for (const table of Object.keys(MARKETING_IMMUTABLE) as MarketingTable[])
      expect(RUNTIME[table].delete, table).toBe(false);
  });

  it("keep history: only the columns named change, and nothing is deleted", async () => {
    const triggers = await t.db.$client<{ table: string }[]>`
      select c.relname as table from pg_trigger g join pg_class c on c.oid = g.tgrelid
      where not g.tgisinternal and c.relname in ${t.db.$client([...MARKETING_TABLES])}`;
    // One immutability trigger per table named, and content_page's live-version check.
    expect(triggers.map((r) => r.table).sort()).toEqual(
      [...Object.keys(MARKETING_IMMUTABLE), "content_page"].sort(),
    );
    expect(Object.keys(FIXED_CHANGE).sort()).toEqual(Object.keys(MARKETING_IMMUTABLE).sort());
    for (const [table, change] of Object.entries(FIXED_CHANGE)) {
      // As the superuser, past grants and RLS: the trigger alone refuses.
      const where = `where tenant_id = '${A.tenantId}'`;
      expect(
        await errorCode(t.db.execute(sql.raw(`update ${table} set ${change} ${where}`))),
        `${table} update`,
      ).toBe("23001");
      expect(
        await errorCode(t.db.execute(sql.raw(`delete from ${table} ${where}`))),
        `${table} delete`,
      ).toBe("23001");
    }
    // What may change, does, as the Worker's role.
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const now = new Date();
      const id = ids.get(A.tenantId);
      if (!id) throw new Error("no ids");
      await tx
        .update(contentPage)
        .set({ status: "unpublished" })
        .where(sql`${contentPage.id} = ${id.pageId}`);
      await tx
        .update(marketingReport)
        .set({ readAt: now, readByUserId: A.userId })
        .where(sql`${marketingReport.tenantId} = ${A.tenantId}`);
      await tx
        .update(marketingReportAction)
        .set({ decision: "done", decidedAt: now, decidedByUserId: A.userId })
        .where(sql`${marketingReportAction.tenantId} = ${A.tenantId}`);
      await tx
        .update(forumReply)
        .set({ status: "posted", decidedAt: now, decidedByUserId: A.userId, postedAt: now })
        .where(sql`${forumReply.tenantId} = ${A.tenantId}`);
    });
  });

  it("a client session sees only its own rows, in every table", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of MARKETING_TABLES) {
        const seen = await tenantIdsIn(tx, table);
        expect(seen.length, table).toBeGreaterThan(0);
        expect(new Set(seen), table).toEqual(new Set([A.tenantId]));
      }
    });
    await withTenants(t.db, [], async (tx) => {
      await asWorker(tx);
      for (const table of MARKETING_TABLES) expect(await tenantIdsIn(tx, table), table).toEqual([]);
    });
  });

  it("a client session cannot write another client's rows", async () => {
    const asA = (fn: (tx: Tx) => Promise<unknown>) =>
      errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await fn(tx);
        }),
      );
    expect(
      await asA((tx) =>
        tx.insert(claimsVersion).values({ tenantId: B.tenantId, version: 9, body: {} }),
      ),
    ).toBe("42501");
    expect(
      await asA((tx) =>
        tx.insert(searchPageDaily).values({
          tenantId: B.tenantId,
          siteId: B.siteId,
          provider: "bing",
          day: "2026-11-06",
          path: "/",
          impressions: 1,
          clicks: 0,
        }),
      ),
    ).toBe("42501");
    // B's rows are invisible, so an update or delete reaches nothing.
    const reached = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const updated = await tx
        .update(searchSource)
        .set({ lastError: "stolen" })
        .where(sql`${searchSource.tenantId} = ${B.tenantId}`)
        .returning();
      const deleted = await tx
        .delete(searchQueryDaily)
        .where(sql`${searchQueryDaily.tenantId} = ${B.tenantId}`)
        .returning();
      return updated.length + deleted.length;
    });
    expect(reached).toBe(0);
  });

  it("never lets a row point at another client's rows (composite keys)", async () => {
    const b = ids.get(B.tenantId);
    if (!b) throw new Error("no ids");
    // As the superuser, past RLS: the foreign keys alone refuse each of these.
    const attempts: Promise<unknown>[] = [
      t.db
        .insert(searchSource)
        .values({ tenantId: A.tenantId, siteId: B.siteId, provider: "bing" }),
      t.db.insert(searchSource).values({
        tenantId: A.tenantId,
        siteId: A.siteId,
        provider: "bing",
        connectionId: B.connectionId,
      }),
      t.db.insert(contentVersion).values({
        tenantId: A.tenantId,
        pageId: b.pageId,
        version: 2,
        title: "x",
        description: "x",
        bodyMd: "x",
        authorUserId: A.userId,
      }),
      t.db.insert(marketingReport).values({
        tenantId: A.tenantId,
        siteId: A.siteId,
        kind: "weekly",
        periodFrom: "2026-11-02",
        periodTo: "2026-11-08",
        body: {},
        sources: ["x"],
        agentVersionId: B.agentVersionId,
      }),
      t.db.insert(forumReply).values({
        tenantId: A.tenantId,
        threadId: b.threadId,
        agentVersionId: A.agentVersionId,
        body: "x",
      }),
      t.db.insert(contentPublish).values({
        tenantId: A.tenantId,
        pageId: ids.get(A.tenantId)?.pageId ?? "",
        versionId: ids.get(A.tenantId)?.versionId ?? "",
        action: "unpublish",
        externalActionId: B.externalActionId,
        byUserId: A.userId,
      }),
    ];
    for (const attempt of attempts) expect(await errorCode(attempt)).toBe("23503");
  });

  it("refuses a report without sources, and a version with two authors or none", async () => {
    expect(
      await errorCode(
        t.db.insert(marketingReport).values({
          tenantId: A.tenantId,
          siteId: A.siteId,
          kind: "weekly",
          periodFrom: "2026-11-02",
          periodTo: "2026-11-08",
          body: {},
          sources: [],
          agentVersionId: A.agentVersionId,
        }),
      ),
    ).toBe("23514");
    const a = ids.get(A.tenantId);
    for (const author of [{}, { authorUserId: A.userId, authorAgentVersionId: A.agentVersionId }]) {
      expect(
        await errorCode(
          t.db.insert(contentVersion).values({
            tenantId: A.tenantId,
            pageId: a?.pageId ?? "",
            version: 5,
            title: "x",
            description: "x",
            bodyMd: "x",
            ...author,
          }),
        ),
      ).toBe("23514");
    }
    // A page's live version must be one of its own versions.
    const [other] = await t.db
      .insert(contentPage)
      .values({
        tenantId: A.tenantId,
        siteId: A.siteId,
        path: "/guides/other",
        createdByUserId: A.userId,
      })
      .returning();
    expect(
      await errorCode(
        t.db
          .update(contentPage)
          .set({ status: "published", liveVersionId: a?.versionId ?? "" })
          .where(sql`${contentPage.id} = ${other?.id ?? ""}`),
      ),
    ).toBe("23503");
  });
});
