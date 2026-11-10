import { describe, expect, it } from "vitest";
import { Workflow } from "../schemas/workflow";
import { type ConvertLookup, fromWorkflowV3 } from "./convert";
import { defaultBusinessHours } from "./hours";
import { Process, type Step } from "./schema";

const lookup: ConvertLookup = {
  wrappedTool: (id) =>
    ({
      "bookkeeping.reconcile-pairs": "bookkeeping.reconcile.pairs",
      "materials.record-prices": "materials.prices.record",
    })[id] ?? null,
  sideEffect: (id) =>
    (
      ({
        "bookkeeping.reconcile.pairs": "none",
        "materials.prices.record": "internal",
        "qbo.bill.create": "external",
      }) as const
    )[id] ?? null,
};

const v3 = Workflow.parse({
  schemaVersion: 3,
  trigger: { id: "t1", on: { type: "schedule", cron: "0 6 3 * *" } },
  moreTriggers: [{ id: "t2", on: { type: "manual", input: {} } }],
  steps: [
    {
      id: "pairs",
      name: "Accounts to reconcile",
      kind: "skill",
      skill: "bookkeeping.reconcile-pairs",
    },
    {
      id: "prices",
      name: "Record prices",
      kind: "skill",
      skill: "materials.record-prices",
      input: { x: "{{steps.pairs.output}}" },
    },
    { id: "think", name: "Categorize", kind: "skill", skill: "bookkeeping.categorize" },
    {
      id: "post",
      name: "Post the bill",
      kind: "action",
      tool: "qbo.bill.create",
      approval: { approver: "client_admin", timeout: "30 minutes" },
    },
    {
      id: "ask",
      name: "Ask the owner",
      kind: "person",
      mode: "ask",
      assignee: "client_admin",
      title: "Which account?",
      timeout: "2 days",
      onTimeout: "notify_operator",
    },
    {
      id: "fork",
      name: "Big?",
      kind: "fork",
      paths: [
        {
          id: "big",
          name: "Big",
          when: {
            match: "all",
            rules: [{ field: "{{steps.post.output.total}}", op: ">", value: 500 }],
          },
          steps: [
            { id: "tell", name: "Tell", kind: "notify", channel: "thread", message: "Big bill" },
          ],
        },
      ],
      otherwise: {
        id: "small",
        steps: [{ id: "done", name: "Done", kind: "stop", status: "succeeded" }],
      },
    },
    { id: "auto", name: "Follow up", kind: "use_automation", automation: "follow-up@2" },
  ],
});

function ids(steps: Step[]): string[] {
  return steps.flatMap((s) => {
    if (s.kind === "if") {
      return [
        s.id,
        ...s.paths.flatMap((p) => [p.id, ...ids(p.steps)]),
        s.otherwise.id,
        ...ids(s.otherwise.steps),
      ];
    }
    if (s.kind === "for_each") return [s.id, ...ids(s.steps)];
    return [s.id];
  });
}

