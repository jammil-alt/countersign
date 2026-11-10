// Wave 5 (docs/plan.md §1.86 "Forks (wave 5)"): the outcome vocabulary, what each step records
// beside its output, the field picker's outcome fields, the validator's rules for conditions that
// route on them, and reading an outcome back from a row.
import { describe, expect, it } from "vitest";
import { outcomeOfStepRow } from "../api/run-checks";
import { fromWorkflowV3 } from "./convert";
import {
  combinedApproval,
  combinedVerdict,
  conferRecord,
  isEmptyOutput,
  outcomeOfRow,
  outcomeVocabulary,
  plainError,
  STEP_OUTCOMES,
  stepOutcomeFields,
  stepOutcomes,
  stepRecordSchema,
  writeMayHaveHappened,
} from "./outcomes";
import { processPathsAt } from "./paths";
import { Process, type Step } from "./schema";
import { validateProcess } from "./validate";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };

const rule = (field: string, value: unknown, op = "=") => ({
  match: "all",
  rules: [{ field: `{{${field}}}`, op, value }],
});

/** A process: a read, a write with a confer and an approval, a person, then an `if` on them. */
function raw(when: unknown = rule("steps.save.outcome", "rejected"), extra: object[] = []) {
  return {
    schemaVersion: 4,
    triggers: [MANUAL],
    steps: [
      {
        id: "find",
        name: "Find",
        kind: "read",
        tool: "qbo.bill.query",
        onError: "continue",
      },
      {
        id: "save",
        name: "Save",
        kind: "write",
        tool: "qbo.bill.update",
        checks: {
          confer: { with: [{ ai: { focus: "Right bill?" } }] },
          approval: { onReject: "continue" },
        },
      },
      {
        id: "ask",
        name: "Ask",
        kind: "person",
        mode: "ask",
        assignee: "client_admin",
        title: "Which?",
        deadline: { after: "1 day", ifNoAnswer: "skip" },
        choices: [
          { value: "keep", label: "Keep" },
          { value: "drop", label: "Drop" },
        ],
      },
      ...extra,
      {
        id: "route",
        name: "Route",
        kind: "if",
        paths: [{ id: "p", name: "Recover", when, steps: [] }],
        otherwise: { id: "o", steps: [] },
      },
    ],
  };
}

const parsed = (input: unknown = raw()) => Process.parse(input);
const stepOf = (id: string, input: unknown = raw()): Step => {
  const s = parsed(input).steps.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};

describe("the vocabulary", () => {
  it("has one closed list per kind that records an outcome", () => {
    expect(Object.keys(STEP_OUTCOMES).sort()).toEqual([
      "conversation",
      "for_each",
      "notify",
      "person",
      "process",
      "read",
      "skill",
      "wait",
      "write",
    ]);
    expect(STEP_OUTCOMES.write).toEqual([
      "done",
      "rejected",
      "no_answer",
      "skipped",
      "needs_help",
      "failed",
    ]);
    expect(STEP_OUTCOMES.read).toContain("empty");
    expect(STEP_OUTCOMES.wait).toEqual(["arrived", "timed_out"]);
  });

  it("offers only what the step, as set up, can end with", () => {
    // `failed` only with onError: continue; a read's approval words only with an approval.
    expect(stepOutcomes(stepOf("find"))).toEqual([
      "done",
      "empty",
      "skipped",
      "needs_help",
      "failed",
    ]);
    expect(stepOutcomes(stepOf("save"))).toEqual(["done", "rejected", "no_answer", "skipped"]);
    expect(stepOutcomes(stepOf("ask"))).toEqual(["answered", "no_answer"]);
    expect(stepOutcomes(stepOf("route"))).toEqual([]);
    const wait = Process.parse({
      schemaVersion: 4,
      triggers: [MANUAL],
      steps: [{ id: "w", name: "Wait", kind: "wait", for: "1 hour" }],
    }).steps[0] as Step;
    expect(stepOutcomes(wait)).toEqual(["timed_out"]);
  });
});

