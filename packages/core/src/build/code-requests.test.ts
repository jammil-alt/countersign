// The Dev queue's guards (docs/plan.md §1.125): what holds Triage → Accepted, which moves are open
// and why not, and the reasons a verdict or a decision must give.
import { describe, expect, it } from "vitest";
import type { BuildDetail } from "../api/build";
import {
  acceptReasons,
  CLAIM_LAPSE_MS,
  candidateProblem,
  claimLapsed,
  closeProblem,
  coveredBy,
  decisionProblems,
  dqNumber,
  duplicateOf,
  parseDqNumber,
  prProblem,
  type RequestFacts,
  type ReuseCandidate,
  requestMoves,
  specProblems,
  splitPartId,
} from "./code-requests";
import { buildIssues } from "./issues";

const NOW = new Date("2026-11-17T12:00:00Z");

const candidate = (over: Partial<ReuseCandidate> = {}): ReuseCandidate => ({
  partType: "operation",
  partId: "data.reshape#daysBetween",
  name: "Reshape data: daysBetween",
  score: 0.5,
  relevant: true,
  verdict: "reject",
  reason: "It counts days between two dates and gives one number.",
  missing: "No months or years, and no start or end of month: only days between two dates.",
  judgedBy: "model",
  number: null,
  open: null,
  ...over,
});

const ready = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  id: "r1",
  status: "triage",
  kind: "extend_existing",
  spec: {
    summary: "Run date minus N days, months or years, and start and end of month.",
    inputs: ["a date", "an offset in days, months or years"],
    outputs: ["a date"],
    rules: [],
    acceptance: ["31 January plus one month is 28 February"],
    parts: ["data.reshape#dateOffset"],
    packages: ["packages/core"],
  },
  openQuestions: [],
  reuseCheck: { ranAt: "2026-11-16T12:00:00Z", candidates: [candidate()], unjudged: false },
  decision: "extend",
  decisionReason: "Reshape data has the one-value operations; a date offset is one more of them.",
  otherUses: ["Weekly AR aging summary"],
  oneOffApprovedAt: null,
  claimedBy: null,
  claimedAt: null,
  lastEventAt: "2026-11-17T11:00:00Z",
  prUrl: null,
  expectedPartId: null,
  ...over,
});

describe("the request's number", () => {
  it("reads and writes DQ numbers", () => {
    expect(dqNumber(12)).toBe("DQ-012");
    expect(dqNumber(1234)).toBe("DQ-1234");
    expect(parseDqNumber("DQ-012")).toBe(12);
    expect(parseDqNumber("dq12")).toBe(12);
    expect(parseDqNumber("7")).toBe(7);
    expect(parseDqNumber("DQ-0")).toBeNull();
    expect(parseDqNumber("012e")).toBeNull();
  });
});

describe("verdicts and reasons", () => {
  it("wants a reject to name what the candidate lacks, not a word count of nothing", () => {
    expect(candidateProblem(candidate())).toBeNull();
    expect(candidateProblem(candidate({ missing: "Different." }))).toMatch(
      /doesn't say what it lacks/,
    );
    // Its own name, padded out, names nothing missing.
    expect(
      candidateProblem(
        candidate({
          name: "Reshape data daysBetween operation",
          missing: "reshape data: daysBetween operation",
        }),
      ),
    ).toMatch(/only repeats its name/);
    expect(candidateProblem(candidate({ verdict: null }))).toMatch(/no verdict/);
    expect(candidateProblem(candidate({ verdict: "use", reason: "Yes." }))).toMatch(
      /needs a reason/,
    );
    // One the judge found irrelevant needs nothing.
    expect(candidateProblem(candidate({ relevant: false, verdict: null }))).toBeNull();
  });

  it("finds what may already do it, and an open request for the same capability", () => {
    const check = {
      ranAt: NOW.toISOString(),
      unjudged: false,
      candidates: [
        candidate({ verdict: "use", partType: "request", partId: "q1", open: true, number: 3 }),
        candidate({ verdict: "use", partType: "tool", partId: "qbo.aging_report" }),
      ],
    };
    expect(duplicateOf(check)?.partId).toBe("q1");
    expect(duplicateOf(check, "q1")).toBeNull();
    expect(coveredBy(check)?.partId).toBe("qbo.aging_report");
  });
});

describe("the ladder and the spec", () => {
  it("asks each step down for a reason, new parts for other uses, one-offs for approval", () => {
    expect(decisionProblems(ready())).toEqual([]);
    expect(decisionProblems(ready({ decision: null }))[0]).toMatch(/no decision/);
    expect(decisionProblems(ready({ decisionReason: "Needed." }))[0]).toMatch(
      /why “Configure what exists” won't do/,
    );
    expect(decisionProblems(ready({ decision: "new_general", otherUses: [] })).join(" ")).toMatch(
      /at least one other use/,
    );
    expect(decisionProblems(ready({ decision: "one_off" })).join(" ")).toMatch(/your approval/);
    expect(
      decisionProblems(ready({ decision: "one_off", oneOffApprovedAt: NOW.toISOString() })),
    ).toEqual([]);
  });

  it("holds the spec to inputs, outputs, acceptance and one part", () => {
    expect(specProblems(ready().spec)).toEqual([]);
    const two = { ...ready().spec, parts: ["data.reshape#dateOffset", "data.group_list#sort"] };
    expect(specProblems(two).join(" ")).toMatch(/Split it/);
    const bare = { ...ready().spec, inputs: [], acceptance: [] };
    expect(specProblems(bare)).toEqual([
      "The spec has no inputs.",
      "The spec doesn't say how to check it's right.",
    ]);
  });
});

