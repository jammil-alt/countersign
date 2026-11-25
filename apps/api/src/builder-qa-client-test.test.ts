// A template build's client test (docs/plan.md §1.108) when the template changed after it was
// forked into the client. From the Builder QA (BUILDER_QA.md, PR #441): STATE-8. Scripted model
// answers only.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { agentVersion, testCase, testCaseResult, testSuiteRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";
import { stepModelAnswer } from "./builder-v5.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const holder = { model: new FakeModel() };
const h = await createApiHarness({
  llm: { create: (req) => holder.model.create(req) },
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
  return stepModelAnswer({
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
                schemaVersion: 5,
                triggers: [{ id: "t", on: { type: "manual", input: {} } }],
                outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
                steps: [
                  {
                    id: "update",
                    name: "Update the record",
                    checks: { approval: { required: "required" } },
                    kind: "do",
                    doneBy: "rules",
                    uses: { type: "action", action: TESTKIT_UPDATE_TOOL },
                    input: { id: "r1", amount: "12.00" },
                  },
                  { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
                ],
              },
            },
          ],
        },
      },
    },
  });
}

describe.skipIf(!h)("a template build's client test after a fix", () => {
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
    const atPoc = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    // The case names the draft's step by its id as stored (the Builder's "update" got a server
    // id): a case naming a step the draft doesn't have is left out (BUILDER_QA AI-6).
    const [drafted] = await H.t.db
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, atPoc.build.agentId as string))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    const draftedBundle = drafted?.bundle as {
      workflows: { workflow: { steps: { id: string }[] } }[];
    };
    const stepId = draftedBundle.workflows[0]?.workflow.steps[0]?.id as string;
    holder.model.push({
      toolUse: {
        name: "submit_test_cases",
        input: {
          cases: [
            {
              name: "Wrong amount",
              dataset: "records",
              input: { workflow: "main", payload: {} },
              expected: { [stepId]: {} },
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

  /**
   * STATE-8: back to the client test after the template is fixed. `ran`: the client's copy was
   * set up and published at the client first (its connection bound), so it is updated in place.
   */
  async function backToClientTest(title: string, slug: string, ran: boolean) {
    let b = await readyForClientTest(title, slug);
    const id = b.build.id;
    const templateId = b.build.agentId as string;
    b = await ok("POST", `/api/ops/builds/${id}/client-test`, { clientId: H.A.tenantId });
    expect(b.build.phase).toBe("client_test");
    const copy = b.build.testAgentId as string;
    expect(copy).not.toBe(templateId);
    if (ran) {
      const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${copy}/operation`, {
        bindings: { testkit: H.A.connectionId },
      });
      expect(bound.status, JSON.stringify(bound.json)).toBe(200);
      const [first] = await H.t.db
        .select({ id: agentVersion.id, status: agentVersion.status })
        .from(agentVersion)
        .where(eq(agentVersion.agentId, copy))
        .orderBy(desc(agentVersion.version))
        .limit(1);
      // The step model (the Builder drafts v5): its publish checks don't check a client's
      // bindings yet, so the copy may already be live from the move (stream I, Not done).
      if (first?.status !== "live") {
        const pub = await H.call(
          OPERATOR,
          "POST",
          `/api/ops/agents/${copy}/versions/${first?.id}/publish`,
        );
        expect(pub.status, JSON.stringify(pub.json)).toBe(200);
      }
    }

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
    if (ran) expect(trialAgent, "the copy the client ran, updated in place").toBe(copy);
  }

  // STATE-8
  it("takes a template fixed after its client test back to the client test with the fix", async () => {
    await backToClientTest("Changed after the fork", "changed-after-fork", false);
  });

  // STATE-8: a copy the client ran gets the template's fix as an update.
  it("updates the client's copy it ran with the template's fix", async () => {
    await backToClientTest("Changed after the trial", "changed-after-trial", true);
  });

  // STATE-8: a move into the client test never skips the copy's update.
  it("refuses moving into the client test while the client's copy is behind the template", async () => {
    const b = await readyForClientTest("Behind the template", "behind-the-template");
    const id = b.build.id;
    const copy = (await ok("POST", `/api/ops/builds/${id}/client-test`, { clientId: H.A.tenantId }))
      .build.testAgentId as string;
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft", reason: "A fix" });
    const templateId = b.build.agentId as string;
    const [latest] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, templateId))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    const bundle = structuredClone(latest?.bundle) as {
      definition: { instructions: string };
    };
    bundle.definition.instructions = "Update records only when asked in writing.";
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
      bundle,
      parentVersionId: latest?.id,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    // The POC passes again; the build is in the POC test with its earlier copy at the client.
    holder.model.push(turnAnswer({ text: "Same plan." }));
    const poc = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    await suitePasses(templateId, poc.draft?.versionId as string);
    expect(copy).toBeTruthy();
    const moved = await call("POST", `/api/ops/builds/${id}/phase`, { to: "client_test" });
    expect(moved.status, JSON.stringify(moved.json)).toBe(409);
    expect((moved.json as unknown as { error?: { code?: string } }).error?.code).toBe(
      "copy_behind",
    );
  });
});
