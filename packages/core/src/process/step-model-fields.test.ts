// A v5 workflow's references checked against what each step hands on (`steps/hands-on.ts`): the
// cases are staging's runs of 2026-11-27, which published and then ran a field as nothing.
import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../schemas/tool";
import { handsOn } from "../steps/hands-on";
import type { Step, Workflow } from "../steps/schema";
import { stepModelRefErrors } from "./step-model-refs";

const tool = (id: string, output: Record<string, unknown>) =>
  ({
    id,
    description: id,
    sideEffect: "none",
    input: { type: "object", properties: {} },
    output: { type: "object", properties: output },
  }) as unknown as ToolSpec;

const tools = {
  "qbo.vendor.query": tool("qbo.vendor.query", {
    more: { type: "boolean" },
    vendors: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
    },
  }),
};

const read = (id: string, action: string, input: Record<string, unknown> = {}) =>
  ({ id, name: id, kind: "do", doneBy: "rules", uses: { type: "action", action }, input }) as Step;

const ai = (id: string, output: { name: string; type: string }[], input = {}) =>
  ({
    id,
    name: id,
    kind: "do",
    doneBy: "ai",
    ai: { text: "Work it out." },
    input,
    output: output.map((f) => ({ ...f, required: true })),
  }) as unknown as Step;

const wf = (steps: Step[], outputs: unknown[] = []) =>
  ({
    schemaVersion: 5,
    triggers: [{ id: "t", on: { type: "manual", input: {} } }],
    outputs,
    steps,
  }) as unknown as Workflow;

const messages = (w: Workflow) => stepModelRefErrors(w, { tools }).map((e) => e.message);

