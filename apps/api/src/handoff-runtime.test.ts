// Hand off (owner, 2026-11-11; docs/plan.md §1.95), end to end in Node with the real runtime and
// database: a live run of AP bill clerk whose last step hands off to Price checker at its step 2.
// Price checker's run starts there with the mapped input, its trigger records the handoff, and
// both run pages say so; the handoff rules hold (never the same agent, at most three deep, the
// target started); a test run starts nothing.

import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { bundleHash } from "@countersign/core";
import { agent, agentVersion, connection, run, stepRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const MANUAL = { id: "trg-manual", on: { type: "manual", input: {} } };
const read = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: "read",
  tool: TESTKIT_QUERY_TOOL,
  input,
});

/** Price checker: pull bills, itemize the invoice, check prices (reads what itemize found). */
const PRICE_CHECKER = {
  schemaVersion: 4,
  triggers: [MANUAL],
  steps: [
    read("pull", "Pull bills from QuickBooks"),
    read("itemize", "Itemize the invoice", { nameContains: "{{trigger.name}}" }),
    read("check", "Check prices", {
      nameContains: "{{steps.itemize.output.records.length}} found",
    }),
  ],
};

/** AP bill clerk: read the invoice, then hand off to `to` at `step`. */
const apClerk = (to: string, step = "itemize") => ({
  schemaVersion: 4,
  triggers: [MANUAL],
  steps: [
    read("read", "Read the invoice"),
    {
      id: "hand",
      name: "Hand off",
      kind: "handoff",
      to: { agent: to, step },
      input: { nameContains: "{{trigger.vendor}}" },
    },
  ],
});

