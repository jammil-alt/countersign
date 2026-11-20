// An issue "holds the next move" only where the gate holds the move (BUILDER_QA CONS-1): the
// issues and `gateReasons` read the same facts.
import { describe, expect, it } from "vitest";
import type { BuildDetail } from "../api/build";
import { type FitGap, gateReasons } from "./build";
import { buildIssues } from "./issues";

const fitgap: FitGap = {
  rows: [
    {
      id: "read",
      need: "Read the invoice",
      verdict: "native",
      how: "Read document",
      dropped: false,
      later: false,
      override: null,
      challenge: null,
    },
  ],
  needsTrue: [],
  setup: [],
  decisions: [],
};

/** A build's detail as `buildDetail` makes it, with its gate from core's `gateReasons`. */
function detailAt(opts: {
  phase: "draft" | "poc" | "qa" | "client_test";
  openItems: number;
  problems: number;
}): BuildDetail {
  const items = Array.from({ length: opts.openItems }, (_, i) => ({
    id: `item-${i}`,
    phase: "draft" as const,
    kind: "question" as const,
    title: `Which tolerance applies? (${i})`,
    detail: "",
    owner: "operator" as const,
    state: "open" as const,
    stepId: null,
    ref: {},
    key: null,
    createdAt: "2026-11-19T00:00:00.000Z",
    resolvedAt: null,
  }));
  const problems = Array.from({ length: opts.problems }, (_, i) => ({
    key: `main|s${i}|input.amount|input_missing`,
    code: "input_missing",
    title: `input "amount" is required (${i})`,
    stepId: `s${i}`,
    workflow: "main",
  }));
  const reasons = gateReasons({
    kind: "agent",
    phase: opts.phase,
    brief: {},
    fitgap,
    draft: true,
    draftErrors: problems.length,
    poc: { passed: true, detail: "Every required case passes." },
    trialDone: true,
    qaSigned: true,
    openItems: opts.openItems,
  });
  const next =
    opts.phase === "draft"
      ? "poc"
      : opts.phase === "poc"
        ? "client_test"
        : opts.phase === "client_test"
          ? "qa"
          : null;
  return {
    build: { phase: opts.phase, fitgap },
    gate: { next, reasons },
    messages: [],
    items,
    draft: {
      agentId: "a",
      skillId: null,
      sessionId: null,
      versionId: "v",
      version: 3,
      live: false,
      problems,
    },
    poc: null,
    clientTest: null,
    qaChecks: [],
  } as unknown as BuildDetail;
}

const blocking = (d: BuildDetail) =>
  buildIssues(d)
    .filter((i) => i.blocking)
    .map((i) => i.key);

describe("issues that hold the next move", () => {
  it("an agent build in the POC test: open items hold nothing, as the gate says (owner, 2026-11-17)", () => {
    const d = detailAt({ phase: "poc", openItems: 2, problems: 0 });
    expect(d.gate.reasons).toEqual([]);
    expect(blocking(d), "issues marked blocking while the gate holds nothing").toEqual([]);
  });

  it("an agent build in the client test: draft problems hold nothing the gate checks", () => {
    // A draft edited in the POC test (edit_draft) can carry a problem into later phases.
    const d = detailAt({ phase: "client_test", openItems: 0, problems: 1 });
    expect(d.gate.reasons).toEqual([]);
    expect(blocking(d), "issues marked blocking while the gate holds nothing").toEqual([]);
  });

  it("holds where the gate holds: draft problems in the draft, open items in QA", () => {
    const draft = detailAt({ phase: "draft", openItems: 1, problems: 1 });
    expect(draft.gate.reasons).toHaveLength(1);
    expect(blocking(draft)).toEqual(["problem:main|s0|input.amount|input_missing"]);
    const qa = detailAt({ phase: "qa", openItems: 1, problems: 0 });
    expect(qa.gate.reasons).toHaveLength(1);
    expect(blocking(qa)).toEqual(["item:item-0"]);
  });
});
