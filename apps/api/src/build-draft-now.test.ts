// Draft it now (docs/plan.md §1.164), through the API with scripted model answers: an agent build
// goes from its intake straight to a draft made from the operator's description. No questions, no
// brief review, no fit-gap; the Builder is asked for a draft that runs (a person does what the
// catalog can't), its decisions and gaps are kept, a client's agent is bound to that client's
// connection, and a draft that fails leaves the build where it was.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { agent } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
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

    // Asked again, it is refused: the build has its draft.
    const again = await call("POST", `/api/ops/builds/${id}/draft-now`, { description: "More" });
    expect(again.status).toBe(409);
    expect(errorOf(again.json)).toBe("same_phase");
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

  it("is for agent builds", async () => {
    const started = await ok("POST", "/api/ops/builds", { kind: "skill", title: "Group rows" });
    const res = await call("POST", `/api/ops/builds/${started.build.id}/draft-now`, {
      description: "Group invoice rows by customer.",
    });
    expect(res.status).toBe(422);
    expect(errorOf(res.json)).toBe("not_an_agent");
  });
});
