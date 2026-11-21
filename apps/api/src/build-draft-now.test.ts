// Draft it now (docs/plan.md §1.165), through the API with scripted model answers: an agent build
// goes from its intake straight to a draft made from the operator's description. No questions, no
// brief review, no fit-gap; the Builder is asked for a draft that runs (a person does what the
// catalog can't), its decisions and gaps are kept, a client's agent is bound to that client's
// connection, and a draft that fails leaves the build where it was.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { agent, agentVersion } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const DESCRIPTION =
  "When someone asks, fix the amount on the record in the testkit. The client approves each change.";

type StepDraft = Record<string, unknown>;

const update: StepDraft = {
  id: "update",
  kind: "write",
  name: "Update the record",
  tool: TESTKIT_UPDATE_TOOL,
  input: { id: "r1", amount: "12.00" },
  checks: { approval: { required: "required" } },
};

function draftAnswer(steps: StepDraft[] = [update], more: Record<string, unknown> = {}) {
  return {
    toolUse: {
      name: "submit_draft",
      input: {
        summary: "It fixes the record's amount and asks the client first.",
        gaps: [],
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
                schemaVersion: 4,
                triggers: [{ id: "t", on: { type: "manual", input: {} } }],
                steps,
              },
            },
          ],
        },
        ...more,
      },
    },
  };
}

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});

type Draft = { workflows: { workflow: { steps: Record<string, unknown>[] } }[] };

/** The workflow Builder's turn: the draft it was shown, with the first step's amount set. */
function setsAmount(text: string, amount: string) {
  return (req: LlmRequest) => {
    const content = req.messages[0]?.content as string;
    const start = content.indexOf("<current_bundle>") + "<current_bundle>".length;
    const d = JSON.parse(content.slice(start, content.indexOf("</current_bundle>"))) as Draft;
    const step = d.workflows[0]?.workflow.steps[0] as { input: { amount: string } } | undefined;
    if (step) step.input.amount = amount;
    return { toolUse: { name: "submit_turn", input: { text, bundle: d } } };
  };
}

/** An edit of the draft, proposed by the Builder in the build's conversation. */
const editProposal = (amount: string, more: Record<string, unknown> = {}) =>
  turnAnswer({
    text: `I'm setting the amount to ${amount} on the update step.`,
    proposal: {
      summary: `Set the amount on “Update the record” to ${amount}`,
      action: { do: "edit_draft", request: `On “Update the record”, set the amount to ${amount}.` },
    },
    ...more,
  });

