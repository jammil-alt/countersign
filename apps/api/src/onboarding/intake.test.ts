// A tool field's answer as Getting started and the build's Requirements panel read it
// (docs/plan.md §1.125.2, §1.125.6): a live connection answers it, and overtakes an earlier
// "Can't connect it now" or "Later"; an answer someone gave stands.

import { GUIDE_VERSION, type Guide, guideTotals } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { answerViews, type IntakeData } from "./intake";

const at = new Date("2026-11-17T10:00:00Z");

const sections: Guide["sections"] = [
  {
    key: "general",
    kind: "general",
    area: null,
    templateId: null,
    title: "Your business",
    intro: "",
    fields: [
      {
        key: "tool.qbo",
        sectionKey: "general",
        alsoIn: [],
        label: "Connect QuickBooks",
        kind: "tool",
        hint: "",
        requiredToStart: true,
        state: "to_ask",
        weThink: null,
        fileSection: "systems",
        connector: "qbo",
        origin: "core",
      },
    ],
  },
];

function data(
  answers: { state: string; value?: unknown }[],
  connected: [string, string][],
): IntakeData {
  return {
    row: { updatedAt: at } as IntakeData["row"],
    guide: { version: GUIDE_VERSION, sections, totals: guideTotals(sections) },
    people: [],
    answers: answers.map((a, i) => ({
      id: `a${i}`,
      fieldKey: "tool.qbo",
      state: a.state,
      value: a.value ?? null,
      source: "client",
      userId: null,
      createdAt: new Date(at.getTime() + i * 1000),
    })) as unknown as IntakeData["answers"],
    events: [],
    connected: new Map(connected),
    names: new Map(),
  };
}

describe("a tool field's answer", () => {
  it("is answered by a live connection", () => {
    expect(answerViews(data([], [["qbo", "c1"]]))).toMatchObject([
      { fieldKey: "tool.qbo", state: "answered", source: "tool", value: { connectionId: "c1" } },
    ]);
  });

  it("is overtaken by the connection after a not sure or a later", () => {
    for (const state of ["not_sure", "later"]) {
      const views = answerViews(data([{ state }], [["qbo", "c1"]]));
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ state: "answered", source: "tool" });
    }
    // Not connected yet: the not sure stands.
    expect(answerViews(data([{ state: "not_sure" }], []))).toMatchObject([{ state: "not_sure" }]);
  });

  it("keeps an answer someone gave", () => {
    expect(
      answerViews(data([{ state: "answered", value: "the main company file" }], [["qbo", "c1"]])),
    ).toMatchObject([{ state: "answered", source: "client", value: "the main company file" }]);
  });
});
