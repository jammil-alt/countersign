// Each step's status on the one-screen builder (docs/builder-plan.md §12, F2): problems, missing
// steps, build items and decisions land on their step; issues win over questions; the bar's counts
// and "next open" go issues first.
import { describe, expect, it } from "vitest";
import type { BuilderProblem } from "../builder/catalog";
import type { Process } from "../builder/model";
import {
  buildStatuses,
  counts,
  MISSING_TITLE,
  nextOpen,
  openItems,
  type SettleEntry,
  stepOrder,
} from "./status";

const process = {
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps: [
    { id: "read", kind: "skill", name: "Read the invoice", skill: "doc.read", input: {} },
    {
      id: "dup",
      kind: "if",
      name: "The invoice is a duplicate?",
      paths: [
        {
          id: "pa",
          name: "The invoice is a duplicate",
          when: { match: "all", rules: [] },
          steps: [
            { id: "tell", kind: "wait", name: "Tell Dana", for: "1 day" },
            { id: "end", kind: "stop", name: "Stop", status: "succeeded" },
          ],
        },
      ],
      otherwise: { id: "po", steps: [{ id: "else", kind: "wait", name: "Wait", for: "1 day" }] },
    },
    { id: "code", kind: "missing", name: "Code each line to a job", need: "A coding skill" },
    {
      id: "each",
      kind: "for_each",
      name: "Each line",
      over: "{{steps.read.output.lines}}",
      concurrency: 10,
      steps: [{ id: "inner", kind: "wait", name: "Pause", for: "1 hour" }],
    },
  ],
} as unknown as Process;

const problem = (stepId: string | null, over: Partial<BuilderProblem> = {}): BuilderProblem => ({
  stepId,
  field: "input.vendor",
  code: "template_path",
  message: "Uses the vendor from “Read the invoice”, but it has no vendor.",
  workflow: "intake",
  ...over,
});

describe("stepOrder", () => {
  it("reads top to bottom, paths in order then otherwise, a loop's steps under it", () => {
    expect(stepOrder(process)).toEqual([
      "read",
      "dup",
      "tell",
      "end",
      "else",
      "code",
      "each",
      "inner",
    ]);
    expect(stepOrder(process, { triggers: true })[0]).toBe("t");
  });
});

describe("buildStatuses", () => {
  it("a missing step is an issue, in the library's words, without the validator's echo", () => {
    const s = buildStatuses({
      process,
      problems: [problem("code", { code: "missing_step", field: "", message: "can't publish" })],
    });
    const code = s.get("code");
    expect(code?.level).toBe("issue");
    expect(code?.items).toEqual([
      {
        key: "missing:code",
        stepId: "code",
        level: "issue",
        title: MISSING_TITLE,
        detail: "A coding skill",
        source: "missing",
      },
    ]);
  });

  it("puts a problem on its step, a path's on its decision, and leaves out the rest", () => {
    const s = buildStatuses({
      process,
      problems: [
        problem("read"),
        problem("read"), // the same twice: one item
        problem("pa", { field: "when", message: "Path A needs a rule." }),
        problem(null),
        problem("gone"),
        problem("read", { workflow: "other", field: "input.x" }),
      ],
      workflow: "intake",
    });
    expect(s.get("read")?.items.map((i) => i.key)).toEqual([
      "problem:template_path:read:input.vendor",
    ]);
    expect(s.get("dup")?.items[0]).toMatchObject({ title: "Path A needs a rule.", level: "issue" });
    expect([...s.keys()].sort()).toEqual(["code", "dup", "read"]);
  });

  it("a path with no condition yet is a question on its decision, not an issue", () => {
    const s = buildStatuses({
      process,
      problems: [
        problem("pa", {
          code: "rules_empty",
          field: "when.rules",
          message: "Add a condition, or use otherwise.",
        }),
      ],
      workflow: "intake",
    });
    expect(s.get("dup")?.level).toBe("question");
    expect(s.get("dup")?.items[0]).toMatchObject({
      key: "problem:rules_empty:pa:when.rules",
      level: "question",
      title: "When does a run take “The invoice is a duplicate”?",
      detail: "Add a condition, or use otherwise.",
    });
    // The bar counts it with the questions (the one issue is the fixture's missing step).
    expect(counts(s)).toEqual({ issues: 1, questions: 1 });
  });

  it("an issue wins over a question; a settled item no longer counts", () => {
    const items: SettleEntry[] = [
      { key: "item:1", stepId: "else", level: "question", title: "How big?", source: "build_item" },
      {
        key: "decision:2",
        stepId: "tell",
        level: "question",
        title: "Who is told?",
        source: "decision",
        settled: "Dana",
      },
      { key: "item:3", stepId: "nowhere", level: "issue", title: "Gone", source: "build_item" },
    ];
    const s = buildStatuses({
      process,
      problems: [problem("else", { field: "for" })],
      items,
      decided: [{ key: "d1", stepId: "read", what: "Reads PDFs only" }],
      customized: new Map([["inner", "added" as const]]),
      tried: [{ stepId: "read", status: "did", summary: "Read 4 lines" }],
    });
    expect(s.get("else")?.level).toBe("issue");
    expect(openItems(s.get("else")).map((i) => i.level)).toEqual(["issue", "question"]);
    expect(s.get("tell")?.level).toBe("ok");
    expect(s.get("tell")?.items).toHaveLength(1);
    expect(s.has("nowhere")).toBe(false);
    expect(s.get("read")).toMatchObject({
      level: "ok",
      decided: [{ key: "d1" }],
      tried: { status: "did" },
    });
    expect(s.get("inner")?.customized).toBe("added");
  });
});

describe("counts and nextOpen", () => {
  const s = buildStatuses({
    process,
    items: [
      { key: "q1", stepId: "read", level: "question", title: "Which inbox?", source: "build_item" },
      { key: "q2", stepId: "inner", level: "question", title: "How long?", source: "build_item" },
      { key: "i1", stepId: "tell", level: "issue", title: "No one to tell", source: "problem" },
    ],
  });
  const order = stepOrder(process);
  // The same steps without the missing one, which is always an issue.
  const noMissing = { ...process, steps: process.steps.filter((x) => x.kind !== "missing") };

  it("counts steps with an issue, and steps with only questions", () => {
    expect(counts(s)).toEqual({ issues: 2, questions: 2 });
  });

  it("goes to the next issue first, round to the top, then questions", () => {
    expect(nextOpen(s, order)).toBe("tell");
    expect(nextOpen(s, order, "tell")).toBe("code");
    expect(nextOpen(s, order, "code")).toBe("tell");
    const onlyQuestions = buildStatuses({
      process: noMissing,
      items: [
        { key: "q1", stepId: "read", level: "question", title: "?", source: "build_item" },
        { key: "q2", stepId: "inner", level: "question", title: "?", source: "build_item" },
      ],
    });
    expect(nextOpen(onlyQuestions, order, "read")).toBe("inner");
    expect(nextOpen(onlyQuestions, order, "inner")).toBe("read");
    expect(nextOpen(buildStatuses({ process: { ...process, steps: [] } }), order)).toBeNull();
  });

  it("is null when the only open step is the one you are on", () => {
    const one = buildStatuses({
      process: noMissing,
      items: [{ key: "q", stepId: "read", level: "question", title: "?", source: "build_item" }],
    });
    expect(nextOpen(one, order, "read")).toBeNull();
  });
});
