// A template's AI written in a step, run outside the template (staging, 2026-11-27: every test run
// of "Employee receipt and invoice coding" failed at its first AI step with "no saved version of
// what is written in it"). The template's step skills are pinned under the template's id; its test
// copy and its forks start from that bundle, so their runs take the template's pins too.
import { stepRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
  v5Workflow,
} from "./api.test-helper";
import { executeRun, pinnedStepSkill } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
const j = (v: unknown) => v as Json;

describe("the step skill a run's pins name", () => {
  const pins = ["custom:step-tmpl-s1@3", "custom:step-own-s2@1", "custom:step-own-s1"];
  it("takes the agent's own pin first, then its template's, never an unversioned one", () => {
    expect(pinnedStepSkill(pins, ["own", "tmpl"], "s2")).toBe("custom:step-own-s2@1");
    expect(pinnedStepSkill(pins, ["own", "tmpl"], "s1")).toBe("custom:step-tmpl-s1@3");
    expect(pinnedStepSkill(pins, "own", "s1")).toBeUndefined();
    expect(pinnedStepSkill(pins, ["own"], "s3")).toBeUndefined();
  });
});

describe.skipIf(!h)("a template's AI written in a step, in its test copy", () => {
  const H = h as NonNullable<typeof h>;

  it("runs the version the template pinned", async () => {
    const workflow = v5Workflow([
      {
        id: "s_check",
        kind: "do",
        name: "Check the receipt",
        doneBy: "ai",
        input: {},
        ai: { text: "Say whether the receipt is complete." },
        output: [{ name: "complete", type: "yes_no", required: true }],
      },
    ]);
    const bundle = testBundle("Receipt checker");
    bundle.workflows = [
      {
        ...(bundle.workflows[0] as (typeof bundle.workflows)[number]),
        slug: "check",
        name: "Check",
        workflow,
      },
    ];
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "receipt-checker",
      bundle,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const templateId = j(j(created.json).agent).id as string;
    const first = j(j(created.json).version).id as string;
    // The builder's save: the text stored behind the step (shared, the template's), then pinned.
    const stored = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/step-skills`, {
      workflow,
    });
    expect(stored.status, JSON.stringify(stored.json)).toBe(200);
    const pin = (j(stored.json).skills as { pin: string }[])[0]?.pin as string;
    expect(pin).toContain(templateId);
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
      bundle: {
        ...bundle,
        definition: { ...bundle.definition, skills: [{ skill: pin, settings: {} }] },
      },
      parentVersionId: first,
      changeNote: "Pinned its step skill",
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const version = j(j(saved.json).version).id as string;

    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${version}/test-run`,
      { workflow: "check", payload: {}, clientId: H.A.tenantId },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId = j(res.json).runId as string;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    expect(params.agentId).not.toBe(templateId);
    const result = await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: new FakeModel([{ toolUse: { name: "finish", input: { complete: true } } }]),
        instances: H.instances,
        credentials: { get: async () => null } as never,
      },
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "succeeded" });
    const rows = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId));
    const check = rows.find((r) => r.nodeId === "s_check");
    expect(check).toMatchObject({ status: "succeeded", skillRef: pin });
    expect(check?.output).toMatchObject({ complete: true });
  });
});
