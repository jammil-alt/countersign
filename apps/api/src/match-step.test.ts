// The step model §7, wired (stream A on stream D's engine): a v5 agent's Match step runs on the
// deployment's Match engine through the API. A hybrid Vendors match the model isn't sure of goes
// to a person, whose answer matches the item and is learned, so the next run's same wording is an
// exact hit with no model and no person. The step's output carries its evidence (invariant 10).
// For a client in HIPAA mode the engine's model call is refused (the guarded transport) and the
// item waits for a person instead.

import { agent, modelCall, stepRun, tenant, vendor } from "@countersign/db";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const bundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "AP clerk", role: "enters bills", mission: "Bills in on time." },
    kind: "functional",
    model: { id: "claude-opus-5-5", maxTokens: 1024 },
    instructions: "Only do what the workflow says.",
    skills: [],
    extraTools: [],
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
        schemaVersion: 5,
        triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
        outputs: [{ id: "o_done", name: "Done", kind: "nothing" }],
        steps: [
          {
            id: "s_match",
            kind: "do",
            name: "Find the vendor",
            doneBy: "rules",
            uses: { type: "match", match: { to: "vendors", type: "hybrid" } },
            input: { items: "{{trigger.vendors}}" },
          },
          { id: "s_end", kind: "end", name: "Done", outputs: ["o_done"] },
        ],
      },
    },
  ],
};

const choose = (recordId: string, confidence: number): FakeTurn => ({
  toolUse: {
    name: "record_choice",
    input: { record_id: recordId, confidence, reason: "Same name, shorter." },
  },
});

describe.skipIf(!h)("a v5 Match step through the API", () => {
  const H = h as ApiHarness;
  let northline = "";
  let northlineB = "";

  /** Answers each person's question with `answer`, as the client's admin. */
  const answering = (client: "a" | "b", answer: () => string, asked: string[] = []) =>
    new FakeWorkflowStep(async (_name, type) => {
      const res = await H.call(admin(client), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      asked.push(item.title);
      const done = await H.call(admin(client), "POST", `/api/inbox/${item.id}/resolve`, {
        answer: answer(),
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });

  async function agentFor(tenantId: string, slug: string) {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/agents`, {
      slug,
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const version = j(created.json).version.id as string;
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${version}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    return id;
  }

  async function run(
    agentId: string,
    client: "a" | "b",
    vendors: unknown[],
    model: FakeModel,
    asked: string[],
    extra: Record<string, unknown> = {},
  ) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
      input: { vendors },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const deps = { db: H.db, platform: H.platform, transport: model, ...extra };
    const result = await executeRun(
      deps,
      params,
      cloudflareStepRunner(
        answering(client, () => (client === "a" ? northline : northlineB), asked),
      ),
    );
    const [row] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "s_match")));
    return { params, result, row };
  }

  beforeAll(async () => {
    const add = async (tenantId: string, name: string) => {
      const [v] = await H.t.db
        .insert(vendor)
        .values({ tenantId, name, normalizedName: name.toLowerCase() })
        .returning();
      return v?.id ?? "";
    };
    northline = await add(H.A.tenantId, "Northline Panel Supply");
    await add(H.A.tenantId, "Northline Hardware");
    northlineB = await add(H.B.tenantId, "Northline Panel Supply");
  });

  it("asks a person what the model isn't sure of, and learns the answer", async () => {
    const id = await agentFor(H.A.tenantId, "v5-matcher");
    const model = new FakeModel([choose(northline, 0.6)]);
    const asked: string[] = [];
    const first = await run(id, "a", [{ name: "Northline Panel" }], model, asked);
    expect(first.result).toMatchObject({ status: "succeeded", nodeId: "s_end" });
    expect(model.requests).toHaveLength(1);
    expect(asked).toEqual(['Vendors: which one is "Northline Panel"?']);
    expect(first.row).toMatchObject({ nodeType: "skill", status: "succeeded" });
    const out = first.row?.output as {
      items: { matched: string; how: string }[];
      sources: string[];
    };
    expect(out.items[0]).toMatchObject({ matched: northline, how: "person" });
    expect(out.sources).toContain(northline);
    // The model's call is the step's own.
    const calls = await H.t.db
      .select()
      .from(modelCall)
      .where(eq(modelCall.runId, first.params.runId));
    expect(calls.map((c) => c.action)).toEqual(["choice"]);
    const [taught] = await H.t.db.select().from(vendor).where(eq(vendor.id, northline));
    expect(taught?.aliases).toContain("northline panel");

    // Next time the same wording is an exact hit: no model, no person.
    const again: string[] = [];
    const quiet = new FakeModel([]);
    const second = await run(id, "a", [{ name: "Northline Panel" }], quiet, again);
    expect(second.result.status).toBe("succeeded");
    expect(quiet.requests).toHaveLength(0);
    expect(again).toEqual([]);
    expect((second.row?.output as { items: unknown[] } | undefined)?.items[0]).toMatchObject({
      matched: northline,
      how: "learned",
    });
  });

  it("refuses the model for a client in HIPAA mode: the item waits for a person", async () => {
    const [b] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.B.tenantId));
    await H.t.db
      .update(tenant)
      .set({ settings: { ...(b?.settings ?? {}), compliance: { hipaa: true } } })
      .where(eq(tenant.id, H.B.tenantId));
    const id = await agentFor(H.B.tenantId, "v5-matcher-b");
    const model = new FakeModel([choose("anything", 0.99)]);
    const asked: string[] = [];
    const { result, row } = await run(id, "b", [{ name: "Northline Panel" }], model, asked, {
      covered: new Set(["cloudflare", "neon", "workos"]),
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "succeeded" });
    expect(model.requests).toHaveLength(0);
    expect(asked).toHaveLength(1);
    expect(row?.status).toBe("succeeded");
    expect((row?.output as { items: unknown[] } | undefined)?.items[0]).toMatchObject({
      matched: northlineB,
      how: "person",
    });
  });
});
