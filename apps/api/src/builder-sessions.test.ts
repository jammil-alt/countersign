// v0.12 W3-A: the Builder as a conversation through the API (ARCHITECTURE §9.6; docs/plan.md §1.51,
// M28), with scripted model answers (FakeModel). M28's done-when: a three-turn session drafts Remy,
// undoes one change alone, changes a setting with /skill, drafts match-card-charge with 8 cases,
// and saves two steps as an automation. Also: an undo that conflicts with a later change is
// refused, the guards hold across turns, a client's examples become that client's cases, and only
// the operators who serve the client reach its conversations.

import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { type AgentBundle, type Step, walkSteps } from "@countersign/core";
import { agentVersion, builderTurn, testCase } from "@countersign/db";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createApiHarness, OPERATOR, OTHER_OPERATOR } from "./api.test-helper";

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

type Json = Record<string, unknown>;
type Turn = {
  id: string;
  seq: number;
  role: string;
  text: string;
  command: string | null;
  changes: { id: string; label: string; undone: boolean }[];
  notes: string[];
  costUsd: string;
};
type Detail = { session: Json & { bundle: AgentBundle }; turns: Turn[]; turn?: Turn };

const stepsOf = (b: AgentBundle) => {
  const out: Step[] = [];
  for (const w of b.workflows) walkSteps(w.workflow, ({ step }) => out.push(step));
  return out;
};

/** The aliased draft the model was shown. */
function shown(req: LlmRequest): Json {
  const content = req.messages[0]?.content as string;
  const start = content.indexOf("<current_bundle>") + "<current_bundle>".length;
  return JSON.parse(content.slice(start, content.indexOf("</current_bundle>"))) as Json;
}

type Draft = {
  definition: Json & { skills: Json[]; permissions: Json };
  workflows: { workflow: { steps: Json[] } }[];
};

/** A model turn that edits the draft it was shown. */
function edits(text: string, fn: (b: Draft) => void) {
  return (req: LlmRequest) => {
    const b = structuredClone(shown(req)) as unknown as Draft;
    fn(b);
    return { toolUse: { name: "submit_turn", input: { text, bundle: b } } };
  };
}

const SKILL = "custom:match-receipt";

