// QA (state and persistence) on a template build's client test (docs/plan.md §1.108): the
// template changed after it was forked into the client. Each test
// asserts what should happen, so it fails while the defect is there. Scripted model answers only.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { agentVersion, testCase, testCaseResult, testSuiteRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "../api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const holder = { model: new FakeModel() };
const h = await createApiHarness({
  llm: { create: (req, opts) => holder.model.create(req, opts) },
});
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});
const reviewed = () => ({ toolUse: { name: "submit_review", input: { concerns: [] } } });
const BRIEF = {
  goal: { text: "Keep records right", state: "confirmed" },
  trigger: { text: "Someone asks", state: "confirmed" },
  dataIn: { text: "The record", state: "confirmed" },
  dataOut: { text: "The corrected record", state: "confirmed" },
};
const ROW = { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" };

function draftAnswer(slug: string) {
  return {
    toolUse: {
      name: "submit_draft",
      input: {
        summary: "It updates the record and asks the client first.",
        gaps: [],
        slug,
        startFromTemplate: null,
        bundle: {
          schemaVersion: 1,
          definition: {
            schemaVersion: 2,
            identity: { name: "Record review", role: "Records", mission: "Keep records right" },
            kind: "functional",
            model: { id: "claude-sonnet-5-5" },
            instructions: "Update records when asked.",
            skills: [],
            permissions: { mode: "suggest_only" },
          },
          workflows: [
            {
              slug: "main",
              name: "Review a record",
              workflow: {
                schemaVersion: 4,
                triggers: [{ id: "t", on: { type: "manual", input: {} } }],
                steps: [
                  {
                    id: "update",
                    kind: "write",
                    name: "Update the record",
                    tool: TESTKIT_UPDATE_TOOL,
                    input: { id: "r1", amount: "12.00" },
                    checks: { approval: { required: "required" } },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

describe.skipIf(!h)("a template build's client test: state and persistence", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    return { status: res.status, json: res.json as BuildDetail };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };

  beforeEach(() => {
    holder.model = new FakeModel();
  });

  /** The template's latest version passes its suite, as the test bench writes it. */
  async function suitePasses(templateId: string, versionId: string): Promise<void> {
    const [suite] = await H.t.db
      .insert(testSuiteRun)
      .values({
        targetKind: "template",
        targetId: templateId,
        versionId,
        status: "done",
        total: 1,
        passed: 1,
        finishedAt: new Date(),
      })
      .returning();
    const cases = await H.t.db
      .select({ id: testCase.id })
      .from(testCase)
      .where(eq(testCase.targetId, templateId));
    for (const c of cases) {
      await H.t.db
        .insert(testCaseResult)
        .values({ suiteRunId: suite?.id as string, testCaseId: c.id, status: "pass" });
    }
  }

  /** A template build in its POC test with the suite passed and nothing holding the client test. */
  async function readyForClientTest(title: string, slug: string): Promise<BuildDetail> {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title });
    const id = b.build.id;
    holder.model.push(turnAnswer({ text: "Got it.", brief: BRIEF }));
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    holder.model.push(
      reviewed(),
      turnAnswer({ text: "As is.", fitgap: { rows: [ROW], needsTrue: [] } }),
    );
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    holder.model.push(draftAnswer(slug));
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    holder.model.push(
      turnAnswer({
        text: "Three records will do.",
        testPlan: {
          datasets: [
            { id: "records", name: "Records", count: 3, covers: "1 wrong", source: "generate" },
          ],
        },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    holder.model.push({
      toolUse: {
        name: "submit_test_cases",
        input: {
          cases: [
            {
              name: "Wrong amount",
              dataset: "records",
              input: { workflow: "main", payload: {} },
              expected: { update: {} },
            },
          ],
        },
      },
    });
    b = await ok("POST", `/api/ops/builds/${id}/cases`);
    await suitePasses(b.build.agentId as string, b.draft?.versionId as string);
    b = await ok("GET", `/api/ops/builds/${id}`);
    for (const item of b.items) {
      b = await ok("PATCH", `/api/ops/builds/${id}/items/${item.id}`, { state: "deferred" });
    }
    expect(b.gate.reasons).toEqual([]);
    return b;
  }

  it("STATE-8: a template fixed after its client test can go back to the client test with the fix", async () => {
    let b = await readyForClientTest("Changed after the fork", "changed-after-fork");
    const id = b.build.id;
    const templateId = b.build.agentId as string;
    b = await ok("POST", `/api/ops/builds/${id}/client-test`, { clientId: H.A.tenantId });
    expect(b.build.phase).toBe("client_test");
    const copy = b.build.testAgentId as string;
    expect(copy).not.toBe(templateId);

    // The trial shows the amount is wrong: back to the draft, fix the template, test it again.
    b = await ok("POST", `/api/ops/builds/${id}/phase`, {
      to: "draft",
      reason: "The client's trial wrote the wrong amount",
    });
    const latest = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, templateId))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    const bundle = structuredClone(latest[0]?.bundle) as {
      workflows: { workflow: { steps: { input?: { amount?: string } }[] } }[];
    };
    const step = bundle.workflows[0]?.workflow.steps[0];
    if (step?.input) step.input.amount = "15.00";
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
      bundle,
      parentVersionId: latest[0]?.id,
      changeNote: "The right amount",
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    holder.model.push(turnAnswer({ text: "Same plan." }));
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    await suitePasses(templateId, b.draft?.versionId as string);
    b = await ok("GET", `/api/ops/builds/${id}`);
    for (const item of b.items.filter((i) => i.state === "open")) {
      b = await ok("PATCH", `/api/ops/builds/${id}/items/${item.id}`, { state: "deferred" });
    }
    const fixedVersion = b.draft?.versionId as string;

    // On to the client test again, the way the build page does it ("Promote to ready to test"
    // sends /client-test; no screen sends /phase with client_test). Verification found the
    // fork of the fixed template conflicts with the first copy: 409 "that already exists".
    const moved = await call("POST", `/api/ops/builds/${id}/client-test`, {
      clientId: H.A.tenantId,
    });
    const [copyLatest] = await H.t.db
      .select({ basedOn: agentVersion.basedOnTemplateVersionId, bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, copy))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    const copyAmount = JSON.stringify(copyLatest?.bundle).includes('"15.00"') ? "15.00" : "12.00";
    // The fixed template goes back to the client: the build is in the client test again and the
    // client's trial runs the fix (the copy updated, or a new copy that the build now points at).
    const trialAgent = moved.json?.build?.testAgentId ?? copy;
    const [trialLatest] = await H.t.db
      .select({ basedOn: agentVersion.basedOnTemplateVersionId, bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, trialAgent))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    const trialRunsFix =
      trialLatest?.basedOn === fixedVersion &&
      JSON.stringify(trialLatest?.bundle).includes('"15.00"');
    expect(
      {
        status: moved.status,
        phase: moved.json?.build?.phase,
        trialRunsFix,
        firstCopyAmount: copyAmount,
      },
      `back to the client test after the fix: ${JSON.stringify(moved.json).slice(0, 200)}`,
    ).toMatchObject({ status: 200, phase: "client_test", trialRunsFix: true });
  });
});
