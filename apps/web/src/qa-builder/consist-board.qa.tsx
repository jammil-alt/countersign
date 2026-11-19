// Consistency QA (Agent Builder): a build's "open issue" count on the Lab's Drafts board vs on the
// build's own page. The page counts core's `buildIssues` (BuildView.tsx: "QA (2026-11-17): one
// name and one count, the Issues panel's"); the board counts only stored open items
// (BuildsBoard.tsx, `BuildSummary.openItems`). Fails while they disagree (findings-consist.md,
// CONS-2).
import { type BuildDetail, type BuildSummary, buildIssues } from "@countersign/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BuildsBoard } from "../ops/builds/BuildsBoard";
import { plural } from "../ops/builds/words";

const at = "2026-11-19T10:00:00.000Z";
const ID = "00000000-0000-4000-8000-0000000c0001";

const summary: BuildSummary = {
  id: ID,
  kind: "agent",
  title: "Vendor bill entry",
  client: { id: "00000000-0000-4000-8000-00000000a001", name: "Harbor Millwork" },
  phase: "draft",
  status: "open",
  agentId: "00000000-0000-4000-8000-0000000a0001",
  skillId: null,
  testAgentId: null,
  testClient: null,
  // No stored open item: the brief and fit-gap left none.
  openItems: 0,
  waitingOnClient: 0,
  createdBy: "Ann",
  createdAt: at,
  updatedAt: at,
  phaseAt: at,
  path: "new",
  templateId: null,
  promisedOn: null,
  origin: null,
  requirements: null,
  pipelineStage: "building",
  standing: "you",
  waitingOn: "operator",
  statusLine: "",
  stuck: false,
};

/** The same build as its page reads it: a draft with two missing steps and a high-risk decision. */
const detail: BuildDetail = {
  build: {
    ...summary,
    brief: {},
    fitgap: {
      rows: [],
      needsTrue: [],
      setup: [],
      decisions: [
        {
          id: "post-direct",
          what: "Bills post to QuickBooks without a second look",
          why: "",
          kind: "assumption",
          risk: "high",
          category: "writes",
          status: "never_discussed",
          by: null,
          at: null,
        },
      ],
    },
    testPlan: { datasets: [] },
    qa: { accepted: {}, signedBy: null, signedAt: null, decision: null },
  },
  phases: [],
  gate: { next: "poc", reasons: ["The draft has 2 problems to fix."] },
  messages: [],
  items: [],
  draft: {
    agentId: summary.agentId,
    skillId: null,
    sessionId: null,
    versionId: "00000000-0000-4000-8000-0000000a0101",
    version: 1,
    live: false,
    problems: [
      {
        key: "main|match||missing_step",
        code: "missing_step",
        title: '"Match to PO" is missing: three-way match',
        stepId: "match",
        workflow: "main",
      },
      {
        key: "main|post||missing_step",
        code: "missing_step",
        title: '"Post bill" is missing: post a bill with lines',
        stepId: "post",
        workflow: "main",
      },
    ],
  },
  poc: null,
  clientTest: null,
  qaChecks: [],
  events: [],
};

describe("CONS-2: the board's open-issue count vs the build page's", () => {
  it("the board says what the build's page says", () => {
    // BuildView.tsx's header: plural(buildIssues(detail).filter((i) => i.open).length, "open issue").
    const onPage = plural(buildIssues(detail).filter((i) => i.open).length, "open issue");
    expect(onPage).toBe("3 open issues");
    render(
      <MemoryRouter>
        <BuildsBoard builds={[summary]} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId(`builds-card-${ID}`);
    expect(card.textContent, "the board's card").toContain(onPage);
  });
});
