// Builds through the API (docs/plan.md §1.108), with scripted model answers: a template's build
// from intake to live. Intake fills the brief, confirming it leaves its open questions as items,
// fit-gap is written by the Builder and agreed, the draft is the Builder's own, the POC makes and
// runs test cases, the client test publishes, forks and activates, QA is signed with a failing
// check accepted, and go waits for the client's copy to be live. Only operators reach it, and an
// operator sees a client's build only when it serves the client.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { agentVersion, run, tenant, testCase, testCaseResult, testSuiteRun } from "@countersign/db";
import { FakeModel, fakeMessage, type LlmRequest } from "@countersign/llm";
import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR } from "./api.test-helper";

// What reaches Sentry (a no-op here otherwise): a Builder failure must (QA on staging, 2026-11-17).
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/cloudflare", async (real) => ({
  ...(await real<object>()),
  captureException: sentry.captureException,
}));

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});

/** The brief's second look before the fit-gap (owner, 2026-11-17): nothing found, by default. */
const reviewed = (concerns: { title: string; detail: string; checklist?: string }[] = []) => ({
  toolUse: { name: "submit_review", input: { concerns } },
});

type Draft = { workflows: { workflow: { steps: Record<string, unknown>[] } }[] };

/** Sets the amount on the draft's first step. */
function setAmount(d: Draft, amount: string): void {
  const step = d.workflows[0]?.workflow.steps[0] as { input: { amount: string } } | undefined;
  if (step) step.input.amount = amount;
}

