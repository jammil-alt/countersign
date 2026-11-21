// A client agent's step against its template's, in plain words, and the way back: the template's
// own settings under the same id, the steps inside left as the client has them.
import { describe, expect, it } from "vitest";
import { customizedSteps, type Process, type Step } from "../../builder/model";
import { putBackStep, stepDiff } from "./stepDiff";

const step = (s: Record<string, unknown>) => s as unknown as Step;
const texts = (a: Step, b: Step) => stepDiff(a, b).map((l) => l.text);

const WRITE = step({
  id: "update",
  kind: "write",
  name: "Update the bill",
  tool: "qbo.bill.update_lines",
  input: { billId: "{{trigger.billId}}", memo: "From Mezonas" },
});
const SKILL = step({
  id: "read",
  kind: "skill",
  name: "Read the invoice",
  skill: "docs.read-invoice@3",
  input: {},
});
const ASK = step({
  id: "ask",
  kind: "person",
  name: "Ask the client",
  mode: "ask",
  assignee: "client_admin",
  title: "Is it right?",
  payload: {},
  deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
  channel: "inbox",
  onReject: "stop",
});

describe("stepDiff", () => {
  it("says nothing for the template's step as it is, or a step the template doesn't have", () => {
    expect(stepDiff(WRITE, WRITE)).toEqual([]);
    expect(stepDiff(WRITE, undefined)).toEqual([]);
  });

  it("words a loosened approval, a skill version and a name", () => {
    expect(
      texts(
        step({
          ...WRITE,
          checks: { approval: { required: "not_required", mode: "in_turn", ifNoAnswer: "stop" } },
        }),
        WRITE,
      ),
    ).toEqual(["Approval: Ask first → On its own"]);
    expect(texts(step({ ...SKILL, skill: "docs.read-invoice@4" }), SKILL)).toEqual([
      "Skill version 3 → 4",
    ]);
    expect(texts(step({ ...SKILL, skill: "docs.read-receipt@1" }), SKILL)).toEqual([
      "Skill: docs.read-invoice → docs.read-receipt",
    ]);
    expect(texts(step({ ...ASK, name: "Ask Jammil" }), ASK)).toEqual([
      "Name: “Ask the client” → “Ask Jammil”",
    ]);
  });

  it("words who approves when approval stays on, a deadline, who is asked and an input", () => {
    const approval = (who: string) => ({
      checks: {
        approval: {
          required: "required",
          mode: "in_turn",
          approvers: [{ who }],
          ifNoAnswer: "stop",
          onReject: "stop",
        },
      },
    });
    expect(
      texts(
        step({ ...WRITE, ...approval("lead") }),
        step({ ...WRITE, ...approval("client_admin") }),
      ),
    ).toEqual([
      "Approval: client admin · if nobody answers, it stops → the client's lead · if nobody answers, it stops",
    ]);
    expect(
      texts(
        step({
          ...ASK,
          assignee: "lead",
          deadline: { after: "2 days", hours: "business", ifNoAnswer: "stop" },
        }),
        ASK,
      ),
    ).toEqual([
      "Who: client admin → the client's lead",
      "Deadline: 1 day · if nobody answers, it stops → 2 days in business hours · if nobody answers, it stops",
    ]);
    expect(
      texts(step({ ...WRITE, input: { billId: "{{trigger.billId}}", memo: "Checked" } }), WRITE),
    ).toEqual(["Input: memo"]);
    expect(texts(step({ ...WRITE, tool: "qbo.bill.create" }), WRITE)).toEqual([
      "Tool: qbo.bill.update lines → qbo.bill.create",
    ]);
  });

  it("reads a decision's paths, and the steps inside as their own", () => {
    const decision = (paths: unknown[], otherwise: Step[] = []) =>
      step({
        id: "d",
        kind: "if",
        name: "Is it a duplicate?",
        paths,
        otherwise: { id: "o", steps: otherwise },
      });
    const path = (id: string, name: string, steps: Step[] = []) => ({
      id,
      name,
      when: { match: "all", rules: [] },
      steps,
    });
    const was = decision([path("p1", "It is a duplicate", [SKILL])]);
    // The nested step's own edit is not the decision's.
    expect(
      texts(
        decision([path("p1", "It is a duplicate", [step({ ...SKILL, name: "Read it" })])]),
        was,
      ),
    ).toEqual([]);
    expect(
      texts(
        decision([path("p1", "A duplicate", [SKILL, WRITE]), path("p2", "It is new")], [ASK]),
        was,
      ),
    ).toEqual([
      "Path name: “It is a duplicate” → “A duplicate”",
      "Path “A duplicate”: the steps on it",
      "Path added: “It is new”",
      "Otherwise: the steps on it",
    ]);
  });

  it("marks the same steps customizedSteps marks as changed", () => {
    const template = {
      schemaVersion: 4,
      triggers: [],
      steps: [WRITE, SKILL, ASK],
    } as unknown as Process;
    const mine = {
      ...template,
      steps: [
        WRITE,
        step({ ...SKILL, skill: "docs.read-invoice@4" }),
        step({ ...ASK, title: "OK?" }),
      ],
    } as Process;
    const changed = [...customizedSteps(mine, template)].map(([id]) => id);
    expect(changed).toEqual(["read", "ask"]);
    for (const s of mine.steps) {
      const was = template.steps.find((t) => t.id === s.id);
      expect(stepDiff(s, was).length > 0).toBe(changed.includes(s.id));
    }
  });
});

