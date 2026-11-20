// Card numbers (invariant 14, "Card numbers are never stored"; docs/plan.md §1.35) in a run's own
// records. A client agent reads a record from the client's tool (the testkit connector over its
// fake backend) and writes a change behind the client's approval, through the real runtime
// (`executeRun`), the gate and external actions. Model-call bodies are redacted
// (log/model-calls.ts), and so are tool calls and a change's states; a change whose input carries
// a card number is refused before anything is stored (PLATFORM_QA SEC-9).
import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { agent, connection, externalAction, run, toolCall } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, FakeWorkflowStep, OPERATOR } from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

const CARD = "4111 1111 1111 1111";
const CARD_DIGITS = /4111[ -]?1111[ -]?1111[ -]?1111/;

describe.skipIf(!h)("card numbers in a run's records", () => {
  const H = h as NonNullable<typeof h>;

  /** A client agent that reads record r1 and writes `write` to it; its run, the admin approving. */
  async function runWith(slug: string, write: Record<string, unknown>) {
    const bundle = {
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Records clerk", role: "keeps records", mission: "keep records right" },
        kind: "functional",
        model: { id: "claude-opus-5-5", maxTokens: 1024 },
        instructions: "Change records only when asked.",
        skills: [],
        extraTools: [TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL],
        canCommand: [],
        permissions: { mode: "act" },
        budgets: { maxSteps: 4, maxCostUsd: "0.10" },
        memory: { enabled: false },
      },
      workflows: [
        {
          slug: "main",
          name: "Main",
          workflow: {
            schemaVersion: 4,
            triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
            steps: [
              {
                id: "look",
                name: "Look up the record",
                kind: "read",
                tool: TESTKIT_QUERY_TOOL,
                input: { ids: ["r1"] },
                client: { visible: true, label: "Looked up the record" },
              },
              {
                id: "fix",
                name: "Update the record",
                kind: "write",
                tool: TESTKIT_UPDATE_TOOL,
                input: write,
                client: { visible: true, label: "Updated the record" },
              },
            ],
          },
        },
      ],
    };
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug,
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const agentId = j(created.json).agent.id as string;
    const version = j(created.json).version.id as string;
    const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    expect(op.status, JSON.stringify(op.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${version}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    const started = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const runId = j(started.json).runId as string;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    // The client's admin approves the write.
    const step = new FakeWorkflowStep(async (_name, type) => {
      const res = await H.call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    const result = await executeRun(
      { db: H.db, platform: H.platform, transport: new FakeModel(), instances: H.instances },
      params,
      cloudflareStepRunner(step),
    );
    const calls = await H.t.db
      .select({ tool: toolCall.tool, input: toolCall.input, output: toolCall.output })
      .from(toolCall)
      .where(eq(toolCall.tenantId, H.A.tenantId));
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId));
    return { runId, result, calls, actions };
  }

  it("(PLATFORM_QA SEC-9) a run stores no card number in tool_call or external_action, and its approved write still goes through", async () => {
    // The client's tool holds a record whose name carries a card (a vendor's note, say).
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: `Card on file ${CARD}`, amount: "10.00" }]);
    await H.t.db
      .update(connection)
      .set({ status: "connected" })
      .where(eq(connection.id, H.A.connectionId));
    const { result, calls, actions } = await runWith("sec-cards", { id: "r1", amount: "12.00" });
    expect(result, JSON.stringify(result)).toEqual({ status: "succeeded" });
    expect(calls.length).toBeGreaterThan(0);
    expect(actions.length).toBe(1);
    expect(actions[0]?.status).toBe("done");
    const stored = {
      toolCalls: calls,
      externalAction: actions.map((a) => ({ input: a.input, before: a.before, result: a.result })),
    };
    // As everywhere else a card number is kept: `[card ending 1111]`.
    expect(JSON.stringify(stored)).not.toMatch(CARD_DIGITS);
    expect(JSON.stringify(stored)).toContain("[card ending 1111]");
    // The approved write was made as approved, over the record as it was.
    expect(H.backend.get(H.A.connectionId, "r1")).toMatchObject({
      name: `Card on file ${CARD}`,
      amount: "12.00",
    });
  });

  it("(PLATFORM_QA SEC-9) a write whose input carries a card number is refused, and nothing is stored or written", async () => {
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
    const { runId, result, calls, actions } = await runWith("sec-cards-write", {
      id: "r1",
      name: `Paid by card ${CARD}`,
    });
    expect(result.status, JSON.stringify(result)).not.toBe("succeeded");
    expect(actions).toEqual([]);
    const [row] = await H.t.db.select().from(run).where(eq(run.id, runId));
    expect(row?.status).not.toBe("succeeded");
    const update = calls.find(
      (c) => c.tool === TESTKIT_UPDATE_TOOL && JSON.stringify(c.output).includes("card number"),
    );
    expect(update, JSON.stringify(calls)).toBeDefined();
    expect(JSON.stringify(calls)).not.toMatch(CARD_DIGITS);
    expect(H.backend.get(H.A.connectionId, "r1")).toMatchObject({ name: "Oak board" });
  });
});