describe.skipIf(!h)("hand-off steps in apps/api", () => {
  const H = h as ApiHarness;
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });
  const ids = { clerk: "", checker: "", clerkVersion: "", checkerVersion: "" };

  /** Version `n` of an agent whose one workflow is `process` (versions are never changed). */
  async function version(agentId: string, n: number, name: string, process: unknown) {
    const bundle = testBundle(name);
    bundle.definition.extraTools = [TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL];
    const stored = {
      ...bundle,
      workflows: [{ slug: "main", name: "Main", enabled: true, workflow: process }],
    };
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId,
        version: n,
        // biome-ignore lint/suspicious/noExplicitAny: a v4 process is stored as written.
        bundle: stored as any,
        bundleHash: await bundleHash(stored),
        authorType: "operator",
      })
      .returning({ id: agentVersion.id });
    if (!v) throw new Error("no version");
    return v.id;
  }

  /** A live client agent of client A whose one workflow is `process`. */
  async function clientAgent(slug: string, serviceName: string, process: unknown) {
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug,
        name: serviceName,
        serviceName,
        status: "active",
        runStatus: "active",
        stage: "live",
        bindings: { testkit: H.A.connectionId },
      })
      .returning({ id: agent.id });
    if (!a) throw new Error("no agent");
    const v = await version(a.id, 1, serviceName, process);
    await H.t.db.update(agentVersion).set({ status: "live" }).where(eq(agentVersion.id, v));
    await H.t.db.update(agent).set({ liveVersionId: v }).where(eq(agent.id, a.id));
    return { id: a.id, version: v };
  }

  function params(
    over: Partial<RunParams> = {},
    trigger: RunParams["trigger"] = { triggerId: "trg-manual", type: "manual" },
  ): RunParams {
    return {
      runId: crypto.randomUUID(),
      tenantId: H.A.tenantId,
      agentId: ids.clerk,
      agentVersionId: ids.clerkVersion,
      workflowSlug: "main",
      mode: "live",
      trigger,
      payload: { vendor: "Acme" },
      ...over,
    };
  }

  const go = (p: RunParams) => executeRun(deps(), p, cloudflareStepRunner(new FakeWorkflowStep()));
  const startedFrom = (runId: string) =>
    [...H.instances.started.values()].filter(
      (p) => p.trigger.type === "handoff" && p.trigger.fromRunId === runId,
    );
  const rowsOf = (runId: string) => H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId));

  beforeAll(async () => {
    await H.t.db
      .update(connection)
      .set({
        status: "connected",
        permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
      })
      .where(eq(connection.id, H.A.connectionId));
    const checker = await clientAgent("price-checker", "Price checker", PRICE_CHECKER);
    const clerk = await clientAgent("ap-clerk", "AP bill clerk", apClerk("price-checker"));
    Object.assign(ids, {
      clerk: clerk.id,
      clerkVersion: clerk.version,
      checker: checker.id,
      checkerVersion: checker.version,
    });
  });

  beforeEach(async () => {
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, ids.checker));
  });

  it("lists the client's agents with their live steps for the builder", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/handoff-agents`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const checker = j(res.json).agents.find((a: { slug: string }) => a.slug === "price-checker");
    expect(checker).toMatchObject({ name: "Price checker", workflow: "main" });
    expect(checker.steps.map((s: { id: string; name: string }) => s.name)).toEqual([
      "Pull bills from QuickBooks",
      "Itemize the invoice",
      "Check prices",
    ]);
    expect(checker.steps[2].reads).toEqual(["itemize"]);
  });

  it("checks a saved version's hand-off against the client's agents, as the builder does", async () => {
    let n = 0;
    const save = async (process: unknown) => {
      const bundle = testBundle("AP bill clerk");
      bundle.definition.extraTools = [TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL];
      // Each save a new draft (an unchanged one is refused as a no-op).
      const name = `Main ${++n}`;
      const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.clerk}/versions`, {
        bundle: { ...bundle, workflows: [{ slug: "main", name, workflow: process }] },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return (j(res.json).errors as { code: string }[]).map((e) => e.code);
    };
    expect((await save(apClerk("price-checker"))).filter((c) => c.startsWith("handoff"))).toEqual(
      [],
    );
    expect(await save(apClerk("nowhere"))).toContain("handoff_unknown_agent");
    expect(await save(apClerk("price-checker", "gone"))).toContain("handoff_unknown_step");
    expect(await save(apClerk("ap-clerk", "read"))).toContain("handoff_same_agent");
  });

  it("starts Price checker at step 2 with the mapped input, and doesn't wait for it", async () => {
    const p = params();
    expect(await go(p)).toEqual({ status: "succeeded" });
    const [started] = startedFrom(p.runId);
    if (!started) throw new Error("nothing was handed off");
    expect(started).toMatchObject({
      agentId: ids.checker,
      agentVersionId: ids.checkerVersion,
      workflowSlug: "main",
      mode: "live",
      trigger: {
        type: "handoff",
        fromRunId: p.runId,
        depth: 1,
        at: "itemize",
        fromAgentId: ids.clerk,
      },
      payload: { at: "itemize", input: { nameContains: "Acme" }, depth: 1 },
    });
    // The sender's step: its output names the run, its line says so.
    const hand = (await rowsOf(p.runId)).find((r) => r.nodeId === "hand");
    expect(hand).toMatchObject({
      status: "succeeded",
      output: { runId: started.runId, agent: "price-checker", step: "itemize" },
    });
    expect(hand?.summary).toMatch(/^Handed off to Price checker \(run R-[0-9a-f]{6}\)$/);
    // Its run row records the handoff from the sender.
    const [row] = await H.t.db.select().from(run).where(eq(run.id, started.runId));
    expect(row?.trigger).toMatchObject({
      type: "handoff",
      fromRunId: p.runId,
      payload: { from: { agentId: ids.clerk, agentSlug: "ap-clerk", runId: p.runId } },
    });

    // Price checker's run starts at step 2: step 1 never runs, step 2 takes the input handed over.
    expect(await go(started)).toEqual({ status: "succeeded" });
    const rows = await rowsOf(started.runId);
    expect(rows.map((r) => r.nodeId).sort()).toEqual(["check", "itemize"]);
    expect(rows.find((r) => r.nodeId === "itemize")?.input).toEqual({ nameContains: "Acme" });

    // Both pages say so: the back office and the portal.
    const ops = await H.call(OPERATOR, "GET", `/api/ops/runs/${started.runId}`);
    expect(j(ops.json).handedOffFrom).toEqual({
      fromRunId: p.runId,
      fromAgent: "AP bill clerk",
      at: "2 · Itemize the invoice",
    });
    const portal = await H.call(admin("a"), "GET", `/api/runs/${started.runId}`);
    expect(portal.status, JSON.stringify(portal.json)).toBe(200);
    expect(j(portal.json).run.handedOffFrom).toEqual({
      fromRunId: p.runId,
      fromAgent: "AP bill clerk",
      at: "2 · Itemize the invoice",
    });
    const sender = await H.call(admin("a"), "GET", `/api/runs/${p.runId}`);
    const step = j(sender.json).steps.find((s: { handoff?: unknown }) => s.handoff);
    expect(step).toMatchObject({ handoff: { runId: started.runId } });
    expect(step.summary).toMatch(/Handed off to Price checker/);
  });

  it("never hands off to the same agent", async () => {
    const toItself = await version(ids.clerk, 100, "AP bill clerk", apClerk("ap-clerk", "read"));
    const p = params({ agentVersionId: toItself });
    expect(await go(p)).toMatchObject({
      status: "failed",
      reason: "a hand-off goes to another agent",
      nodeId: "hand",
    });
    expect(startedFrom(p.runId)).toEqual([]);
  });

  it("goes at most three handoffs deep", async () => {
    const deep = params(
      {},
      {
        triggerId: "trg-manual",
        type: "handoff",
        fromRunId: crypto.randomUUID(),
        depth: 3,
      },
    );
    expect(await go(deep)).toMatchObject({ status: "failed", nodeId: "hand" });
    expect(startedFrom(deep.runId)).toEqual([]);
    const two = params(
      {},
      {
        triggerId: "trg-manual",
        type: "handoff",
        fromRunId: crypto.randomUUID(),
        depth: 2,
      },
    );
    expect(await go(two)).toEqual({ status: "succeeded" });
    expect(startedFrom(two.runId)[0]?.trigger).toMatchObject({ depth: 3 });
  });

  it("a test run starts nothing and records what it would have handed off", async () => {
    const p = params({ mode: "test" });
    expect(await go(p)).toEqual({ status: "succeeded" });
    expect(startedFrom(p.runId)).toEqual([]);
    const hand = (await rowsOf(p.runId)).find((r) => r.nodeId === "hand");
    expect(hand).toMatchObject({ status: "succeeded", input: { nameContains: "Acme" } });
    expect(hand?.summary).toBe(
      "Would hand off to Price checker at 2 · Itemize the invoice (test run, nothing started)",
    );
  });

  it("fails plainly when Price checker isn't started", async () => {
    await H.t.db.update(agent).set({ runStatus: "paused" }).where(eq(agent.id, ids.checker));
    const p = params();
    expect(await go(p)).toMatchObject({
      status: "failed",
      reason: "Price checker isn't started, so the hand-off didn't run",
      nodeId: "hand",
    });
    expect(startedFrom(p.runId)).toEqual([]);
    const hand = (await rowsOf(p.runId)).find((r) => r.nodeId === "hand");
    expect(hand?.summary).toBe("Price checker isn't started, so the hand-off didn't run");
  });
});
