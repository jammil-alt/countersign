// Consistency QA (Agent Builder): the same concept computed twice in the platform's own code, fed
// the same input, must agree. Each test fails while its copies disagree (see
// findings-consist.md, CONS-*). Core and agents only: no database, no model.
import { searchCatalog, words } from "@countersign/agents";
import {
  type BuildDetail,
  buildIssues,
  type Decision,
  type FitGap,
  gateReasons,
  processes,
  type TypingContext,
  withDecisionRisk,
  writingStepIds,
} from "@countersign/core";
import { describe, expect, it } from "vitest";

const emptyFitgap = (decisions: Decision[] = []): FitGap => ({
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
  decisions,
});

/** A build's detail as `buildDetail` makes it, with its gate from core's `gateReasons`. */
function detailAt(opts: {
  phase: "poc" | "qa" | "client_test";
  openItems: number;
  problems: number;
}): BuildDetail {
  const fitgap = emptyFitgap();
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
  const next = opts.phase === "poc" ? "client_test" : opts.phase === "client_test" ? "qa" : null;
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

describe("CONS-1: an issue that 'holds the next move' and the gate that holds it", () => {
  it("an agent build in the POC test: open items hold nothing, as the gate says (owner, 2026-11-17)", () => {
    const d = detailAt({ phase: "poc", openItems: 2, problems: 0 });
    // The gate passes: open items no longer hold the POC test (core build.ts DECISION).
    expect(d.gate.reasons).toEqual([]);
    const blocking = buildIssues(d).filter((i) => i.blocking);
    // The Builder is told "holds the next move" (issueLine) and the screen sorts them first.
    expect(
      blocking.map((i) => i.key),
      "issues marked blocking while the gate holds nothing",
    ).toEqual([]);
  });

  it("an agent build in the client test: draft problems hold nothing the gate checks", () => {
    // A draft edited in the POC test (edit_draft) can carry a problem into later phases.
    const d = detailAt({ phase: "client_test", openItems: 0, problems: 1 });
    expect(d.gate.reasons).toEqual([]);
    const blocking = buildIssues(d).filter((i) => i.blocking);
    expect(
      blocking.map((i) => i.key),
      "issues marked blocking while the gate holds nothing",
    ).toEqual([]);
  });
});

describe("CONS-4: which steps write, for a decision's risk, vs the validator and executor", () => {
  // What `draftWritingSteps` (apps/api/src/build/store.ts) passes: the platform's tools and only
  // the built-in skills it finds; a client's custom skill (`custom:<slug>`) is not looked up.
  const typing: TypingContext = { tools: {}, skills: {} };
  const bundle = {
    workflows: [
      {
        slug: "main",
        name: "Pay bills",
        workflow: {
          schemaVersion: 4 as const,
          triggers: [{ id: "t", on: { type: "manual" as const, input: {} } }],
          steps: [
            {
              id: "post-bill",
              kind: "skill" as const,
              name: "Post the bill to QuickBooks",
              skill: "custom:post-bill",
              input: {},
            },
          ],
        },
      },
    ],
  };

  it("a skill step the registries don't know counts as writing in both", () => {
    const step = bundle.workflows[0]?.workflow.steps[0] as processes.Step;
    // Core's DECISION (process/validate.ts outputBeforeChecks): an unknown skill counts as
    // writing, the safe side; the executor reads its approval as a write's (readLike false).
    expect(processes.outputBeforeChecks(step, typing)).toBe(false);
    const writes = writingStepIds(bundle as never, typing);
    expect(
      [...writes],
      "writingStepIds leaves the unknown skill out: never less strict than the draft",
    ).toContain("post-bill");
  });

  it("so a decision on that step is high risk and holds the move into the client test", () => {
    const decision: Decision = {
      id: "post-without-check",
      what: "Bills over the PO go straight to QuickBooks",
      why: "",
      kind: "assumption",
      risk: "normal",
      stepId: "post-bill",
      status: "never_discussed",
      by: null,
      at: null,
    };
    const fitgap = {
      ...emptyFitgap(),
      decisions: withDecisionRisk([decision], writingStepIds(bundle as never, typing)),
    };
    const reasons = gateReasons({
      kind: "agent",
      phase: "poc",
      brief: {},
      fitgap,
      draft: true,
      draftErrors: 0,
      poc: { passed: true, detail: "" },
      trialDone: false,
      qaSigned: false,
      openItems: 0,
    });
    expect(fitgap.decisions[0]?.risk).toBe("high");
    expect(reasons).toContain("1 high-risk decision hasn't been looked at yet.");
  });
});

describe("CONS-5: the reuse check's words, singular and plural", () => {
  it.each([
    ["address", "addresses"],
    ["match", "matches"],
    ["tax", "taxes"],
    ["status", "statuses"],
    ["box", "boxes"],
  ])("%s and %s are one word", (one, many) => {
    expect(words(many), `words("${one}") = ${JSON.stringify(words(one))}`).toEqual(words(one));
  });

  it("a request in the plural finds the part described in the singular", () => {
    const index = [
      {
        partType: "tool" as const,
        partId: "vendor.address_lookup",
        name: "vendor.address_lookup",
        description: "Looks up a vendor's remit-to address",
        inputs: ["vendorId"],
        outputs: ["address"],
      },
    ];
    const score = (query: string, outputs: string[]) =>
      searchCatalog(index, { query, outputs })[0]?.score ?? 0;
    const singular = score("Look up a vendor remit-to address", ["address"]);
    const plural = score("Look up vendor remit-to addresses", ["addresses"]);
    expect(plural, `singular scores ${singular}`).toBe(singular);
  });
});