describe("putBackStep", () => {
  const template = {
    schemaVersion: 4,
    triggers: [],
    steps: [
      SKILL,
      step({
        id: "d",
        kind: "if",
        name: "Is it a duplicate?",
        paths: [
          { id: "p1", name: "It is a duplicate", when: { match: "all", rules: [] }, steps: [ASK] },
        ],
        otherwise: { id: "o", steps: [] },
      }),
      WRITE,
    ],
  } as unknown as Process;

  it("puts the template's settings back under the same id, and nothing when they are the same", () => {
    const mine = {
      ...template,
      steps: [
        step({ ...SKILL, name: "Read it", skill: "docs.read-invoice@4" }),
        ...template.steps.slice(1),
      ],
    } as Process;
    const next = putBackStep(mine, template, "read");
    expect(next?.steps[0]).toEqual(SKILL);
    expect(next?.steps[0]?.id).toBe("read");
    expect(customizedSteps(next as Process, template).size).toBe(0);
    expect(putBackStep(next as Process, template, "read")).toBeNull();
    expect(putBackStep(mine, template, "not-there")).toBeNull();
    expect(putBackStep(mine, undefined, "read")).toBeNull();
  });

  it("keeps the client's steps inside a decision, and a path the client added", () => {
    const asked = step({ ...ASK, name: "Ask Jammil" });
    const extra = step({ ...WRITE, id: "extra", name: "Note it" });
    const mine = {
      ...template,
      steps: [
        SKILL,
        step({
          id: "d",
          kind: "if",
          name: "A duplicate?",
          paths: [
            { id: "p1", name: "Yes", when: { match: "all", rules: [] }, steps: [asked] },
            { id: "p2", name: "Maybe", when: { match: "all", rules: [] }, steps: [extra] },
          ],
          otherwise: { id: "o", steps: [] },
        }),
        WRITE,
      ],
    } as Process;
    const next = putBackStep(mine, template, "d") as Process;
    const d = next.steps[1];
    if (d?.kind !== "if") throw new Error("not a decision");
    expect(d.name).toBe("Is it a duplicate?");
    expect(d.paths.map((p) => p.name)).toEqual(["It is a duplicate", "Maybe"]);
    // The client's own edit of the nested step stays: it has its own mark and its own way back.
    expect(d.paths[0]?.steps).toEqual([asked]);
    expect(d.paths[1]?.steps).toEqual([extra]);
    expect(customizedSteps(next, template).get("ask")).toBe("changed");
  });

  it("brings a removed path back without a step the client moved somewhere else", () => {
    const mine = {
      ...template,
      steps: [
        SKILL,
        step({
          id: "d",
          kind: "if",
          name: "Is it a duplicate?",
          paths: [],
          otherwise: { id: "o", steps: [] },
        }),
        ASK,
        WRITE,
      ],
    } as Process;
    const next = putBackStep(mine, template, "d") as Process;
    const d = next.steps[1];
    if (d?.kind !== "if") throw new Error("not a decision");
    expect(d.paths.map((p) => p.id)).toEqual(["p1"]);
    expect(d.paths[0]?.steps).toEqual([]);
    expect(next.steps.map((s) => s.id)).toEqual(["read", "d", "ask", "update"]);
  });
});
