import { describe, expect, it } from "vitest";
import type { BuildDetail } from "../api/build";
import { buildIssues, issueLine } from "./issues";

const at = "2026-11-17T10:00:00.000Z";
const item = (id: string, over: Partial<BuildDetail["items"][number]> = {}) => ({
  id,
  phase: "intake" as const,
  kind: "question" as const,
  title: `Item ${id}`,
  detail: "",
  owner: "operator" as const,
  state: "open" as const,
  stepId: null,
  ref: {},
  key: null,
  createdAt: at,
  resolvedAt: null,
  ...over,
});

function detail(over: Partial<BuildDetail> = {}, phase: BuildDetail["build"]["phase"] = "poc") {
  return {
    build: { phase, kind: "agent" },
    gate: { next: null, reasons: [] },
    messages: [],
    items: [],
    draft: null,
    poc: null,
    clientTest: null,
    qaChecks: [
      {
        id: "tests",
        label: "Required test cases pass",
        state: "fail",
        detail: "1 fails",
        reason: null,
      },
    ],
    ...over,
  } as unknown as BuildDetail;
}

describe("buildIssues", () => {
  it("lists open issues first, the draft's problems and failing tests before items", () => {
    const issues = buildIssues(
      detail({
        items: [item("a", { state: "done" }), item("b"), item("c", { ref: { testCaseId: "k2" } })],
        draft: {
          problems: [
            {
              key: "p1",
              code: "input_missing",
              title: "Amount is empty",
              stepId: "s",
              workflow: "w",
              stepName: "Pay",
              workflowName: "Main",
            },
          ],
        } as BuildDetail["draft"],
        poc: {
          failures: [
            { caseId: "k1", name: "Over price", status: "failed", runId: null },
            { caseId: "k2", name: "Has an item", status: "failed", runId: null },
          ],
        } as BuildDetail["poc"],
        messages: [{ about: "item:b" }, { about: "item:b" }, {}] as BuildDetail["messages"],
      }),
    );
    // In the POC test the failing case holds the move and the draft problem doesn't, as the gate
    // says (BUILDER_QA CONS-1): the case comes first.
    expect(issues.map((i) => i.key)).toEqual([
      "case:k1",
      "problem:p1",
      "item:b",
      "item:c",
      "item:a",
    ]);
    expect(issues.find((i) => i.key === "problem:p1")?.detail).toBe("In “Pay” of “Main”");
    expect(issues.find((i) => i.key === "item:a")).toMatchObject({ open: false, state: "Done" });
    expect(issues.find((i) => i.key === "item:b")?.talk).toBe(2);
    // QA's checklist is an issue only in QA.
    expect(issues.some((i) => i.source === "check")).toBe(false);
  });

  it("names the step each issue is on, from the source that has one", () => {
    const issues = buildIssues(
      detail({
        items: [item("a", { stepId: "s-item" }), item("b")],
        draft: {
          problems: [
            {
              key: "p1",
              code: "input_missing",
              title: "Amount is empty",
              stepId: "s-problem",
              workflow: "w",
            },
            {
              key: "p2",
              code: "no_trigger",
              title: "Nothing starts it",
              stepId: null,
              workflow: "w",
            },
          ],
        } as BuildDetail["draft"],
        poc: {
          failures: [{ caseId: "k1", name: "Over price", status: "failed", runId: null }],
        } as BuildDetail["poc"],
        build: {
          phase: "poc",
          kind: "agent",
          fitgap: {
            decisions: [
              {
                id: "d1",
                what: "Writes the bill",
                why: "",
                kind: "assumption",
                risk: "high",
                stepId: "s-decision",
                status: "never_discussed",
              },
              {
                id: "d2",
                what: "Pays by check",
                why: "",
                kind: "assumption",
                risk: "high",
                status: "never_discussed",
              },
            ],
          },
        } as unknown as BuildDetail["build"],
      }),
    );
    const step = (key: string) => issues.find((i) => i.key === key)?.stepId;
    expect(step("item:a")).toBe("s-item");
    expect(step("item:b")).toBeNull();
    expect(step("problem:p1")).toBe("s-problem");
    expect(step("problem:p2")).toBeNull();
    expect(step("decision:d1")).toBe("s-decision");
    expect(step("decision:d2")).toBeNull();
    expect(step("case:k1")).toBeNull();
  });

  it("takes failing and accepted QA checks in QA, and names each by its key", () => {
    const issues = buildIssues(detail({}, "qa"));
    expect(issues).toEqual([
      expect.objectContaining({ key: "check:tests", open: true, blocking: true }),
    ]);
    expect(issueLine(issues[0] as never)).toBe(
      "[check:tests] QA check (Fails, holds the next move): Required test cases pass. 1 fails",
    );
  });
});
