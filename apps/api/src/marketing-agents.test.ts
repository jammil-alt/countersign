// §1.77 (M47–M49): the Marketing area's agent set through the platform. Switching the pack on
// installs its five templates, each valid against the platform's registries with approval on;
// a step that would let `website.meta` or `linkedin.post` run unsigned is refused. Each template
// is forked into client A and run on a scripted model (FakeModel; no live model, no network):
// the weekly report is refused for an invented number and kept once corrected, with its sources
// and agent version; titles become one `website.meta` a person signs (a refused proposal never
// does); the forum watch drafts one reply for a thread a person added, refused until it opens
// with the disclosure, and people approve it naming the poster and mark it posted; article drafts
// refuse to save without research; and a social post becomes one `linkedin.post` a person signs.

import {
  createHackerNewsConnector,
  createLinkedInConnector,
  createWebsiteConnector,
  MemoryObjectStore,
} from "@countersign/connectors";
import { AgentBundle, validateBundle } from "@countersign/core";
import { agent, connection, externalAction, inboxItem, stepRun, toolCall } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import {
  contentPage,
  forumReply,
  MARKETING_SKILLS,
  marketingManifest,
  marketingReport,
  searchPageDaily,
  siteDailyPage,
  siteDailyTotal,
} from "@countersign/pack-marketing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: bodies and outputs are read loosely in tests.
type J = any;
const j = (v: unknown) => v as J;

const h = await createApiHarness({
  connectors: () => [
    createWebsiteConnector({ store: new MemoryObjectStore() }),
    // No fetch: the scripted runs never search Hacker News, so nothing could reach the network.
    createHackerNewsConnector({
      fetch: async () => {
        throw new Error("no network in tests");
      },
    }),
    createLinkedInConnector({}),
  ],
});
afterAll(() => h?.close());

const SLUGS = ["site-report", "titles", "article-drafts", "forum-watch", "social-posts"];
const tool = (id: string) => id.replaceAll(".", "__");
const day = (ago: number) =>
  new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - ago * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** The JSON of the newest tool result the model was sent. */
function lastResult(request: LlmRequest): J {
  const last = request.messages.at(-1);
  const blocks = Array.isArray(last?.content) ? last.content : [];
  const result = [...blocks].reverse().find((b: J) => b.type === "tool_result") as J;
  return JSON.parse(typeof result?.content === "string" ? result.content : "null");
}

