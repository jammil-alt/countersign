// Offering the Marketing area to clients (M50, docs/plan.md §1.78), on a throwaway database as the
// Worker's role: the portal's screens name only the reports it may read; the weekly report as the
// portal reads it keeps the client's words and leaves out the agent, the run and who decided, and
// reads tolerantly whatever the agent wrote; one client never reads another's; and a Google
// sign-in connection reads the property of the site it is pointed at, or is refused.

import { closeDb, connection, createDb, type Db, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKETING_REPORTS, marketingManifest } from "../manifest";
import { PackRefusal } from "../pack";
import { marketingReport, marketingReportAction } from "../schema";
import { setSearchSource } from "../search/sources";
import { insertMarketingClient, type MarketingClient } from "../testing.test-helper";
import { WEEKLY_REPORT, weeklyReport, weeklyReports } from "./weekly";

const online = await databaseAvailable();

const workerUrl = (url: string) => {
  const u = new URL(url);
  u.searchParams.set("options", "-c role=cs_worker");
  return u.toString();
};

/** What no portal answer may carry (invariant 11), and what this one leaves out besides. */
const HIDDEN = /agentVersionId|runId|decidedBy|readBy|figures|evidence|bundle|prompt|cost|model/i;
const keysOf = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap(keysOf)
    : v && typeof v === "object"
      ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)])
      : [];

describe("the portal's screens", () => {
  it("name the website, search and weekly report, each a report of the pack", () => {
    const routes = marketingManifest.screens.map((s) => s.route);
    expect(routes).toEqual([
      "/reports/marketing/overview",
      "/reports/marketing/search",
      `/reports/marketing/${WEEKLY_REPORT}`,
    ]);
    for (const r of routes) {
      expect(MARKETING_REPORTS[r.split("/")[3] ?? ""], r).toBeDefined();
    }
    for (const s of marketingManifest.screens) {
      expect(s.roles).toEqual(["client_admin", "client_user"]);
    }
  });
});