/** The workflow Builder's turn: the draft it was shown, changed by `fn`. */
function editsDraft(text: string, fn: (d: Draft) => void) {
  return (req: LlmRequest) => {
    const content = req.messages[0]?.content as string;
    const start = content.indexOf("<current_bundle>") + "<current_bundle>".length;
    const d = JSON.parse(content.slice(start, content.indexOf("</current_bundle>"))) as Draft;
    fn(d);
    return { toolUse: { name: "submit_turn", input: { text, bundle: d } } };
  };
}

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
  const lastUserText = () => {
    const m = model.requests.at(-1)?.messages.at(-1);
    return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
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
    model.push(reviewed());
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
    // The operator makes the portal row a known risk (happy path first) and edits the form's
    // fields; agreeing drafts it.
    const fitgap = {
      ...b.build.fitgap,
      rows: b.build.fitgap.rows.map((r) => (r.id === "portal" ? { ...r, later: true } : r)),
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
    // v1 is the drafter's; v2 adds the manual and the template's setup checklist
    // (docs/builder-plan.md §5, §6).
    expect(b.draft).toMatchObject({ version: 2, live: false, problems: [] });
    // The fit-gap's build row is an open item; the known risk is one put off from the start,
    // and a template's intake form makes no items: there is no client yet.
    expect(b.items.map((i) => [i.title, i.owner, i.state])).toEqual([
      ["How many: still open", "operator", "open"],
      ["Volume tiers", "builder", "open"],
      ["Read a vendor portal", "engineering", "deferred"],
    ]);
    // The Builder drew its description from the brief and the fit-gap: the normal case to
    // draft, the known risk named so it is left out.
    const sent = JSON.stringify(model.requests.at(-1)?.messages);
    expect(sent).toContain("Keep records right");
    expect(sent).toContain("Volume tiers");
    expect(sent).not.toContain("Read a vendor portal (");
    expect(sent).toContain("Known risks, not built in this version");
    expect(sent).toContain("- Read a vendor portal");
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
    // The case names the draft's step by its id as stored (the Builder's "update" got a server
    // id): a case naming a step the draft doesn't have is left out (BUILDER_QA AI-6).
    const [drafted] = await H.t.db
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, b.build.agentId as string))
      .orderBy(desc(agentVersion.version))
      .limit(1);
    const draftedBundle = drafted?.bundle as {
      workflows: { workflow: { steps: { id: string }[] } }[];
    };
    const stepId = draftedBundle.workflows[0]?.workflow.steps[0]?.id as string;
    model.push({
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
            { name: "Not a template case", dataset: "records", input: {}, expected: {} },
          ],
        },
      },
    });
    b = await ok("POST", `/api/ops/builds/${id}/cases`);
    expect(b.created).toBe(1);
    expect(b.poc).toMatchObject({ mode: "suite", cases: 1, required: 1, passed: false });
    expect(b.gate.reasons).toContain("The test cases haven't run yet.");

    // Staging (2026-11-18, Sentry MEZONAS-API-7): the Builder proposes running them and the
    // operator agrees; the suite starts in the Sandbox (the run route is a slow one, so the
    // proposal calls its code directly).
    const [b2] = await H.t.db
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, H.B.tenantId));
    await H.t.db
      .update(tenant)
      .set({ settings: { ...(b2?.settings as object), sandbox: true } })
      .where(eq(tenant.id, H.B.tenantId));
    model.push(
      turnAnswer({
        text: "The cases are made. I'd run them now.",
        proposal: { summary: "Run the test cases", action: { do: "run_tests" } },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "What's next?" });
    const runIt = b.messages.at(-1);
    expect(runIt?.proposal).toMatchObject({ state: "proposed", action: { do: "run_tests" } });
    b = await ok("POST", `/api/ops/builds/${id}/messages/${runIt?.id}/proposal`, {
      decide: "agree",
    });
    expect(b.messages.find((m) => m.id === runIt?.id)?.proposal).toMatchObject({
      state: "agreed",
    });
    const started = await H.t.db
      .select({ id: testSuiteRun.id })
      .from(testSuiteRun)
      .where(eq(testSuiteRun.targetId, b.build.agentId as string));
    expect(started).toHaveLength(1);

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
    // Happy path first: open items don't hold the move into the client test (they hold QA).
    expect(b.gate.reasons).toEqual([]);
    for (const item of b.items) {
      b = await ok("PATCH", `/api/ops/builds/${id}/items/${item.id}`, { state: "deferred" });
    }

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
    // docs/builder-plan.md §6: the copy carries the template's setup checklist, and its stages
    // wait on it; we record the items the client agreed with us.
    const held = await H.call(OPERATOR, "POST", `/api/ops/agents/${b.build.testAgentId}/stage`, {
      to: "live",
      reason: "Signed off on paper",
    });
    expect(held.status).toBe(409);
    expect((held.json as { error: { code: string } }).error.code).toBe("setup_not_done");
    const goLive = (await H.call(OPERATOR, "GET", `/api/ops/agents/${b.build.testAgentId}/go-live`))
      .json as { goLive: { setup?: { items: { id: string; done: boolean }[] } } };
    for (const item of goLive.goLive.setup?.items.filter((i) => !i.done) ?? []) {
      const done = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${b.build.testAgentId}/setup/${item.id}`,
        { value: "2" },
      );
      expect(done.status, JSON.stringify(done.json)).toBe(200);
    }
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

  // Owner (2026-11-17): talk through the issues one at a time, agree each fix, and go back to one.
  it("talks about one issue, agrees its fix, undoes it, and goes back to it later", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Issue threads" });
    const id = b.build.id;
    await ok("POST", `/api/ops/builds/${id}/items`, { title: "Check the W-9" });
    b = await ok("POST", `/api/ops/builds/${id}/items`, { title: "Who approves new vendors" });
    const w9 = b.items.find((i) => i.title === "Check the W-9")?.id as string;
    const approver = b.items.find((i) => i.title === "Who approves new vendors")?.id as string;

    // On one issue: the words carry it, the Builder sees it and its proposal is kept as proposed.
    model.push(
      turnAnswer({
        text: "The vendor form step checks it. I'd close it as done.",
        about: `item:${w9}`,
        proposal: {
          summary: "Close “Check the W-9” as done",
          action: { do: "close_item", itemId: `item:${w9}`, state: "done" },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, {
      text: "Where does the tax id get checked?",
      about: `item:${w9}`,
    });
    expect(lastUserText()).toContain(`Talking about: [item:${w9}]`);
    expect(lastUserText()).toContain(`[item:${approver}] Open item`);
    const [asked, proposed] = b.messages.slice(-2);
    expect(asked).toMatchObject({ role: "operator", about: `item:${w9}` });
    expect(proposed).toMatchObject({
      role: "builder",
      about: `item:${w9}`,
      proposal: { state: "proposed", action: { do: "close_item", itemId: w9, state: "done" } },
    });

    // Agreed: the item is done through its own route, Undo is offered, and the next one is offered.
    b = await ok("POST", `/api/ops/builds/${id}/messages/${proposed?.id}/proposal`, {
      decide: "agree",
    });
    expect(b.items.find((i) => i.id === w9)?.state).toBe("done");
    expect(b.messages.find((m) => m.id === proposed?.id)?.proposal).toMatchObject({
      state: "agreed",
      undo: true,
    });
    expect(b.messages.at(-1)).toMatchObject({
      role: "builder",
      about: `item:${approver}`,
      chips: ["Yes, take it", "What's left?"],
    });
    expect(b.messages.at(-1)?.text).toContain("Next open issue: “Who approves new vendors”");
    expect(
      (
        await call("POST", `/api/ops/builds/${id}/messages/${proposed?.id}/proposal`, {
          decide: "agree",
        })
      ).status,
    ).toBe(409);

    // Undo puts the item back.
    b = await ok("POST", `/api/ops/builds/${id}/messages/${proposed?.id}/proposal`, {
      decide: "undo",
    });
    expect(b.items.find((i) => i.id === w9)?.state).toBe("open");
    expect(b.messages.find((m) => m.id === proposed?.id)?.proposal?.state).toBe("undone");

    // Later, on another issue: a proposal for an item that isn't the build's is dropped.
    model.push(
      turnAnswer({
        text: "Ann approves them.",
        about: `item:${approver}`,
        proposal: {
          summary: "Close it",
          action: {
            do: "close_item",
            itemId: "00000000-0000-4000-8000-00000000dead",
            state: "done",
          },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, {
      text: "Ann approves them.",
      about: `item:${approver}`,
    });
    expect(b.messages.at(-1)?.proposal).toBeUndefined();

    // Going back to the W-9: its thread comes with it, and a declined proposal stays declined.
    model.push(
      turnAnswer({
        text: "I'd put it off until the client test.",
        about: `item:${w9}`,
        proposal: {
          summary: "Put off “Check the W-9”",
          action: { do: "close_item", itemId: w9, state: "deferred" },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, {
      text: "Back to the W-9 one.",
      about: `item:${w9}`,
    });
    expect(lastUserText()).toContain("Operator: Where does the tax id get checked?");
    expect(lastUserText()).toContain("You: The vendor form step checks it.");
    const again = b.messages.at(-1);
    b = await ok("POST", `/api/ops/builds/${id}/messages/${again?.id}/proposal`, {
      decide: "decline",
    });
    expect(b.messages.find((m) => m.id === again?.id)?.proposal?.state).toBe("declined");
    expect(b.items.find((i) => i.id === w9)?.state).toBe("open");
  });

  // QA on staging (2026-11-17): after agreeing to "build the filter skill", it said "Done" when
  // only the step's wording had changed and the step was still missing.
  it("never says a draft edit is done when the issue it was for is still open", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Past-due reminders" });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: { text: "Remind customers of past-due invoices", state: "confirmed" },
          trigger: { text: "Mondays at 8am", state: "confirmed" },
          dataIn: { text: "Open invoices", state: "confirmed" },
          dataOut: { text: "Reminder emails", state: "confirmed" },
        },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Weekly past-due reminders." });
    model.push(reviewed());
    model.push(
      turnAnswer({
        text: "One to figure out.",
        fitgap: {
          rows: [
            { id: "group", need: "Group invoices by customer", verdict: "figure_out", how: "x" },
          ],
        },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    const withMissing = draftAnswer();
    const flow = withMissing.toolUse.input.bundle.workflows[0]?.workflow as { steps: unknown[] };
    flow.steps.unshift({
      id: "group",
      kind: "missing",
      name: "Group invoices by customer",
      need: "No skill groups a list by customer.",
      fill: "skill",
    });
    model.push(withMissing);
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    const missing = b.draft?.problems.find((p) => p.code === "missing_step");
    expect(missing).toBeTruthy();
    const key = `problem:${missing?.key}`;

    model.push(
      turnAnswer({
        text: "I'd build the grouping on that step.",
        about: key,
        proposal: {
          summary: "Build the filter and group skill",
          action: {
            do: "edit_draft",
            request: "On “Group invoices by customer”, group the open invoices by customer.",
            ...(missing?.stepId ? { stepId: missing.stepId } : {}),
          },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Build it.", about: key });
    const proposed = b.messages.at(-1);
    // The workflow's Builder can only reword the step: the catalog has nothing that groups.
    model.push(
      editsDraft("I reworded the step to say what it must do.", (d) => {
        const step = d.workflows[0]?.workflow.steps[0] as { need?: string } | undefined;
        if (step)
          step.need = "Needs a skill that groups open invoices by customer and totals them.";
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/messages/${proposed?.id}/proposal`, {
      decide: "agree",
    });
    const decided = b.messages.find((m) => m.id === proposed?.id)?.proposal;
    expect(decided).toMatchObject({ state: "agreed", unresolved: true });
    expect(decided?.result).toMatch(/^Changed, still open: /);
    const said = b.messages.at(-1);
    expect(said?.text).toContain("it isn't fixed");
    expect(said?.text).not.toMatch(/^Done/);
    expect(said?.about).toBe(key);
    expect(said?.chips).toEqual(["What would fix it?"]);
  });

  // Owner (2026-11-17): a brief gets a second look before it's confirmed.
  it("reviews a brief before it's confirmed, and goes on when it's confirmed again", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Vendor onboarding" });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: { text: "Set up new vendors", state: "confirmed" },
          trigger: { text: "A vendor's form arrives", state: "confirmed" },
          dataIn: { text: "The form and the contract", state: "confirmed" },
          dataOut: { text: "The vendor in QuickBooks", state: "confirmed" },
        },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Onboard new vendors." });
    model.push(
      reviewed([
        {
          title: "Where does the vendor go for a client with no accounting system?",
          detail: "Some clients run on spreadsheets.",
          checklist: "source",
        },
      ]),
    );
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(b.build.phase).toBe("intake");
    expect(b.items.map((i) => [i.title, i.kind, i.owner])).toContainEqual([
      "Where does the vendor go for a client with no accounting system?",
      "question",
      "operator",
    ]);
    expect(b.messages.at(-1)?.text).toContain("Before you confirm, I gave the brief a second look");
    // The reviewer read the checklist and the catalog, in short.
    const review = model.requests.at(-1);
    expect(JSON.stringify(review?.system)).toContain("no ERP or accounting tool");
    expect(JSON.stringify(review?.system)).toContain("<catalog>");

    // QA (2026-11-17, fourth run): answering a question in the chat closes it, and says so.
    const question = b.items.find((i) => i.kind === "question");
    if (!question) throw new Error("no question");
    model.push(
      turnAnswer({
        text: "Then it goes in the vendor list. That settles the question.",
        brief: {
          dataOut: { text: "The vendor in QuickBooks, or the vendor list", state: "confirmed" },
        },
        answered: [`item:${question.id}`, "item:00000000-0000-4000-8000-000000000000"],
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "The vendor list, then." });
    expect(b.items.find((i) => i.id === question.id)?.state).toBe("done");
    expect(b.messages.at(-1)?.changes).toContain(
      "Answered: Where does the vendor go for a client with no accounting system?",
    );

    // Confirmed again, with the brief changed by the answer: no second review (once a build),
    // on to the fit-gap.
    const asked = model.requests.length;
    model.push(
      turnAnswer({
        text: "One we do as is.",
        fitgap: { rows: [{ id: "r", need: "x", verdict: "native", how: "y" }] },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(b.build.phase).toBe("fitgap");
    expect(model.requests).toHaveLength(asked + 1);
  });

  // QA on staging (2026-11-17): a 17-step draft was cut off twice; the banner said "max_tokens"
  // and "submit_draft", nothing said whether trying again would help, and Sentry had nothing.
  it("says a draft that can't be finished in plain words, and reports it", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Monthly reconciliation" });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: { text: "Reconcile each account monthly", state: "confirmed" },
          trigger: { text: "Month end", state: "confirmed" },
          dataIn: { text: "Bank lines and the statement", state: "confirmed" },
          dataOut: { text: "A reconciliation report", state: "open" },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Monthly bank reconciliation." });
    // A field the turn left open says so in the change tags.
    expect(b.messages.at(-1)?.changes).toContain("Brief: data out (still open)");
    model.push(reviewed());
    model.push(
      turnAnswer({
        text: "One we do as is.",
        fitgap: { rows: [{ id: "lines", need: "Read bank lines", verdict: "native", how: "x" }] },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    const cut = () => ({
      message: fakeMessage(
        "claude-sonnet-5-5",
        [{ type: "tool_use", id: "toolu_cut", name: "submit_draft", input: {} }] as never,
        "max_tokens",
      ),
    });
    model.push(cut(), cut());
    sentry.captureException.mockClear();
    const res = await call("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    expect(res.status).toBe(422);
    const error = (res.json as unknown as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("builder_failed");
    expect(error.message).toContain("too long to finish, even as a smaller first draft");
    expect(error.message).not.toMatch(/max_tokens|submit_draft/);
    // The smaller draft was asked for before giving up, with the higher limit.
    expect(model.requests.at(-2)?.max_tokens).toBe(64_000);
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain("the main path only");
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ kind: "builder", failure: "max_tokens" }),
      }),
    );
    b = await ok("GET", `/api/ops/builds/${id}`);
    expect(b.build.phase).toBe("fitgap");
  });

  // Owner (2026-11-17): the draft changes in the build's conversation, agreed and undoable.
  it("changes the draft from the conversation when agreed, and undoes it", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Draft edits" });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: { text: "Keep records right", state: "confirmed" },
          trigger: { text: "Someone asks", state: "confirmed" },
          dataIn: { text: "The record", state: "confirmed" },
          dataOut: { text: "The corrected record", state: "confirmed" },
        },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    model.push(reviewed());
    model.push(
      turnAnswer({
        text: "One we do as is.",
        fitgap: {
          rows: [{ id: "update", need: "Update the record", verdict: "native", how: "Testkit" }],
        },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    model.push(draftAnswer());
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    const agentId = b.build.agentId as string;
    const versions = async () =>
      H.t.db
        .select({ version: agentVersion.version, bundle: agentVersion.bundle })
        .from(agentVersion)
        .where(eq(agentVersion.agentId, agentId))
        .orderBy(desc(agentVersion.version));

    // The Builder sees the draft's steps by id and proposes one edit.
    model.push((req: LlmRequest) => {
      const sent = JSON.stringify(req.messages);
      const stepId = /step \[([^\]]+)\] Update the record/.exec(sent)?.[1] ?? "missing";
      return turnAnswer({
        text: "The amount should come in as 15.00. I'd change it on the update step.",
        proposal: {
          summary: "Set the amount on “Update the record” to 15.00",
          action: {
            do: "edit_draft",
            request: "On “Update the record”, set the amount to 15.00.",
            stepId,
          },
        },
      });
    });
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "The amount is wrong." });
    const step = /Draft v2 step \[([^\]]+)\] Update the record \(write\)/.exec(lastUserText());
    expect(step).not.toBeNull();
    const proposed = b.messages.at(-1);
    expect(proposed?.proposal).toMatchObject({ state: "proposed", action: { do: "edit_draft" } });

    // Agreed: the workflow's Builder makes it (about that step) and it is saved as v3 (v2 is
    // the manual the build wrote into the draft).
    model.push(
      editsDraft("Set the amount to 15.00.", (d) => {
        setAmount(d, "15.00");
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/messages/${proposed?.id}/proposal`, {
      decide: "agree",
    });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain(
      "On “Update the record”, set the amount to 15.00.",
    );
    const agreed = b.messages.find((m) => m.id === proposed?.id)?.proposal;
    expect(agreed).toMatchObject({ state: "agreed", undo: true });
    expect(agreed?.result).toMatch(/^Changed: /);
    expect(b.messages.at(-1)?.text).toContain("Changed the draft: Set the amount to 15.00.");
    let saved = await versions();
    expect(saved.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(JSON.stringify(saved[0]?.bundle)).toContain('"15.00"');
    expect(b.draft?.version).toBe(3);

    // Undo puts the step back, as a new version: history is never rewritten.
    b = await ok("POST", `/api/ops/builds/${id}/messages/${proposed?.id}/proposal`, {
      decide: "undo",
    });
    saved = await versions();
    expect(saved.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(JSON.stringify(saved[0]?.bundle)).toContain('"12.00"');
    expect(JSON.stringify(saved[0]?.bundle)).not.toContain('"15.00"');
    expect(b.messages.find((m) => m.id === proposed?.id)?.proposal?.state).toBe("undone");

    // When the workflow's Builder changes nothing, the conversation says why; nothing is saved.
    model.push(
      turnAnswer({
        text: "I'd rename the step.",
        proposal: {
          summary: "Rename the update step",
          action: { do: "edit_draft", request: "Rename “Update the record” to “Fix the record”." },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Rename it?" });
    const rename = b.messages.at(-1);
    model.push(editsDraft("It already reads well, so I left it.", () => {}));
    b = await ok("POST", `/api/ops/builds/${id}/messages/${rename?.id}/proposal`, {
      decide: "agree",
    });
    expect(b.messages.find((m) => m.id === rename?.id)?.proposal?.state).toBe("unchanged");
    expect(b.messages.at(-1)?.text).toContain("It already reads well");
    expect((await versions()).map((v) => v.version)).toEqual([4, 3, 2, 1]);

    // An edit whose draft was saved again since (in the workflow) is not undone over that save.
    model.push(
      turnAnswer({
        text: "I'd set it to 20.00.",
        proposal: {
          summary: "Set the amount to 20.00",
          action: { do: "edit_draft", request: "On “Update the record”, set the amount to 20.00." },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Set it to 20.00." });
    const twenty = b.messages.at(-1);
    model.push(
      editsDraft("Set it.", (d) => {
        setAmount(d, "20.00");
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/messages/${twenty?.id}/proposal`, { decide: "agree" });
    const elsewhere = (await ok("POST", "/api/ops/builder/sessions", {
      kind: "agent",
      agentId,
    })) as unknown as { session: { id: string } };
    model.push(
      editsDraft("Set it to 25.00.", (d) => {
        setAmount(d, "25.00");
      }),
    );
    await ok("POST", `/api/ops/builder/sessions/${elsewhere.session.id}/turns`, {
      text: "Set the amount to 25.00.",
    });
    await ok("POST", `/api/ops/builder/sessions/${elsewhere.session.id}/save`, {});
    const refused = await call("POST", `/api/ops/builds/${id}/messages/${twenty?.id}/proposal`, {
      decide: "undo",
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.json)).toContain("Undo it in the workflow instead");
  });

  // QA on staging (2026-11-16): the fit-gap failed three times out of three. The raw validation
  // error reached the screen, the operator's words vanished, and nothing reached Sentry.
  it("says a failed turn in the conversation, keeps it from the model and retries it", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Vendor onboarding" });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "That's enough to go on. Check the brief and press Confirm the brief under it.",
        chips: ["Confirm the brief", "Add the volume"],
        brief: {
          goal: { text: "Set up new vendors", state: "confirmed" },
          trigger: { text: "A new vendor's form arrives", state: "confirmed" },
          dataIn: { text: "The vendor form", state: "confirmed" },
          dataOut: { text: "The vendor in QuickBooks", state: "confirmed" },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Onboard new vendors." });
    // A chip that reads as a move is dropped: only the button moves the build.
    expect(b.messages.at(-1)?.chips).toEqual(["Add the volume"]);

    // Opening the fit-gap fails: the conversation says why in plain words; nothing changes.
    // Asked again once with what was wrong (MEZONAS-API-4), then said in the conversation.
    model.push(reviewed());
    model.push(
      turnAnswer({ text: "Here it is.", fitgap: "not a fit-gap" }),
      turnAnswer({ text: "Here it is.", fitgap: "still not a fit-gap" }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain(
      "did not match the tool's schema",
    );
    expect(b.build.phase).toBe("fitgap");
    expect(b.build.fitgap.rows).toEqual([]);
    const opened = b.messages.at(-1);
    expect(opened).toMatchObject({ role: "builder", failed: true });
    expect(opened?.text).toContain("couldn't save");
    expect(opened?.text).toContain("The fit-gap isn't written yet");
    expect(opened?.text).not.toContain("validation");

    // The operator asks again and the answer is cut off: still a message, not an error.
    model.push({
      message: fakeMessage(
        "claude-sonnet-5-5",
        [{ type: "tool_use", id: "toolu_cut", name: "submit_build_turn", input: {} }] as never,
        "max_tokens",
      ),
    });
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Please write the fit-gap." });
    expect(b.messages.slice(-2).map((m) => [m.role, !!m.failed])).toEqual([
      ["operator", false],
      ["builder", true],
    ]);
    expect(b.messages.at(-1)?.text).toContain("cut off");
    const fitgapTurn = model.requests.at(-1);
    expect(fitgapTurn?.max_tokens).toBe(16_000);

    // Retry (no words): the operator's last words are answered again, not saved twice, and the
    // failed answers never reach the model. A fit-gap sent as JSON text is read as the object.
    model.push(
      turnAnswer({
        text: "One we do as is.",
        fitgap: JSON.stringify({
          rows: [{ id: "vendor", need: "Add the vendor", verdict: "native", how: "QuickBooks" }],
        }),
      }),
    );
    const before = b.messages.length;
    b = await ok("POST", `/api/ops/builds/${id}/turns`, {});
    expect(b.messages).toHaveLength(before + 1);
    expect(b.messages.at(-1)).toMatchObject({ role: "builder", text: "One we do as is." });
    expect(b.messages.at(-1)?.failed).toBeUndefined();
    expect(b.build.fitgap.rows.map((r) => r.id)).toEqual(["vendor"]);
    const sent = JSON.stringify(model.requests.at(-1)?.messages);
    expect(sent).toContain("Please write the fit-gap.");
    expect(sent.match(/Please write the fit-gap\./g)).toHaveLength(1);
    expect(sent).not.toContain("couldn't save");
    expect(sent).not.toContain("cut off");
  });
});

async function caseIds(H: NonNullable<typeof h>, templateId: string): Promise<string[]> {
  const rows = await H.t.db
    .select({ id: testCase.id })
    .from(testCase)
    .where(eq(testCase.targetId, templateId));
  return rows.map((r) => r.id);
}
