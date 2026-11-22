import type { BuildDetail } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { decidedNotes, fromBuild, settleItems } from "./fromBuild";

const at = "2026-11-21T10:00:00.000Z";
const item = (id: string, over: Partial<BuildDetail["items"][number]> = {}) => ({
  id,
  phase: "draft" as const,
  kind: "gap" as const,
  title: `Item ${id}`,
  detail: "",
  owner: "builder" as const,
  state: "open" as const,
  stepId: null,
  ref: {},
  key: null,
  createdAt: at,
  resolvedAt: null,
  ...over,
});

const decision = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  what: `Decision ${id}`,
  why: "",
  kind: "assumption",
  risk: "normal",
  status: "never_discussed",
  by: null,
  at: null,
  ...over,
});

function detail(over: Partial<BuildDetail> = {}, decisions: unknown[] = []): BuildDetail {
  return {
    build: { id: "b", phase: "draft", kind: "agent", fitgap: { decisions } },
    gate: { next: null, reasons: [] },
    messages: [],
    items: [],
    draft: { problems: [] },
    poc: null,
    clientTest: null,
    qaChecks: [],
    ...over,
  } as unknown as BuildDetail;
}

describe("settleItems", () => {
  it("puts each open issue and question on its step, with what settles it", () => {
    const d = detail(
      {
        items: [
          item("q", { kind: "question", stepId: "s1", title: "Who signs?" }),
          item("g", { stepId: "s2", state: "deferred", detail: "A person does it for now." }),
          item("done", { stepId: "s1", state: "done" }),
          item("loose", { stepId: null }),
        ],
        draft: {
          problems: [
            {
              key: "p1",
              code: "input_missing",
              title: "Amount is empty",
              stepId: "s3",
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
        } as unknown as BuildDetail["draft"],
      },
      [
        decision("d1", { risk: "high", stepId: "s2", what: "It writes the bill" }),
        decision("d2", { risk: "high", stepId: "s2", status: "confirmed" }),
      ],
    );
    const items = settleItems(d);
    expect(items).toEqual([
      {
        key: "problem:p1",
        stepId: "s3",
        title: "Amount is empty",
        detail: "In “s3” of “w”",
        level: "issue",
        source: "problem",
      },
      {
        key: "decision:d1",
        stepId: "s2",
        title: "It writes the bill",
        detail: "High risk, assumption",
        level: "question",
        source: "decision",
        refId: "d1",
      },
      {
        key: "item:q",
        stepId: "s1",
        title: "Who signs?",
        level: "question",
        source: "build_item",
        refId: "q",
      },
      {
        key: "item:g",
        stepId: "s2",
        title: "Item g",
        detail: "Put off. A person does it for now.",
        level: "issue",
        source: "build_item",
        refId: "g",
      },
    ]);
    // Where the host shows the live validator's problems, the build's copy is left out.
    expect(settleItems(d, { problems: false }).map((i) => i.key)).not.toContain("problem:p1");
  });
});

describe("decidedNotes", () => {
  it("lists every decision on a step, its risk and starting value kept", () => {
    const d = detail({}, [
      decision("d1", { stepId: "s1", what: "Flags a price up 5%", value: "5%", why: "The brief" }),
      decision("d2", { stepId: "s2", risk: "high", status: "confirmed" }),
      decision("d3"),
    ]);
    expect(decidedNotes(d)).toEqual([
      {
        key: "decision:d1",
        stepId: "s1",
        what: "Flags a price up 5%",
        why: "Starts at 5%. The brief",
        decisionId: "d1",
        risk: "normal",
      },
      {
        key: "decision:d2",
        stepId: "s2",
        what: "Decision d2",
        decisionId: "d2",
        risk: "high",
      },
    ]);
    expect(fromBuild(d).decided).toHaveLength(2);
  });
});
