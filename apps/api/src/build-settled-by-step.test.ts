// An issue is settled by its step (docs/plan.md §1.169; owner, 2026-11-21: "give it an action, not
// just mark it... just because I say it is closed does not close it"). Through the API with
// scripted model answers: a gap, test, feedback or question can't be marked done by hand; a way
// chosen on it gives it to whoever takes that step; the change made for it closes it and its undo
// opens it again; a test issue closes when its case passes; dropping it is the one way out.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { buildItem, testCase, testCaseResult, testSuiteRun } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";
import { stepModelAnswer } from "./builder-v5.test-helper";
import { finishSuite } from "./testbench/suite";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const update = {
  id: "update",
  kind: "write",
  name: "Update the record",
  tool: TESTKIT_UPDATE_TOOL,
  input: { id: "r1", amount: "12.00" },
  checks: { approval: { required: "required" } },
};

function draftAnswer(gaps: string[]) {
  return stepModelAnswer({
    toolUse: {
      name: "submit_draft",
      input: {
        summary: "It fixes the record's amount and asks the client first.",
        gaps,
        startFromTemplate: null,
        bundle: {
          schemaVersion: 1,
          definition: {
            schemaVersion: 2,
            identity: { name: "Record fixer", role: "Records", mission: "Keep records right" },
            kind: "functional",
            model: { id: "claude-sonnet-5-5" },
            instructions: "Fix records when asked.",
            skills: [],
            permissions: { mode: "suggest_only" },
          },
          workflows: [
            {
              slug: "main",
              name: "Fix a record",
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

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});

type Draft = { workflows: { workflow: { steps: Record<string, unknown>[] } }[] };

/** The workflow Builder's turn: the draft it was shown, with the first step's amount set. */
function setsAmount(amount: string) {
  return (req: LlmRequest) => {
    const content = req.messages[0]?.content as string;
    const start = content.indexOf("<current_bundle>") + "<current_bundle>".length;
    const d = JSON.parse(content.slice(start, content.indexOf("</current_bundle>"))) as Draft;
    const step = d.workflows[0]?.workflow.steps[0] as { input: { amount: string } } | undefined;
    if (step) step.input.amount = amount;
    return stepModelAnswer({
      toolUse: { name: "submit_turn", input: { text: `Set it to ${amount}.`, bundle: d } },
    });
  };
}

const editProposal = (amount: string) =>
  turnAnswer({
    text: `I'm setting the amount to ${amount} on the update step.`,
    proposal: {
      summary: `Set the amount on “Update the record” to ${amount}`,
      action: { do: "edit_draft", request: `On “Update the record”, set the amount to ${amount}.` },
    },
  });

describe.skipIf(!h)("an issue is settled by its step", () => {
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
  const errorOf = (json: unknown) => (json as { error: { code: string } }).error.code;
  const drafted = async (title: string, gaps: string[]) => {
    const started = await ok("POST", "/api/ops/builds", { kind: "agent", title });
    model.push(draftAnswer(gaps));
    return ok("POST", `/api/ops/builds/${started.build.id}/draft-now`, {
      description:
        "When someone asks, fix the amount on the record in the testkit. The client approves each change.",
    });
  };

  it("refuses done by hand on a gap or a question, and drops one as not needed", async () => {
    let b = await drafted("Not closed by saying so", ["No connector reads the vendor's portal."]);
    const id = b.build.id;
    const gap = b.items.find((i) => i.kind === "gap");
    expect(gap).toMatchObject({ state: "deferred" });
    const items = (itemId: string) => `/api/ops/builds/${id}/items/${itemId}`;

    const hand = await call("PATCH", items(gap?.id as string), { state: "done" });
    expect(hand.status).toBe(409);
    expect(errorOf(hand.json)).toBe("settled_by_its_step");

    b = await ok("POST", `/api/ops/builds/${id}/items`, {
      title: "Who signs off?",
      kind: "question",
    });
    const question = b.items.find((i) => i.kind === "question");
    const asked = await call("PATCH", items(question?.id as string), { state: "done" });
    expect(asked.status).toBe(409);

    // A note is still done by a click.
    b = await ok("POST", `/api/ops/builds/${id}/items`, { title: "Ask about holidays" });
    const note = b.items.find((i) => i.kind === "note");
    b = await ok("PATCH", items(note?.id as string), { state: "done" });
    expect(b.items.find((i) => i.id === note?.id)?.state).toBe("done");

    // Dropped as not needed: closed, with its note kept.
    b = await ok("PATCH", items(gap?.id as string), { drop: true });
    const dropped = b.items.find((i) => i.id === gap?.id);
    expect(dropped?.state).toBe("done");
    expect(dropped?.detail).toMatch(/Closed as not needed\.$/);

    // The Builder can't close one by saying so either: its proposal is left out.
    b = await ok("PATCH", items(question?.id as string), { state: "open" });
    model.push(
      turnAnswer({
        text: "That's settled, I'll close it.",
        proposal: {
          summary: "Close “Who signs off?”",
          action: { do: "close_item", itemId: question?.id, state: "done" },
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Close the question." });
    expect(b.messages.at(-1)?.proposal).toBeUndefined();
    expect(b.items.find((i) => i.id === question?.id)?.state).toBe("open");
  });

  it("gives a put-off gap to who takes its step, closes it by the change, and opens it on undo", async () => {
    let b = await drafted("Given and settled", ["Nothing reads the job site from a photo."]);
    const id = b.build.id;
    const gap = b.items.find((i) => i.kind === "gap");
    const about = `item:${gap?.id}`;
    const item = (d: BuildDetail) => d.items.find((i) => i.id === gap?.id);

    // Needs code: given to Mezonas engineering and started. The Builder answering with a draft
    // edit instead isn't what was chosen, so nothing closes it.
    model.push(editProposal("19.00"));
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { about, settle: "code" });
    expect(item(b)).toMatchObject({ owner: "engineering", state: "in_progress" });
    expect(b.messages.at(-1)?.proposal).toMatchObject({ state: "proposed" });

    // Change the process: given to the Builder; its change is made, and that settles the gap.
    model.push(editProposal("18.00"), setsAmount("18.00"));
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { about, settle: "process" });
    expect(item(b)).toMatchObject({ owner: "builder", state: "done" });
    expect(item(b)?.detail).toContain("Settled by the change:");
    expect(b.messages.at(-1)?.text).toContain("so I closed it. Undo opens it again.");

    // Its undo opens it again, as it was before the change.
    const made = b.messages.find(
      (m) => m.proposal?.state === "agreed" && m.proposal.action.do === "edit_draft",
    );
    b = await ok("POST", `/api/ops/builds/${id}/messages/${made?.id}/proposal`, {
      decide: "undo",
    });
    expect(item(b)).toMatchObject({ state: "in_progress" });
  });

  it("closes a test issue when its case passes in a full run", async () => {
    const b = await drafted("Test closes on a pass", []);
    const id = b.build.id;
    const templateId = b.build.agentId as string;
    const [c] = await H.t.db
      .insert(testCase)
      .values({
        targetKind: "template",
        targetId: templateId,
        name: "Wrong amount",
        input: {},
        expected: {},
        matcher: {},
      })
      .returning({ id: testCase.id });
    const caseId = c?.id as string;
    const made = await ok("POST", `/api/ops/builds/${id}/items`, {
      title: "Test fails: Wrong amount",
      kind: "test",
      ref: { testCaseId: caseId },
    });
    const test = made.items.find((i) => i.kind === "test");
    expect(test?.state).toBe("open");

    const run = async (status: "pass" | "fail", partial: boolean) => {
      const [s] = await H.t.db
        .insert(testSuiteRun)
        .values({
          targetKind: "template",
          targetId: templateId,
          versionId: b.draft?.versionId as string,
          status: "running",
          total: 1,
        })
        .returning({ id: testSuiteRun.id });
      await H.t.db
        .insert(testCaseResult)
        .values({ suiteRunId: s?.id as string, testCaseId: caseId, status });
      await finishSuite(
        H.t.db,
        {
          suiteRunId: s?.id as string,
          tenantId: null,
          targetKind: "template",
          targetId: templateId,
          versionId: b.draft?.versionId as string,
          caseIds: [caseId],
          ...(partial ? { partial: true } : {}),
        } as Parameters<typeof finishSuite>[1],
        [{ status, costUsd: "0", label: null } as Parameters<typeof finishSuite>[2][number]],
      );
      const [row] = await H.t.db
        .select({ state: buildItem.state, detail: buildItem.detail })
        .from(buildItem)
        .where(eq(buildItem.id, test?.id as string));
      return row;
    };
    // A failing run and a partial run close nothing; a full run that passes does.
    expect((await run("fail", false))?.state).toBe("open");
    expect((await run("pass", true))?.state).toBe("open");
    const closed = await run("pass", false);
    expect(closed?.state).toBe("done");
    expect(closed?.detail).toContain("Settled: its test passes.");
  });
});
