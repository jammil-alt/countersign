// Builds (docs/plan.md §1.108): the phases a build goes through, what holds each move, and records
// read leniently from storage.
import { describe, expect, it } from "vitest";
import {
  clampFitGap,
  clampText,
  type FitGap,
  FitGapAnswer,
  fitChangeKind,
  type GateFacts,
  gateReasons,
  mergeFitGap,
  nextPhase,
  operatorFitGap,
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
  fitgap: { rows: [], needsTrue: [], setup: [] },
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
      setup: [],
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
    expect(readFitGap("nonsense")).toEqual({ rows: [], needsTrue: [], setup: [] });
    expect(readTestPlan(null)).toEqual({ datasets: [] });
    expect(readQa({})).toEqual({ accepted: {}, signedBy: null, signedAt: null, decision: null });
  });
});

describe("verdicts", () => {
  const why = "Their invoices are scanned images, never PDFs with text.";
  const row = (id: string, verdict: FitGap["rows"][number]["verdict"]) => ({
    id,
    need: `Need ${id}`,
    verdict,
    how: "",
    dropped: false,
  });
  const stored: FitGap = {
    rows: [
      {
        ...row("read", "figure_out"),
        override: { from: "native", reason: why, by: "Ada", at: "t" },
      },
      {
        ...row("match", "configure"),
        challenge: { wanted: "native", reason: why, by: null, at: null },
      },
      { ...row("tiers", "build"), dropped: true },
      row("pay", "not_possible"),
    ],
    needsTrue: [],
    setup: [],
  };

  it("set more work at once and ask the Builder for less", () => {
    expect(fitChangeKind("native", "figure_out")).toBe("override");
    expect(fitChangeKind("configure", "not_possible")).toBe("override");
    expect(fitChangeKind("figure_out", "native")).toBe("challenge");
    expect(fitChangeKind("not_possible", "build")).toBe("challenge");
  });

  it("keep the operator's changes when the Builder writes the fit-gap again", () => {
    const merged = mergeFitGap(stored, {
      rows: [row("read", "native"), row("match", "native"), row("pay", "not_possible")],
      needsTrue: [],
      setup: [],
    });
    // The override stays; the challenge is answered by the Builder's verdict; the dropped row the
    // Builder left out comes back, still dropped.
    expect(
      merged.rows.map((r) => [r.id, r.verdict, !!r.override, !!r.challenge, r.dropped]),
    ).toEqual([
      ["read", "figure_out", true, false, false],
      ["match", "native", false, false, false],
      ["pay", "not_possible", false, false, false],
      ["tiers", "build", false, false, true],
    ]);
  });

  it("let the operator change scope, never a verdict, when saving the fit-gap", () => {
    const sent = { ...stored, rows: stored.rows.map((r) => ({ ...r, dropped: r.id === "pay" })) };
    const out = operatorFitGap(stored, sent);
    expect(out.ok && out.fitgap.rows.map((r) => r.dropped)).toEqual([false, false, false, true]);
    expect(out.ok && out.fitgap.rows[0]?.override?.from).toBe("native");
    const native = {
      ...stored,
      rows: stored.rows.map((r) => ({ ...r, verdict: "native" as const })),
    };
    expect(operatorFitGap(stored, native)).toMatchObject({ ok: false });
    expect(
      operatorFitGap(stored, { rows: [row("new", "native")], needsTrue: [], setup: [] }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("hold the fit-gap while a challenge waits on the Builder", () => {
    expect(gateReasons({ ...base, phase: "fitgap", fitgap: stored })).toEqual([
      "1 challenged verdict is waiting on the Builder.",
    ]);
  });

  it("cut a wordy answer to size instead of refusing it", () => {
    const long = `${"Read document takes a stored document id. ".repeat(20)}End`;
    const answer = FitGapAnswer.parse({
      rows: [{ id: "a", need: "x", verdict: "native", how: long }],
    });
    const how = clampFitGap(answer).rows[0]?.how ?? "";
    expect(how.length).toBeLessThanOrEqual(500);
    expect(how.endsWith(".")).toBe(true);
    expect(clampText("short", 500)).toBe("short");
    expect(clampText("a ".repeat(400), 100).endsWith("…")).toBe(true);
  });

  it("keep the operator's intake form fields through the Builder's rewrites", () => {
    const field = (id: string, label: string, extra = {}) => ({
      id,
      label,
      kind: "answer" as const,
      hint: "",
      dropped: false,
      byOperator: false,
      ...extra,
    });
    const before: FitGap = {
      rows: [],
      needsTrue: [],
      setup: [
        field("ap", "Your AP address"),
        field("tol", "Price tolerance, in percent", { byOperator: true }),
        field("vol", "Invoices a month", { dropped: true }),
      ],
    };
    const draft = (id: string, label: string) => ({ id, label, kind: "answer" as const, hint: "" });
    const merged = mergeFitGap(before, {
      rows: [],
      needsTrue: [],
      setup: [draft("ap", "The AP inbox"), draft("tol", "Tolerance"), draft("who", "Who approves")],
    });
    expect(merged.setup.map((f) => [f.id, f.label, f.dropped])).toEqual([
      ["ap", "The AP inbox", false],
      ["tol", "Price tolerance, in percent", false],
      ["who", "Who approves", false],
      ["vol", "Invoices a month", true],
    ]);
    // An answer without a form leaves it as it was.
    expect(mergeFitGap(before, { rows: [], needsTrue: [], setup: [] }).setup).toEqual(before.setup);
    // Saving marks what the operator changed as theirs.
    const saved = operatorFitGap(before, {
      ...before,
      setup: before.setup.map((f) => (f.id === "ap" ? { ...f, hint: "e.g. ap@client.com" } : f)),
    });
    expect(saved.ok && saved.fitgap.setup.map((f) => f.byOperator)).toEqual([true, true, false]);
  });
});