describe("references checked against what a step hands on", () => {
  it("refuses a field a tool doesn't hand on, and accepts one it does", () => {
    const ok = wf([
      read("vendor", "qbo.vendor.query"),
      read("bills", "qbo.vendor.query", { vendorId: "{{steps.vendor.output.vendors.0.id}}" }),
    ]);
    expect(messages(ok)).toEqual([]);
    const typo = wf([
      read("vendor", "qbo.vendor.query"),
      read("bills", "qbo.vendor.query", { vendorId: "{{steps.vendor.output.vendor.id}}" }),
    ]);
    expect(messages(typo)).toEqual([
      '{{steps.vendor.output.vendor.id}}: "vendor" hands on no field "vendor"',
    ]);
  });

  it("says nothing of a tool it doesn't know", () => {
    const w = wf([
      read("x", "somewhere.unknown"),
      read("y", "somewhere.unknown", { a: "{{steps.x.output.anything.at.all}}" }),
    ]);
    expect(messages(w)).toEqual([]);
  });

  it("reads an AI step's output by the fields it lists", () => {
    const w = wf([
      ai("assess", [{ name: "needs_info", type: "yes_no" }]),
      ai("next", [], {
        a: "{{steps.assess.output.needs_info}}",
        b: "{{steps.assess.output.missing}}",
      }),
    ]);
    expect(messages(w)).toEqual([
      '{{steps.assess.output.missing}}: "assess" hands on no field "missing"',
    ]);
  });

  // Owner, 2026-11-28: a person step hands on the fields it lists, by their names.
  it("reads a person step by the fields it lists, beside its answer and who gave it", () => {
    const person = {
      id: "ask",
      name: "Ask the bookkeeper",
      kind: "do",
      doneBy: "person",
      input: {},
      output: [
        { name: "choice", type: "text", required: true },
        { name: "note", type: "text", required: false },
      ],
      person: { who: "client_admin", mode: "ask", question: "Book it?" },
    } as unknown as Step;
    const w = wf([
      person,
      ai("after", [], {
        a: "{{steps.ask.output.choice}}",
        b: "{{steps.ask.output.note}}",
        c: "{{steps.ask.output.by}}",
        d: "{{steps.ask.output.reason}}",
      }),
    ]);
    expect(messages(w)).toEqual([
      '{{steps.ask.output.reason}}: "Ask the bookkeeper" hands on no field "reason"',
    ]);
  });

  // Staging, 2026-11-27: "Read the employee's answers" read `answers` from the fork the employee
  // was asked in. A fork hands on what its path's last step gave, beside the path.
  it("reads a fork by its path and what its paths' last steps give", () => {
    const contact = {
      id: "ask-email",
      name: "Ask by email",
      kind: "do",
      doneBy: "contact",
      input: {},
      output: [{ name: "answers", type: "text", required: true }],
      contact: { goal: "Get answers", with: "{{trigger.contactId}}", channel: "email" },
    } as unknown as Step;
    const fork = {
      id: "f",
      name: "More information needed?",
      kind: "fork",
      paths: [
        { id: "p", name: "Ask by email", when: { match: "all", rules: [] }, steps: [contact] },
      ],
      otherwise: { id: "o", steps: [] },
    } as unknown as Step;
    const w = wf([
      fork,
      ai("read", [], {
        asked: "{{steps.f.output.pathName}}",
        answers: "{{steps.f.output.answers}}",
        wrong: "{{steps.f.output.reply}}",
      }),
    ]);
    expect(messages(w)).toEqual([
      '{{steps.f.output.reply}}: "More information needed?" hands on no field "reply"',
    ]);
  });

  it("leaves out a fork path that ends the run", () => {
    const end = {
      id: "e",
      name: "Stop",
      kind: "end",
      status: "succeeded",
      outputs: [],
    } as unknown as Step;
    const fork = {
      id: "f",
      name: "Found?",
      kind: "fork",
      paths: [{ id: "p", name: "No", when: { match: "all", rules: [] }, steps: [end] }],
      otherwise: { id: "o", steps: [] },
    } as unknown as Step;
    expect(handsOn(fork)).toEqual({
      type: "object",
      properties: { pathId: { type: "string" }, pathName: { type: "string" } },
    });
  });

  // Staging, 2026-11-27: "Read each receipt" handed on only its count; a For each now hands on
  // each item's last step's output, and a step inside reads `{{item}}` as an item of its list.
  it("reads a For each's items and its item's fields", () => {
    const code = ai("code", [{ name: "purchases", type: "list" }]);
    (code as unknown as { output: unknown[] }).output = [
      {
        name: "purchases",
        type: "list",
        required: true,
        of: [
          { name: "total", type: "money", required: true },
          { name: "memo", type: "text", required: true },
        ],
      },
    ];
    const each = {
      id: "each",
      name: "Book each",
      kind: "for_each",
      over: "{{steps.code.output.purchases}}",
      steps: [
        ai("book", [{ name: "ok", type: "yes_no" }], {
          total: "{{item.total}}",
          ref: "{{item.reference}}",
        }),
      ],
    } as unknown as Step;
    const w = wf([
      code,
      each,
      ai("after", [], { a: "{{steps.each.output.items.0.ok}}", n: "{{steps.each.output.count}}" }),
    ]);
    expect(messages(w)).toEqual([
      '{{item.reference}}: an item of the list this For each goes over has no field "reference"',
    ]);
  });

  it("checks what an End's outputs say against the steps before the End", () => {
    const end = {
      id: "e",
      name: "Done",
      kind: "end",
      status: "succeeded",
      outputs: ["o"],
    } as unknown as Step;
    const report = {
      id: "o",
      name: "Report",
      kind: "report",
      fields: [],
      report: {
        to: ["client_admin"],
        channel: "inbox",
        message: "{{steps.vendor.output.vendorName}}",
      },
    };
    expect(messages(wf([read("vendor", "qbo.vendor.query"), end], [report]))).toEqual([
      '{{steps.vendor.output.vendorName}}: "vendor" hands on no field "vendorName"',
    ]);
  });
});
