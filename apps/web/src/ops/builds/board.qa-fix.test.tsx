// The Lab's Drafts board and a build's page say the same thing about what's open (CONS-2,
// BUILDER_QA.md). The page counts core's `buildIssues` as "open issues" (its open items, the
// draft's problems, failing tests, unreviewed high-risk decisions); the board knows only the
// stored open items (`BuildSummary.openItems`). It called those "open issues" too, and said
// "Nothing open" in green beside a page with three. The board now names what it counts, items, as
// the page names them, and makes no claim about the issues it can't see.
import { type BuildDetail, type BuildSummary, buildIssues } from "@countersign/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BuildsBoard } from "./BuildsBoard";
import { plural } from "./words";

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
    steps: [],
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

describe("the board's count of what's open, beside the build page's", () => {
  it("doesn't say nothing is open while the page has open issues", () => {
    // BuildView.tsx's header: plural(buildIssues(detail).filter((i) => i.open).length, "open issue").
    const onPage = plural(buildIssues(detail).filter((i) => i.open).length, "open issue");
    expect(onPage).toBe("3 open issues");
    render(
      <MemoryRouter>
        <BuildsBoard builds={[summary]} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId(`builds-card-${ID}`);
    expect(card.textContent, "the board's card").not.toMatch(/nothing open/i);
    // It doesn't count issues it can't see under the page's name for them.
    expect(card.textContent, "the board's card").not.toMatch(/open issue/i);
  });

  it("names its count as the page names it: open items", () => {
    render(
      <MemoryRouter>
        <BuildsBoard builds={[{ ...summary, openItems: 2 }]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId(`builds-card-${ID}`)).toHaveTextContent("2 open items");
  });
});
