// The content area over a throwaway database: pages and versions, the claims list, the website
// connection's domain, publishing through a signed write (a fake here; apps/api's runs the
// connector), the checks refusing a publish, the agent's draft tool, and one client never
// reading or changing another's guides (invariant 1).

import { connection, type Db, withTenant } from "@countersign/db";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PackRefusal, type PackToolContext } from "../pack";
import { contentPage, contentPublish, contentVersion } from "../schema";
import { insertMarketingClient, type MarketingClient } from "../testing.test-helper";
import { AREA } from "./index";
import type { SignedWrite, SignedWriteRequest } from "./publish";
import { pageDetail } from "./store";
import { contentDraftTool, contentGetTool } from "./tools";

const online = await databaseAvailable();

describe.skipIf(!online)("content (guides, claims, publishing)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: MarketingClient;
  let B: MarketingClient;

  const action = (name: string) => {
    const a = AREA.ACTIONS[name];
    if (!a) throw new Error(`no action ${name}`);
    return a;
  };
  const run = async (
    c: MarketingClient,
    name: string,
    input: Record<string, unknown>,
    signedWrite?: SignedWrite,
  ) =>
    action(name).run(db, {
      tenantId: c.tenantId,
      userId: c.userId,
      input: action(name).input.parse(input),
      ...(signedWrite ? { signedWrite } : {}),
    } as Parameters<ReturnType<typeof action>["run"]>[1]);

  /** A signed write that records what it was asked and answers done (or the given failure). */
  function fakeSigner(fail?: string) {
    const calls: SignedWriteRequest[] = [];
    const signer: SignedWrite = async (req) => {
      calls.push(req);
      return fail
        ? { status: "failed", actionId: null, error: `WebsiteSetupError: ${fail}` }
        : { status: "done", actionId: A.externalActionId, output: { written: true } };
    };
    return { calls, signer };
  }

  const toolCtx = (c: MarketingClient): PackToolContext => ({
    tenantId: c.tenantId,
    agentVersionId: c.agentVersionId,
    runId: c.runId,
    mode: "live",
    settings: {},
    db,
    llm: null,
  });

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("no database");
    t = created;
    db = t.db;
    A = await insertMarketingClient(db, "Client A", "a-site.example.com");
    B = await insertMarketingClient(db, "Client B", "b-site.example.com");
  });
  afterAll(async () => {
    await t?.drop();
  });

  let pageId = "";

  it("creates a guide at a fixed address with a first version", async () => {
    const r = await run(A, "create-page", { site: A.siteId, slug: "approval-basics", title: "x" });
    expect(r.path).toBe("/guides/approval-basics");
    pageId = String(r.pageId);
    await expect(
      run(A, "create-page", { site: A.siteId, slug: "approval-basics" }),
    ).rejects.toBeInstanceOf(PackRefusal);
    await expect(run(A, "create-page", { site: A.siteId, slug: "Bad Slug" })).rejects.toThrow();
  });

  it("saves each edit as a new version, never changing an old one", async () => {
    const saved = await run(A, "save-version", {
      page: pageId,
      title: "How approvals work",
      description: "Every change waits for a person to sign it, with the before and after.",
      body: "## Why\n\nA change waits for you. Our agents are AI-powered!",
      targetQueries: ["approval workflow"],
    });
    expect(saved.version).toBe(2);
    const detail = await withTenant(db, A.tenantId, (tx) => pageDetail(tx, A.tenantId, pageId));
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail?.check?.publishable).toBe(false);
    expect(detail?.check?.problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(["claims_exclamation", "claims_ai_powered"]),
    );
    expect(detail?.queries).toEqual([
      { query: "approval workflow", impressions: 0, clicks: 0, position: null, inTitle: false },
    ]);
  });

  it("refuses to publish while a check refuses, and never reaches the signed write", async () => {
    const { calls, signer } = fakeSigner();
    await withTenant(db, A.tenantId, async (tx) => {
      await tx
        .update(connection)
        .set({ config: { domain: "a-site.example.com" } })
        .where(eq(connection.id, A.connectionId));
    });
    await expect(run(A, "publish", { page: pageId }, signer)).rejects.toThrow(/Not published:/);
    expect(calls).toHaveLength(0);
  });

  it("keeps the claims list per client and checks against its newest version", async () => {
    const list = {
      title: "A's list",
      never: [{ id: "no-guarantee", text: "No guarantees", phrases: ["guaranteed"] }],
    };
    await run(A, "seed-claims", { list });
    await expect(run(A, "seed-claims", { list })).rejects.toBeInstanceOf(PackRefusal);
    const v2 = await run(A, "save-claims", { list: { ...list, title: "A's list, v2" } });
    expect((v2.claims as { version: number }).version).toBe(2);
    const checked = await run(A, "check", {
      page: pageId,
      title: "Results guaranteed",
      description: "d",
      body: "Words.",
    });
    expect((checked.problems as { code: string }[]).map((p) => p.code)).toContain(
      "claims_no-guarantee",
    );
    // B has no list: the same words pass its checks but for the house rules.
    const bPage = await run(B, "create-page", { site: B.siteId, slug: "b-guide", title: "B" });
    const bChecked = await run(B, "check", {
      page: String(bPage.pageId),
      title: "Results guaranteed",
      description: "d",
      body: "Words.",
    });
    expect((bChecked.problems as { code: string }[]).map((p) => p.code)).not.toContain(
      "claims_no-guarantee",
    );
  });

  it("refuses to publish when the website connection points elsewhere", async () => {
    await run(A, "save-version", {
      page: pageId,
      title: "How approvals work",
      description: "Every change waits for a person to sign it, with the before and after.",
      body: "## Why\n\nA change waits for you. See [why](#why).",
    });
    await withTenant(db, A.tenantId, (tx) =>
      tx
        .update(connection)
        .set({ config: { domain: "elsewhere.example.com" } })
        .where(eq(connection.id, A.connectionId)),
    );
    const { calls, signer } = fakeSigner();
    await expect(run(A, "publish", { page: pageId }, signer)).rejects.toThrow(/publishes to/);
    expect(calls).toHaveLength(0);
    const pointed = await run(A, "set-website", { site: A.siteId });
    expect((pointed.website as { domain: string }).domain).toBe("a-site.example.com");
  });

  it("records nothing when the signed write fails (publishing isn't set up)", async () => {
    const { calls, signer } = fakeSigner("publishing isn't set up");
    await expect(run(A, "publish", { page: pageId }, signer)).rejects.toThrow(
      "Not published: publishing isn't set up.",
    );
    expect(calls).toHaveLength(1);
    const rows = await db.select().from(contentPublish).where(eq(contentPublish.pageId, pageId));
    expect(rows).toHaveLength(0);
  });

  it("publishes through one signed website.publish and records who signed it", async () => {
    const { calls, signer } = fakeSigner();
    const r = await run(A, "publish", { page: pageId }, signer);
    expect(r).toMatchObject({
      status: "published",
      url: "https://a-site.example.com/guides/approval-basics",
      version: 3,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0] as SignedWriteRequest;
    expect(call.tool).toBe("website.publish");
    expect(call.connectionId).toBe(A.connectionId);
    expect(call.input).toMatchObject({
      action: "publish",
      slug: "approval-basics",
      title: "How approvals work",
      redirects: [],
    });
    expect(String(call.input.html)).toContain('<h2 id="why">Why</h2>');
    expect(call.idempotencyKey).toMatch(/^marketing:publish:/);
    const [page] = await db.select().from(contentPage).where(eq(contentPage.id, pageId));
    expect(page?.status).toBe("published");
    const [publish] = await db
      .select()
      .from(contentPublish)
      .where(eq(contentPublish.pageId, pageId));
    expect(publish).toMatchObject({
      action: "publish",
      byUserId: A.userId,
      externalActionId: A.externalActionId,
    });
  });

  it("refuses a redirect from a live guide, and unpublishes it through the same tool", async () => {
    await expect(
      run(A, "add-redirect", { site: A.siteId, from: "/guides/approval-basics", to: "/" }),
    ).rejects.toThrow(/live guide/);
    const { calls, signer } = fakeSigner();
    const r = await run(A, "unpublish", { page: pageId }, signer);
    expect(r.status).toBe("unpublished");
    expect(calls[0]?.input).toMatchObject({ action: "unpublish", slug: "approval-basics" });
    const redirect = await run(A, "add-redirect", {
      site: A.siteId,
      from: "/guides/approval-basics",
      to: "/",
    });
    expect(redirect.redirects).toEqual([{ from: "/guides/approval-basics", to: "/" }]);
    await expect(run(A, "unpublish", { page: pageId }, signer)).rejects.toThrow(/isn't live/);
  });

  it("lets an agent draft a version with its agent version, run and sources, never a publish", async () => {
    const out = await contentDraftTool.run(
      {
        slug: "month-end-close",
        title: "Month-end close, step by step",
        description: "What a month-end close needs, and which steps agents can prepare for you.",
        body: "## Steps\n\nReconcile, review, sign.",
        targetQueries: ["month end close checklist"],
        why: "The query has impressions and no page answers it.",
        sources: ["search_query_daily: month end close checklist"],
      },
      toolCtx(A),
    );
    const o = out as { pageId: string; version: number; check: { publishable: boolean } };
    expect(o.version).toBe(1);
    expect(o.check.publishable).toBe(true);
    const [v] = await db
      .select()
      .from(contentVersion)
      .where(and(eq(contentVersion.pageId, o.pageId), eq(contentVersion.version, 1)));
    expect(v).toMatchObject({ authorAgentVersionId: A.agentVersionId, runId: A.runId });
    expect(v?.authorUserId).toBeNull();
    expect(v?.why).toContain("Sources:\n- search_query_daily: month end close checklist");
    const [p] = await db.select().from(contentPage).where(eq(contentPage.id, o.pageId));
    expect(p?.status).toBe("draft");
    await expect(
      (async () =>
        contentDraftTool.run(
          { slug: "x", title: "t", description: "d", body: "b", why: "w", sources: [] },
          toolCtx(A),
        ))(),
    ).rejects.toThrow();
  });

  it("gives the agent the guides and the claims list as data", async () => {
    const out = (await contentGetTool.run({ path: "/guides/month-end-close" }, toolCtx(A))) as {
      page: { title: string } | null;
      claims: { never: string[] } | null;
      pages: unknown[];
    };
    expect(out.page?.title).toBe("Month-end close, step by step");
    expect(out.claims?.never).toEqual(["No guarantees"]);
    expect(out.pages.length).toBe(2);
  });

  it("keeps one client's guides from another (as the Worker's role)", async () => {
    const seen = await withTenant(db, B.tenantId, async (tx) => {
      await asWorker(tx);
      return {
        mine: await pageDetail(tx, B.tenantId, pageId),
        theirs: await pageDetail(tx, A.tenantId, pageId),
        list: await AREA.REPORTS.content?.json(tx, B.tenantId, "2026-11-08", {}),
      };
    });
    expect(seen.mine).toBeNull();
    expect(seen.theirs).toBeNull();
    expect((seen.list as { pages: { path: string }[] }).pages.map((p) => p.path)).toEqual([
      "/guides/b-guide",
    ]);
    await expect(
      run(B, "save-version", { page: pageId, title: "t", description: "d", body: "b" }),
    ).rejects.toBeInstanceOf(PackRefusal);
    await expect(run(B, "publish", { page: pageId }, fakeSigner().signer)).rejects.toThrow(
      /isn't one of this client's/,
    );
    // B can't point its website connection at A's site.
    await expect(run(B, "set-website", { site: A.siteId })).rejects.toBeInstanceOf(PackRefusal);
    await expect(
      withTenant(db, B.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.insert(contentVersion).values({
          tenantId: B.tenantId,
          pageId,
          version: 9,
          title: "x",
          description: "y",
          bodyMd: "z",
          authorUserId: B.userId,
        });
      }),
    ).rejects.toThrow();
  });

  it("renders a version for a preview link, only for its own client", async () => {
    const [v] = await db.select().from(contentVersion).where(eq(contentVersion.pageId, pageId));
    const preview = AREA.REPORTS["content-preview"];
    const mine = await withTenant(db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return preview?.item?.(tx, A.tenantId, String(v?.id), "2026-11-08", {});
    });
    expect(mine).toMatchObject({ path: "/guides/approval-basics", domain: "a-site.example.com" });
    const theirs = await withTenant(db, B.tenantId, async (tx) => {
      await asWorker(tx);
      return preview?.item?.(tx, B.tenantId, String(v?.id), "2026-11-08", {});
    });
    expect(theirs).toBeNull();
  });
});