describe.skipIf(!h)("the Marketing agent set on the platform", () => {
  const H = h as ApiHarness;
  const act = (name: string, body: unknown, who = OPERATOR) =>
    H.call(who, "POST", `/api/ops/clients/${H.A.tenantId}/packs/marketing/actions/${name}`, body);
  const templates: Record<string, string> = {};
  let siteId = "";
  let reportId = "";

  /** A connection of A's to `connector`, connected. */
  async function connect(connector: string, config: Record<string, unknown> = {}) {
    const [c] = await H.t.db
      .insert(connection)
      .values({ tenantId: H.A.tenantId, connector, status: "connected", config })
      .returning();
    return c?.id as string;
  }

  /** Forks one of the pack's templates into client A, publishes it and runs `workflow`. */
  async function runTemplate(
    slug: string,
    workflow: string,
    model: FakeModel,
    opts: {
      bindings?: Record<string, string>;
      input?: unknown;
      onWait?: (type: string) => Promise<unknown>;
    } = {},
  ) {
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templates[slug]}/fork`, {
      clientId: H.A.tenantId,
      slug: `${slug}-a`,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const agentId = j(fork.json).agent.id as string;
    const versionId = j(fork.json).version.id as string;
    await H.t.db
      .update(agent)
      .set({ bindings: opts.bindings ?? {} })
      .where(eq(agent.id, agentId));
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow,
      ...(opts.input ? { input: opts.input } : {}),
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const result = await executeRun(
      { db: H.db, platform: H.platform, transport: model, instances: H.instances },
      params,
      cloudflareStepRunner(
        new FakeWorkflowStep(async (_n, type) => {
          if (!opts.onWait) throw new Error(`unexpected wait ${type}`);
          return opts.onWait(type);
        }),
      ),
    );
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, params.runId));
    return {
      params,
      result,
      steps,
      out: (id: string) => j(steps.find((s) => s.nodeId === id)?.output),
    };
  }

  /** A person is asked to sign it, told it is always signed, and until then it never runs. */
  async function signedNeverRan(action: typeof externalAction.$inferSelect | undefined) {
    expect(action?.inboxItemId).toBeTruthy();
    const [item] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.id, action?.inboxItemId as string));
    expect(JSON.stringify(item?.payload)).toMatch(/"always"/);
    // Nobody signed in time (the test times the wait out): it expired, and nothing ran.
    expect(item?.status).toBe("expired");
    expect(action?.status).not.toBe("done");
    expect(action?.executedAt).toBeNull();
  }

  it("installs its five templates when the pack is switched on, each valid with approval on", async () => {
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const rows = await H.t.db
      .select()
      .from(agent)
      .where(and(eq(agent.kind, "template"), inArray(agent.slug, SLUGS)));
    expect(rows.map((r) => r.slug).sort()).toEqual([...SLUGS].sort());
    for (const r of rows) templates[r.slug] = r.id;
    const ctx = {
      skills: Object.fromEntries(H.platform.catalog.list().map((s) => [s.id, s])),
      tools: H.platform.tools.specs(),
      events: H.platform.events.byType(),
    };
    for (const t of marketingManifest.templates) {
      expect(validateBundle(t.bundle, ctx).errors, t.slug).toEqual([]);
    }
    for (const s of MARKETING_SKILLS) expect(H.platform.catalog.get(s.id)?.id).toBe(s.id);
    // The verbs that change something outside are always signed.
    expect(H.platform.tools.get("website.meta")?.spec.approval).toBe("always");
    expect(H.platform.tools.get("linkedin.post")?.spec.approval).toBe("always");
  });

  it("refuses a titles or posts step set to run without a person", () => {
    const ctx = {
      skills: Object.fromEntries(H.platform.catalog.list().map((s) => [s.id, s])),
      tools: H.platform.tools.specs(),
      events: H.platform.events.byType(),
    };
    for (const slug of ["titles", "social-posts"]) {
      const t = marketingManifest.templates.find((x) => x.slug === slug);
      const loose = JSON.parse(
        JSON.stringify(t?.bundle).replaceAll('"required":"required"', '"required":"not_required"'),
      );
      const codes = validateBundle(AgentBundle.parse(loose), ctx).errors.map((e) => e.code);
      expect(codes, slug).toContain("approval_always");
    }
  });

  it("sets up the client: a site with two weeks of figures", async () => {
    const site = await act("add-site", { domain: "client-a.example.com", name: "Client A" });
    expect(site.status, JSON.stringify(site.json)).toBe(200);
    siteId = j(site.json).result.site.id;
    for (let ago = 1; ago <= 14; ago++) {
      const visits = ago <= 7 ? 15 : 10;
      const bands = [0, 0, visits, 0, 0, 0];
      await H.t.db.insert(siteDailyTotal).values({
        tenantId: H.A.tenantId,
        siteId,
        day: day(ago),
        dimension: "all",
        key: "",
        visits,
        views: visits * 2,
        goals: 0,
        bounces: 5,
        engagedMs: visits * 40_000,
        engagedBands: bands,
      });
      await H.t.db.insert(siteDailyPage).values({
        tenantId: H.A.tenantId,
        siteId,
        day: day(ago),
        path: "/pricing",
        views: visits,
        entries: visits,
        exits: 3,
        goals: 0,
        formSeen: 0,
        engagedMs: visits * 40_000,
        engagedBands: bands,
        scrollReached: [visits, 4, 2, 1],
      });
    }
  });

  const report = (summary: string) => ({
    summary,
    changes: [
      {
        text: "Visits: 105 (was 70, +50.0%).",
        evidence: [{ label: "Overview", href: `/ops/clients/${H.A.tenantId}/marketing/overview` }],
      },
    ],
    causes: [{ text: "Probably more people found the pricing page." }],
    unknown: "Why visitors left the pricing page without getting in touch.",
    actions: [0, 1, 2].map((i) => ({
      text: `Action ${["one", "two", "three"][i]}: look at /pricing.`,
      why: "Most visits read it.",
      evidence: [{ label: "Pages", href: `/ops/clients/${H.A.tenantId}/marketing/pages` }],
    })),
  });

  it("writes the weekly report: refused for an invented number, kept once corrected", async () => {
    const good = report("Visits rose to 105 from 70 (+50.0%).");
    const model = new FakeModel([
      { toolUse: { name: tool("marketing.site.figures"), input: {} } },
      (req) => {
        expect(lastResult(req).written).toContain("Visits: 105 (was 70, +50.0%)");
        return {
          toolUse: {
            name: tool("marketing.report.record"),
            input: { report: report("Visits rose to 110."), sources: [siteId] },
          },
        };
      },
      (req) => {
        expect(JSON.stringify(lastResult(req))).toMatch(/not in the figures: 110/);
        return {
          toolUse: {
            name: tool("marketing.report.record"),
            input: { report: good, sources: [siteId] },
          },
        };
      },
      (req) => {
        const kept = lastResult(req);
        expect(kept.recorded).toBe(true);
        return {
          toolUse: {
            name: "finish",
            input: { ...good, reportId: kept.reportId, sources: kept.sources },
          },
        };
      },
    ]);
    const { params, result, out } = await runTemplate("site-report", "weekly", model);
    expect(result).toEqual({ status: "succeeded" });
    reportId = out("report").reportId;
    const [row] = await H.t.db
      .select()
      .from(marketingReport)
      .where(eq(marketingReport.id, reportId));
    expect(row).toMatchObject({
      tenantId: H.A.tenantId,
      agentVersionId: params.agentVersionId,
      runId: params.runId,
      periodFrom: day(7),
      periodTo: day(1),
    });
    expect(row?.sources).toEqual([siteId]);
    // Every request carried the figures only as tool results, never as instructions.
    expect(JSON.stringify(model.requests[0]?.system)).not.toMatch(/105/);
    // The back office reads it, and marks an action Done.
    const list = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/reports`,
    );
    expect(list.status).toBe(200);
    expect(j(list.json).report.reports[0]).toMatchObject({ id: reportId, read: false });
    expect(forbiddenKeys(list.json)).toEqual([]);
    const one = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/reports/items/${reportId}`,
    );
    expect(one.status).toBe(200);
    expect(forbiddenKeys(one.json)).toEqual([]);
    expect(j(one.json).report.actions).toHaveLength(3);
    const done = await act("decide-report-action", { reportId, idx: 1, decision: "done" });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect((await act("mark-report-read", { reportId })).status).toBe(200);
    // Another client's back office finds no such report.
    const other = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.B.tenantId}/reports/marketing/reports/items/${reportId}`,
    );
    expect(other.status).not.toBe(200);
  });

  it("proposes a title as one website.meta that waits for a person; a refused one never is", async () => {
    const website = await connect("website", { domain: "client-a.example.com" });
    // /pricing is seen in search and seldom clicked.
    for (let ago = 2; ago <= 10; ago++) {
      await H.t.db.insert(searchPageDaily).values({
        tenantId: H.A.tenantId,
        siteId,
        provider: "google",
        day: day(ago),
        path: "/pricing",
        impressions: 50,
        clicks: 1,
        position: "8.50",
      });
    }
    const description =
      "What approvals cost and what you get: every change waits for a person to sign it, with the before and after.";
    const model = new FakeModel([
      {
        toolUse: {
          name: "finish",
          input: {
            proposals: [
              {
                path: "/pricing",
                title: "Approval pricing, in plain numbers",
                description,
                why: "Seen 450 times, clicked 9.",
                queries: [],
              },
              {
                path: "/",
                title: "The best approvals tool ever!",
                description,
                why: "Hype.",
                queries: [],
              },
            ],
            sources: [siteId],
          },
        },
      },
    ]);
    const waits: string[] = [];
    const { out, params } = await runTemplate("titles", "weekly", model, {
      bindings: { website },
      // The run waits for the person; the test stops it there.
      onWait: async (type) => {
        waits.push(type);
        throw Object.assign(new Error("Execution timed out after 1000ms"), {
          name: "WorkflowTimeoutError",
        });
      },
    });
    expect(out("check").proposals.map((p: J) => p.path)).toEqual(["/pricing"]);
    expect(out("check").refused[0].path).toBe("/");
    expect(waits).toHaveLength(1);
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(and(eq(externalAction.runId, params.runId), eq(externalAction.tool, "website.meta")));
    expect(actions).toHaveLength(1);
    await signedNeverRan(actions[0]);
    expect(actions[0]?.input).toMatchObject({
      path: "/pricing",
      title: "Approval pricing, in plain numbers",
    });
  });

  it("drafts a forum reply for a thread a person added, opening with the disclosure", async () => {
    const hn = await connect("hackernews");
    const added = await act("add-forum-thread", {
      url: "https://news.ycombinator.com/item?id=4242",
      title: "Ask HN: How do you approve vendor bills?",
    });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    const threadId = j(added.json).result.thread.id;
    const model = new FakeModel([
      { toolUse: { name: tool("marketing.forum.threads.unseen"), input: { threads: [] } } },
      (req) => {
        expect(lastResult(req).waiting.map((w: J) => w.threadId)).toEqual([threadId]);
        return {
          toolUse: {
            name: tool("marketing.forum.reply.draft"),
            input: { threadId, body: "Great question! We route every bill to a person." },
          },
        };
      },
      (req) => {
        expect(JSON.stringify(lastResult(req))).toMatch(/must open with/);
        return {
          toolUse: {
            name: tool("marketing.forum.reply.draft"),
            input: {
              threadId,
              body: "I work at Client A. What worked for us: each bill waits for one named person.",
            },
          },
        };
      },
      (req) => {
        const r = lastResult(req);
        return {
          toolUse: {
            name: "finish",
            input: {
              looked: 1,
              drafted: [{ threadId, replyId: r.replyId }],
              passed: 0,
              sources: [threadId],
            },
          },
        };
      },
    ]);
    const { result, params } = await runTemplate("forum-watch", "watch", model, {
      bindings: { hackernews: hn },
      input: { thread: "https://news.ycombinator.com/item?id=4242" },
    });
    expect(result).toEqual({ status: "succeeded" });
    const replies = await H.t.db.select().from(forumReply).where(eq(forumReply.threadId, threadId));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ status: "waiting", agentVersionId: params.agentVersionId });
    // The Forum screen's queue: approve naming the poster, then mark it posted by hand.
    const forum = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/forum`,
    );
    expect(forum.status).toBe(200);
    expect(j(forum.json).report.waiting[0].thread.id).toBe(threadId);
    expect(forbiddenKeys(forum.json)).toEqual([]);
    const ok = await act("decide-forum-reply", {
      replyId: replies[0]?.id,
      decision: "approve",
      posterUserId: H.A.admin,
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const queued = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/reports/marketing/forum`))
        .json,
    ).report;
    expect(queued.toPost[0].poster).toEqual({ id: H.A.admin, name: "Client A admin" });
    expect((await act("mark-forum-posted", { replyId: replies[0]?.id })).status).toBe(200);
  });

  it("saves no article without research, and never publishes", async () => {
    const model = new FakeModel([
      { toolUse: { name: tool("web.search"), input: { query: "approval workflows" } } },
      (req) => {
        expect(lastResult(req).status).toBe("off");
        return {
          toolUse: {
            name: tool("marketing.article.draft"),
            input: {
              slug: "approval-workflows",
              title: "How approval workflows work",
              description: "What an approval workflow is and who signs what.",
              body: `${"An approval workflow makes a change wait for a person. ".repeat(6)}`,
              why: "People search for it.",
              sources: [{ title: "Made up", url: "https://made.up/x" }],
            },
          },
        };
      },
      (req) => {
        expect(JSON.stringify(lastResult(req))).toMatch(/found nothing/);
        return {
          toolUse: {
            name: "finish",
            input: {
              drafted: false,
              pageId: null,
              path: null,
              topic: "approval workflows",
              why: "Web research is off, so there is nothing to cite.",
              sources: [siteId],
            },
          },
        };
      },
    ]);
    const { result, params } = await runTemplate("article-drafts", "draft", model, {
      input: { topic: "approval workflows" },
    });
    expect(result).toEqual({ status: "succeeded" });
    expect(
      await H.t.db.select().from(contentPage).where(eq(contentPage.tenantId, H.A.tenantId)),
    ).toEqual([]);
    const calls = await H.t.db
      .select({ tool: toolCall.tool, status: toolCall.status })
      .from(toolCall)
      .innerJoin(stepRun, eq(stepRun.id, toolCall.stepRunId))
      .where(eq(stepRun.runId, params.runId));
    expect(calls.map((c) => c.tool)).toEqual(["web.search", "marketing.article.draft"]);
  });

  it("offers a LinkedIn post about the report as one linkedin.post that waits for a person", async () => {
    const li = await connect("linkedin", {
      pages: [{ id: "123", name: "Client A" }],
      accountName: "Client A admin",
      scopes: ["w_organization_social", "r_organization_admin"],
    });
    const text =
      "Last week more people found our pricing page. We wrote down what we learned and what we will try next.";
    const model = new FakeModel([
      { toolUse: { name: tool("marketing.report.get"), input: {} } },
      (req) => {
        expect(lastResult(req).sources).toEqual([reportId]);
        return {
          toolUse: {
            name: "finish",
            input: { text, guide: null, report: reportId, sources: [reportId] },
          },
        };
      },
    ]);
    const waits: string[] = [];
    const { out, params } = await runTemplate("social-posts", "post", model, {
      bindings: { linkedin: li },
      input: { report: reportId },
      // The run waits for the person; the test stops it there.
      onWait: async (type) => {
        waits.push(type);
        throw Object.assign(new Error("Execution timed out after 1000ms"), {
          name: "WorkflowTimeoutError",
        });
      },
    });
    expect(out("check")).toEqual({ text, link: null, sources: [reportId] });
    expect(waits).toHaveLength(1);
    const [posted] = await H.t.db
      .select()
      .from(externalAction)
      .where(and(eq(externalAction.runId, params.runId), eq(externalAction.tool, "linkedin.post")));
    expect(posted).toMatchObject({ input: { text } });
    await signedNeverRan(posted);
  });
});
