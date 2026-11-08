// §1.77: the agent set's guardrails in code, pure and against a throwaway database as the Worker's
// role (RLS applies): the figures check refuses a number the figures don't have; the report is
// kept once with its sources, agent version and three actions, and not at all in a test run;
// people mark it read and its actions Done or Not now; titles are held to their lengths, the
// claims list, the site's pages and a daily limit; an article cites only what this run's research
// found; a post is about a live guide or a report, within LinkedIn's length, linking only to our
// own site; and client B never sees or touches A's.

import {
  closeDb,
  createDb,
  type Db,
  externalAction,
  stepRun,
  toolCall,
  withTenant,
} from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackTool, PackToolContext } from "../pack";
import { contentPage, contentVersion, marketingReport, marketingReportAction } from "../schema";
import { insertMarketingClient, type MarketingClient } from "../testing.test-helper";
import { articleDraftTool, citationProblems, linkKey, linksIn } from "./articles";
import { siteFiguresTool } from "./figures";
import { changeText, inventedFigures, numbersIn, rateText } from "./figures-check";
import {
  decideReportAction,
  evidenceProblem,
  listReports,
  markReportRead,
  REPORTS_REPORT,
  reportDetail,
  reportProblems,
  reportRecordTool,
  type WeeklyReport,
} from "./report";
import { daysAgo, seedTwoWeeks } from "./seed.test-helper";
import { postProblems, socialCheckTool } from "./social";
import { perDayLimit, titlesCheckTool, wordingProblems } from "./titles";

const online = await databaseAvailable();

// biome-ignore lint/suspicious/noExplicitAny: tool outputs are read loosely in tests.
type J = any;

const TENANT = "0195f3c0-0000-7000-8000-00000000000a";

/** A report that quotes only the seeded figures. */
const goodReport = (tenantId: string): WeeklyReport => ({
  summary: "Visits rose to 105 from 70 (+50.0%). Most came from Google.",
  changes: [
    {
      text: "Visits: 105 (was 70, +50.0%), and goals reached went from none to 7.",
      evidence: [{ label: "Overview", href: `/ops/clients/${tenantId}/marketing/overview` }],
    },
  ],
  causes: [{ text: "Probably more people found /pricing in search." }],
  unknown: "Why visitors who read the pricing page did not get in touch.",
  actions: [
    {
      text: "Answer the pricing question on /pricing in its first lines.",
      why: "It is seen in search far more often than it is clicked.",
      evidence: [{ label: "Search", href: `/ops/clients/${tenantId}/marketing/search` }],
    },
    {
      text: "Add a guide on approval workflows.",
      why: "People search for it.",
      evidence: [{ label: "Pricing", href: "/pricing" }],
    },
    {
      text: "Look at the sources screen next week.",
      why: "Most visits came from one source.",
      evidence: [{ label: "Sources", href: `/ops/clients/${tenantId}/marketing/sources` }],
    },
  ],
});

describe("the figures check (pure)", () => {
  it("reads numbers as written, leaving out dates, ordinals and addresses", () => {
    expect(numbersIn("Visits: 1,204 (was 980, +22.9%) on 2026-11-02 and 3 Nov; 1st time")).toEqual([
      "1204",
      "980",
      "+22.9%",
    ]);
    expect(numbersIn("See /guides/2026-plan and https://x.example/a/42")).toEqual([]);
  });

  it("refuses a number the figures don't have, with or without its sign", () => {
    const given = "Visits: 105 (was 70, +50.0%)\nBounce rate: 33.3% (was 50.0%)";
    expect(inventedFigures("Visits rose 50.0% to 105.", given)).toEqual([]);
    expect(inventedFigures("Visits fell by 50.0%.", given)).toEqual([]);
    expect(inventedFigures("Visits rose 51% to 106.", given)).toEqual(["51%", "106"]);
  });

  it("writes rates and changes the way the report quotes them", () => {
    expect(rateText("0.0312")).toBe("3.1%");
    expect(rateText(null)).toBe("none");
    expect(changeText(105, 70)).toBe("+50.0%");
    expect(changeText(7, 0)).toBe("new");
    expect(changeText(50, 100)).toBe("−50.0%");
  });

  it("refuses an invented figure, a refused claim and evidence that isn't a path of ours", () => {
    const r = goodReport(TENANT);
    expect(reportProblems(r, "Visits: 105 (was 70, +50.0%) goals 7", { tenantId: TENANT })).toEqual(
      [],
    );
    const bad: WeeklyReport = {
      ...r,
      summary: "Visits rose to 120!",
      changes: [{ text: "Up.", evidence: [{ label: "Elsewhere", href: "https://example.com" }] }],
    };
    expect(
      reportProblems(bad, "Visits: 105 (was 70, +50.0%) goals 7", { tenantId: TENANT }).map(
        (p) => p.code,
      ),
    ).toEqual(["invented_figures", "claims", "evidence"]);
    expect(evidenceProblem("/ops/clients/someone-else/marketing/overview", TENANT)).toMatch(
      /not one of this client's/,
    );
    expect(evidenceProblem(`/ops/clients/${TENANT}/marketing/pages`, TENANT)).toBeNull();
    expect(evidenceProblem("//evil.example.com", TENANT)).toMatch(/path/);
  });
});