describe("the field picker", () => {
  it("types what each step records", () => {
    const fields = stepOutcomeFields(stepOf("save")).map((f) => f.path);
    expect(fields).toEqual([
      "outcome",
      "approval.outcome",
      "approval.by",
      "confer.verdict",
      "confer.0.verdict",
      "confer.0.by",
    ]);
    expect(stepOutcomeFields(stepOf("ask"))).toEqual([
      { path: "outcome", schema: { type: "string", enum: ["answered", "no_answer"] } },
      { path: "choice", schema: { type: "string", enum: ["keep", "drop"] } },
    ]);
    expect(stepOutcomeFields(stepOf("find")).map((f) => f.path)).toContain("error.code");
    expect(stepRecordSchema(stepOf("route"))).toBeUndefined();
  });

  it("lists earlier steps' outcomes at a step, never its own", () => {
    const paths = processPathsAt(parsed(), "route").map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "steps.find.outcome",
        "steps.find.error.code",
        "steps.save.outcome",
        "steps.save.approval.outcome",
        "steps.save.confer.verdict",
        "steps.ask.choice",
      ]),
    );
    const atSave = processPathsAt(parsed(), "save", {}, { own: true }).map((p) => p.path);
    expect(atSave).toContain("steps.find.outcome");
    expect(atSave).not.toContain("steps.save.outcome");
    const option = processPathsAt(parsed(), "route").find((p) => p.path === "steps.save.outcome");
    expect(option).toMatchObject({ stepId: "save", schema: { enum: expect.any(Array) } });
  });
});

describe("validation", () => {
  const errors = (input: unknown) =>
    validateProcess(input).errors.map((e) => ({ code: e.code, stepId: e.stepId, field: e.field }));

  it("accepts conditions on an earlier step's outcome, approval, verdict and quick answer", () => {
    for (const when of [
      rule("steps.save.outcome", "rejected"),
      rule("steps.save.approval.outcome", ["rejected", "no_answer"], "in"),
      rule("steps.save.confer.verdict", "disagree"),
      rule("steps.save.confer.0.verdict", "agree", "!="),
      rule("steps.ask.choice", "drop"),
      rule("steps.ask.outcome", "no_answer"),
      rule("steps.find.outcome", "empty"),
      rule("steps.find.error.code", "unauthorized"),
    ]) {
      const r = validateProcess(raw(when));
      expect(r.errors, JSON.stringify(when)).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });

  it("refuses an outcome word not in the kind's vocabulary", () => {
    expect(errors(raw(rule("steps.save.outcome", "approved")))).toEqual([
      { code: "outcome_unknown", stepId: "p", field: "when.rules.0.value" },
    ]);
    expect(errors(raw(rule("steps.ask.choice", "maybe")))).toEqual([
      { code: "outcome_unknown", stepId: "p", field: "when.rules.0.value" },
    ]);
  });

  it("warns on an outcome the step never ends with as set up", () => {
    const r = validateProcess(raw(rule("steps.save.outcome", "failed")));
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: "outcome_unreachable", stepId: "p" }),
    ]);
    expect(r.warnings[0]?.message).toMatch(/onError: continue/);
  });

  it("refuses a step's own outcome in its checks, and a later step's anywhere", () => {
    const own = raw();
    (own.steps[1] as Record<string, unknown>).checks = {
      approval: { when: rule("steps.save.outcome", "done") },
    };
    expect(errors(own)).toEqual([
      expect.objectContaining({ stepId: "save", field: "checks.approval.when.rules.0.field" }),
    ]);
    const later = raw(rule("steps.after.outcome", "done"), []);
    later.steps.push({ id: "after", name: "After", kind: "wait", for: "1 hour" } as never);
    expect(errors(later)).toEqual([
      expect.objectContaining({ stepId: "p", field: "when.rules.0.field" }),
    ]);
    // A field a step doesn't record.
    expect(errors(raw(rule("steps.ask.approval.outcome", "approved")))).toEqual([
      expect.objectContaining({ stepId: "p", field: "when.rules.0.field" }),
    ]);
  });

  it("keeps the hand-off to outputs: it is read from the stored rows after the run", () => {
    const input = { ...raw(), handoff: { output: { how: "{{steps.save.outcome}}" } } };
    expect(errors(input)).toEqual([
      expect.objectContaining({ code: expect.any(String), field: "handoff.output.how" }),
    ]);
  });

  it("refuses onError where a step has no failure of its own to go on past", () => {
    const input = raw();
    (input.steps[2] as Record<string, unknown>).onError = "continue";
    (input.steps[3] as Record<string, unknown>).onError = "continue";
    expect(errors(input)).toEqual([
      { code: "on_error_not_here", stepId: "ask", field: "onError" },
      { code: "on_error_not_here", stepId: "route", field: "onError" },
    ]);
  });

  it("leaves onError out of a parsed step that never said it, and out of converted v3 steps", () => {
    expect("onError" in stepOf("save")).toBe(false);
    const v4 = fromWorkflowV3(
      {
        schemaVersion: 3,
        trigger: MANUAL,
        steps: [{ id: "a", name: "A", kind: "wait", for: "1 hour" }],
      } as never,
      { wrappedTool: () => null, sideEffect: () => null },
    );
    expect(JSON.stringify(v4)).not.toContain("onError");
  });
});

