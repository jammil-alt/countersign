// The build page keeps the operator's work and says why a button is off (BUILDER_QA.md, the flow
// lens of 2026-11-19: FLOW-1, FLOW-2, FLOW-3 and FLOW-10). Since 2026-11-27 a build goes from its
// draft straight to Publish, and the bar says why Publish is off.
import type { BuildDetail, BuildSummary } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { aboutStart, busyPath, mergeRecord } from "./BuildView";

await import("../OpsApp");

const ID = "00000000-0000-4000-8000-0000000b0001";
const at = "2026-11-15T10:00:00.000Z";

const summary: BuildSummary = {
  id: ID,
  kind: "agent",
  title: "Invoice intake reviewer",
  client: null,
  phase: "intake",
  status: "open",
  agentId: null,
  skillId: null,
  testAgentId: null,
  testClient: null,
  openItems: 0,
  waitingOnClient: 0,
  createdBy: "Ann",
  createdAt: at,
  updatedAt: at,
  phaseAt: at,
  path: "new",
  flow: "phases",
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

type Message = BuildDetail["messages"][number];

function intake(messages: Message[] = []): BuildDetail {
  return {
    build: {
      ...summary,
      brief: {
        goal: { text: "Check invoices against contracts", state: "confirmed" },
        trigger: { text: "An invoice is forwarded", state: "confirmed" },
        dataIn: { text: "Invoice PDFs", state: "confirmed" },
        dataOut: { text: "Review notes", state: "confirmed" },
      },
      fitgap: { rows: [], needsTrue: [], setup: [], decisions: [] },
      testPlan: { datasets: [] },
      qa: { accepted: {}, signedBy: null, signedAt: null, decision: null },
    },
    phases: [
      { phase: "intake", label: "Intake", state: "current" },
      { phase: "fitgap", label: "Fit-gap", state: "todo" },
      { phase: "draft", label: "Draft", state: "todo" },
    ],
    gate: { next: "fitgap", reasons: [] },
    messages,
    items: [],
    draft: null,
    poc: null,
    clientTest: null,
    qaChecks: [],
    events: [],
  };
}

/** A build in its draft (or stored in an older phase, which the page reads as its draft). */
function inDraft(reasons: string[], phase: BuildDetail["build"]["phase"] = "draft"): BuildDetail {
  const base = intake();
  return {
    ...base,
    build: { ...base.build, phase, agentId: "00000000-0000-4000-8000-00000000d001" },
    phases: base.phases.map((p) => ({
      ...p,
      state: p.phase === "draft" ? ("current" as const) : ("done" as const),
    })),
    gate: { next: null, reasons },
    draft: {
      agentId: "00000000-0000-4000-8000-00000000d001",
      skillId: null,
      sessionId: null,
      versionId: "00000000-0000-4000-8000-00000000d002",
      version: 2,
      live: false,
      steps: [],
      problems: [],
    },
  };
}

const said = (id: string, role: "operator" | "builder", text: string): Message => ({
  id,
  phase: "intake",
  role,
  text,
  chips: [],
  changes: [],
  createdAt: at,
});

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/clients": () => ({ clients: [] }),
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
};

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("the build page keeps the operator's work", () => {
  // FLOW-1: IntakePanel resets its local brief from `detail.build.brief` on every new reference,
  // and every action (a chat turn, an item's state) answers with a new BuildDetail object.
  it("keeps an unsaved brief edit when the operator sends a message to the Builder", async () => {
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => intake(),
      // The Builder answers without touching the brief: the brief is equal, a new object.
      [`POST /api/ops/builds/${ID}/turns`]: () =>
        intake([
          said("m1", "operator", "Is the goal clear?"),
          said("m2", "builder", "Yes. Anything else?"),
        ]),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    const goal = within(view).getByTestId("build-brief-goal");
    await userEvent.type(goal, " every Monday for Harbor");
    expect(goal).toHaveValue("Check invoices against contracts every Monday for Harbor");

    await userEvent.type(within(view).getByTestId("build-input"), "Is the goal clear?");
    await userEvent.click(within(view).getByTestId("build-send"));
    expect(await within(view).findByText("Yes. Anything else?")).toBeInTheDocument();

    // Expected: what the operator typed in the brief (not yet saved) is still there.
    expect(within(view).getByTestId("build-brief-goal")).toHaveValue(
      "Check invoices against contracts every Monday for Harbor",
    );
  });

  // FLOW-2: the composer stays open while a phase move runs (it is off only while a chat turn
  // runs), and the turn's `finally` sets `busy` to null though the move is still on its way.
  it("keeps Confirm off while its move runs, even after a chat turn sent meanwhile returns", async () => {
    const moves: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => intake(),
      // The second look at the brief and the fit-gap take a minute or more.
      [`POST /api/ops/builds/${ID}/phase`]: ({ init }) => {
        moves.push(JSON.parse(String(init.body)));
        return new Promise(() => {});
      },
      [`POST /api/ops/builds/${ID}/turns`]: () =>
        intake([
          said("m1", "operator", "While you work: volume is 40 a week."),
          said("m2", "builder", "Noted."),
        ]),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    await userEvent.click(within(view).getByTestId("build-confirm-brief"));
    await waitFor(() => expect(moves).toHaveLength(1));
    expect(within(view).getByTestId("build-confirm-brief")).toBeDisabled();

    // The operator adds a line while waiting: the box lets them send it.
    await userEvent.type(
      within(view).getByTestId("build-input"),
      "While you work: volume is 40 a week.",
    );
    await userEvent.click(within(view).getByTestId("build-send"));
    expect(await within(view).findByText("Noted.")).toBeInTheDocument();

    // Expected: the move hasn't answered, so Confirm is still off (no second move).
    expect(within(view).getByTestId("build-confirm-brief")).toBeDisabled();
  });

  // FLOW-3, for the draft's Publish (owner, 2026-11-27): it is off while the gate holds, and the
  // reason is said beside it, not only in a tooltip.
  it("says why Publish is off on the draft's bar", async () => {
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => inDraft(["The draft has 2 problems to fix."]),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    const bar = within(view).getByTestId("build-publish-bar");
    expect(within(bar).getByTestId("build-publish-bar-publish")).toBeDisabled();
    expect(within(bar).getByTestId("build-publish-bar-state")).toHaveTextContent(
      "Draft · The draft has 2 problems to fix.",
    );
    // No move to a POC test anywhere on the page.
    expect(within(view).queryByText(/POC test/)).toBeNull();
  });

  // FLOW-10: an open question's "Answer it" (and a try's "Wrong", PocPanel onAbout) calls
  // `setDraftText(\`About “${title}”: \`)` (BuildView.tsx:555, :582), replacing what the operator
  // had already typed in the conversation's box with no way to get it back.
  it("keeps the words already in the box when an issue's Answer it is pressed", async () => {
    const ITEM = "00000000-0000-4000-8000-0000000b0101";
    const withQuestion: BuildDetail = {
      ...intake(),
      items: [
        {
          id: ITEM,
          phase: "intake",
          kind: "question",
          title: "How many invoices a week",
          detail: "",
          owner: "operator",
          state: "open",
          stepId: null,
          ref: {},
          key: "brief:volume",
          createdAt: at,
          resolvedAt: null,
        },
      ],
    };
    const api = fakeApi({ ...common, [`GET /api/ops/builds/${ID}`]: () => withQuestion });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    const box = within(view).getByTestId("build-input");
    await userEvent.type(box, "The approver is Dana in accounts payable, and");
    await userEvent.click(within(view).getByTestId(`build-item-${ITEM}-answer`));
    // Expected: what was typed is still in the box. Owner (2026-11-21): the answer has its own
    // box under the question, so the conversation's box is left as it was.
    expect(within(view).getByTestId(`build-item-${ITEM}-answer-box`)).toBeInTheDocument();
    expect(within(view).getByTestId("build-input")).toHaveValue(
      "The approver is Dana in accounts payable, and",
    );
    // A try's "Wrong" still starts the conversation's box: a second start swaps, the words stay.
    expect(aboutStart("Who approves", "About “How many invoices a week”: Dana, and")).toBe(
      "About “Who approves”: Dana, and",
    );
  });

  // FLOW-1: an issue added while the brief has unsaved words, and the Builder filling another
  // field of the brief: the operator's words stay, and the Builder's field comes in beside them.
  it("keeps an unsaved brief edit through a new issue, and merges what the Builder changed", async () => {
    const ITEM = "00000000-0000-4000-8000-0000000b0102";
    const base = intake();
    const filled: BuildDetail = {
      ...base,
      build: {
        ...base.build,
        brief: {
          ...base.build.brief,
          dataOut: { text: "Review notes in QuickBooks", state: "assumed" },
        },
      },
      items: [
        {
          id: ITEM,
          phase: "intake",
          kind: "note",
          title: "Ask about weekends",
          detail: "",
          owner: "operator",
          state: "open",
          stepId: null,
          ref: {},
          key: null,
          createdAt: at,
          resolvedAt: null,
        },
      ],
    };
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => intake(),
      [`POST /api/ops/builds/${ID}/items`]: () => filled,
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    await userEvent.type(within(view).getByTestId("build-brief-goal"), " every Monday");
    await userEvent.type(within(view).getByTestId("build-item-new"), "Ask about weekends");
    await userEvent.click(within(view).getByTestId("build-item-add"));
    expect(await within(view).findByText("Ask about weekends")).toBeInTheDocument();

    expect(within(view).getByTestId("build-brief-goal")).toHaveValue(
      "Check invoices against contracts every Monday",
    );
    expect(within(view).getByTestId("build-brief-dataOut")).toHaveValue(
      "Review notes in QuickBooks",
    );
    // Still unsaved: the save offers itself.
    expect(within(view).getByTestId("build-brief-save")).toBeInTheDocument();
  });

  // FLOW-2: a proposal's Agree stays off until its own request answers, though a chat turn sent
  // meanwhile answered first.
  it("keeps a proposal's Agree off while it runs, even after a chat turn sent meanwhile returns", async () => {
    const PROPOSAL = "00000000-0000-4000-8000-0000000b0201";
    const proposed: Message = {
      ...said(PROPOSAL, "builder", "I'd draft the skill now."),
      proposal: {
        summary: "Draft the skill",
        action: { do: "close_item", itemId: "00000000-0000-4000-8000-0000000b0101", state: "done" },
        state: "proposed",
      } as NonNullable<Message["proposal"]>,
    };
    const decided: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => intake([proposed]),
      [`POST /api/ops/builds/${ID}/messages/${PROPOSAL}/proposal`]: ({ init }) => {
        decided.push(JSON.parse(String(init.body)));
        return new Promise(() => {});
      },
      [`POST /api/ops/builds/${ID}/turns`]: () =>
        intake([
          proposed,
          said("m1", "operator", "And weekends?"),
          said("m2", "builder", "Noted."),
        ]),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    await userEvent.click(within(view).getByTestId("build-proposal-agree"));
    await waitFor(() => expect(decided).toHaveLength(1));
    await userEvent.type(within(view).getByTestId("build-input"), "And weekends?");
    await userEvent.click(within(view).getByTestId("build-send"));
    expect(await within(view).findByText("Noted.")).toBeInTheDocument();
    expect(within(view).getByTestId("build-proposal-agree")).toBeDisabled();
  });

  // Owner (2026-11-27): from the draft straight to Publish, one press, and the build is live.
  it("publishes the draft from its bar, and says the build is done", async () => {
    const draft = inDraft([]);
    const live: BuildDetail = {
      ...draft,
      build: { ...draft.build, status: "live" },
      phases: draft.phases.map((p) => ({ ...p, state: "done" as const })),
      gate: { next: null, reasons: [] },
    };
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => draft,
      [`POST /api/ops/builds/${ID}/publish`]: () => live,
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    expect(within(view).getByTestId("build-publish-bar-state")).toHaveTextContent(
      "Draft · Ready to publish",
    );
    await userEvent.click(within(view).getByTestId("build-publish-bar-publish"));
    expect(await within(view).findByTestId("build-closed")).toHaveTextContent(
      "This build is done: the agent is live.",
    );
    expect(api.calls).toContain(`POST /api/ops/builds/${ID}/publish`);
    expect(within(view).queryByTestId("build-publish-bar")).toBeNull();
  });

  // A build made before in QA reads as its draft (the API says so): no QA panel, the same bar.
  it("shows a build stored in QA as its draft, with no QA panel", async () => {
    const api = fakeApi({ ...common, [`GET /api/ops/builds/${ID}`]: () => inDraft([], "qa") });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    expect(within(view).getByTestId("build-publish-bar")).toBeInTheDocument();
    expect(within(view).getByTestId("build-draft")).toBeInTheDocument();
    expect(within(view).queryByTestId("build-decision")).toBeNull();
    expect(within(view).queryByTestId("build-go")).toBeNull();
  });
});

describe("the build page's helpers", () => {
  it("merges a record by key: the operator's changes stay, the server's others come in", () => {
    const base = { a: 1, b: 1, c: 1 };
    const mine = { a: 2, b: 1, c: 1 };
    const theirs = { a: 1, b: 3, c: 1, d: 4 };
    expect(mergeRecord(base, mine, theirs)).toEqual({ a: 2, b: 3, c: 1, d: 4 });
    // Both changed one key: the server's (the panel's own save, tidied, or the newer answer).
    expect(mergeRecord(base, mine, { ...theirs, a: 5 })).toEqual({ a: 5, b: 3, c: 1, d: 4 });
  });

  it("is busy with a move while one runs, whatever answers first", () => {
    const move = "/api/ops/builds/:id/phase";
    const turn = "/api/ops/builds/:id/turns";
    expect(busyPath([move, turn])).toBe(move);
    expect(busyPath([turn])).toBe(turn);
    expect(busyPath([])).toBeNull();
  });
});