describe("titles, articles and posts (pure)", () => {
  it("holds titles to 60 characters, descriptions to 155 and the claims list", () => {
    const ok = {
      title: "Approval workflows that wait for you",
      description:
        "Every change an agent wants to make waits for a person to sign it, with the before and after shown side by side.",
    };
    expect(wordingProblems(ok)).toEqual([]);
    expect(wordingProblems({ ...ok, title: "x".repeat(61) })[0]).toMatch(/61 characters/);
    expect(wordingProblems({ ...ok, description: "y".repeat(156) })[0]).toMatch(/156 characters/);
    expect(wordingProblems({ ...ok, title: "Approvals, AI-powered" }).join(" ")).toMatch(
      /AI-powered/i,
    );
    expect(wordingProblems({ ...ok, title: "Approvals that work!" }).join(" ")).toMatch(/"!"/);
    expect(perDayLimit({})).toBe(3);
    expect(perDayLimit({ max_per_day: 50 })).toBe(10);
  });

  it("compares links without fragments or trailing slashes, and finds a body's links", () => {
    expect(linkKey("https://www.Example.com/a/#x")).toBe("example.com/a");
    expect(linkKey("ftp://example.com")).toBeNull();
    expect(linksIn("See [this](https://a.example/x). And https://b.example/y, too.")).toEqual([
      "https://a.example/x",
      "https://b.example/y",
    ]);
  });

  it("lets an article cite only what research found, and link only there or to our site", () => {
    const found = new Set([linkKey("https://a.example/x") as string]);
    const draft = {
      sources: [{ title: "A", url: "https://a.example/x/" }],
      body: "Read [A](https://a.example/x) and [ours](https://mezonas.com/guides/one).",
    };
    expect(citationProblems(draft, found, ["mezonas.com"])).toEqual([]);
    expect(
      citationProblems({ ...draft, sources: [{ title: "B", url: "https://b.example/" }] }, found, [
        "mezonas.com",
      ])[0],
    ).toMatch(/isn't a page your research found/);
    expect(
      citationProblems({ ...draft, body: `${draft.body} https://c.example/z` }, found, [
        "mezonas.com",
      ])[0],
    ).toMatch(/didn't find/);
    expect(citationProblems(draft, new Set(), ["mezonas.com"])[0]).toMatch(/found nothing/);
  });

  it("keeps a post within LinkedIn's length, the claims list and links to our own site", () => {
    const text =
      "We wrote down how approvals work at Mezonas: every change waits for a person. https://mezonas.com/guides/approvals";
    expect(postProblems(text, { domains: ["mezonas.com"] })).toEqual([]);
    expect(postProblems("x".repeat(3001), { domains: ["mezonas.com"] })[0]).toMatch(/3000/);
    expect(
      postProblems(`${text} https://other.example/x`, { domains: ["mezonas.com"] })[0],
    ).toMatch(/only to our own site/);
    expect(postProblems(`${text} Great news!`, { domains: ["mezonas.com"] }).join(" ")).toMatch(
      /"!"/,
    );
  });
});

describe.skipIf(!online)("the agent set's tools (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: MarketingClient;
  let B: MarketingClient;
  let searchSourceId = "";

  const ctx = (
    c: MarketingClient,
    mode: "live" | "test" = "live",
    settings: Record<string, unknown> = {},
  ): PackToolContext => ({
    tenantId: c.tenantId,
    agentVersionId: c.agentVersionId,
    runId: c.runId,
    mode,
    settings,
    db,
    llm: null,
  });
  const call = async (
    tool: PackTool,
    input: unknown,
    c: MarketingClient = A,
    mode: "live" | "test" = "live",
    settings: Record<string, unknown> = {},
  ) => tool.output.parse(await tool.run(input, ctx(c, mode, settings))) as J;
  const fails = async (tool: PackTool, input: unknown, c: MarketingClient = A) => {
    try {
      await tool.run(input, ctx(c));
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    return null;
  };

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertMarketingClient(t.db, "Mezonas", "mezonas.com");
    B = await insertMarketingClient(t.db, "Other client", "other.example.com");
    ({ searchSourceId } = await seedTwoWeeks(t.db, A));
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  let reportId = "";

  it("reads a site's week with search beside it, written out", async () => {
    const f = await call(siteFiguresTool, {});
    expect(f.site.domain).toBe("mezonas.com");
    expect(f.period).toEqual({ from: daysAgo(7), to: daysAgo(1) });
    expect(f.totals).toMatchObject({ visits: 105, views: 210, goals: 7 });
    expect(f.previousTotals).toMatchObject({ visits: 70, goals: 0 });
    expect(f.written).toEqual(
      expect.arrayContaining([
        "Visits: 105 (was 70, +50.0%)",
        "Goals reached: 7 (was 0, new)",
        "Impressions: 280 (was 280, no change)",
      ]),
    );
    expect(f.search.totals).toMatchObject({ impressions: 280, clicks: 7 });
    expect(f.sourcesIds).toEqual([A.siteId, searchSourceId]);
    expect(f.screens.overview).toBe(`/ops/clients/${A.tenantId}/marketing/overview`);
    // Another client reads none of A's figures.
    const b = await call(siteFiguresTool, {}, B);
    expect(b.totals.visits).toBe(0);
    expect(await fails(siteFiguresTool, { site: A.siteId }, B)).toMatch(/isn't one of this/);
  });

  it("refuses a report with a number the figures don't have, and keeps nothing", async () => {
    const r = goodReport(A.tenantId);
    const invented = { ...r, summary: "Visits rose to 106." };
    expect(await fails(reportRecordTool, { report: invented, sources: [A.siteId] })).toMatch(
      /not in the figures: 106/,
    );
    expect(await t.db.select().from(marketingReport)).toEqual([]);
  });

  it("checks a test run's report and keeps nothing", async () => {
    const out = await call(
      reportRecordTool,
      { report: goodReport(A.tenantId), sources: [A.siteId] },
      A,
      "test",
    );
    expect(out).toMatchObject({ recorded: false, reportId: null });
    expect(await t.db.select().from(marketingReport)).toEqual([]);
  });

  it("keeps a report once, with its sources, agent version and three actions", async () => {
    const input = { report: goodReport(A.tenantId), sources: [A.siteId, "not-an-id"] };
    const out = await call(reportRecordTool, input);
    expect(out.recorded).toBe(true);
    reportId = out.reportId;
    const [row] = await t.db.select().from(marketingReport).where(eq(marketingReport.id, reportId));
    expect(row).toMatchObject({
      tenantId: A.tenantId,
      siteId: A.siteId,
      kind: "weekly",
      periodFrom: daysAgo(7),
      periodTo: daysAgo(1),
      agentVersionId: A.agentVersionId,
      runId: A.runId,
    });
    expect(row?.sources).toEqual([A.siteId, searchSourceId]);
    const actions = await t.db
      .select()
      .from(marketingReportAction)
      .where(eq(marketingReportAction.reportId, reportId));
    expect(actions.map((a) => [a.idx, a.decision])).toEqual([
      [0, "open"],
      [1, "open"],
      [2, "open"],
    ]);
    const again = await call(reportRecordTool, input);
    expect(again).toMatchObject({ recorded: false, reportId });
  });

  it("lists and shows the report, marks it read and decides its actions", async () => {
    const list = await withTenant(db, A.tenantId, (tx) => listReports(tx, A.tenantId, {}));
    expect(list.reports).toHaveLength(1);
    expect(list.reports[0]).toMatchObject({ id: reportId, read: false });
    expect(list.reports[0]?.actions).toEqual({ open: 3, done: 0, notNow: 0 });
    await markReportRead(db, { tenantId: A.tenantId, userId: A.userId, input: { reportId } });
    await decideReportAction(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      input: { reportId, idx: 0, decision: "done" },
    });
    await decideReportAction(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      input: { reportId, idx: 2, decision: "not_now" },
    });
    const detail = (await withTenant(db, A.tenantId, (tx) =>
      reportDetail(tx, A.tenantId, reportId),
    )) as J;
    expect(detail.readBy).toBe("Marketer 1");
    expect(detail.actions.map((a: J) => a.decision)).toEqual(["done", "open", "not_now"]);
    expect(detail.actions[0].decidedBy).toBe("Marketer 1");
    expect(detail.figures).toContain("Visits: 105 (was 70, +50.0%)");
    // Back to open clears who decided.
    await decideReportAction(db, {
      tenantId: A.tenantId,
      userId: A.userId,
      input: { reportId, idx: 0, decision: "open" },
    });
    const csv = await withTenant(db, A.tenantId, (tx) =>
      REPORTS_REPORT.csv(tx, A.tenantId, daysAgo(0), {}),
    );
    expect(csv).toMatch(/^period_from,period_to,read/);
    // Client B sees none of it and can't decide it.
    expect(
      await withTenant(db, B.tenantId, (tx) => reportDetail(tx, B.tenantId, reportId)),
    ).toBeNull();
    await expect(
      decideReportAction(db, {
        tenantId: B.tenantId,
        userId: B.userId,
        input: { reportId, idx: 1, decision: "done" },
      }),
    ).rejects.toThrow(/no such action/);
    await expect(
      markReportRead(db, { tenantId: B.tenantId, userId: B.userId, input: { reportId } }),
    ).rejects.toThrow(/no such report/);
  });

  const proposal = (path: string, title = "Approval workflow pricing, in plain numbers") => ({
    path,
    title,
    description:
      "What approvals cost and what you get: every change waits for a person to sign it, with the before and after.",
    why: "/pricing is seen 280 times a week and clicked 7 times.",
    queries: ["approval workflow pricing"],
  });

  it("checks title proposals: the site's pages only, lengths, claims and one per page", async () => {
    const out = await call(titlesCheckTool, {
      proposals: [
        proposal("/pricing"),
        proposal("/pricing", "A second one for the same page"),
        proposal("/nowhere"),
        proposal("/", `${"Long ".repeat(15)}title`),
      ],
    });
    expect(out.proposals.map((p: J) => p.path)).toEqual(["/pricing"]);
    expect(out.proposals[0].search).toEqual({ impressions: 560, clicks: 14, ctr: "0.0250" });
    expect(out.refused.map((r: J) => r.path)).toEqual(["/pricing", "/nowhere", "/"]);
    expect(out.refused[1].reasons[0]).toMatch(/isn't one the site/);
    expect(out.refused[2].reasons.join(" ")).toMatch(/characters; at most 60/);
  });

  it("keeps to the day's limit and skips a page already waiting for a person", async () => {
    // Two changes proposed today already, one of them for /pricing and still waiting.
    for (const [i, path] of ["/pricing", "/"].entries()) {
      await t.db.insert(externalAction).values({
        tenantId: A.tenantId,
        connectionId: A.connectionId,
        tool: "website.meta",
        runId: A.runId,
        agentVersionId: A.agentVersionId,
        input: { path, title: "t", description: "d" },
        idempotencyKey: `${A.runId}:meta:${i}`,
        status: i === 0 ? "proposed" : "rejected",
      });
    }
    // A live guide, so a second page is the site's.
    const [g] = await t.db
      .insert(contentPage)
      .values({
        tenantId: A.tenantId,
        siteId: A.siteId,
        path: "/guides/approvals",
        status: "draft",
        createdByUserId: A.userId,
      })
      .returning();
    const [v] = await t.db
      .insert(contentVersion)
      .values({
        tenantId: A.tenantId,
        pageId: g?.id as string,
        version: 1,
        title: "Approvals",
        description: "How approvals work.",
        bodyMd: "Text.",
        authorUserId: A.userId,
      })
      .returning();
    await t.db
      .update(contentPage)
      .set({ status: "published", liveVersionId: v?.id as string })
      .where(eq(contentPage.id, g?.id as string));
    const out = await call(
      titlesCheckTool,
      { proposals: [proposal("/pricing"), proposal("/guides/approvals")] },
      A,
      "live",
      { max_per_day: 3 },
    );
    expect(out.refused[0].reasons.join(" ")).toMatch(/already waiting/);
    expect(out.proposals.map((p: J) => p.path)).toEqual(["/guides/approvals"]);
    expect(out.proposals[0].now).toEqual({
      title: "Approvals",
      description: "How approvals work.",
    });
    const capped = await call(
      titlesCheckTool,
      { proposals: [proposal("/guides/approvals")] },
      A,
      "live",
      { max_per_day: 2 },
    );
    expect(capped).toMatchObject({ proposals: [], overLimit: 1, limit: 2 });
    // B's site knows none of A's pages.
    const b = await call(titlesCheckTool, { proposals: [proposal("/pricing")] }, B);
    expect(b.proposals).toEqual([]);
  });

  /** A finished `web.search` in A's run, as the runtime logs it. */
  async function researched(urls: string[]) {
    const [sr] = await t.db
      .insert(stepRun)
      .values({
        tenantId: A.tenantId,
        runId: A.runId,
        nodeId: `draft-${urls.length}`,
        nodeType: "skill",
      })
      .returning();
    await t.db.insert(toolCall).values({
      tenantId: A.tenantId,
      stepRunId: sr?.id as string,
      tool: "web.search",
      input: { query: "approval workflows" },
      output: {
        status: "ok",
        reason: null,
        query: "approval workflows",
        results: urls.map((url) => ({ url, title: url, pageAge: null, excerpts: [] })),
        sources: urls,
      },
      status: "succeeded",
    });
  }

  const article = (sources: { title: string; url: string }[], extra = "") => ({
    slug: "approval-workflows",
    title: "How approval workflows work",
    description:
      "What an approval workflow is, who signs what, and how to keep changes safe without slowing the team.",
    body: `## What it is\n\nAn approval workflow makes a change wait for a person. ${"It keeps the record. ".repeat(10)}\n\nSee [the study](https://research.example/study).${extra}`,
    targetQueries: ["approval workflow"],
    why: "People search for it and no guide answers it.",
    sources,
  });

  it("drafts an article citing only what this run's research found", async () => {
    const study = { title: "A study", url: "https://research.example/study" };
    expect(await fails(articleDraftTool, article([study]))).toMatch(/found nothing/);
    await researched(["https://research.example/study"]);
    expect(
      await fails(articleDraftTool, article([{ title: "Made up", url: "https://made.up/x" }])),
    ).toMatch(/isn't a page your research found/);
    expect(
      await fails(articleDraftTool, article([study], " And https://elsewhere.example/a.")),
    ).toMatch(/didn't find/);
    expect(await fails(articleDraftTool, article([study], " It is AI-powered."))).toMatch(
      /AI-powered/i,
    );
    const test = await call(articleDraftTool, article([study]), A, "test");
    expect(test).toMatchObject({ recorded: false, versionId: null });
    const out = await call(articleDraftTool, article([study]));
    expect(out).toMatchObject({ recorded: true, path: "/guides/approval-workflows", version: 1 });
    const [ver] = await t.db
      .select()
      .from(contentVersion)
      .where(eq(contentVersion.id, out.versionId));
    expect(ver).toMatchObject({ authorAgentVersionId: A.agentVersionId, runId: A.runId });
    expect(ver?.why).toMatch(/Sources:\n- A study: https:\/\/research\.example\/study/);
    // Nothing was published.
    const [page] = await t.db.select().from(contentPage).where(eq(contentPage.id, out.pageId));
    expect(page?.status).toBe("draft");
  });

  it("checks a post: about a live guide or a report, linking only to our own site", async () => {
    const [draft] = await t.db
      .select()
      .from(contentPage)
      .where(
        and(
          eq(contentPage.tenantId, A.tenantId),
          eq(contentPage.path, "/guides/approval-workflows"),
        ),
      );
    const [live] = await t.db
      .select()
      .from(contentPage)
      .where(and(eq(contentPage.tenantId, A.tenantId), eq(contentPage.path, "/guides/approvals")));
    const text = "We wrote down how approvals work: every change waits for a person to sign it.";
    expect(await fails(socialCheckTool, { text, guide: draft?.id })).toMatch(/isn't live/);
    const out = await call(socialCheckTool, { text, guide: live?.id, report: null });
    expect(out).toEqual({
      text,
      link: "https://mezonas.com/guides/approvals",
      sources: [live?.id],
    });
    const fromReport = await call(socialCheckTool, { text, report: reportId });
    expect(fromReport.sources).toEqual([reportId]);
    expect(
      await fails(socialCheckTool, { text: `${text} https://other.example`, report: reportId }),
    ).toMatch(/only to our own site/);
    expect(await fails(socialCheckTool, { text, guide: live?.id, report: reportId })).toMatch(
      /one of them/,
    );
    // Another client's guide or report is not found.
    expect(await fails(socialCheckTool, { text, report: reportId }, B)).toMatch(/isn't one of/);
    expect(await fails(socialCheckTool, { text, guide: live?.id }, B)).toMatch(/isn't one of/);
  });
});
