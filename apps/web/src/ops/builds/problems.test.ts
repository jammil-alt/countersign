import { describe, expect, it } from "vitest";
import { plainRefs, problemAdvice, problemWhere } from "./problems";

describe("a draft's problems in plain words", () => {
  it("reads references as words", () => {
    expect(plainRefs("{{trigger.documentId}} and {{steps.find.output.total}}")).toBe(
      "the trigger's documentId and the find step's total",
    );
  });

  it("says what is wrong, the fix and what it costs", () => {
    const field = problemAdvice({
      code: "template_path",
      title: '{{trigger.documentId}}: no field "documentId"',
    });
    expect(field.what).toBe(
      'A step reads the trigger\'s documentId, but nothing before it gives a field called "documentId".',
    );
    expect(field.fix).toMatch(/field picker/);
    expect(field.cost).toMatch(/one more to build/);

    const missing = problemAdvice({
      code: "missing_step",
      title:
        '"Read an invoice that is only in the email body" is missing: There is no step that turns email body text into an invoice reading',
    });
    expect(missing.what).toBe(
      "There is no step that turns email body text into an invoice reading.",
    );
    expect(missing.cost).toMatch(/person's time/);

    expect(
      problemAdvice({ code: "handoff_unknown_step", title: "choose the step it starts at" }).what,
    ).toBe("A hand-off to another workflow or agent doesn't say which step it starts at.");
    // A code with no words of its own reads as its message, with the Builder as the way to a fix.
    expect(problemAdvice({ code: "something_new", title: "a thing is off" })).toEqual({
      what: "A thing is off.",
      fix: "Ask the Builder about it in the conversation, or open the step in the workflow.",
      cost: null,
    });
  });

  it("says where it is", () => {
    expect(problemWhere({ stepName: "Read document", workflowName: "Vendor flow" })).toBe(
      "In “Read document” · Vendor flow",
    );
    expect(problemWhere({ stepName: null, workflowName: null })).toBeNull();
  });
});
