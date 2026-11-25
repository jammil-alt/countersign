import { describe, expect, it } from "vitest";
import { Workflow as StepWorkflow } from "../steps/schema";
import { conditionKey, conditionUses, stepModelConditionUses } from "./conditions";
import { Process } from "./schema";

const BIG = { rules: [{ field: "{{trigger.total}}", op: ">", value: 5000 }] };

const p = Process.parse({
  schemaVersion: 4,
  triggers: [
    { id: "t1", on: { type: "event", event: "qbo.bill.created", filter: BIG } },
    { id: "t2", on: { type: "manual", input: {} } },
    // A filter with no rows always holds: not a condition.
    { id: "t3", on: { type: "event", event: "qbo.bill.updated", filter: { rules: [] } } },
  ],
  steps: [
    {
      id: "enter",
      name: "Enter the bill",
      kind: "write",
      tool: "qbo.bill.create",
      checks: {
        confer: {
          when: BIG,
          with: [
            { ai: { focus: "do the lines add up" } },
            {
              person: "client_admin",
              when: { rules: [{ field: "{{checks.confer.0}}", op: "=", value: "disagree" }] },
              deadline: { after: "4 hours" },
            },
          ],
        },
        approval: { when: BIG },
        notify: [
          {
            to: ["lead"],
            message: "Entered",
            when: BIG,
            urgent: {
              when: { rules: [{ field: "{{trigger.total}}", op: ">", value: 50000 }] },
              ackWithin: "1 hour",
            },
          },
        ],
      },
    },
    {
      id: "fork",
      name: "Which vendor",
      kind: "if",
      paths: [
        {
          id: "big",
          name: "Big bills",
          // The same rules in another key order.
          when: { rules: [{ value: 5000, op: ">", field: "{{trigger.total}}" }], match: "all" },
          steps: [
            {
              id: "sum",
              name: "Summary",
              kind: "notify",
              notify: { to: ["lead"], message: "x", when: BIG },
            },
          ],
        },
      ],
      otherwise: { id: "else", steps: [] },
    },
    {
      id: "sub",
      name: "Follow up",
      kind: "process",
      process: "follow-up@2",
      approvals: { send: { required: "required", when: BIG } },
    },
  ],
});

describe("the conditions a process uses", () => {
  it("lists triggers' filters, if paths and every check's when, in run order", () => {
    const uses = conditionUses(p);
    expect(uses.map((u) => [u.place, u.stepId, u.label])).toEqual([
      ["trigger", null, "t1"],
      ["confer", "enter", null],
      ["conferee", "enter", null],
      ["approval", "enter", null],
      ["notify", "enter", null],
      ["urgent", "enter", null],
      ["if_path", "fork", "Big bills"],
      ["notify", "sum", null],
      ["approval", "sub", null],
    ]);
    expect(uses[1]?.stepName).toBe("Enter the bill");
  });

  it("keys the same rules alike whatever their key order", () => {
    const uses = conditionUses(p);
    const keys = new Set(uses.map((u) => conditionKey(u.when)));
    // BIG (seven places), the disagreement, and the urgent threshold.
    expect(keys.size).toBe(3);
    expect(conditionKey({ match: "any", rules: BIG.rules as never })).not.toBe(
      conditionKey({ match: "all", rules: BIG.rules as never }),
    );
  });
});

describe("the conditions of a workflow in the step model", () => {
  it("are its triggers' filters, its Forks' paths, its steps' and outputs' checks", () => {
    const w = StepWorkflow.parse({
      schemaVersion: 5,
      triggers: [
        { id: "t1", on: { type: "event", event: "qbo.bill.created", filter: BIG } },
        { id: "t2", on: { type: "event", event: "qbo.bill.updated", filter: { rules: [] } } },
      ],
      outputs: [
        {
          id: "out",
          name: "Bill entered",
          kind: "write",
          action: { action: "qbo.bill.create" },
          checks: { approval: { required: "required", when: BIG } },
        },
      ],
      steps: [
        {
          id: "size",
          name: "How big",
          kind: "fork",
          paths: [{ id: "big", name: "Big bills", when: BIG, steps: [] }],
          otherwise: { id: "small", steps: [] },
        },
        {
          id: "tell",
          name: "Tell the lead",
          kind: "do",
          doneBy: "rules",
          uses: { type: "tell" },
          tell: { to: ["lead"], channel: "inbox", message: "A bill", when: BIG },
        },
        { id: "end", name: "End", kind: "end", outputs: ["out"] },
      ],
    });
    expect(
      stepModelConditionUses(w).map((u) => [u.place, u.stepId, u.label, conditionKey(u.when)]),
    ).toEqual([
      ["trigger", null, "t1", conditionKey(BIG)],
      ["if_path", "size", "Big bills", conditionKey(BIG)],
      ["notify", "tell", null, conditionKey(BIG)],
      ["approval", "out", null, conditionKey(BIG)],
    ]);
  });
});
