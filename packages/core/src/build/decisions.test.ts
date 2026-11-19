import { describe, expect, it } from "vitest";
import type { BuildDetail } from "../api/build";
import type { ProcessAgentBundle } from "../schemas/agent";
import {
  clampDecisions,
  type Decision,
  DecisionAnswer,
  decisionRisk,
  type FitGap,
  type GateFacts,
  gateReasons,
  mergeDecisions,
  mergeFitGap,
  operatorFitGap,
  readFitGap,
  setDecisionStatus,
  withDecisionRisk,
} from "./build";
import { writingStepIds } from "./decisions";
import { buildIssues, issueByKey } from "./issues";

const dec = (id: string, over: Partial<Decision> = {}): Decision => ({
  id,
  what: `Decision ${id}`,
  why: "The brief says so.",
  kind: "assumption",
  risk: "normal",
  status: "never_discussed",
  by: null,
  at: null,
  ...over,
});

const empty: FitGap = { rows: [], needsTrue: [], setup: [], decisions: [] };

describe("decisions: the record", () => {
  it("are read row by row: a row that no longer reads doesn't lose the rest", () => {
    const fitgap = readFitGap({
      rows: [{ id: "a", need: "Read invoices", verdict: "native", how: "Read document" }],
      decisions: [
        { id: "freight", what: "Freight stays out of the catalog", kind: "assumption" },
        { id: "bad", what: "", kind: "nope" },
      ],
    });
    expect(fitgap.rows).toHaveLength(1);
    expect(fitgap.decisions).toEqual([
      {
        id: "freight",
        what: "Freight stays out of the catalog",
        why: "",
        kind: "assumption",
        risk: "normal",
        status: "never_discussed",
        by: null,
        at: null,
      },
    ]);
    // A stored fit-gap from before decisions reads with none.
    expect(readFitGap({ rows: [] }).decisions).toEqual([]);
    expect(readFitGap("nonsense").decisions).toEqual([]);
  });

  it("keep a wordy answer by cutting it to size", () => {
    const long = `${"It rests on the brief and the catalog. ".repeat(20)}End`;
    const answer = DecisionAnswer.parse({
      id: "a",
      what: long,
      why: long,
      kind: "client_setup",
      value: "2%",
    });
    const [d] = clampDecisions([answer]);
    expect(d?.what.length).toBeLessThanOrEqual(300);
    expect(d?.why.length).toBeLessThanOrEqual(500);
    expect(d?.value).toBe("2%");
    // The Builder can't set a status: it isn't in its answer.
    expect(
      "status" in
        DecisionAnswer.parse({ id: "b", what: "x", kind: "assumption", status: "confirmed" }),
    ).toBe(false);
  });
});

describe("decisions: merge", () => {
  it("adds new rows and never drops one an answer leaves out", () => {
    const out = mergeDecisions(
      [dec("a")],
      [{ id: "b", what: "New", why: "", kind: "decision_point", risk: "normal" }],
    );
    expect(out.map((d) => d.id)).toEqual(["a", "b"]);
    expect(out[1]?.status).toBe("never_discussed");
  });

  it("keeps the operator's status, and says changed when a looked-at row changes", () => {
    const before = [
      dec("a", { status: "confirmed", by: "Ada", at: "t1" }),
      dec("b", { status: "discussed", by: "Ada", at: "t2" }),
      dec("c"),
    ];
    const out = mergeDecisions(before, [
      // Only the reason changed: still confirmed.
      { id: "a", what: "Decision a", why: "A better reason.", kind: "assumption", risk: "normal" },
      // Its value changed after a look: changed, by whoever looked.
      {
        id: "b",
        what: "Decision b",
        why: "",
        value: "5%",
        kind: "assumption",
        risk: "normal",
      },
      { id: "c", what: "Decision c, reworded", why: "", kind: "assumption", risk: "normal" },
    ]);
    expect(out[0]).toMatchObject({ status: "confirmed", by: "Ada", why: "A better reason." });
    expect(out[1]).toMatchObject({ status: "changed", by: "Ada", at: "t2", value: "5%" });
    expect(out[2]).toMatchObject({ status: "never_discussed", what: "Decision c, reworded" });
  });

  it("never lowers a high risk", () => {
    const out = mergeDecisions(
      [dec("a", { risk: "high", category: "money" })],
      [{ id: "a", what: "Decision a", why: "", kind: "assumption", risk: "normal" }],
    );
    expect(out[0]).toMatchObject({ risk: "high", category: "money" });
  });

  it("go through the fit-gap's merge, and a save of the fit-gap leaves them as they are", () => {
    const before = { ...empty, decisions: [dec("a", { status: "confirmed", by: "Ada", at: "t" })] };
    const merged = mergeFitGap(before, {
      rows: [],
      needsTrue: [],
      setup: [],
      decisions: [{ id: "b", what: "B", why: "", kind: "assumption", risk: "high" }],
    });
    expect(merged.decisions.map((d) => [d.id, d.status])).toEqual([
      ["a", "confirmed"],
      ["b", "never_discussed"],
    ]);
    // An answer without decisions keeps them.
    expect(mergeFitGap(merged, { rows: [], needsTrue: [], setup: [] }).decisions).toHaveLength(2);
    const saved = operatorFitGap(merged, { ...merged, decisions: [] });
    expect(saved.ok && saved.fitgap.decisions).toEqual(merged.decisions);
  });

  it("the operator marks one discussed or confirmed, or back to never discussed", () => {
    const list = [dec("a"), dec("b")];
    const out = setDecisionStatus(list, "a", "confirmed", "Ada", "t");
    expect(out?.[0]).toMatchObject({ status: "confirmed", by: "Ada", at: "t" });
    expect(out?.[1]).toEqual(list[1]);
    expect(setDecisionStatus(out ?? [], "a", "never_discussed", "Ada", "t2")?.[0]).toMatchObject({
      status: "never_discussed",
      by: null,
      at: null,
    });
    expect(setDecisionStatus(list, "zzz", "discussed", "Ada", "t")).toBeNull();
  });
});

