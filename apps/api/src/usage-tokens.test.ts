// Tokens by client, agent, model and action (docs/plan.md §1.62) over a throwaway database: model
// calls of every action (Sloan's portal question recorded through its own path), reading no agent
// asked for, the account-level tally per client, the filters, the scope of the operator's clients,
// and that only operators read it.

import { createHash } from "node:crypto";
import { ACCOUNT_AGENT_SLUG, type ModelCallAction } from "@countersign/core";
import {
  agent,
  agentVersion,
  docExtraction,
  document,
  modelCall,
  run,
  stepRun,
  withTenant,
} from "@countersign/db";
import { MODELS, ZERO_USAGE } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, testBundle } from "./api.test-helper";
import { recordAskUsage } from "./runs-ask/usage";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const RANGE = "from=2026-11-01&to=2026-11-30";

describe.skipIf(!h)("tokens by client, agent, model and action", () => {
  const H = h as NonNullable<typeof h>;
  const db = H.t.db;

  async function clientAgent(tenantId: string, slug: string, name: string) {
    const [a] = await db.insert(agent).values({ tenantId, kind: "client", slug, name }).returning();
    if (!a) throw new Error("no agent");
    const [v] = await db
      .insert(agentVersion)
      .values({
        tenantId,
        agentId: a.id,
        version: 1,
        bundle: testBundle(name),
        bundleHash: `hash-${tenantId}-${slug}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await db.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, a.id));
    return { agentId: a.id, versionId: v.id };
  }

  /** One run of an agent with one step and its model calls. */
  async function calls(
    tenantId: string,
    who: { agentId: string; versionId: string },
    at: string,
    list: {
      model: string;
      action: ModelCallAction;
      tokensIn: number;
      tokensOut: number;
      cost: string;
    }[],
  ) {
    const [r] = await db
      .insert(run)
      .values({
        tenantId,
        agentId: who.agentId,
        agentVersionId: who.versionId,
        workflowSlug: "work",
        mode: "live",
        status: "succeeded",
        createdAt: new Date(at),
      })
      .returning();
    if (!r) throw new Error("no run");
    const [s] = await db
      .insert(stepRun)
      .values({ tenantId, runId: r.id, nodeId: "s1", nodeType: "skill", status: "succeeded" })
      .returning();
    if (!s) throw new Error("no step");
    for (const c of list) {
      const id = crypto.randomUUID();
      await db.insert(modelCall).values({
        id,
        tenantId,
        runId: r.id,
        stepRunId: s.id,
        agentVersionId: who.versionId,
        provider: "x",
        model: c.model,
        action: c.action,
        tokensIn: c.tokensIn,
        tokensOut: c.tokensOut,
        costUsd: c.cost,
        durationMs: 10,
        stopReason: "end_turn",
        bodyKey: `tenants/${tenantId}/model-calls/${id}.json`,
        createdAt: new Date(at),
      });
    }
  }

  it("tallies every call per client, agent, model and action", async () => {
    const clerk = await clientAgent(H.A.tenantId, "bill-clerk", "Bill clerk");
    const sloan = await clientAgent(H.A.tenantId, ACCOUNT_AGENT_SLUG, "Sloan");
    const otherB = await clientAgent(H.B.tenantId, "bill-clerk", "Bill clerk");
    const notServed = await clientAgent(H.C.tenantId, "bill-clerk", "Bill clerk");
    await calls(H.A.tenantId, clerk, "2026-11-02T10:00:00Z", [
      {
        model: MODELS.gemini,
        action: "agent_turn",
        tokensIn: 1000,
        tokensOut: 100,
        cost: "0.0100",
      },
      { model: MODELS.gemini, action: "agent_turn", tokensIn: 500, tokensOut: 50, cost: "0.0050" },
      { model: MODELS.grok, action: "oversight", tokensIn: 300, tokensOut: 30, cost: "0.0020" },
      { model: MODELS.sonnet, action: "tool_call", tokensIn: 200, tokensOut: 20, cost: "0.0010" },
    ]);
    // Sloan's conversation, and one call outside the range.
    await calls(H.A.tenantId, sloan, "2026-11-03T10:00:00Z", [
      { model: MODELS.haiku, action: "agent_turn", tokensIn: 400, tokensOut: 40, cost: "0.0001" },
    ]);
    await calls(H.A.tenantId, clerk, "2026-10-31T23:59:59Z", [
      { model: MODELS.gemini, action: "agent_turn", tokensIn: 9, tokensOut: 9, cost: "9.0000" },
    ]);
    await calls(H.B.tenantId, otherB, "2026-11-04T10:00:00Z", [
      { model: MODELS.gpt, action: "reach_out", tokensIn: 100, tokensOut: 10, cost: "0.0030" },
    ]);
    await calls(H.C.tenantId, notServed, "2026-11-04T10:00:00Z", [
      { model: MODELS.gpt, action: "agent_turn", tokensIn: 1, tokensOut: 1, cost: "1.0000" },
    ]);
    // A portal question, recorded as Sloan's through its own path.
    const askRun = await withTenant(H.db, H.A.tenantId, (tx) =>
      recordAskUsage(tx, {
        surface: "portal",
        tenantId: H.A.tenantId,
        userId: "u1",
        question: "What failed?",
        record: {
          model: MODELS.haiku,
          ok: true,
          usage: { ...ZERO_USAGE, inputTokens: 150, cacheReadTokens: 50, outputTokens: 15 },
          costUsd: "0.000020",
          durationMs: 30,
          stopReason: "tool_use",
        },
        filter: null,
        refused: "not understood",
      }),
    );
    const [asked] = await db
      .select()
      .from(modelCall)
      .where(eq(modelCall.runId, askRun as string));
    expect(asked).toMatchObject({
      action: "question",
      provider: "anthropic",
      tokensIn: 200,
      tokensOut: 15,
      costUsd: "0.0001",
      agentVersionId: sloan.versionId,
    });
    // Background reading of an upload: the client's, no agent's.
    const [d] = await db
      .insert(document)
      .values({
        tenantId: H.A.tenantId,
        source: "upload",
        storageKey: "tenants/a/up.pdf",
        mimeType: "application/pdf",
        filename: "up.pdf",
        sizeBytes: 10,
        sha256: createHash("sha256").update("up").digest("hex"),
      })
      .returning();
    await db.insert(docExtraction).values({
      tenantId: H.A.tenantId,
      documentId: d?.id as string,
      model: MODELS.geminiFlash,
      agentVersionId: null,
      header: {},
      currency: "USD",
      subtotal: "10.0000",
      total: "10.0000",
      linesSum: "10.0000",
      totalsMatch: true,
      tokensIn: 1200,
      tokensOut: 300,
      costUsd: "0.0125",
      createdAt: new Date("2026-11-05T10:00:00Z"),
    });

    const res = await H.call(OPERATOR, "GET", `/api/ops/usage/tokens?${RANGE}`);
    expect(res.status).toBe(200);
    const r = j(res.json);
    // A and B only: C isn't this operator's; October's call is out of range.
    expect(r.total).toEqual({
      calls: 8,
      tokensIn: 1000 + 500 + 300 + 200 + 400 + 200 + 1200 + 100,
      tokensOut: 100 + 50 + 30 + 20 + 40 + 15 + 300 + 10,
      costUsd: "0.0337",
    });
    expect(r.byClient.map((c: { id: string; calls: number }) => [c.id, c.calls])).toEqual([
      [H.A.tenantId, 7],
      [H.B.tenantId, 1],
    ]);
    const agentRow = (id: string | null) =>
      r.byAgent.find((a: { agent: { id: string } | null }) => (a.agent?.id ?? null) === id);
    expect(agentRow(sloan.agentId)).toMatchObject({
      agent: { name: "Sloan", account: true },
      calls: 2,
      tokensIn: 600,
      costUsd: "0.0002",
    });
    expect(agentRow(clerk.agentId)).toMatchObject({ agent: { account: false }, calls: 4 });
    expect(agentRow(null)).toMatchObject({ client: { id: H.A.tenantId }, calls: 1 });
    expect(r.byModel[0]).toMatchObject({
      provider: "google",
      model: MODELS.gemini,
      calls: 2,
      tokensIn: 1500,
      costUsd: "0.0150",
    });
    expect(r.byModel.map((m: { model: string }) => m.model).sort()).toEqual(
      [
        MODELS.gemini,
        MODELS.geminiFlash,
        MODELS.grok,
        MODELS.sonnet,
        MODELS.haiku,
        MODELS.gpt,
      ].sort(),
    );
    expect(
      Object.fromEntries(
        r.byAction.map((a: { action: string; calls: number }) => [a.action, a.calls]),
      ),
    ).toEqual({
      agent_turn: 3,
      oversight: 1,
      tool_call: 1,
      question: 1,
      reach_out: 1,
      background_read: 1,
    });
    expect(r.rows[0]).toMatchObject({
      client: { id: H.A.tenantId },
      agent: { id: clerk.agentId },
      model: MODELS.gemini,
      action: "agent_turn",
      calls: 2,
    });

    // Narrowed: to Sloan, to a model, to an action, to a client.
    const s = j(
      (await H.call(OPERATOR, "GET", `/api/ops/usage/tokens?${RANGE}&agent=${sloan.agentId}`)).json,
    );
    expect(s.total).toMatchObject({ calls: 2, tokensIn: 600 });
    expect(s.byAction.map((a: { action: string }) => a.action).sort()).toEqual([
      "agent_turn",
      "question",
    ]);
    const g = j(
      (await H.call(OPERATOR, "GET", `/api/ops/usage/tokens?${RANGE}&model=${MODELS.grok}`)).json,
    );
    expect(g.total).toMatchObject({ calls: 1, costUsd: "0.0020" });
    const bg = j(
      (await H.call(OPERATOR, "GET", `/api/ops/usage/tokens?${RANGE}&action=background_read`)).json,
    );
    expect(bg.rows).toEqual([
      expect.objectContaining({ agent: null, model: MODELS.geminiFlash, provider: "google" }),
    ]);
    const b = j(
      (await H.call(OPERATOR, "GET", `/api/ops/usage/tokens?${RANGE}&client=${H.B.tenantId}`)).json,
    );
    expect(b.total).toMatchObject({ calls: 1, costUsd: "0.0030" });

    // The other operator sees C alone; C isn't this operator's to ask for.
    const c = j((await H.call(OTHER_OPERATOR, "GET", `/api/ops/usage/tokens?${RANGE}`)).json);
    expect(c.byClient.map((x: { id: string }) => x.id)).toEqual([H.C.tenantId]);
    expect(
      (await H.call(OPERATOR, "GET", `/api/ops/usage/tokens?client=${H.C.tenantId}`)).status,
    ).toBe(403);
  });

  it("is the operator's only, and checks the range", async () => {
    expect((await H.call(admin("a"), "GET", "/api/ops/usage/tokens")).status).toBe(403);
    const bad = async (q: string) =>
      (await H.call(OPERATOR, "GET", `/api/ops/usage/tokens?${q}`)).status;
    expect(await bad("from=2026-11-03&to=2026-11-01")).toBe(422);
    expect(await bad("action=chat")).toBe(400);
    const d = j((await H.call(OPERATOR, "GET", "/api/ops/usage/tokens")).json);
    expect(d.from.slice(8)).toBe("01");
  });
});
