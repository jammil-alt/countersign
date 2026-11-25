import { describe, expect, it } from "vitest";
import { Step, Workflow, type WorkflowInput } from "./schema";
import { endsAlways, validateWorkflow } from "./validate";

const trigger = { id: "t1", on: { type: "event", event: "document.extracted" } } as const;
const outputs = [
  {
    id: "o_saved",
    name: "Purchase saved",
    kind: "save",
    action: { action: "materials.vendor_items.register", input: {} },
  },
  { id: "o_none", name: "Nothing to do", kind: "nothing" },
] as const;

const wf = (steps: unknown[], more: Partial<WorkflowInput> = {}) =>
  Workflow.parse({ schemaVersion: 5, triggers: [trigger], outputs, steps, ...more });

const read = {
  id: "s_read",
  kind: "do",
  name: "Read the invoice",
  doneBy: "ai",
  uses: { type: "skill", skill: "docs.read-document" },
  input: { documentId: "{{trigger.documentId}}" },
};
const endSaved = { id: "s_end", kind: "end", name: "Saved", outputs: ["o_saved"] };
const endNone = { id: "s_none", kind: "end", name: "Nothing", outputs: ["o_none"] };

describe("the step model's schema", () => {
  it("stores the eight kinds and a Do's done by and uses", () => {
    const w = wf([
      read,
      {
        id: "s_fork",
        kind: "fork",
        name: "Vendor known?",
        paths: [
          { id: "p_no", name: "Not found", when: { match: "all", rules: [] }, steps: [endNone] },
        ],
        otherwise: { id: "p_else", steps: [] },
      },
      {
        id: "s_match",
        kind: "do",
        name: "Match lines to the vendor's items",
        doneBy: "rules",
        uses: { type: "match", match: { to: "vendor-items", type: "exact", keys: ["sku"] } },
      },
      endSaved,
    ]);
    const match = w.steps[2] as Extract<Step, { kind: "do" }>;
    expect(match.uses?.type === "match" && match.uses.match.confidenceThreshold).toBe(90);
    expect(match.uses?.type === "match" && match.uses.match.shortlist).toEqual({
      model: 20,
      person: 5,
    });
  });

  it("refuses an End that neither delivers an output nor says why there is nothing to do", () => {
    expect(() => wf([read, { id: "e", kind: "end", name: "End" }])).toThrow(/End delivers/);
  });

  it("refuses an output that doesn't say how it is delivered", () => {
    expect(() =>
      wf([read, endSaved], { outputs: [{ id: "o", name: "Report", kind: "report" }] as never }),
    ).toThrow(/report output says how/);
  });

  it("types a field list and a record link", () => {
    expect(() =>
      Step.parse({
        id: "s",
        kind: "do",
        name: "Work it out",
        doneBy: "rules",
        rules: { rows: [] },
        output: [{ name: "lines", type: "list", required: true }],
      }),
    ).toThrow(/list names its fields/);
  });
});

describe("validateWorkflow", () => {
  it("passes a workflow whose every path ends and every output is delivered", () => {
    const w = wf([
      read,
      {
        id: "s_fork",
        kind: "fork",
        name: "Anything to do?",
        paths: [{ id: "p", name: "No", when: { match: "all", rules: [] }, steps: [endNone] }],
        otherwise: { id: "p_else", steps: [] },
      },
      endSaved,
    ]);
    expect(validateWorkflow(w)).toEqual([]);
  });

  it("finds a workflow that can finish without an End, and an output nothing delivers", () => {
    const issues = validateWorkflow(wf([read]));
    expect(issues.map((i) => i.code)).toEqual([
      "no_end",
      "output_never_delivered",
      "output_never_delivered",
    ]);
  });

  it("finds an End delivering something not on the list", () => {
    const issues = validateWorkflow(
      wf([read, { id: "e", kind: "end", name: "End", outputs: ["o_saved", "o_other"] }, endNone]),
    );
    expect(issues.map((i) => i.code)).toContain("unknown_output");
  });

  it("holds a Do to the combinations of done by and uses", () => {
    const steps = [
      { ...read, id: "a", doneBy: "ai", uses: { type: "action", action: "qbo.bill.create" } },
      { ...read, id: "b", doneBy: undefined },
      { ...read, id: "c", doneBy: "rules", uses: { type: "automation", automation: "x@1" } },
      { id: "d", kind: "do", name: "Ask", doneBy: "person" },
      { id: "e", kind: "do", name: "Gap", uses: { type: "missing", need: "A tool for X" } },
      { id: "f", kind: "do", name: "Rules", doneBy: "rules", ai: { text: "think" } },
    ];
    const codes = validateWorkflow(wf([...steps, endSaved, endNone].slice(0))).map((i) => [
      i.at,
      i.code,
    ]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ["a", "uses_not_allowed"],
        ["b", "done_by_required"],
        ["c", "done_by_with_automation"],
        ["d", "instructions_missing"],
        ["e", "not_built_yet"],
        ["f", "instructions_not_for_done_by"],
        ["f", "instructions_missing"],
      ]),
    );
  });

  it("keeps a Loop to reads, and flags an input nothing gives", () => {
    const w = wf([
      {
        id: "l",
        kind: "loop",
        name: "Look into the leftovers",
        goal: "Find which leftovers are the same money",
        reads: ["bookkeeping.reconcile.open", "qbo.bill.create"],
      },
      {
        id: "s",
        kind: "do",
        name: "Save",
        doneBy: "rules",
        uses: { type: "action", action: "materials.vendor_items.register" },
        input: { documentId: "{{trigger.documentId}}" },
      },
      endSaved,
      endNone,
    ]);
    const issues = validateWorkflow(w, {
      sideEffect: (a) => (a === "qbo.bill.create" ? "external" : "none"),
      requiredInput: (u) =>
        u.type === "action" && u.action === "materials.vendor_items.register"
          ? ["documentId", "vendorId"]
          : [],
    });
    expect(issues.map((i) => [i.at, i.code])).toEqual(
      expect.arrayContaining([
        ["l", "loop_writes"],
        ["s", "input_missing"],
      ]),
    );
  });

  it("knows a list ends when its last Fork ends on every path", () => {
    const fork = (ends: boolean) =>
      Step.parse({
        id: "f",
        kind: "fork",
        name: "f",
        paths: [{ id: "p", name: "p", when: { match: "all", rules: [] }, steps: [endNone] }],
        otherwise: { id: "o", steps: ends ? [endSaved] : [] },
      });
    expect(endsAlways([fork(true)])).toBe(true);
    expect(endsAlways([fork(false)])).toBe(false);
  });
});