describe("decisions: risk by code", () => {
  it("is high for the Builder's high, a high-risk category, or a step that writes", () => {
    const writes = new Set(["post-bill"]);
    expect(decisionRisk(dec("a"), writes)).toBe("normal");
    expect(decisionRisk(dec("a", { risk: "high" }), writes)).toBe("high");
    expect(decisionRisk(dec("a", { category: "contact" }), writes)).toBe("high");
    expect(decisionRisk(dec("a", { stepId: "post-bill" }), writes)).toBe("high");
    expect(decisionRisk(dec("a", { stepId: "read-invoice" }), writes)).toBe("normal");
    const out = withDecisionRisk([dec("a"), dec("b", { stepId: "post-bill" })], writes);
    expect(out.map((d) => d.risk)).toEqual(["normal", "high"]);
  });

  it("finds the draft's steps that write to a client's tool or contact people", () => {
    const bundle = {
      workflows: [
        {
          workflow: {
            schemaVersion: 4,
            triggers: [],
            steps: [
              { id: "read-invoice", kind: "read", name: "Read", tool: "qbo.bill.list" },
              { id: "post-bill", kind: "write", name: "Post", tool: "qbo.bill.create" },
              { id: "save-note", kind: "write", name: "Note", tool: "platform.note" },
              { id: "ask-vendor", kind: "conversation", name: "Ask the vendor" },
              { id: "tell", kind: "notify", name: "Tell the team" },
            ],
          },
        },
      ],
    } as unknown as ProcessAgentBundle;
    const ids = writingStepIds(bundle, {
      tools: {
        "qbo.bill.list": { id: "qbo.bill.list", sideEffect: "none" },
        "qbo.bill.create": { id: "qbo.bill.create", sideEffect: "external" },
        "platform.note": { id: "platform.note", sideEffect: "internal" },
      } as never,
    });
    expect([...ids].sort()).toEqual(["ask-vendor", "post-bill"]);
  });
});

describe("decisions: the gate and the issues", () => {
  const base: GateFacts = {
    kind: "agent",
    phase: "poc",
    brief: {},
    fitgap: empty,
    draft: true,
    draftErrors: 0,
    poc: { passed: true, detail: "All pass." },
    trialDone: false,
    qaSigned: false,
    openItems: 0,
  };

  it("hold the move from the POC into the client test until high-risk ones are looked at", () => {
    const decisions = [
      dec("a", { risk: "high" }),
      dec("b", { risk: "high" }),
      dec("c"),
      dec("d", { risk: "high", status: "discussed" }),
    ];
    expect(gateReasons({ ...base, fitgap: { ...empty, decisions } })).toEqual([
      "2 high-risk decisions haven't been looked at yet.",
    ]);
    expect(gateReasons({ ...base, fitgap: { ...empty, decisions: decisions.slice(1) } })).toEqual([
      "1 high-risk decision hasn't been looked at yet.",
    ]);
    // Normal ones never hold a phase.
    expect(gateReasons({ ...base, fitgap: { ...empty, decisions: [dec("c")] } })).toEqual([]);
    // Only the POC's move waits on them.
    expect(gateReasons({ ...base, phase: "draft", fitgap: { ...empty, decisions } })).toEqual([]);
  });

  const detail = (decisions: Decision[], phase: BuildDetail["build"]["phase"] = "poc") =>
    ({
      build: { phase, kind: "agent", fitgap: { ...empty, decisions } },
      gate: { next: null, reasons: [] },
      messages: [{ about: "decision:c" }, { about: "decision:a" }],
      items: [],
      draft: null,
      poc: null,
      clientTest: null,
      qaChecks: [],
    }) as unknown as BuildDetail;

  it("list unreviewed high-risk decisions as issues, and find any decision by its key", () => {
    const d = detail([
      dec("a", { risk: "high", value: "$5,000" }),
      dec("b", { risk: "high", status: "confirmed" }),
      dec("c"),
    ]);
    const issues = buildIssues(d);
    expect(issues.map((i) => i.key)).toEqual(["decision:a"]);
    expect(issues[0]).toMatchObject({
      source: "decision",
      title: "Decision a",
      open: true,
      blocking: true,
      state: "Never discussed",
      talk: 1,
    });
    expect(issues[0]?.detail).toContain("Starts at $5,000");
    // A normal one isn't an issue, but the conversation can still be on it.
    expect(issueByKey(d, "decision:c")).toMatchObject({ open: false, talk: 1 });
    expect(issueByKey(d, "decision:b")).toMatchObject({ open: false, state: "Confirmed" });
    expect(issueByKey(d, "decision:zzz")).toBeNull();
    // Outside the POC it is open but holds nothing.
    expect(buildIssues(detail([dec("a", { risk: "high" })], "draft"))[0]?.blocking).toBe(false);
  });
});
