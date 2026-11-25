// The step model (docs/step-model-plan.md, wave 1): a bundle entry may hold a v5 workflow beside v3
// and v4 ones; it parses, validates with the step model's publish checks, and its needs are read.
import { describe, expect, it } from "vitest";
import { agentNeeds } from "../permissions/needs";
import { AnyAgentBundle, holdsStepModel } from "../schemas/agent";
import type { ToolSpec } from "../schemas/tool";
import { bundleNodeIds, validateAnyBundle } from "./bundle";

const tool = (id: string, sideEffect: ToolSpec["sideEffect"], connector: string): ToolSpec => ({
  id,
  description: id,
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  output: { type: "object" },
  sideEffect,
  verb: sideEffect === "none" ? "read" : "create",
  source: connector,
  connector,
});
const READ = tool("testkit.record.read", "none", "testkit");
const QBO_BILL = tool("qbo.bill.create", "external", "qbo");
const BILL_BILL = tool("billcom.bill.create", "external", "billcom");
const TOOLS = { [READ.id]: READ, [QBO_BILL.id]: QBO_BILL, [BILL_BILL.id]: BILL_BILL };

const definition = {
  schemaVersion: 2 as const,
  identity: { name: "Clerk", role: "Records", mission: "Keep records right" },
  kind: "functional" as const,
  model: { id: "m" },
  instructions: "Work carefully.",
  skills: [],
  extraTools: [],
  permissions: { mode: "act" as const },
};

const v5 = (steps: unknown[], outputs?: unknown[]) => ({
  schemaVersion: 5,
  triggers: [{ id: "t5", on: { type: "manual", input: {} } }],
  outputs: outputs ?? [
    {
      id: "o_bill",
      name: "Bill created",
      kind: "write",
      action: { action: "accounting.bill.create", input: { id: "{{steps.s_read.output.id}}" } },
    },
  ],
  steps,
});

const good = v5([
  {
    id: "s_read",
    kind: "do",
    name: "Read the record",
    doneBy: "rules",
    uses: { type: "action", action: READ.id },
    input: { id: "{{trigger.id}}" },
  },
  { id: "s_end", kind: "end", name: "Done", outputs: ["o_bill"] },
]);

const bundle = (workflows: unknown[]) => ({ schemaVersion: 1, definition, workflows });

describe("a bundle holding a v5 workflow", () => {
  it("parses beside a v4 process, and says it holds the step model", () => {
    const b = AnyAgentBundle.parse(
      bundle([
        { slug: "new", name: "New", workflow: good },
        {
          slug: "old",
          name: "Old",
          workflow: {
            schemaVersion: 4,
            triggers: [{ id: "t4", on: { type: "manual", input: {} } }],
            steps: [{ id: "w4", kind: "wait", name: "Wait", for: "1 day" }],
          },
        },
      ]),
    );
    expect(holdsStepModel(b)).toBe(true);
    expect([...bundleNodeIds(b)]).toEqual(
      expect.arrayContaining(["t5", "o_bill", "s_read", "s_end", "t4", "w4"]),
    );
  });

  it("is valid when the step model's publish checks pass", () => {
    const r = validateAnyBundle(bundle([{ slug: "new", name: "New", workflow: good }]), {
      tools: TOOLS,
    });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("reports the step model's checks on their step, with their own code", () => {
    const r = validateAnyBundle(
      bundle([
        {
          slug: "new",
          name: "New",
          workflow: v5([
            {
              id: "s_read",
              kind: "do",
              name: "Read the record",
              doneBy: "rules",
              uses: { type: "action", action: READ.id },
            },
          ]),
        },
      ]),
      { tools: TOOLS },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => [e.code, e.stepCode, e.stepId])).toEqual(
      expect.arrayContaining([
        ["step_model", "input_missing", "s_read"],
        ["step_model", "no_end", null],
        ["step_model", "output_never_delivered", "o_bill"],
      ]),
    );
  });

  it("refuses an id used in two workflows", () => {
    const r = validateAnyBundle(
      bundle([
        { slug: "a", name: "A", workflow: good },
        {
          slug: "b",
          name: "B",
          workflow: { ...good, triggers: [{ id: "t6", on: good.triggers[0]?.on }] },
        },
      ]),
      { tools: TOOLS },
    );
    expect(r.errors.some((e) => e.code === "duplicate_id" && e.stepId === "s_read")).toBe(true);
  });

  it("names the schema problem in the workflow it is in", () => {
    const r = validateAnyBundle(
      bundle([{ slug: "new", name: "New", workflow: { ...good, triggers: [] } }]),
      { tools: TOOLS },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatchObject({ code: "schema", workflow: "new", field: "triggers" });
  });

  it("saves a draft with no outputs yet, and refuses to publish it", () => {
    const r = validateAnyBundle(
      bundle([{ slug: "new", name: "New", workflow: { ...good, outputs: [] } }]),
      { tools: TOOLS },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.every((e) => e.code === "step_model")).toBe(true);
  });

  it("needs its reads, and one of a merged action's connectors for a write output", () => {
    const b = AnyAgentBundle.parse(bundle([{ slug: "new", name: "New", workflow: good }]));
    const needs = agentNeeds(b, {
      tools: TOOLS,
      connectors: new Set(["testkit", "qbo", "billcom"]),
    });
    expect(needs.map((n) => [n.connector, n.verb, n.anyOf ?? null])).toEqual([
      ["testkit", "read", null],
      ["qbo", "create", "new/o_bill"],
      ["billcom", "create", "new/o_bill"],
    ]);
    expect(needs.every((n) => !n.wantsAuto)).toBe(true);
  });
});