describe("Triage → Accepted", () => {
  it("goes when triage is done", () => {
    expect(acceptReasons(ready(), NOW)).toEqual([]);
  });

  it("refuses an unjudged candidate, a reason that names nothing, an unapproved one-off or two parts", () => {
    const unjudged = ready({
      reuseCheck: {
        ranAt: NOW.toISOString(),
        unjudged: true,
        candidates: [candidate({ verdict: null })],
      },
    });
    expect(acceptReasons(unjudged, NOW).join(" ")).toMatch(/haven't been judged/);
    const vague = ready({
      reuseCheck: {
        ranAt: NOW.toISOString(),
        unjudged: false,
        candidates: [candidate({ missing: "It's not the same thing." })],
      },
    });
    expect(acceptReasons(vague, NOW).join(" ")).toMatch(/doesn't say what it lacks/);
    expect(acceptReasons(ready({ decision: "one_off" }), NOW).join(" ")).toMatch(/approval/);
    const split = ready({ spec: { ...ready().spec, parts: ["a", "b"] } });
    expect(acceptReasons(split, NOW).join(" ")).toMatch(/Split it/);
  });

  it("wants the reuse check under 7 days old and the answer-first questions answered", () => {
    const old = ready({
      reuseCheck: { ranAt: "2026-11-01T00:00:00Z", unjudged: false, candidates: [candidate()] },
    });
    expect(acceptReasons(old, NOW).join(" ")).toMatch(/more than 7 days old/);
    expect(acceptReasons(ready({ reuseCheck: null }), NOW)[0]).toMatch(/hasn't run/);
    const asked = ready({
      openQuestions: [
        { question: "Does the aging report give Parent:Job?", answer: null, mode: "answer_first" },
        { question: "Which locale?", answer: null, mode: "investigate_during_build" },
      ],
    });
    expect(acceptReasons(asked, NOW).join(" ")).toMatch(/1 question must be answered first/);
  });

  it("closes exists and config instead of accepting them", () => {
    expect(acceptReasons(ready({ decision: "exists" }), NOW).join(" ")).toMatch(/close it/);
  });
});

describe("moves", () => {
  it("lets one session have a claim until it lapses", () => {
    const mine = ready({
      status: "in_progress",
      claimedBy: "u1",
      lastEventAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    expect(requestMoves(mine, NOW, { userId: "u2" }).claim).toEqual({
      allowed: false,
      reason: "Someone has it. A claim lapses 2 hours after its last event.",
    });
    expect(requestMoves(mine, NOW, { userId: "u1" }).attach_pr.allowed).toBe(true);
    expect(requestMoves(mine, NOW, { userId: "u2" }).attach_pr.allowed).toBe(false);
    const lapsed = { ...mine, lastEventAt: new Date(NOW.getTime() - CLAIM_LAPSE_MS).toISOString() };
    expect(claimLapsed(lapsed, NOW)).toBe(true);
    expect(requestMoves(lapsed, NOW, { userId: "u2" }).claim.allowed).toBe(true);
    expect(requestMoves(ready(), NOW, { userId: "u1" }).claim.reason).toMatch(/accepted/);
  });

  it("gives every disabled move its reason", () => {
    const moves = requestMoves(ready({ status: "closed" }), NOW, { userId: "u1" });
    for (const m of Object.values(moves)) {
      expect(m.allowed).toBe(false);
      expect(m.reason.length).toBeGreaterThan(5);
    }
  });

  it("checks a close and a PR", () => {
    expect(closeProblem({ id: "r1", status: "triage" }, "merged", null)).toMatch(/which request/);
    expect(closeProblem({ id: "r1", status: "triage" }, "merged", "r1")).toMatch(/itself/);
    expect(closeProblem({ id: "r1", status: "shipped" }, "exists", null)).toMatch(/already/);
    expect(closeProblem({ id: "r1", status: "accepted" }, "not_possible", null)).toBeNull();
    expect(prProblem("https://github.com/acme/app/pull/12", "data.reshape#dateOffset")).toBeNull();
    expect(prProblem("https://example.com/pull/12", "x")).toMatch(/GitHub pull request/);
    expect(splitPartId("data.reshape#dateOffset")).toEqual({
      base: "data.reshape",
      operation: "dateOffset",
    });
  });
});

describe("a build waiting on a request", () => {
  it("says so on its gap item and on the missing step's problem", () => {
    const detail = {
      build: { phase: "draft" },
      gate: { next: "poc" },
      messages: [],
      draft: {
        problems: [
          {
            key: "w:offset:missing",
            code: "missing_step",
            title: "A step is missing",
            stepId: "offset",
            workflow: "monthly",
            stepName: "Offset the run date",
            workflowName: "Monthly report",
          },
        ],
      },
      poc: null,
      qaChecks: [],
      clientTest: null,
      items: [
        {
          id: "i1",
          phase: "fitgap",
          kind: "gap",
          title: "Add date offsets to Reshape data",
          detail: "",
          owner: "engineering",
          state: "waiting",
          stepId: "offset",
          ref: { codeRequestId: "r1", codeRequestRef: "DQ-012" },
          key: null,
          createdAt: NOW.toISOString(),
          resolvedAt: null,
        },
      ],
    } as unknown as BuildDetail;
    const issues = buildIssues(detail);
    const problem = issues.find((i) => i.source === "problem");
    expect(problem?.detail).toBe("In “Offset the run date” of “Monthly report”. Waiting on DQ-012");
    expect(problem?.waitingOn).toEqual({ id: "r1", ref: "DQ-012" });
    const item = issues.find((i) => i.source === "item");
    expect(item?.state).toBe("Waiting on DQ-012");
  });
});