describe.skipIf(!h)("the Builder as a conversation", () => {
  const H = h as NonNullable<typeof h>;
  const ok = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await H.call(who, method, path, body);
    if (res.status !== 200)
      throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json as Detail & Json;
  };

  it("drafts Remy in three turns, undoes one change alone, and saves two steps as an automation", async () => {
    // A published shared skill the agent can use.
    const created = await ok(OPERATOR, "POST", "/api/ops/skills", {
      definition: {
        schemaVersion: 1,
        id: SKILL,
        name: "Match a receipt",
        description: "Finds the record a card receipt belongs to",
        category: "data",
        mode: "agent",
        instructions: "Match it.",
        tools: [TESTKIT_QUERY_TOOL],
        input: { type: "object", properties: { text: { type: "string" } } },
        output: { type: "object", properties: { recordId: { type: "string" } } },
        settings: [{ key: "window_days", label: "Window", type: "number", default: 3 }],
      },
    });
    const skill = created.skill as Json;
    const version = created.version as Json;
    await ok(OPERATOR, "POST", `/api/ops/skills/${skill.id}/versions/${version.id}/publish`);

    // Start: a new client agent for A.
    const start = await ok(OPERATOR, "POST", "/api/ops/builder/sessions", {
      kind: "agent",
      clientId: H.A.tenantId,
      name: "Remy",
      role: "Card receipts",
    });
    const id = start.session.id as string;
    const triggerId = start.session.bundle.workflows[0]?.workflow.trigger.id as string;
    expect(start.session).toMatchObject({ kind: "agent", clientId: H.A.tenantId, status: "open" });
    expect(start.turns.map((t) => t.command)).toEqual(["/start"]);

    // Turn 1: the draft. The model tries to act alone, skip an approval and switch oversight off.
    model.push(
      edits("Remy matches each receipt, notes it, waits a day and tells the lead.", (b) => {
        b.definition.permissions = { mode: "act" };
        b.definition.oversight = { review: "off" };
        b.definition.skills = [{ skill: SKILL }];
        b.definition.instructions = "Match card receipts to their records.";
        (b.workflows[0] as Draft["workflows"][number]).workflow.steps = [
          {
            id: "s1",
            kind: "skill",
            name: "Match the receipt",
            skill: SKILL,
            input: { text: "{{trigger.text}}" },
            model: { id: "claude-haiku-5-5" },
          },
          {
            id: "s2",
            kind: "action",
            name: "Note it on the record",
            tool: TESTKIT_UPDATE_TOOL,
            input: { id: "{{steps.s1.output.recordId}}", name: "Receipt matched" },
            approval: { required: "not_required" },
          },
          { id: "s3", kind: "wait", name: "Wait a day", for: "1 day" },
          { id: "s4", kind: "notify", name: "Tell the lead", channel: "thread", message: "Done" },
        ];
      }),
    );
    const t1 = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: "Draft Remy: match each card receipt to its record and note it there.",
    });
    // The model never saw a real id.
    const request = JSON.stringify(model.requests.at(-1));
    expect(request).not.toContain(triggerId);
    expect(request).not.toContain(id);
    const b1 = t1.session.bundle;
    expect(b1.workflows[0]?.workflow.trigger.id).toBe(triggerId);
    const [match, note, wait, notify] = stepsOf(b1);
    for (const s of [match, note, wait, notify]) expect(s?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b1.definition.permissions.mode).toBe("suggest_only");
    expect(b1.definition.oversight).toMatchObject({ review: "failures" });
    expect(note?.kind === "action" ? note.approval.required : null).toBe("required");
    // A step model the platform prices stays.
    expect(match?.kind === "skill" ? match.model : null).toEqual({ id: "claude-haiku-5-5" });
    const turn1 = t1.turn as Turn;
    expect(turn1.role).toBe("builder");
    expect(turn1.changes.map((c) => c.label)).toEqual(
      expect.arrayContaining([
        "+1 skill, step 1 · Match the receipt",
        "+1 action, step 2 · Note it on the record",
        "+1 wait, step 3 · Wait a day",
        "+1 notify, step 4 · Tell the lead",
      ]),
    );
    expect(turn1.notes.join(" ")).toContain("Approval stays on");

    // Undo one change alone: the notify step goes, the rest of the turn stays.
    const notifyChange = turn1.changes.find((c) => c.id === `step:${notify?.id}`);
    const u1 = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/undo`, {
      turnId: turn1.id,
      changeId: notifyChange?.id,
    });
    expect(stepsOf(u1.session.bundle).map((s) => s.id)).toEqual([match?.id, note?.id, wait?.id]);
    expect(u1.session.bundle.definition.instructions).toBe("Match card receipts to their records.");
    const after = u1.turns.find((t) => t.id === turn1.id);
    expect(after?.changes.find((c) => c.id === notifyChange?.id)?.undone).toBe(true);
    expect(after?.changes.filter((c) => c.undone)).toHaveLength(1);
    // Twice is refused.
    const twice = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/undo`, {
      turnId: turn1.id,
      changeId: notifyChange?.id,
    });
    expect(twice.status).toBe(409);

    // Turn 2: /skill changes a setting; what else the model touches is left out.
    model.push(
      edits("The window is now 5 days.", (b) => {
        b.definition.skills = [{ skill: SKILL, settings: { window_days: 5 } }];
        b.definition.instructions = "Rewritten out of scope.";
      }),
    );
    const t2 = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: "/skill match-receipt widen the window to 5 days",
    });
    expect(t2.session.bundle.definition.skills).toEqual([
      { skill: SKILL, settings: { window_days: 5 } },
    ]);
    expect(t2.session.bundle.definition.instructions).toBe("Match card receipts to their records.");
    expect((t2.turn as Turn).changes.map((c) => c.label)).toEqual([
      "~1 skill · custom:match-receipt · setting · window_days none → 5",
    ]);
    const asked = t2.turns.find((t) => t.seq === (t2.turn as Turn).seq - 1);
    expect(asked?.command).toBe("/skill");

    // Turn 3: rename the note step. Then undoing turn 1's note step conflicts with it.
    model.push(
      edits("Renamed it.", (b) => {
        const steps = (b.workflows[0] as Draft["workflows"][number]).workflow.steps;
        (steps[1] as Json).name = "Note the match";
      }),
    );
    const t3 = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: "Call the note step 'Note the match'.",
    });
    expect(stepsOf(t3.session.bundle)[1]?.name).toBe("Note the match");
    const conflict = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/undo`, {
      turnId: turn1.id,
      changeId: `step:${note?.id}`,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ error: { code: "undo_conflict" } });

    // Save the note and wait steps as an automation; one use step takes their place.
    const auto = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/automation`, {
      stepIds: [note?.id, wait?.id],
      slug: "note-and-wait",
      name: "Note and wait",
    });
    expect(auto.automation).toMatchObject({ slug: "note-and-wait", ref: "note-and-wait@1" });
    const steps = stepsOf(auto.session.bundle);
    expect(steps.map((s) => s.kind)).toEqual(["skill", "use_automation"]);
    expect(steps[0]?.id).toBe(match?.id);
    expect((auto.turn as Turn).command).toBe("/save-automation");
    const listed = await ok(OPERATOR, "GET", `/api/ops/automations?client=${H.A.tenantId}`);
    expect((listed.automations as Json[]).find((a) => a.slug === "note-and-wait")).toMatchObject({
      source: "client",
      clientId: H.A.tenantId,
      latestStatus: "draft",
    });

    // Save: a client agent with a v1 draft written by the Builder; nothing is published.
    const saved = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/save`, {});
    expect(saved.session.status).toBe("saved");
    const v = saved.version as { id: string; version: number };
    expect(v.version).toBe(1);
    const [row] = await H.t.db.select().from(agentVersion).where(eq(agentVersion.id, v.id));
    expect(row).toMatchObject({ status: "draft", authorType: "builder", tenantId: H.A.tenantId });
    expect(row?.bundle.definition.permissions.mode).toBe("suggest_only");
    expect(row?.bundle.definition.oversight).toMatchObject({ review: "failures" });

    // Turns are history: the model's cost is on its turns, and a turn can't be rewritten.
    const turns = await H.t.db
      .select()
      .from(builderTurn)
      .where(eq(builderTurn.sessionId, id))
      .orderBy(builderTurn.seq);
    expect(turns.map((t) => t.command)).toEqual([
      "/start",
      null,
      null,
      "/undo",
      "/skill",
      null,
      null,
      null,
      "/save-automation",
      "/save",
    ]);
    expect(turns.find((t) => t.id === turn1.id)?.costUsd).not.toBe("0.0000");

    // Only operators who serve A reach the conversation.
    expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/builder/sessions/${id}`)).status).toBe(
      404,
    );
    const mine = await ok(OPERATOR, "GET", `/api/ops/builder/sessions?client=${H.A.tenantId}`);
    expect((mine.sessions as Json[]).map((s) => s.id)).toContain(id);
    const theirs = await ok(OTHER_OPERATOR, "GET", "/api/ops/builder/sessions");
    expect((theirs.sessions as Json[]).map((s) => s.id)).not.toContain(id);

    // A turn that changes nothing leaves nothing new to save.
    model.push(edits("Nothing to change.", () => {}));
    const t4 = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: "Is the window right?",
    });
    expect((t4.turn as Turn).changes).toEqual([]);
    const again = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/save`, {});
    expect(again.status).toBe(409);
  });

  it("drafts match-card-charge with 8 cases from a client's examples, the client's own", async () => {
    const start = await ok(OPERATOR, "POST", "/api/ops/builder/sessions", {
      kind: "skill",
      clientId: H.A.tenantId,
    });
    const id = start.session.id as string;
    const examples = Array.from({ length: 8 }, (_, i) => ({
      name: `Charge ${i + 1}`,
      input: { amount: `${(i + 1) * 12}.50`, merchant: `Lumber yard ${i + 1}` },
      expected: { recordId: `r${i + 1}` },
    }));
    model.push({
      toolUse: {
        name: "submit_skill",
        input: {
          text: "Drafted match-card-charge: it matches on amount, then merchant.",
          definition: {
            slug: "match-card-charge",
            name: "Match card charge",
            description: "Finds the record a card charge belongs to",
            category: "data",
            mode: "task",
            model: { id: "claude-haiku-5-5" },
            instructions: "Match on the amount first, then the merchant.",
            tools: [TESTKIT_QUERY_TOOL],
            input: { type: "object", properties: { amount: { type: "string" } } },
            output: { type: "object", properties: { recordId: { type: "string" } } },
          },
          cases: examples.map((_, i) => ({
            example: i + 1,
            matcher: { kind: "label", label: { field: "recordId", positive: `r${i + 1}` } },
          })),
        },
      },
    });
    const t = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: "Draft a skill that matches a card charge to its record.",
      examples,
    });
    expect((t.turn as Turn).changes).toHaveLength(9);
    const draft = t.session.bundle as unknown as { definition: Json; cases: Json[] };
    expect(draft.definition).toMatchObject({ id: "custom:match-card-charge", mode: "task" });
    expect(draft.cases.map((c) => c.input)).toEqual(examples.map((e) => e.input));
    // Commands are for agents.
    const bad = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: "/trigger schedule weekly",
    });
    expect(bad.status).toBe(422);

    const saved = await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/save`, {});
    expect(saved.skill).toMatchObject({ ref: "custom:match-card-charge" });
    const cases = saved.cases as Json[];
    expect(cases).toHaveLength(8);
    for (const c of cases) expect(c.clientId).toBe(H.A.tenantId);
    const rows = await H.t.db
      .select()
      .from(testCase)
      .where(eq(testCase.targetId, (saved.skill as Json).id as string));
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r).toMatchObject({ tenantId: H.A.tenantId, source: "builder", targetKind: "skill" });
    }
    // The test bench shows them as A's; an operator who doesn't serve A doesn't see the skill.
    const target = `/api/ops/tests?target=skill:${(saved.skill as Json).id}`;
    const bench = await ok(OPERATOR, "GET", target);
    expect((bench.cases as Json[]).map((c) => c.clientId)).toEqual(
      Array.from({ length: 8 }, () => H.A.tenantId),
    );
    expect((await H.call(OTHER_OPERATOR, "GET", target)).status).toBe(404);
  });

  it("refuses a /command it doesn't know and a closed conversation", async () => {
    const start = await ok(OPERATOR, "POST", "/api/ops/builder/sessions", {
      kind: "agent",
      name: "Template draft",
    });
    const id = start.session.id as string;
    expect(start.session.clientId).toBeNull();
    const unknown = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: "/remy do something",
    });
    expect(unknown.status).toBe(422);
    expect(unknown.json).toMatchObject({ error: { code: "unknown_command" } });
    await ok(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/close`);
    const closed = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: "More",
    });
    expect(closed.status).toBe(409);
  });
});
