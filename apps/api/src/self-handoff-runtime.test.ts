// Ways in, ways out (owner, 2026-11-23), end to end in Node with the real runtime and database: an
// agent with two workflows, "Check an invoice" and "Scan QuickBooks bills". The scan is a second
// way in: for each bill it finds, it hands off to "Check an invoice" at its step 2, as a new run
// of the same agent on the scan's own version, instead of carrying a copy of those steps.

import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { bundleHash } from "@countersign/core";
import { agent, agentVersion, connection, run, stepRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  ended,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
  v5Workflow,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const read = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: "read",
  tool: TESTKIT_QUERY_TOOL,
  input,
});

/** Check an invoice: find the document, read the invoice, save what it found. */
const CHECK = {
  schemaVersion: 5,
  triggers: [{ id: "chk-manual", on: { type: "manual", input: {} } }],
  outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
  steps: [
    {
      id: "chk-find",
      name: "Find the document",
      kind: "do",
      doneBy: "rules",
      uses: { type: "action", action: TESTKIT_QUERY_TOOL },
      input: {},
    },
    {
      id: "chk-read",
      name: "Read the invoice",
      kind: "do",
      doneBy: "rules",
      uses: { type: "action", action: TESTKIT_QUERY_TOOL },
      input: { nameContains: "{{trigger.vendor}}" },
    },
    {
      id: "chk-save",
      name: "Save it",
      kind: "do",
      doneBy: "rules",
      uses: { type: "action", action: TESTKIT_QUERY_TOOL },
      input: { nameContains: "{{steps.chk-read.output.records.length}} found" },
    },
    { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
  ],
};

/** Scan QuickBooks bills: for each bill, hand off to Check an invoice at step 2. */
const scan = (to: Record<string, unknown>) =>
  v5Workflow(
    [
      read("scan-find", "Find last week's bills"),
      {
        id: "scan-each",
        name: "For each bill",
        kind: "for_each",
        over: "{{trigger.bills}}",
        steps: [
          {
            id: "scan-hand",
            name: "Hand off",
            kind: "handoff",
            to,
            input: { nameContains: "{{item.vendor}}" },
          },
        ],
      },
    ],
    { triggers: [{ id: "scan-manual", on: { type: "manual", input: {} } }] },
  );

const TO_CHECK = { agent: "@self", step: "chk-read", workflow: "check" };

const workflows = (scanProcess: unknown, check: unknown = CHECK) => [
  { slug: "check", name: "Check an invoice", enabled: true, workflow: check },
  { slug: "scan", name: "Scan QuickBooks bills", enabled: true, workflow: scanProcess },
];

describe.skipIf(!h)("hand-offs to the agent's own workflow in apps/api", () => {
  const H = h as ApiHarness;
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });
  const ids = { agent: "", live: "", older: "" };

  async function version(n: number, process: unknown) {
    const bundle = testBundle("Invoice checker");
    bundle.definition.extraTools = [TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL];
    const stored = { ...bundle, workflows: workflows(process) };
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId: ids.agent,
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

  const params = (over: Partial<RunParams> = {}): RunParams => ({
    runId: crypto.randomUUID(),
    tenantId: H.A.tenantId,
    agentId: ids.agent,
    agentVersionId: ids.older,
    workflowSlug: "scan",
    mode: "live",
    trigger: { triggerId: "scan-manual", type: "manual" },
    payload: { bills: [{ vendor: "Acme" }, { vendor: "Beta" }] },
    ...over,
  });
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
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug: "invoice-checker",
        name: "Invoice checker",
        serviceName: "Invoice checker",
        status: "active",
        runStatus: "active",
        stage: "live",
        bindings: { testkit: H.A.connectionId },
      })
      .returning({ id: agent.id });
    if (!a) throw new Error("no agent");
    ids.agent = a.id;
    // An older version the scan run is pinned to, and a newer live one: the hand-off stays on
    // the sending run's version.
    ids.older = await version(1, scan(TO_CHECK));
    ids.live = await version(2, scan(TO_CHECK));
    await H.t.db.update(agentVersion).set({ status: "live" }).where(eq(agentVersion.id, ids.live));
    await H.t.db.update(agent).set({ liveVersionId: ids.live }).where(eq(agent.id, a.id));
  });

  it("starts one run per bill, of the same agent and version, at Check an invoice's step 2", async () => {
    const p = params();
    expect(await go(p)).toEqual(ended());
    // The items run side by side: in the order of their node ids.
    const fromStep = (s: RunParams) => (s.trigger.type === "handoff" ? s.trigger.fromStep : "");
    const started = startedFrom(p.runId).sort((a, b) =>
      String(fromStep(a)).localeCompare(String(fromStep(b))),
    );
    expect(started.map(fromStep)).toEqual(["scan-each:0:scan-hand", "scan-each:1:scan-hand"]);
    expect(new Set(started.map((s) => s.runId)).size).toBe(2);
    for (const [i, s] of started.entries()) {
      expect(s).toMatchObject({
        agentId: ids.agent,
        agentVersionId: ids.older,
        workflowSlug: "check",
        mode: "live",
        trigger: {
          type: "handoff",
          fromRunId: p.runId,
          depth: 1,
          at: "chk-read",
          fromAgentId: ids.agent,
        },
        payload: {
          at: "chk-read",
          input: { nameContains: i === 0 ? "Acme" : "Beta" },
          from: { workflowSlug: "scan", workflowName: "Scan QuickBooks bills" },
        },
      });
    }
    // Each item's step says where its invoice went.
    const rows = await rowsOf(p.runId);
    for (const [i, s] of started.entries()) {
      const hand = rows.find((r) => r.nodeId === `scan-each:${i}:scan-hand`);
      expect(hand).toMatchObject({
        status: "succeeded",
        output: { runId: s.runId, agent: "@self", step: "chk-read", workflow: "check" },
      });
      expect(hand?.summary).toMatch(/^Handed off to Check an invoice \(run R-[0-9a-f]{6}\)$/);
    }

    // The run started skips step 1 and takes the bill handed over at step 2.
    const [first] = started;
    if (!first) throw new Error("nothing was handed off");
    const [row] = await H.t.db.select().from(run).where(eq(run.id, first.runId));
    expect(row).toMatchObject({ agentId: ids.agent, agentVersionId: ids.older });
    expect(await go(first)).toEqual(ended());
    const checkRows = await rowsOf(first.runId);
    expect(checkRows.map((r) => r.nodeId).sort()).toEqual(["chk-read", "chk-save"]);
    expect(checkRows.find((r) => r.nodeId === "chk-read")?.input).toEqual({
      nameContains: "Acme",
    });

    // Its pages name the workflow it came from: the back office and the portal.
    const from = {
      fromRunId: p.runId,
      fromAgent: "Scan QuickBooks bills",
      at: "2 · Read the invoice",
    };
    const ops = await H.call(OPERATOR, "GET", `/api/ops/runs/${first.runId}`);
    expect(j(ops.json).handedOffFrom).toEqual(from);
    const portal = await H.call(admin("a"), "GET", `/api/runs/${first.runId}`);
    expect(portal.status, JSON.stringify(portal.json)).toBe(200);
    expect(j(portal.json).run.handedOffFrom).toEqual(from);
  });

  it("a test run starts nothing and names the workflow it would have handed off to", async () => {
    const p = params({ mode: "test" });
    expect(await go(p)).toEqual(ended());
    expect(startedFrom(p.runId)).toEqual([]);
    const hand = (await rowsOf(p.runId)).find((r) => r.nodeId === "scan-each:0:scan-hand");
    expect(hand?.summary).toBe(
      "Would hand off to Check an invoice at 2 · Read the invoice (test run, nothing started)",
    );
  });

  it("refuses at run time a hand-off back into its own workflow", async () => {
    const own = await version(10, scan({ agent: "@self", step: "scan-find", workflow: "scan" }));
    const p = params({ agentVersionId: own });
    expect(await go(p)).toMatchObject({
      status: "failed",
      reason: "a hand-off goes to another of this agent's workflows, not back into its own",
    });
    expect(startedFrom(p.runId)).toEqual([]);
  });

  it("checks a saved version: no hand-off into its own workflow, no loop between workflows", async () => {
    let n = 0;
    const save = async (scanProcess: unknown, check: unknown = CHECK) => {
      const bundle = testBundle("Invoice checker");
      bundle.definition.extraTools = [TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL];
      const list = workflows(scanProcess, check).map((w) =>
        w.slug === "scan" ? { ...w, name: `Scan ${++n}` } : w,
      );
      const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.agent}/versions`, {
        bundle: { ...bundle, workflows: list },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return (j(res.json).errors as { code: string }[])
        .map((e) => e.code)
        .filter((c) => c.startsWith("handoff"));
    };
    expect(await save(scan(TO_CHECK))).toEqual([]);
    expect(await save(scan({ agent: "@self", step: "scan-find", workflow: "scan" }))).toEqual([
      "handoff_same_workflow",
    ]);
    const back = {
      ...CHECK,
      steps: [
        ...CHECK.steps,
        {
          id: "chk-hand",
          name: "Hand back",
          kind: "handoff",
          to: { agent: "@self", step: "scan-find", workflow: "scan" },
          input: {},
        },
      ],
    };
    expect(await save(scan(TO_CHECK), back)).toEqual(["handoff_loop", "handoff_loop"]);
  });
});
