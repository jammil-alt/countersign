// Decisions on a build (docs/builder-plan.md §4) through the API, with scripted model answers: the
// Builder records its decisions in the fit-gap and while drafting, any decision can be talked
// about, the risk of one on a step that writes is raised by code, the high-risk ones hold the move
// from the POC into the client test until the operator marks them discussed or confirmed, and only
// operators reach the status route.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { type BuildDetail, buildIssues } from "@countersign/core";
import { FakeModel } from "@countersign/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});
const reviewed = () => ({ toolUse: { name: "submit_review", input: { concerns: [] } } });

function draftAnswer() {
  return {
    toolUse: {
      name: "submit_draft",
      input: {
        summary: "It updates the record and asks the client first.",
        gaps: [],
        slug: "record-review",
        startFromTemplate: null,
        decisions: [
          {
            id: "post",
            what: "The record is updated only after a person approves",
            why: "Writes start strict.",
            kind: "decision_point",
            // The model's id for the step: the server renames it, the decision follows.
            stepId: "update",
          },
        ],
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

describe.skipIf(!h)("decisions on a build", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown, who = OPERATOR) => {
    const res = await H.call(who, method, path, body);
    return { status: res.status, json: res.json as BuildDetail };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };
  const lastUserText = () => {
    const m = model.requests.at(-1)?.messages.at(-1);
    return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
  };

  it("are recorded by the Builder, raised by code and looked at before the client test", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Record review" });
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
        // Intake doesn't record decisions: they start in the fit-gap.
        decisions: [{ id: "early", what: "Too early", kind: "assumption" }],
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    expect(b.build.fitgap.decisions).toEqual([]);

    // Fit-gap: the Builder starts its decisions list.
    model.push(reviewed());
    model.push(
      turnAnswer({
        text: "One we do as is.",
        fitgap: {
          rows: [
            { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" },
          ],
          needsTrue: [],
        },
        decisions: [
          {
            id: "freight",
            what: "Freight and fees stay out of the record",
            why: "The brief is about the record's amount.",
            kind: "assumption",
          },
          {
            id: "tol",
            what: "The amount may differ by at most 0% before a person looks",
            why: "Strict first.",
            value: "0%",
            kind: "client_setup",
            category: "money",
          },
        ],
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(b.build.fitgap.decisions.map((d) => [d.id, d.risk, d.status])).toEqual([
      ["freight", "normal", "never_discussed"],
      // A category on the high-risk list makes it high, whatever the Builder said.
      ["tol", "high", "never_discussed"],
    ]);
    expect(b.messages.at(-1)?.changes).toContain(
      "Decision: Freight and fees stay out of the record",
    );

    // Any decision can be talked about, not only the high-risk ones; the Builder updates it.
    model.push(
      turnAnswer({
        text: "It rests on the brief. I set it to leave fees out too.",
        about: "decision:freight",
        decisions: [
          {
            id: "freight",
            what: "Freight and fees stay out of the record",
            why: "The brief is about the record's amount, so fees are left out as well.",
            kind: "assumption",
          },
        ],
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, {
      text: "Why is that?",
      about: "decision:freight",
    });
    expect(lastUserText()).toContain("Talking about: [decision:freight]");
    expect(lastUserText()).toContain("[decision:tol] (Client setup, high risk (money)");
    expect(b.messages.at(-2)?.about).toBe("decision:freight");
    expect(b.messages.at(-1)?.about).toBe("decision:freight");
    expect(b.build.fitgap.decisions[0]?.why).toContain("fees are left out as well");

    // The draft: the drafter's decision is kept, on the step as the server named it, and is
    // high risk by code: that step writes to a client's tool.
    model.push(draftAnswer());
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    expect(b.build.phase).toBe("draft");
    // The drafter is told the decisions made so far, so the draft follows them.
    const drafted = JSON.stringify(model.requests.at(-1)?.messages);
    expect(drafted).toContain("Decisions already made");
    expect(drafted).toContain("Freight and fees stay out of the record");
    expect(drafted).toContain("(starts at 0%)");
    const post = b.build.fitgap.decisions.find((d) => d.id === "post");
    expect(post).toMatchObject({ kind: "decision_point", risk: "high" });
    expect(post?.stepId).toBeTruthy();
    expect(post?.stepId).not.toBe("update");

    // POC: the high-risk ones are issues, in the Builder's facts, and hold the client test.
    model.push(turnAnswer({ text: "One record will do.", testPlan: { datasets: [] } }));
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    expect(lastUserText()).toContain("High-risk decision not looked at yet [decision:post]");
    expect(b.gate.reasons).toContain("2 high-risk decisions haven't been looked at yet.");
    expect(
      buildIssues(b)
        .filter((i) => i.source === "decision")
        .map((i) => [i.key, i.blocking]),
    ).toEqual([
      ["decision:tol", true],
      ["decision:post", true],
    ]);

    // The operator marks them; only operators may, and only to their own statuses.
    const path = (d: string) => `/api/ops/builds/${id}/decisions/${d}`;
    expect((await H.call(admin("a"), "PATCH", path("tol"), { status: "confirmed" })).status).toBe(
      403,
    );
    expect((await call("PATCH", path("tol"), { status: "changed" })).status).toBe(400);
    expect((await call("PATCH", path("nowhere"), { status: "discussed" })).status).toBe(404);
    b = await ok("PATCH", path("tol"), { status: "confirmed" });
    expect(b.build.fitgap.decisions.find((d) => d.id === "tol")).toMatchObject({
      status: "confirmed",
      by: expect.any(String),
      at: expect.any(String),
    });
    expect(b.gate.reasons).toContain("1 high-risk decision hasn't been looked at yet.");
    b = await ok("PATCH", path("post"), { status: "discussed" });
    expect(b.gate.reasons.join(" ")).not.toContain("high-risk");
    expect(buildIssues(b).some((i) => i.source === "decision")).toBe(false);
    expect(b.events.some((e) => e.kind === "record")).toBe(true);

    // A save of the fit-gap leaves the decisions as they are.
    b = await ok("PATCH", `/api/ops/builds/${id}`, {
      fitgap: { ...b.build.fitgap, decisions: [] },
    });
    expect(b.build.fitgap.decisions.map((d) => d.status)).toEqual([
      "never_discussed",
      "confirmed",
      "discussed",
    ]);

    // The Builder's rewrite of a looked-at decision says it changed, and keeps who looked.
    model.push(
      turnAnswer({
        text: "Set to 1%, as you said.",
        decisions: [
          {
            id: "tol",
            what: "The amount may differ by at most 1% before a person looks",
            why: "The operator asked for 1%.",
            value: "1%",
            kind: "client_setup",
            category: "money",
          },
        ],
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Make the tolerance 1%." });
    expect(b.build.fitgap.decisions.find((d) => d.id === "tol")).toMatchObject({
      status: "changed",
      value: "1%",
      by: expect.any(String),
    });
    expect(b.gate.reasons.join(" ")).not.toContain("high-risk");
  });
});
