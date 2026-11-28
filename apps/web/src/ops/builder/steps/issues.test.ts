import { describe, expect, it } from "vitest";
import { canPublish, issuesByStep, issuesFromServer, workflowIssues } from "./issues";
import {
  ensureEnd,
  insertStep,
  newOutput,
  newStep,
  ROOT,
  setEndOutputs,
  updateStep,
} from "./model";
import {
  chooseDoneBy,
  chooseUses,
  indexCatalog,
  NO_USES_CONTEXT,
  type UsesContext,
} from "./options";
import type { DoStep, Workflow } from "./types";

let n = 0;
const id = () => `i${++n}`;
const wf = (): Workflow =>
  ensureEnd(
    {
      schemaVersion: 5,
      triggers: [{ id: "t", on: { type: "manual" } } as never],
      outputs: [{ ...newOutput("Report", id), id: "o1" }],
      steps: [],
    },
    id,
  );

const ctx: UsesContext = {
  ...NO_USES_CONTEXT,
  actions: indexCatalog([
    {
      type: "connector",
      id: "qbo",
      name: "QuickBooks",
      actions: [
        {
          id: "qbo.bill.create",
          label: "Create bill",
          description: "",
          kind: "change",
          input: [{ name: "vendorId", type: "text", required: true }],
          output: [],
        },
      ],
    },
  ]),
};

describe("what stops publishing", () => {
  it("says an End delivers nothing, and an output no End delivers", () => {
    const issues = workflowIssues(wf(), ctx);
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["end_empty", "output_never_delivered"]),
    );
    expect(canPublish(issues)).toBe(false);
  });

  it("is clear once the End delivers the output and every step is filled", () => {
    let w = wf();
    const end = w.steps.at(-1);
    w = setEndOutputs(w, end?.id ?? "", { outputs: ["o1"] });
    expect(workflowIssues(w, ctx)).toEqual([]);
  });

  it("puts a step's issues on the step, in words", () => {
    let w = wf();
    const a = newStep("do", id) as DoStep;
    w = insertStep(w, { container: ROOT, index: 0 }, a);
    const by = issuesByStep(workflowIssues(w, ctx));
    expect(by.get(a.id)?.map((i) => i.code)).toEqual(
      expect.arrayContaining(["goal_missing", "done_by_required"]),
    );
    w = updateStep(w, a.id, (s) =>
      s.kind === "do"
        ? chooseUses(
            chooseDoneBy({ ...s, name: "Bill it" }, "rules"),
            { type: "action", action: "qbo.bill.create" },
            ctx,
          )
        : s,
    );
    const after = workflowIssues(w, ctx).filter((i) => i.at === a.id);
    expect(after.map((i) => i.code)).toEqual(["input_missing"]);
    expect(after[0]?.message).toContain("vendorId");
  });

  it("says what an output still needs", () => {
    let w = wf();
    w = {
      ...w,
      outputs: [
        {
          ...w.outputs[0],
          kind: "report",
          report: { to: [], channel: "inbox", message: "" },
        } as never,
      ],
    };
    expect(workflowIssues(w, ctx).find((i) => i.code === "output_incomplete")?.message).toBe(
      "Say who gets this report.",
    );
    w = {
      ...w,
      outputs: [{ ...w.outputs[0], kind: "write" } as never],
    };
    expect(workflowIssues(w, ctx).find((i) => i.code === "output_incomplete")?.message).toBe(
      "Pick the action that delivers this output.",
    );
  });
});

describe("the server's issues", () => {
  it("keeps this workflow's and the bundle's, on their steps, with the step check's code", () => {
    const issues = issuesFromServer(
      [
        {
          stepId: "s1",
          field: "",
          code: "step_model",
          stepCode: "input_missing",
          message: "a",
          workflow: "main",
        },
        { stepId: "t1", field: "on.cron", code: "invalid_cron", message: "b", workflow: "main" },
        { stepId: null, field: "definition.skills", code: "unknown_skill", message: "c" },
        { stepId: "x", field: "", code: "step_model", message: "d", workflow: "other" },
      ],
      "main",
    );
    expect(issues).toEqual([
      { at: "s1", code: "input_missing", message: "a" },
      { at: "t1", code: "invalid_cron", message: "b" },
      { code: "unknown_skill", message: "c" },
    ]);
  });
});
