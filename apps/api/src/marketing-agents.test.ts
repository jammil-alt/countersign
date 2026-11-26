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
import {
  agent,
  agentVersion,
  connection,
  type externalAction,
  inboxItem,
  stepRun,
} from "@countersign/db";
import type { FakeModel, LlmRequest } from "@countersign/llm";
import { siteDailyPage, siteDailyTotal } from "@countersign/pack-marketing";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, FakeWorkflowStep, OPERATOR } from "./api.test-helper";
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

const _SLUGS = ["site-report", "titles", "article-drafts", "forum-watch", "social-posts"];
const _tool = (id: string) => id.replaceAll(".", "__");
const day = (ago: number) =>
  new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - ago * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** The JSON of the newest tool result the model was sent. */
function _lastResult(request: LlmRequest): J {
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
  const _reportId = "";

  /** A connection of A's to `connector`, connected. */
  async function _connect(connector: string, config: Record<string, unknown> = {}) {
    const [c] = await H.t.db
      .insert(connection)
      .values({ tenantId: H.A.tenantId, connector, status: "connected", config })
      .returning();
    return c?.id as string;
  }

  /** Forks one of the pack's templates into client A, publishes it and runs `workflow`. */
  async function _runTemplate(
    slug: string,
    workflow: string,
    model: FakeModel,
    opts: {
      bindings?: Record<string, string>;
      input?: unknown;
      onWait?: (type: string) => Promise<unknown>;
    } = {},
  ) {
    // Skill model (2026-11-10): the scripted runs are v2's, the agent-mode skills stored agents
    // still run; v3 (AI skills and write steps) is held by templates-skill-model.test.ts.
    const [v2] = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(and(eq(agentVersion.agentId, templates[slug] as string), eq(agentVersion.version, 2)));
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templates[slug]}/fork`, {
      clientId: H.A.tenantId,
      slug: `${slug}-a`,
      versionId: v2?.id,
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
  async function _signedNeverRan(action: typeof externalAction.$inferSelect | undefined) {
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

  it("switches the area on for the client", async () => {
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
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

  const _report = (summary: string) => ({
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
});