describe("deriving outcomes", () => {
  it("decides empty on the output's shape alone", () => {
    for (const v of [null, undefined, "", [], {}, { items: [], next: null }]) {
      expect(isEmptyOutput(v)).toBe(true);
    }
    for (const v of [[1], { count: 0 }, { found: false }, "x", 0, { items: [{}] }]) {
      expect(isEmptyOutput(v)).toBe(false);
    }
  });

  it("combines verdicts and approvals on the cautious side", () => {
    expect(combinedVerdict(["agree", null, "unsure"])).toBe("unsure");
    expect(combinedVerdict(["agree", "disagree"])).toBe("disagree");
    expect(combinedVerdict([null])).toBe("no_answer");
    expect(conferRecord([{ verdict: "agree", by: "ai" }, null])).toEqual({
      verdict: "agree",
      0: { verdict: "agree", by: "ai" },
    });
    expect(combinedApproval([])).toEqual({ outcome: "not_needed" });
    expect(
      combinedApproval([
        { outcome: "approved", by: "u1" },
        { outcome: "no_answer" },
        { outcome: "approved", by: "u2" },
      ]),
    ).toEqual({ outcome: "no_answer" });
  });

  it("keeps an error plain and short, and knows a write that may have happened", () => {
    const e = plainError(`refused: token sk_live_${"a".repeat(30)} expired\nstack`);
    expect(e).toEqual({ code: "refused", message: "refused: token [hidden] expired" });
    expect(plainError("x".repeat(300) + " y").message.length).toBeLessThanOrEqual(200);
    expect(
      writeMayHaveHappened("The text to Pat may have been sent; check before trying again: 500"),
    ).toBe(true);
    expect(writeMayHaveHappened("refused: not allowed")).toBe(false);
  });

  it("reads an outcome back from a step's row as the executor left it", () => {
    expect(outcomeOfRow({ kind: "read", status: "succeeded", output: [] })).toBe("empty");
    expect(outcomeOfRow({ kind: "write", status: "skipped", approvers: ["rejected"] })).toBe(
      "rejected",
    );
    expect(outcomeOfRow({ kind: "action", status: "skipped", approvers: ["no_answer"] })).toBe(
      "no_answer",
    );
    expect(
      outcomeOfRow({ kind: "skill", status: "failed", output: { error: "needs help: no answer" } }),
    ).toBe("needs_help");
    expect(outcomeOfRow({ kind: "person", status: "skipped" })).toBe("no_answer");
    expect(outcomeOfRow({ kind: "wait", status: "succeeded" })).toBe("timed_out");
    expect(
      outcomeOfRow({ kind: "for_each", status: "succeeded", output: { count: 2, failed: 2 } }),
    ).toBe("all_failed");
    expect(outcomeOfRow({ kind: "use_automation", status: "skipped" })).toBe("stopped");
    expect(outcomeOfRow({ kind: "if", status: "succeeded" })).toBeNull();
    expect(outcomeOfRow({ kind: "write", status: "waiting" })).toBeNull();
    // A check's own row has no outcome of its own.
    expect(
      outcomeOfStepRow({ nodeId: "save:notify:0", nodeType: "notify", status: "succeeded" }, []),
    ).toBeNull();
  });

  it("names the vocabulary a compared field holds", () => {
    expect(outcomeVocabulary(stepOf("save"), ["approval", "outcome"])).toContain("not_needed");
    expect(outcomeVocabulary(stepOf("save"), ["confer", "0", "verdict"])).toContain("agree");
    expect(outcomeVocabulary(stepOf("find"), ["error", "code"])).toBeNull();
  });
});