describe("fromWorkflowV3", () => {
  const p = fromWorkflowV3(v3, lookup);

  it("gives a valid v4 process", () => {
    expect(() => Process.parse(p)).not.toThrow();
    expect(p.schemaVersion).toBe(4);
    expect(p.triggers.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("keeps every step and path id, in order (merges line up by them)", () => {
    expect(ids(p.steps)).toEqual([
      "pairs",
      "prices",
      "think",
      "post",
      "ask",
      "fork",
      "big",
      "tell",
      "small",
      "done",
      "auto",
    ]);
  });

  it("turns skills that only wrap a tool into read and write steps", () => {
    expect(p.steps[0]).toMatchObject({ kind: "read", tool: "bookkeeping.reconcile.pairs" });
    expect(p.steps[1]).toMatchObject({
      kind: "write",
      tool: "materials.prices.record",
      input: { x: "{{steps.pairs.output}}" },
    });
    expect(p.steps[2]).toMatchObject({ kind: "skill", skill: "bookkeeping.categorize" });
  });

  it("keeps approval on for an action, with its approver and deadline", () => {
    expect(p.steps[3]).toMatchObject({
      kind: "write",
      checks: {
        approval: {
          required: "required",
          mode: "in_turn",
          ifNoAnswer: "stop",
          approvers: [
            {
              who: "client_admin",
              deadline: { after: "30 minutes", hours: "clock", ifNoAnswer: "stop" },
            },
          ],
        },
      },
    });
  });

  it("maps a person step's timeout to a deadline that stops and tells the operator", () => {
    expect(p.steps[4]).toMatchObject({
      kind: "person",
      deadline: { after: "2 days", ifNoAnswer: "stop", tell: ["operator"] },
    });
  });

  it("maps fork to if, notify to a notify step and an automation to a sub-process", () => {
    expect(p.steps[5]).toMatchObject({
      kind: "if",
      paths: [{ steps: [{ kind: "notify", notify: { channel: "inbox" } }] }],
    });
    expect(p.steps[6]).toMatchObject({ kind: "process", process: "follow-up@2" });
  });

  it("treats an unknown tool as an external write, so approval stays on", () => {
    const one = Workflow.parse({
      schemaVersion: 3,
      trigger: { id: "t", on: { type: "manual", input: {} } },
      steps: [{ id: "s", name: "S", kind: "skill", skill: "x.y" }],
    });
    const out = fromWorkflowV3(one, { wrappedTool: () => "x.tool", sideEffect: () => null });
    expect(out.steps[0]).toMatchObject({ kind: "write", tool: "x.tool" });
  });
});

describe("process checks", () => {
  it("defaults a deadline to clock time and stop", () => {
    const parsed = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "manual", input: {} } }],
      steps: [
        {
          id: "post",
          name: "Post",
          kind: "write",
          tool: "qbo.bill.create",
          checks: {
            confer: {
              with: [
                { ai: { focus: "Do the lines add up?" } },
                { person: "accountant", deadline: { after: "4 hours", hours: "business" } },
              ],
            },
            approval: {
              mode: "all",
              approvers: [
                { who: "maria" },
                { who: "client_admin", deadline: { after: "30 minutes" } },
              ],
            },
            notify: [
              { to: ["client_admin"], message: "Posted", urgent: { ackWithin: "15 minutes" } },
            ],
          },
        },
      ],
    });
    const step = parsed.steps[0];
    if (step?.kind !== "write") throw new Error("expected a write");
    expect(step.checks?.approval).toMatchObject({ required: "required", ifNoAnswer: "stop" });
    expect(step.checks?.approval?.approvers?.[1]?.deadline).toEqual({
      after: "30 minutes",
      hours: "clock",
      ifNoAnswer: "stop",
    });
    expect(step.checks?.confer?.with[1]).toMatchObject({
      deadline: { hours: "business", ifNoAnswer: "stop" },
    });
    expect(step.checks?.notify?.[0]).toMatchObject({
      channel: "inbox",
      urgent: { ifNoAnswer: "stop" },
    });
  });

  it("takes an escalation chain as the deadline's then", () => {
    const parsed = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "manual", input: {} } }],
      steps: [
        {
          id: "ask",
          name: "Ask",
          kind: "person",
          mode: "approve",
          assignee: "maria",
          title: "OK?",
          deadline: {
            after: "30 minutes",
            hours: "business",
            ifNoAnswer: { escalate: { to: "lead", deadline: { after: "2 hours" } } },
          },
        },
      ],
    });
    expect(parsed.steps[0]).toMatchObject({
      deadline: {
        ifNoAnswer: {
          escalate: { to: "lead", deadline: { after: "2 hours", ifNoAnswer: "stop" } },
        },
      },
    });
  });

  it("refuses a deadline that is not a duration", () => {
    expect(() =>
      Process.parse({
        schemaVersion: 4,
        triggers: [{ id: "t", on: { type: "manual", input: {} } }],
        steps: [
          {
            id: "w",
            name: "W",
            kind: "person",
            mode: "ask",
            assignee: "a",
            title: "?",
            deadline: { after: "soon" },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("business hours", () => {
  it("defaults to Monday to Friday, 8am to 6pm, weekends closed", () => {
    const h = defaultBusinessHours("America/Chicago");
    expect(Object.keys(h.week)).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(h.week.mon).toEqual([{ from: "08:00", to: "18:00" }]);
    expect(h.week.sat).toBeUndefined();
  });
});