describe.skipIf(!h)("draft it now", () => {
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

  it("drafts a template from a description, with no questions, review or fit-gap", async () => {
    const started = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Record fixer" });
    const id = started.build.id;
    const before = model.requests.length;
    model.push(
      draftAnswer([update], {
        gaps: ["No connector reads the vendor's portal, so a person checks it for now."],
        decisions: [
          {
            id: "approve-each",
            what: "The client approves each change to a record.",
            why: "The description says so.",
            kind: "assumption",
            risk: "high",
            category: "writes",
            stepId: "update",
          },
        ],
      }),
    );
    const b = await ok("POST", `/api/ops/builds/${id}/draft-now`, { description: DESCRIPTION });

    // One model call: the draft. No intake turn, no brief review, no fit-gap turn.
    expect(model.requests.length - before).toBe(1);
    const request = model.requests.at(-1);
    expect(JSON.stringify(request?.system)).toContain("Works first: this draft must run as it is");
    expect(JSON.stringify(request?.messages)).toContain("fix the amount on the record");

    // The build is in its draft, which can move on: nothing holds it.
    expect(b.build.phase).toBe("draft");
    expect(b.phases.map((p) => p.state)).toEqual([
      "done",
      "done",
      "current",
      "todo",
      "todo",
      "todo",
    ]);
    expect(b.draft?.problems).toEqual([]);
    expect(b.gate).toEqual({ next: "poc", reasons: [] });

    // The operator's words are kept, and the Builder says what it did instead of asking.
    expect(b.build.brief.goal).toEqual({ text: DESCRIPTION, state: "assumed" });
    expect(b.messages.map((m) => m.role)).toEqual(["operator", "builder"]);
    expect(b.messages[0]?.text).toBe(DESCRIPTION);
    const said = b.messages[1]?.text ?? "";
    expect(said).toContain("I drafted it from your description.");
    expect(said).toContain("I made 1 decision to get it running instead of asking");
    expect(said).toContain("a person does it for now");
    expect(said).toContain("move to the POC test and try it on a real example");

    // Its decision is on the build, and the part nothing does yet is a gap put off: it holds nothing.
    expect(b.build.fitgap.decisions.map((d) => d.what)).toEqual([
      "The client approves each change to a record.",
    ]);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: "gap", state: "deferred" });
    expect(b.items[0]?.title).toContain("No connector reads the vendor's portal");

    // The flow as drafted is on the build: its steps in order, in plain words.
    expect(b.draft?.steps).toEqual([
      {
        workflow: "Fix a record",
        stepId: expect.any(String),
        depth: 0,
        kind: "write",
        name: "Update the record",
        words: "Updates your tools, after a person approves",
      },
    ]);

    // Asked again, it is refused: the build has its draft.
    const again = await call("POST", `/api/ops/builds/${id}/draft-now`, { description: "More" });
    expect(again.status).toBe(409);
    expect(errorOf(again.json)).toBe("same_phase");

    // On to the POC test: it opens with the try, and the Builder writes no plan of made-up data.
    const calls = model.requests.length;
    const poc = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    expect(poc.build.phase).toBe("poc");
    expect(model.requests.length).toBe(calls);
    expect(poc.build.testPlan.datasets).toEqual([]);
    expect(poc.messages.at(-1)?.text).toContain("Try it now on a real example");
  });

  it("has the Builder put a person where it left a missing step", async () => {
    const started = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Portal check" });
    const id = started.build.id;
    const before = model.requests.length;
    model.push(
      draftAnswer([
        {
          id: "portal",
          kind: "missing",
          name: "Read the vendor's portal",
          need: "There is no connector for the vendor's portal.",
          fill: "connector",
        },
        update,
      ]),
      draftAnswer([
        {
          id: "portal",
          kind: "person",
          name: "Read the vendor's portal",
          mode: "ask",
          assignee: "client_admin",
          title: "Check the vendor's portal and enter the amount",
          deadline: { after: "2 days" },
        },
        update,
      ]),
    );
    const b = await ok("POST", `/api/ops/builds/${id}/draft-now`, { description: DESCRIPTION });
    // The missing step went back to the Builder as something to repair, and the draft runs.
    expect(model.requests.length - before).toBe(2);
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain("missing_step");
    expect(b.build.phase).toBe("draft");
    expect(b.draft?.problems).toEqual([]);
    expect(b.gate.reasons).toEqual([]);
  });

  it("leaves the build where it was when the draft fails, and says the words once", async () => {
    const started = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Record fixer 2" });
    const id = started.build.id;
    // Nothing to draft from: no description, an empty brief.
    const empty = await call("POST", `/api/ops/builds/${id}/draft-now`, {});
    expect(empty.status).toBe(400);
    expect(errorOf(empty.json)).toBe("nothing_to_draft");

    model.push({ error: new Error("the model is down") });
    const failed = await call("POST", `/api/ops/builds/${id}/draft-now`, {
      description: DESCRIPTION,
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    let b = await ok("GET", `/api/ops/builds/${id}`);
    expect(b.build.phase).toBe("intake");
    expect(b.draft).toBeNull();
    expect(b.messages.map((m) => m.role)).toEqual(["operator"]);

    model.push(draftAnswer());
    b = await ok("POST", `/api/ops/builds/${id}/draft-now`, { description: DESCRIPTION });
    expect(b.build.phase).toBe("draft");
    expect(b.messages.map((m) => m.role)).toEqual(["operator", "builder"]);
  });

  it("drafts from the brief as it is when no description is given", async () => {
    const started = await ok("POST", "/api/ops/builds", { kind: "agent", title: "Record fixer 3" });
    const id = started.build.id;
    await ok("PATCH", `/api/ops/builds/${id}`, {
      brief: { goal: { text: "Keep the testkit's records right", state: "confirmed" } },
    });
    model.push(draftAnswer());
    const b = await ok("POST", `/api/ops/builds/${id}/draft-now`, {});
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain(
      "Keep the testkit's records right",
    );
    expect(b.build.phase).toBe("draft");
    expect(b.build.brief.goal?.state).toBe("confirmed");
    expect(b.messages.map((m) => m.role)).toEqual(["builder"]);
  });

  it("binds a client's agent to that client's connection, and loosens nothing", async () => {
    const started = await ok("POST", "/api/ops/builds", {
      kind: "agent",
      title: "Record fixer for A",
      clientId: H.A.tenantId,
    });
    const id = started.build.id;
    model.push(draftAnswer());
    const b = await ok("POST", `/api/ops/builds/${id}/draft-now`, { description: DESCRIPTION });
    expect(b.build.phase).toBe("draft");
    const [row] = await H.t.db
      .select({ bindings: agent.bindings, tenantId: agent.tenantId })
      .from(agent)
      .where(eq(agent.id, b.build.agentId as string));
    expect(row).toEqual({ tenantId: H.A.tenantId, bindings: { testkit: H.A.connectionId } });
    expect(b.messages.at(-1)?.text).toContain("I bound it to the client's connection it uses.");
    // Bound, it is checked against the connection's own settings: no "no connection is bound".
    expect(b.draft?.problems.map((p) => p.code)).not.toContain("connection_missing");
  });

  // Owner (2026-11-21): "if we get it written then we can see the flows and keep editing it".
  describe("changes asked for are made at once", () => {
    const versionsOf = async (agentId: string) =>
      H.t.db
        .select({ version: agentVersion.version, bundle: agentVersion.bundle })
        .from(agentVersion)
        .where(eq(agentVersion.agentId, agentId))
        .orderBy(desc(agentVersion.version));
    const drafted = async (title: string, gaps: string[] = []) => {
      const started = await ok("POST", "/api/ops/builds", { kind: "agent", title });
      model.push(draftAnswer([update], { gaps }));
      return ok("POST", `/api/ops/builds/${started.build.id}/draft-now`, {
        description: DESCRIPTION,
      });
    };

    it("makes a draft edit the operator asked for in words, and undoes it", async () => {
      let b = await drafted("Asked edits");
      const id = b.build.id;
      const agentId = b.build.agentId as string;
      const before = (await versionsOf(agentId)).length;

      model.push(editProposal("15.00", { asked: true }), setsAmount("Set it to 15.00.", "15.00"));
      b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Make the amount 15.00." });
      // No Agree: the change is made, saved as a new version, and can be undone.
      const proposed = b.messages.find((m) => m.proposal);
      expect(proposed?.proposal).toMatchObject({ state: "agreed", undo: true });
      expect(proposed?.proposal?.result).toMatch(/^Changed: /);
      let saved = await versionsOf(agentId);
      expect(saved).toHaveLength(before + 1);
      expect(JSON.stringify(saved[0]?.bundle)).toContain('"15.00"');
      // The conversation says what happened in the Builder's words, never an "Agreed." of ours.
      const texts = b.messages.map((m) => `${m.role}: ${m.text}`);
      expect(texts).toContain("builder: Making the change you asked for.");
      expect(texts).not.toContain("operator: Agreed.");
      expect(b.messages.at(-1)?.text).toContain("Changed the draft");

      b = await ok("POST", `/api/ops/builds/${id}/messages/${proposed?.id}/proposal`, {
        decide: "undo",
      });
      saved = await versionsOf(agentId);
      expect(JSON.stringify(saved[0]?.bundle)).toContain('"12.00"');
      expect(b.messages.find((m) => m.id === proposed?.id)?.proposal?.state).toBe("undone");
    });

    it("leaves the Builder's own suggestion as a proposal to agree", async () => {
      let b = await drafted("Suggested edits");
      const agentId = b.build.agentId as string;
      const before = (await versionsOf(agentId)).length;
      model.push(editProposal("20.00"));
      b = await ok("POST", `/api/ops/builds/${b.build.id}/turns`, { text: "What would you fix?" });
      expect(b.messages.at(-1)?.proposal).toMatchObject({ state: "proposed" });
      expect(await versionsOf(agentId)).toHaveLength(before);
    });

    it("settles an issue the way its button says, with no second yes", async () => {
      let b = await drafted("Settled issues", ["No connector reads the vendor's portal."]);
      const id = b.build.id;
      const agentId = b.build.agentId as string;
      const issue = `item:${b.items[0]?.id}`;
      const before = (await versionsOf(agentId)).length;

      // A way needs its issue.
      const bare = await call("POST", `/api/ops/builds/${id}/turns`, { settle: "process" });
      expect(bare.status).toBe(400);
      expect(errorOf(bare.json)).toBe("settle_needs_issue");

      // Change the process: the way's own words go to the Builder, and its edit is made at once
      // whether or not it says the operator asked.
      model.push(editProposal("18.00"), setsAmount("Set it to 18.00.", "18.00"));
      b = await ok("POST", `/api/ops/builds/${id}/turns`, { about: issue, settle: "process" });
      const said = b.messages.find((m) => m.role === "operator" && m.about === issue);
      expect(said?.text).toContain("Settle this by changing the process");
      expect(b.messages.find((m) => m.proposal)?.proposal).toMatchObject({ state: "agreed" });
      const saved = await versionsOf(agentId);
      expect(saved).toHaveLength(before + 1);
      expect(JSON.stringify(saved[0]?.bundle)).toContain('"18.00"');

      // Needs code, but the Builder proposes a draft edit instead: not what was chosen, so it
      // waits for the operator.
      model.push(editProposal("19.00"));
      b = await ok("POST", `/api/ops/builds/${id}/turns`, { about: issue, settle: "code" });
      expect(b.messages.at(-1)?.proposal).toMatchObject({ state: "proposed" });
      expect(await versionsOf(agentId)).toHaveLength(before + 1);
    });
  });

  it("is for agent builds", async () => {
    const started = await ok("POST", "/api/ops/builds", { kind: "skill", title: "Group rows" });
    const res = await call("POST", `/api/ops/builds/${started.build.id}/draft-now`, {
      description: "Group invoice rows by customer.",
    });
    expect(res.status).toBe(422);
    expect(errorOf(res.json)).toBe("not_an_agent");
  });
});
