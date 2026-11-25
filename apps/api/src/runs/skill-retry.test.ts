// PLATFORM_QA STATE-8: Cloudflare Workflows retrying a skill step whose work already ran. A durable step that
// times out (STEP_CONFIG: 15 minutes) or whose Worker is evicted before its result is stored is
// run again by the engine; the executor's `attempt` then re-runs the whole skill. External writes
// are found again by their idempotency keys, but internal (platform) writes are not.
import { AgentBundle, type AgentBundleInput, SkillDefinition } from "@countersign/core";
import { agent, inboxItem } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, FakeWorkflowStep, OPERATOR } from "../api.test-helper";
import { credentialsFor, executeRun } from "./execute";
import type { CloudflareStepConfig, WorkflowStepLike } from "./step-runner";
import { cloudflareStepRunner } from "./step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const SKILL = "qa.state.ask-for-statement";
const ask = SkillDefinition.parse({
  schemaVersion: 1,
  id: SKILL,
  name: "Ask for the statement",
  description: "Ask the client's admin for the month's bank statement",
  category: "test",
  mode: "agent",
  instructions: "Ask the client's admin for the bank statement, then finish.",
  tools: ["inbox.create"],
  input: { type: "object", properties: {} },
  output: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
});

const h = await createApiHarness({ skills: [ask] });
afterAll(() => h?.close());

/** The engine as it behaves when a step's first try ran its work but its result was lost. */
class RetryOnce implements WorkflowStepLike {
  readonly inner = new FakeWorkflowStep();
  constructor(private readonly target: string) {}
  async do(
    name: string,
    a: CloudflareStepConfig | ((ctx?: { attempt?: number }) => Promise<unknown>),
    b?: (ctx?: { attempt?: number }) => Promise<unknown>,
  ): Promise<unknown> {
    const fn = typeof a === "function" ? a : b;
    if (name === this.target && fn && !this.inner.results.has(name)) {
      // Try 1 does its work, then the step times out (or the Worker is evicted): no result kept.
      await fn({ attempt: 1 });
      const config = typeof a === "function" ? undefined : a;
      // Try 2: the engine's retry of the same step.
      return config
        ? this.inner.do(name, config, () => fn({ attempt: 2 }))
        : this.inner.do(name, () => fn({ attempt: 2 }));
    }
    return typeof a === "function" ? this.inner.do(name, a) : this.inner.do(name, a, b as never);
  }
  sleep(name: string) {
    return this.inner.sleep(name);
  }
  waitForEvent(name: string, options: { type: string; timeout?: string | number }) {
    return this.inner.waitForEvent(name, options);
  }
}

describe.skipIf(!h)("STATE: an engine retry of a skill step", () => {
  const H = h as ApiHarness;

  it("(PLATFORM_QA STATE-8) a skill step retried by the engine after its work ran asks the client once (no second inbox item)", async () => {
    const bundle = AgentBundle.parse({
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Bookkeeper", role: "keeps the books", mission: "books closed on time" },
        kind: "functional",
        model: { id: "claude-opus-5-5", maxTokens: 1024 },
        instructions: "Only do what the workflow says.",
        skills: [{ skill: SKILL, settings: {} }],
        extraTools: [],
        canCommand: [],
        permissions: { mode: "act" },
        budgets: { maxSteps: 6, maxCostUsd: "0.10" },
        memory: { enabled: false },
      },
      workflows: [
        {
          slug: "main",
          name: "Month end",
          workflow: {
            schemaVersion: 5,
            triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
            outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
            steps: [
              {
                id: "ask",
                name: "Ask for the statement",
                client: { visible: true, label: "Asked for the statement" },
                kind: "do",
                doneBy: "ai",
                uses: { type: "skill", skill: "qa.state.ask-for-statement" },
                input: {},
              },
              { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
            ],
          },
        },
      ],
    } as AgentBundleInput);
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "state-8-bookkeeper",
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const version = j(created.json).version.id as string;
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${version}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");

    const title = "Please send the May bank statement";
    const turns = () => [
      { toolUse: { name: "inbox__create", input: { title, details: "For the May close." } } },
      { toolUse: { name: "finish", input: { answer: "Asked for the statement" } } },
    ];
    const model = new FakeModel([...turns(), ...turns()]);
    const result = await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: model,
        instances: H.instances,
        credentials: credentialsFor(H.db, { current: "unused-in-this-test-000000000000000" }),
      },
      params,
      cloudflareStepRunner(new RetryOnce("ask")),
    );
    expect(result).toEqual({ status: "succeeded" });
    const items = await H.t.db
      .select({ id: inboxItem.id })
      .from(inboxItem)
      .where(and(eq(inboxItem.runId, params.runId), eq(inboxItem.title, title)));
    // The client's admin is asked once, however many times the engine ran the step.
    expect(items).toHaveLength(1);
  });
});
