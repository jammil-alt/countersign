// Builds (docs/plan.md §1.108): the phases a build goes through, what holds each move, and records
// read leniently from storage.
import { describe, expect, it } from "vitest";
import {
  type GateFacts,
  gateReasons,
  nextPhase,
  phasesOf,
  readBrief,
  readFitGap,
  readQa,
  readTestPlan,
} from "./build";

const base: GateFacts = {
  kind: "agent",
  phase: "intake",
  brief: {},
  fitgap: { rows: [], needsTrue: [] },
  draft: false,
  draftErrors: 0,
  poc: { passed: false, detail: "No test has run yet." },
  trialDone: false,
  qaSigned: false,
  openItems: 0,
};

describe("phases", () => {
  it("are six for an agent and five for a skill, which skips the client test", () => {
    expect(phasesOf("agent")).toEqual(["intake", "fitgap", "draft", "poc", "client_test", "qa"]);
    expect(phasesOf("skill")).toEqual(["intake", "fitgap", "draft", "poc", "qa"]);
    expect(nextPhase("skill", "poc")).toBe("qa");
    expect(nextPhase("agent", "poc")).toBe("client_test");
    expect(nextPhase("agent", "qa")).toBeNull();
  });
});

describe("gates", () => {
  it("hold intake until the brief has a goal, a start, data in and data out", () => {
    expect(gateReasons(base)).toHaveLength(4);
    const brief = {
      goal: { text: "Check invoices against contracts", state: "confirmed" as const },
      trigger: { text: "An invoice is forwarded", state: "confirmed" as const },
      dataIn: { text: "Invoice PDFs", state: "assumed" as const },
      dataOut: { text: "", state: "open" as const },
    };
    expect(gateReasons({ ...base, brief })).toEqual(["The brief has no data out yet."]);
  });

  it("let open items carry over until the client test and go-live", () => {
    expect(gateReasons({ ...base, phase: "draft", draft: true, openItems: 3 })).toEqual([]);
    expect(gateReasons({ ...base, phase: "draft", draft: true, draftErrors: 2 })).toEqual([
      "The draft has 2 problems to fix.",
    ]);
    expect(
      gateReasons({ ...base, phase: "poc", poc: { passed: true, detail: "" }, openItems: 1 }),
    ).toEqual(["1 open item is not done or put off."]);
    expect(gateReasons({ ...base, phase: "qa", qaSigned: true })).toEqual([]);
  });

  it("need a fit-gap row in scope", () => {
    const fitgap = {
      rows: [
        {
          id: "pay",
          need: "Pay the vendor",
          verdict: "not_possible" as const,
          how: "",
          dropped: true,
        },
      ],
      needsTrue: [],
    };
    expect(gateReasons({ ...base, phase: "fitgap", fitgap })).toEqual([
      "The fit-gap has no rows in scope.",
    ]);
  });
});

describe("records", () => {
  it("read what they can and drop what they can't", () => {
    expect(readBrief({ goal: { text: "x", state: "confirmed" }, rules: { text: 3 } })).toEqual({
      goal: { text: "x", state: "confirmed" },
    });
    expect(readFitGap("nonsense")).toEqual({ rows: [], needsTrue: [] });
    expect(readTestPlan(null)).toEqual({ datasets: [] });
    expect(readQa({})).toEqual({ accepted: {}, signedBy: null, signedAt: null, decision: null });
  });
});
