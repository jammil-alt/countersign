import { AgentBundle, gateReasons, groupProblems } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { type BuilderProblem, validateProcessesLikeServer } from "./catalog";
import type { ProcessAgentBundle } from "./model";
import { fieldLabel, problemLines, problemPlace, readableProblem } from "./problems";

type ValidationError = BuilderProblem;

const bundle = {
  workflows: [
    {
      slug: "bill",
      name: "When an invoice has been read",
      workflow: {
        triggers: [{ id: "t1", on: { kind: "event", event: "document.read" } }],
        steps: [
          { id: "ask", name: "Ask which bill", kind: "person" },
          { id: "match", name: "Match the invoice", kind: "skill" },
          { id: "read", name: "Read the bill", kind: "read" },
        ],
      },
    },
  ],
} as unknown as ProcessAgentBundle;

const order = (stepId: string, ref: string, field = "input.question"): ValidationError => ({
  workflow: "bill",
  stepId,
  field,
  code: "template_scope",
  message: `{{${ref}}}: step "match" does not run before this one on its path`,
});

describe("workflow problems in plain words", () => {
  it("names the step a reference needs and says what to do", () => {
    const p = readableProblem(
      order("read", "steps.match.output.bill.recordId", "input.ids.0"),
      bundle,
    );
    expect(p.text).toBe(
      "Uses the bill record id from “Match the invoice”, but “Match the invoice” doesn't run before this step. Move this step below “Match the invoice”, on the same path.",
    );
    expect(fieldLabel("input.ids.0")).toBe("Ids");
    expect(problemPlace(p.error, bundle, "bill")).toBe("Read the bill");
  });

  it("joins one step's references to the same step into one line", () => {
    const lines = problemLines(
      [
        order("ask", "steps.match.output.invoice.number"),
        order("ask", "steps.match.output.invoice.vendorName"),
        order("ask", "steps.match.output.reason"),
        order("ask", "steps.match.output.sources"),
        order("read", "steps.match.output.bill.recordId"),
      ],
      bundle,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe(
      "Uses the invoice number, invoice vendor name, reason and 1 more from “Match the invoice”, but “Match the invoice” doesn't run before this step. Move this step below “Match the invoice”, on the same path.",
    );
  });

  it("says when the step a reference needs was removed", () => {
    const gone = {
      ...order("read", "steps.old.output.total"),
      message: '{{steps.old.output.total}}: step "old" does not run before this one on its path',
    };
    expect(readableProblem(gone, bundle).text).toBe(
      "Uses the total from a removed step. That step is no longer in this workflow: pick the value again.",
    );
  });

  it("rewords required inputs and missing fields", () => {
    const base = { workflow: "bill", stepId: "read", code: "input_missing" } as const;
    expect(
      readableProblem({ ...base, field: "input.id", message: '"id" is required' }, bundle).text,
    ).toBe("Id is required.");
    expect(
      readableProblem(
        {
          ...base,
          field: "input.ids.0",
          code: "template_path",
          message: '{{trigger.docId}}: no field "docId"',
        },
        bundle,
      ).text,
    ).toBe("Uses the trigger's doc id, but there is no doc id there.");
  });
});

// BUILDER_QA CONS-6: the build's draft gate (fed core's grouped count by apps/api's
// `draftProblems`) and the workflow builder count one draft's problems the same.
describe("the draft's problem count, builder and build", () => {
  /** A workflow with no output and no End: two problems to fix. */
  const unfinished = AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Vendor check", role: "checks vendors", mission: "Vendors checked." },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the process says.",
      skills: [],
      permissions: { mode: "suggest_only" },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 5,
          triggers: [{ id: "t", on: { type: "manual", input: {} } }],
          outputs: [],
          steps: [
            {
              id: "tell",
              kind: "do",
              name: "Tell",
              doneBy: "rules",
              uses: { type: "tell" },
              tell: { to: ["client_admin"], channel: "inbox", message: "Check it" },
              input: {},
            },
            {
              id: "ask",
              kind: "do",
              name: "Ask",
              doneBy: "person",
              person: {
                mode: "ask",
                who: "client_admin",
                question: "Which vendor?",
                deadline: { after: "1 day", ifNoAnswer: "stop" },
                channel: "inbox",
              },
            },
          ],
        },
      },
    ],
  });

  it("the workflow builder and the build's draft gate count the same problems", () => {
    const r = validateProcessesLikeServer(
      unfinished,
      { tools: {}, skills: {} },
      { clientAgent: true },
    );
    expect(r.errors.length).toBe(2);
    // The build's gate, as buildDetail feeds it: one per group of validator errors.
    const gate = gateReasons({
      kind: "agent",
      phase: "draft",
      brief: {},
      fitgap: { rows: [], needsTrue: [], setup: [], decisions: [] },
      draft: true,
      draftErrors: groupProblems(r.errors).length,
      poc: { passed: false, detail: "" },
      trialDone: false,
      qaSigned: false,
      openItems: 0,
    });
    // The workflow builder's header and Publish line: plural(problemCount, "problem").
    const builder = problemLines(r.errors, unfinished as unknown as ProcessAgentBundle).length;
    expect(
      gate,
      `the workflow builder shows ${builder === 1 ? "1 problem" : `${builder} problems`}`,
    ).toEqual([`The draft has ${builder === 1 ? "1 problem" : `${builder} problems`} to fix.`]);
  });
});