describe.skipIf(!online)("the weekly report in the portal, and Google sign-in's property", () => {
  let t: TestDatabase;
  let worker: Db;
  let A: MarketingClient;
  let B: MarketingClient;
  let older = "";
  let newer = "";

  const report = async (
    m: MarketingClient,
    periodFrom: string,
    periodTo: string,
    body: Record<string, unknown>,
  ) => {
    const [r] = await t.db
      .insert(marketingReport)
      .values({
        tenantId: m.tenantId,
        siteId: m.siteId,
        kind: "weekly",
        periodFrom,
        periodTo,
        body,
        sources: [{ kind: "site_daily_total", id: "x" }],
        agentVersionId: m.agentVersionId,
        runId: m.runId,
      })
      .returning();
    if (!r) throw new Error("no report");
    return r.id;
  };

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    worker = createDb(workerUrl(t.url), { max: 2 });
    A = await insertMarketingClient(t.db, "A client", "a-client.example");
    B = await insertMarketingClient(t.db, "B client", "b-client.example");
    older = await report(A, "2026-10-26", "2026-11-01", { summary: "A quiet week." });
    newer = await report(A, "2026-11-02", "2026-11-08", {
      summary: "Visits rose by a third.",
      changes: [
        { text: "Visits up from 90 to 120.", evidence: [{ href: "/ops/x", label: "y" }] },
        { nope: true },
      ],
      causes: "not a list",
      unknown: "Whether the newsletter brought them.",
      figures: "visits=120",
    });
    await t.db.insert(marketingReportAction).values([
      { tenantId: A.tenantId, reportId: newer, idx: 0, text: "Write a guide on invoices." },
      {
        tenantId: A.tenantId,
        reportId: newer,
        idx: 1,
        text: "Fix the title of /pricing.",
        decision: "done",
        decidedByUserId: A.userId,
        decidedAt: new Date(),
      },
    ]);
    await report(B, "2026-11-02", "2026-11-08", { summary: "B's own week." });
  });
  afterAll(async () => {
    if (worker) await closeDb(worker);
    await t?.drop();
  });

  it("lists a site's reports newest first, the newest in full, nothing of the agent's", async () => {
    const w = await withTenant(worker, A.tenantId, (tx) => weeklyReports(tx, A.tenantId));
    expect(w.site?.id).toBe(A.siteId);
    expect(w.reports.map((r) => r.id)).toEqual([newer, older]);
    expect(w.latest).toMatchObject({
      id: newer,
      summary: "Visits rose by a third.",
      changes: [{ text: "Visits up from 90 to 120." }],
      causes: [],
      unknown: "Whether the newsletter brought them.",
      actions: [
        { idx: 0, text: "Write a guide on invoices.", decision: "open" },
        { idx: 1, text: "Fix the title of /pricing.", decision: "done" },
      ],
      sourceCount: 1,
      read: false,
    });
    expect(keysOf(w).filter((k) => HIDDEN.test(k))).toEqual([]);
  });

  it("opens one report, and never another client's", async () => {
    const one = await withTenant(worker, A.tenantId, (tx) => weeklyReport(tx, A.tenantId, older));
    expect(one).toMatchObject({ summary: "A quiet week.", changes: [], actions: [] });
    const theirs = await withTenant(worker, B.tenantId, (tx) =>
      weeklyReport(tx, B.tenantId, newer),
    );
    expect(theirs).toBeNull();
    // Another client's site reads as no site.
    const asked = await withTenant(worker, B.tenantId, (tx) =>
      weeklyReports(tx, B.tenantId, { site: A.siteId }),
    );
    expect(asked).toMatchObject({ site: null, reports: [], latest: null });
    const own = await withTenant(worker, B.tenantId, (tx) => weeklyReports(tx, B.tenantId));
    expect(own.latest?.summary).toBe("B's own week.");
  });

  it("gives the list as CSV", async () => {
    const handler = MARKETING_REPORTS[WEEKLY_REPORT];
    if (!handler) throw new Error("no weekly report");
    const csv = await withTenant(worker, A.tenantId, (tx) =>
      handler.csv(tx, A.tenantId, "2026-11-09", {}),
    );
    expect(csv.split("\n")[0]).toBe(
      "week_from,week_to,written_at,actions_done,actions_not_now,actions_open",
    );
    expect(csv).toContain("2026-11-02,2026-11-08,");
    expect(csv).toMatch(/,1,0,1\n/);
  });

  it("points a Google sign-in connection at the site's own property, or refuses", async () => {
    const [c] = await t.db
      .insert(connection)
      .values({
        tenantId: A.tenantId,
        connector: "gsc_oauth",
        status: "connected",
        config: {
          property: null,
          properties: ["https://www.a-client.example/", "sc-domain:elsewhere.example"],
        },
      })
      .returning();
    if (!c) throw new Error("no connection");
    const set = await setSearchSource(worker, {
      tenantId: A.tenantId,
      input: { siteId: A.siteId, provider: "google", connectionId: c.id },
    });
    expect(set.source.connectionId).toBe(c.id);
    const [after] = await t.db.select().from(connection).where(eq(connection.id, c.id));
    expect(after?.config).toMatchObject({ property: "https://www.a-client.example/" });
    expect(after?.externalAccountId).toBe("https://www.a-client.example/");

    const [none] = await t.db
      .insert(connection)
      .values({
        tenantId: A.tenantId,
        connector: "gsc_oauth",
        status: "connected",
        config: {
          property: "sc-domain:elsewhere.example",
          properties: ["sc-domain:elsewhere.example"],
        },
      })
      .returning();
    if (!none) throw new Error("no connection");
    await expect(
      setSearchSource(worker, {
        tenantId: A.tenantId,
        input: { siteId: A.siteId, provider: "google", connectionId: none.id },
      }),
    ).rejects.toBeInstanceOf(PackRefusal);
    // Bing never takes a Google connection.
    await expect(
      setSearchSource(worker, {
        tenantId: A.tenantId,
        input: { siteId: A.siteId, provider: "bing", connectionId: c.id },
      }),
    ).rejects.toThrow(/Bing/);
  });
});
