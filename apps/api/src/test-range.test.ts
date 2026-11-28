// Testing some of a step-model workflow's steps (owner, 2026-11-26: "the whole flow, or from step
// x to y"): the test-run route takes a range of top-level steps, says in words why one can't run,
// and the run does only the steps picked.
import { stepRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createApiHarness,
  doTell,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
  v5Workflow,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
const j = (v: unknown) => v as Json;

describe.skipIf(!h)("testing from one step to another", () => {
  const H = h as NonNullable<typeof h>;
  let agentId = "";
  let versionId = "";

  beforeAll(async () => {
    const bundle = testBundle("Range clerk");
    bundle.workflows = [
      {
        ...(bundle.workflows[0] as (typeof bundle.workflows)[number]),
        slug: "notes",
        name: "Notes",
        workflow: v5Workflow([
          doTell("one", "First note", "One"),
          doTell("two", "Second note", "Two"),
          doTell("three", "Third note", "Three: {{steps.two.output.sent}}"),
        ]),
      },
    ];
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "range-clerk",
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(j(created.json).agent).id as string;
    versionId = j(j(created.json).version).id as string;
  });

  const tryRange = (range: unknown) =>
    H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${versionId}/test-run`, {
      workflow: "notes",
      payload: {},
      range,
    });

  it("runs only the steps picked", async () => {
    const res = await tryRange({ from: "two", to: "two" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId = j(res.json).runId as string;
    const params = H.instances.started.get(runId);
    expect(params?.range).toEqual({ from: "two", to: "two" });
    const result = await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: new FakeModel(),
        instances: H.instances,
        credentials: { get: async () => null } as never,
      },
      params as NonNullable<typeof params>,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result).toMatchObject({ status: "succeeded" });
    const rows = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId));
    expect(rows.map((r) => r.nodeId)).toEqual(["two"]);
  });

  it("says what a range needs, and runs once it is given", async () => {
    const missing = await tryRange({ from: "three" });
    expect(missing.status).toBe(422);
    expect(j(j(missing.json).error).message).toContain(
      "“Third note” reads “Second note”, which isn't run: give its output",
    );
    const given = await tryRange({ from: "three", given: { two: { sent: true } } });
    expect(given.status, JSON.stringify(given.json)).toBe(200);
    const backwards = await tryRange({ from: "three", to: "one" });
    expect(backwards.status).toBe(422);
    expect(j(j(backwards.json).error).message).toContain("the last step comes before the first");
  });
});
