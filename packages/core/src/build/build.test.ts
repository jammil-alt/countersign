// Builds (docs/plan.md §1.108): the phases a build goes through, what holds each move, and records
// read leniently from storage.
import { describe, expect, it } from "vitest";
import {
  clampFitGap,
  clampText,
  type FitGap,
  FitGapAnswer,
  fitChangeKind,
  fitScope,
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
  SETUP_KINDS,
  withFitScope,
} from "./build";

const base: GateFacts = {
  kind: "agent",
  phase: "intake",
  brief: {},
  fitgap: { rows: [], needsTrue: [], setup: [], decisions: [] },
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

  it("let open items carry over until the go-live", () => {
    expect(gateReasons({ ...base, phase: "draft", draft: true, openItems: 3 })).toEqual([]);
    expect(gateReasons({ ...base, phase: "draft", draft: true, draftErrors: 2 })).toEqual([
      "The draft has 2 problems to fix.",
    ]);
    expect(
      gateReasons({ ...base, phase: "poc", poc: { passed: true, detail: "" }, openItems: 1 }),
    ).toEqual([]);
    expect(gateReasons({ ...base, phase: "qa", qaSigned: true })).toEqual([]);
    expect(gateReasons({ ...base, phase: "qa", qaSigned: true, openItems: 1 })).toEqual([
      "1 open item is not done or put off.",
    ]);
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
          later: false,
        },
        {
          id: "split",
          need: "Split a photo of several receipts",
          verdict: "figure_out" as const,
          how: "",
          dropped: false,
          later: true,
        },
      ],
      needsTrue: [],
      setup: [],
      decisions: [],
    };
    // Known risks alone leave nothing to draft.
    expect(gateReasons({ ...base, phase: "fitgap", fitgap })).toEqual([
      "The fit-gap has nothing in the first version.",
    ]);
  });
});

describe("records", () => {
  it("read what they can and drop what they can't", () => {
    expect(readBrief({ goal: { text: "x", state: "confirmed" }, rules: { text: 3 } })).toEqual({
      goal: { text: "x", state: "confirmed" },
    });
    expect(readFitGap("nonsense")).toEqual({ rows: [], needsTrue: [], setup: [], decisions: [] });
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
    later: false,
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
    decisions: [],
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

  it("keep a row's place once set, and let the operator move it", () => {
    const before: FitGap = {
      ...stored,
      rows: stored.rows.map((r) => (r.id === "match" ? { ...r, later: true } : r)),
    };
    // The Builder's rewrite puts "match" back in the first version and a new row in later: the
    // stored row keeps its place, the new row takes the Builder's.
    const merged = mergeFitGap(before, {
      rows: [row("match", "native"), { ...row("split", "figure_out"), later: true }],
      needsTrue: [],
      setup: [],
    });
    expect(merged.rows.map((r) => [r.id, fitScope(r)])).toEqual([
      ["match", "later"],
      ["split", "later"],
      ["read", "main"],
      ["tiers", "out"],
    ]);
    const sent = { ...before, rows: before.rows.map((r) => withFitScope(r, "main")) };
    const out = operatorFitGap(before, sent);
    expect(out.ok && out.fitgap.rows.map(fitScope)).toEqual(["main", "main", "main", "main"]);
    expect(withFitScope(row("x", "build"), "later")).toMatchObject({ dropped: false, later: true });
    expect(withFitScope(row("x", "build"), "out")).toMatchObject({ dropped: true, later: false });
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
      operatorFitGap(stored, {
        rows: [row("new", "native")],
        needsTrue: [],
        setup: [],
        decisions: [],
      }),
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
      decisions: [],
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
    expect(
      mergeFitGap(before, { rows: [], needsTrue: [], setup: [], decisions: [] }).setup,
    ).toEqual(before.setup);
    // Saving marks what the operator changed as theirs.
    const saved = operatorFitGap(before, {
      ...before,
      setup: before.setup.map((f) => (f.id === "ap" ? { ...f, hint: "e.g. ap@client.com" } : f)),
    });
    expect(saved.ok && saved.fitgap.setup.map((f) => f.byOperator)).toEqual([true, true, false]);
  });
});

// Owner (2026-11-17): the client intake form holds only what the client gives us.
describe("the client intake form", () => {
  it("offers no pack to switch on, and drops one already stored without losing the rest", () => {
    expect(SETUP_KINDS).toEqual(["connect", "answer", "file"]);
    const stored = {
      rows: [
        { id: "r", need: "Read the bank feed", verdict: "configure", how: "Bookkeeping pack" },
      ],
      setup: [
        { id: "qbo", label: "Connect QuickBooks", kind: "connect", hint: "" },
        {
          id: "bk",
          label: "Switch on the Bookkeeping pack",
          kind: "pack",
          hint: "",
          byOperator: true,
        },
        { id: "who", label: "Who approves?", kind: "answer", hint: "" },
      ],
    };
    const read = readFitGap(stored);
    expect(read.rows.map((r) => r.id)).toEqual(["r"]);
    expect(read.setup.map((f) => f.id)).toEqual(["qbo", "who"]);
  });
});
