import type { AgentBundle, ValidationError } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { fieldLabel, problemLines, problemPlace, readableProblem } from "./problems";

const bundle = {
  workflows: [
    {
      slug: "bill",
      name: "When an invoice has been read",
      workflow: {
        trigger: { id: "t1", on: { kind: "event", event: "document.read" } },
        steps: [
          { id: "ask", name: "Ask which bill", kind: "ask" },
          { id: "match", name: "Match the invoice", kind: "skill" },
          { id: "read", name: "Read the bill", kind: "tool" },
        ],
      },
    },
  ],
} as unknown as AgentBundle;

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
