// Builds through the API (docs/plan.md §1.108), with scripted model answers: a template's build
// from intake to live. Intake fills the brief, confirming it leaves its open questions as items,
// fit-gap is written by the Builder and agreed, the draft is the Builder's own, the POC makes and
// runs test cases, the client test publishes, forks and activates, QA is signed with a failing
// check accepted, and go waits for the client's copy to be live. Only operators reach it, and an
// operator sees a client's build only when it serves the client.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { run, testCase, testCaseResult, testSuiteRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});

function draftAnswer() {
  return {
    toolUse: {
      name: "submit_draft",
      input: {
        summary: "It updates the record and asks the client first.",
        gaps: [],
        slug: "record-review",
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

describe.skipIf(!h)("builds", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown, who = OPERATOR) => {
    const res = await H.call(who, method, path, body);
    return { status: res.status, json: res.json as BuildDetail & { created?: number } };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };

  it("are the operator's only, and a client's build only for operators serving it", async () => {
    expect((await H.call(admin("a"), "GET", "/api/ops/builds")).status).toBe(403);
    const mine = await ok("POST", "/api/ops/builds", {
      kind: "agent",
      title: "For client A",
      clientId: H.A.tenantId,
    });
    expect(
      (await call("GET", `/api/ops/builds/${mine.build.id}`, undefined, OTHER_OPERATOR)).status,
    ).toBe(404);
    expect(
      (
        await call(
          "POST",
          "/api/ops/builds",
          { kind: "agent", title: "x", clientId: H.A.tenantId },
          OTHER_OPERATOR,
        )
      ).status,
    ).toBe(404);
  });

  it("takes a template from intake to live", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Record review" });
    expect(b.build).toMatchObject({ phase: "intake", status: "open", client: null });
    expect(b.phases.map((p) => p.state)).toEqual([
      "current",
      "todo",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
    expect(b.gate.reasons).toHaveLength(4);
    const id = b.build.id;

    // Intake: the Builder fills the brief and asks, with chips; a fit-gap it sends is dropped.
    model.push(
      turnAnswer({
        text: "Got it. How many records a week?",
        chips: ["Under 50", "50 to 500"],
        brief: {
          goal: { text: "Keep records right", state: "confirmed" },
          trigger: { text: "Someone asks", state: "confirmed" },
          dataIn: { text: "The record", state: "assumed" },
          dataOut: { text: "The corrected record", state: "confirmed" },
          volume: { text: "", state: "open" },
        },
        fitgap: { rows: [{ id: "x", need: "y", verdict: "native", how: "" }], needsTrue: [] },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    expect(b.messages.map((m) => m.role)).toEqual(["operator", "builder"]);
    expect(b.messages[1]).toMatchObject({ chips: ["Under 50", "50 to 500"] });
    expect(b.messages[1]?.changes).toContain("Brief: goal");
    expect(b.build.brief.goal?.text).toBe("Keep records right");
    expect(b.build.fitgap.rows).toEqual([]);
    expect(b.gate).toEqual({ next: "fitgap", reasons: [] });

    // Into fit-gap: the open field is a question; the Builder writes the fit-gap.
    expect((await call("POST", `/api/ops/builds/${id}/phase`, { to: "draft" })).status).toBe(409);
    model.push(
      turnAnswer({
        text: "Two we do as is, one we'd build, one we can't.",
        fitgap: {
          rows: [
            { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" },
            { id: "tiers", need: "Volume tiers", verdict: "build", how: "A new skill" },
            {
              id: "portal",
              need: "Read a vendor portal",
              verdict: "figure_out",
              how: "No connector",
            },
            {
              id: "pay",
              need: "Pay the vendor",
              verdict: "not_possible",
              how: "Agents never move money",
            },
          ],
          needsTrue: [],
          setup: [
            { id: "conn", label: "Connect the testkit", kind: "connect", hint: "It writes there" },
            { id: "tol", label: "Your price tolerance", kind: "answer", hint: "e.g. 2%" },
          ],
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(b.build.phase).toBe("fitgap");
    expect(b.items.map((i) => i.title)).toEqual(["How many: still open"]);
    expect(b.build.fitgap.rows).toHaveLength(4);

    // A verdict doesn't change by saving the fit-gap: it needs a reason.
    const native = {
      ...b.build.fitgap,
      rows: b.build.fitgap.rows.map((r) => (r.id === "portal" ? { ...r, verdict: "native" } : r)),
    };
    expect((await call("PATCH", `/api/ops/builds/${id}`, { fitgap: native })).status).toBe(409);
    const why = "Their records come in as scanned images, never text.";
    expect(
      (
        await call("POST", `/api/ops/builds/${id}/verdicts`, {
          rowId: "update",
          to: "figure_out",
          reason: "short",
        })
      ).status,
    ).toBe(400);
    // More work changes at once, with the Builder's verdict and the reason kept.
    b = await ok("POST", `/api/ops/builds/${id}/verdicts`, {
      rowId: "update",
      to: "build",
      reason: why,
    });
    expect(b.build.fitgap.rows[0]).toMatchObject({
      verdict: "build",
      override: { from: "native", reason: why },
    });
    // Less work is a challenge: the Builder answers it, and the override survives its rewrite.
    model.push(
      turnAnswer({
        text: "Volume tiers is native: the Testkit update takes tiers.",
        fitgap: {
          rows: [
            { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" },
            { id: "tiers", need: "Volume tiers", verdict: "native", how: "Testkit update" },
            { id: "portal", need: "Read a vendor portal", verdict: "figure_out", how: "None" },
            { id: "pay", need: "Pay the vendor", verdict: "not_possible", how: "Never" },
          ],
          needsTrue: [],
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/verdicts`, {
      rowId: "tiers",
      to: "native",
      reason: "The testkit update already takes a tier field.",
    });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain(
      'challenging \\"Volume tiers',
    );
    expect(b.build.fitgap.rows.map((r) => [r.id, r.verdict, !!r.challenge])).toEqual([
      ["update", "build", false],
      ["tiers", "native", false],
      ["portal", "figure_out", false],
      ["pay", "not_possible", false],
    ]);
    // Back as it was, so the rest of the build is the same.
    model.push(
      turnAnswer({
        text: "Agreed: the records are text, so the update is native.",
        fitgap: {
          rows: [
            { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" },
            { id: "tiers", need: "Volume tiers", verdict: "native", how: "Testkit update" },
            { id: "portal", need: "Read a vendor portal", verdict: "figure_out", how: "None" },
            { id: "pay", need: "Pay the vendor", verdict: "not_possible", how: "Never" },
          ],
          needsTrue: [],
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/verdicts`, {
      rowId: "update",
      to: "native",
      reason: "I was wrong, the records are text after all.",
    });
    b = await ok("POST", `/api/ops/builds/${id}/verdicts`, {
      rowId: "tiers",
      to: "build",
      reason: "The tier field doesn't do volume breaks.",
    });
    expect(b.build.fitgap.rows.map((r) => r.verdict)).toEqual([
      "native",
      "build",
      "figure_out",
      "not_possible",
    ]);

    // A template's intake form survives the Builder's rewrites: the challenges above rewrote
    // the fit-gap without one, and the form stayed.
    expect(b.build.fitgap.setup.map((f) => f.id)).toEqual(["conn", "tol"]);
    // The operator drops the portal row and edits the form's fields; agreeing drafts it.
    const fitgap = {
      ...b.build.fitgap,
      rows: b.build.fitgap.rows.map((r) => (r.id === "portal" ? { ...r, dropped: true } : r)),
      setup: [
        { id: "conn", label: "Connect the testkit", kind: "connect", hint: "It writes there" },
        { id: "tol", label: "Your price tolerance", kind: "answer", hint: "Within 2%" },
      ],
    };
    b = await ok("PATCH", `/api/ops/builds/${id}`, { fitgap });
    // Only the field the operator changed is theirs.
    expect(b.build.fitgap.setup.map((f) => [f.id, f.byOperator])).toEqual([
      ["conn", false],
      ["tol", true],
    ]);
    model.push(draftAnswer());
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    expect(b.build.phase).toBe("draft");
    expect(b.build.agentId).toBeTruthy();
    expect(b.draft).toMatchObject({ version: 1, live: false, problems: [] });
    // The fit-gap's build row is an open item; the dropped row isn't, and a template's intake
    // form makes no items: there is no client yet.
    expect(b.items.map((i) => [i.title, i.owner])).toEqual([
      ["How many: still open", "operator"],
      ["Volume tiers", "builder"],
    ]);
    // The Builder drew its description from the brief and the fit-gap.
    const sent = JSON.stringify(model.requests.at(-1)?.messages);
    expect(sent).toContain("Keep records right");
    expect(sent).toContain("Volume tiers");
    expect(sent).not.toContain("Read a vendor portal (");
    expect(sent).toContain("Your price tolerance (Answer)");

    // POC: the Builder plans the data, makes the cases; the gate waits for them to pass.
    model.push(
      turnAnswer({
        text: "Three records will do.",
        testPlan: {
          datasets: [
            {
              id: "records",
              name: "Records",
              count: 3,
              covers: "1 wrong amount",
              source: "generate",
            },
          ],
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    expect(b.build.testPlan.datasets).toHaveLength(1);
    model.push({
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
            { name: "Not a template case", dataset: "records", input: {}, expected: {} },
          ],
        },
      },
    });
    b = await ok("POST", `/api/ops/builds/${id}/cases`);
    expect(b.created).toBe(1);
    expect(b.poc).toMatchObject({ mode: "suite", cases: 1, required: 1, passed: false });
    expect(b.gate.reasons).toContain("The test cases haven't run yet.");

    // The suite passes (as the test bench writes it).
    const [suite] = await H.t.db
      .insert(testSuiteRun)
      .values({
        targetKind: "template",
        targetId: b.build.agentId as string,
        versionId: b.draft?.versionId as string,
        status: "done",
        total: 1,
        passed: 1,
        finishedAt: new Date(),
      })
      .returning();
    await H.t.db.insert(testCaseResult).values({
      suiteRunId: suite?.id as string,
      testCaseId: (await caseIds(H, b.build.agentId as string))[0] as string,
      status: "pass",
    });
    b = await ok("GET", `/api/ops/builds/${id}`);
    expect(b.poc?.passed).toBe(true);
    // Open items hold the move into the client test.
    expect(b.gate.reasons).toEqual(["2 open items are not done or put off."]);
    for (const item of b.items) {
      b = await ok("PATCH", `/api/ops/builds/${id}/items/${item.id}`, { state: "deferred" });
    }
    expect(b.gate.reasons).toEqual([]);

    // Client test: published, forked into A, its trial started (or an open item says why not).
    expect((await call("POST", `/api/ops/builds/${id}/phase`, { to: "client_test" })).status).toBe(
      409,
    );
    b = await ok("POST", `/api/ops/builds/${id}/client-test`, { clientId: H.A.tenantId });
    expect(b.build).toMatchObject({ phase: "client_test", testClient: { id: H.A.tenantId } });
    expect(b.build.testAgentId).not.toBe(b.build.agentId);
    expect(b.clientTest).toMatchObject({ client: { id: H.A.tenantId }, writes: { rejected: 0 } });
    expect(b.draft?.live).toBe(true);
    // The copy's connection isn't bound at A yet: an open item says so, and the build is there.
    expect(b.items.find((i) => i.title === "Publish the client's copy")).toMatchObject({
      state: "open",
      detail: expect.stringContaining("does not validate"),
    });
    const copy = b.build.testAgentId as string;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${copy}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const page = (await H.call(OPERATOR, "GET", `/api/ops/agents/${copy}`)).json as {
      latest: { id: string };
    };
    const published = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${copy}/versions/${page.latest.id}/publish`,
    );
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    const startItem = b.items.find((i) => i.title === "Publish the client's copy");
    b = await ok("PATCH", `/api/ops/builds/${id}/items/${startItem?.id}`, { state: "done" });
    expect(b.items.find((i) => i.id === startItem?.id)?.resolvedAt).toBeTruthy();
    // A passing test run at A, as the test run route records one.
    await H.t.db.insert(run).values({
      tenantId: H.A.tenantId,
      agentId: copy,
      agentVersionId: page.latest.id,
      workflowSlug: "main",
      mode: "test",
      status: "succeeded",
    });

    // Moving on before the trial is done needs a reason.
    expect((await call("POST", `/api/ops/builds/${id}/phase`, { to: "qa" })).status).toBe(409);
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "qa", reason: "Short trial agreed" });
    expect(b.build.phase).toBe("qa");

    // QA: a failing check is accepted with a reason, then QA is signed.
    // Every write asks first, and a published version stays to go back to.
    expect(b.qaChecks.find((c) => c.id === "approvals")?.state).toBe("pass");
    expect(b.qaChecks.find((c) => c.id === "rollback")?.state).toBe("pass");
    const failing = b.qaChecks.filter((c) => c.state === "fail").map((c) => c.id);
    expect(failing).toContain("trial");
    expect((await call("POST", `/api/ops/builds/${id}/qa`, { sign: true })).status).toBe(409);
    for (const check of failing) {
      b = await ok("POST", `/api/ops/builds/${id}/qa`, {
        accept: check,
        reason: "Agreed with the client",
      });
    }
    expect(b.qaChecks.find((c) => c.id === "trial")).toMatchObject({
      state: "accepted",
      reason: "Agreed with the client",
    });
    b = await ok("POST", `/api/ops/builds/${id}/qa`, { sign: true });
    expect(b.build.qa.signedAt).toBeTruthy();

    // Go waits for the client's copy to be live.
    const waiting = await call("POST", `/api/ops/builds/${id}/decision`, { go: true });
    expect(waiting.status).toBe(409);
    const stage = await H.call(OPERATOR, "POST", `/api/ops/agents/${b.build.testAgentId}/stage`, {
      to: "live",
      reason: "Signed off on paper",
    });
    expect(stage.status, JSON.stringify(stage.json)).toBe(200);
    b = await ok("POST", `/api/ops/builds/${id}/decision`, { go: true });
    expect(b.build.status).toBe("live");
    expect(b.phases.every((p) => p.state === "done")).toBe(true);
    expect(b.events.map((e) => e.kind)).toContain("decision");

    const board = (await H.call(OPERATOR, "GET", "/api/ops/builds?status=live")).json as {
      builds: { id: string }[];
    };
    expect(board.builds.map((x) => x.id)).toContain(id);
  });

  it("goes back with a reason, makes an item from a case once, and stops", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "skill", title: "Apply volume tiers" });
    expect(b.phases.map((p) => p.phase)).toEqual(["intake", "fitgap", "draft", "poc", "qa"]);
    const id = b.build.id;
    const ref = { testCaseId: "00000000-0000-4000-8000-00000000c001" };
    await ok("POST", `/api/ops/builds/${id}/items`, { title: "Case fails", kind: "test", ref });
    b = await ok("POST", `/api/ops/builds/${id}/items`, {
      title: "Case fails again",
      kind: "test",
      ref,
    });
    expect(b.items).toHaveLength(1);
    expect((await call("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" })).status).toBe(409);
    b = await ok("POST", `/api/ops/builds/${id}/stop`, { reason: "Not needed" });
    expect(b.build.status).toBe("stopped");
    expect((await call("POST", `/api/ops/builds/${id}/turns`, { text: "hi" })).status).toBe(409);
  });
});

async function caseIds(H: NonNullable<typeof h>, templateId: string): Promise<string[]> {
  const rows = await H.t.db
    .select({ id: testCase.id })
    .from(testCase)
    .where(eq(testCase.targetId, templateId));
  return rows.map((r) => r.id);
}
