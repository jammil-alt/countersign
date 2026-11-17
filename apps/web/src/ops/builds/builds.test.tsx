// Builds in the back office (docs/plan.md §1.108): the board by phase with New build, and a build:
// its stepper, the conversation (chips answer, the words leave the box at once), the brief with the
// gate's reasons on Confirm, a done phase looked at again and gone back to with a reason, and open
// items whose state changes.
import type { BuildDetail } from "@countersign/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

// The back office's code loads on demand; the first test in a file would wait for it inside
// Testing Library's 5 s, which a busy CI runner can pass (2026-11-17). Loaded once, up front.
await import("../OpsApp");

const ID = "00000000-0000-4000-8000-0000000b0001";
const ITEM = "00000000-0000-4000-8000-0000000b0101";
const at = "2026-11-15T10:00:00.000Z";

const summary = {
  id: ID,
  kind: "agent" as const,
  title: "Invoice intake reviewer",
  client: null,
  phase: "fitgap" as const,
  status: "open" as const,
  agentId: null,
  skillId: null,
  testAgentId: null,
  testClient: null,
  openItems: 1,
  waitingOnClient: 0,
  createdBy: "Ann",
  createdAt: at,
  updatedAt: at,
  phaseAt: at,
};

function detail(over: Partial<BuildDetail> = {}): BuildDetail {
  return {
    build: {
      ...summary,
      brief: {
        goal: { text: "Check invoices against contracts", state: "confirmed" },
        trigger: { text: "An invoice is forwarded", state: "confirmed" },
        dataIn: { text: "Invoice PDFs", state: "confirmed" },
        dataOut: { text: "Review notes", state: "confirmed" },
      },
      fitgap: {
        rows: [
          {
            id: "read",
            need: "Read invoice PDFs",
            verdict: "native",
            how: "Read the invoice",
            dropped: false,
          },
          {
            id: "pay",
            need: "Pay the vendor",
            verdict: "not_possible",
            how: "Agents never move money",
            dropped: false,
          },
        ],
        needsTrue: [{ id: "qbo", text: "The client connects QuickBooks", done: false }],
        setup: [],
      },
      testPlan: { datasets: [] },
      qa: { accepted: {}, signedBy: null, signedAt: null, decision: null },
    },
    phases: [
      { phase: "intake", label: "Intake", state: "done" },
      { phase: "fitgap", label: "Fit-gap", state: "current" },
      { phase: "draft", label: "Draft", state: "todo" },
      { phase: "poc", label: "POC test", state: "todo" },
      { phase: "client_test", label: "Client test", state: "todo" },
      { phase: "qa", label: "QA and go / no-go", state: "todo" },
    ],
    gate: { next: "draft", reasons: [] },
    messages: [
      {
        id: "m1",
        phase: "intake",
        role: "operator",
        text: "Review invoices against contracts.",
        chips: [],
        changes: [],
        createdAt: at,
      },
      {
        id: "m2",
        phase: "fitgap",
        role: "builder",
        text: "**One** we do as is, one we can't. Drop anything?",
        chips: ["Looks right", "Drop one"],
        changes: ["Fit-gap: 2 rows"],
        createdAt: at,
      },
    ],
    items: [
      {
        id: ITEM,
        phase: "intake",
        kind: "question",
        title: "How many: still open",
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
    draft: null,
    poc: null,
    clientTest: null,
    qaChecks: [],
    events: [],
    ...over,
  };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/clients": () => ({
    clients: [
      {
        id: "00000000-0000-4000-8000-00000000a001",
        name: "Harbor Millwork",
        timezone: "UTC",
        createdAt: at,
        agents: 0,
        openInbox: 0,
      },
    ],
  }),
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
};

describe("Builds", () => {
  it("shows the board by phase and starts a build", async () => {
    const started: unknown[] = [];
    const api = fakeApi({
      ...common,
      "GET /api/ops/builds": () => ({
        builds: [summary],
        items: [{ ...detail().items[0], buildId: ID, buildTitle: summary.title }],
      }),
      "POST /api/ops/builds": ({ init }) => {
        started.push(JSON.parse(String(init.body)));
        return detail();
      },
      [`GET /api/ops/builds/${ID}`]: () => detail(),
    });
    renderAt("/ops/builds", api);
    const board = await screen.findByTestId("builds-board");
    const fit = within(board).getByRole("region", { name: "Fit-gap" });
    expect(within(fit).getByTestId(`builds-card-${ID}`)).toHaveTextContent(
      "Invoice intake reviewer",
    );
    expect(within(fit).getByTestId(`builds-card-${ID}`)).toHaveTextContent("1 open issue");
    expect(screen.getByTestId("builds-items")).toHaveTextContent("How many: still open");
    // Who has each item, in words; gold says it waits on you.
    const row = screen.getByTestId(`builds-item-${ITEM}`);
    expect(row).toHaveTextContent("You");
    expect(row).toHaveTextContent("Waiting on you");

    await userEvent.click(screen.getByTestId("builds-new"));
    await userEvent.type(screen.getByTestId("builds-start-title"), "Invoice intake reviewer");
    await screen.findByRole("option", { name: "Harbor Millwork only" });
    await userEvent.selectOptions(
      screen.getByTestId("builds-start-client"),
      "00000000-0000-4000-8000-00000000a001",
    );
    await userEvent.click(screen.getByTestId("builds-start-go"));
    await waitFor(() =>
      expect(started).toEqual([
        {
          kind: "agent",
          title: "Invoice intake reviewer",
          clientId: "00000000-0000-4000-8000-00000000a001",
        },
      ]),
    );
    expect(await screen.findByTestId("build-view")).toBeInTheDocument();
  });

  it("shows a build: its phases, the conversation, the fit-gap and its items", async () => {
    const turns: unknown[] = [];
    const moves: unknown[] = [];
    const updates: unknown[] = [];
    let answer: (v: unknown) => void = () => {};
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => detail(),
      [`POST /api/ops/builds/${ID}/turns`]: ({ init }) => {
        turns.push(JSON.parse(String(init.body)));
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      [`POST /api/ops/builds/${ID}/phase`]: ({ init }) => {
        moves.push(JSON.parse(String(init.body)));
        return detail();
      },
      [`PATCH /api/ops/builds/${ID}/items/${ITEM}`]: ({ init }) => {
        updates.push(JSON.parse(String(init.body)));
        return detail({
          items: [
            { ...detail().items[0], state: "done", resolvedAt: at } as BuildDetail["items"][number],
          ],
        });
      },
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    expect(within(view).getByTestId("build-header")).toHaveTextContent("Building · Fit-gap");
    expect(within(view).getByTestId("build-phase-fitgap")).toHaveAttribute("aria-current", "step");

    // The Builder's words read as a chat reply; a chip answers.
    const said = within(view).getAllByTestId("build-builder-message")[0];
    expect(said).not.toHaveTextContent("**");
    expect(said).toHaveTextContent("Fit-gap: 2 rows");
    await userEvent.click(within(view).getByRole("button", { name: "Looks right" }));
    expect(turns).toEqual([{ text: "Looks right" }]);
    expect(await within(view).findByTestId("build-thinking")).toBeInTheDocument();
    answer(
      detail({
        messages: [
          ...detail().messages,
          {
            id: "m3",
            phase: "fitgap",
            role: "builder",
            text: "Good. Agree it when you're ready.",
            chips: [],
            changes: [],
            createdAt: at,
          },
        ],
      }),
    );
    expect(await within(view).findByText("Good. Agree it when you're ready.")).toBeInTheDocument();

    // The fit-gap: verdicts and what must be true; agreeing drafts it.
    const fit = within(view).getByTestId("build-fitgap");
    expect(within(fit).getByTestId("build-fit-pay")).toHaveTextContent("Pay the vendor");
    await userEvent.click(within(view).getByTestId("build-agree"));
    await waitFor(() => expect(moves).toEqual([{ to: "draft" }]));

    // A done phase can be looked at again; going back needs a reason.
    await userEvent.click(within(view).getByTestId("build-phase-intake"));
    expect(within(view).getByTestId("build-brief")).toHaveTextContent(
      "Check invoices against contracts",
    );
    const back = within(view).getByTestId("build-go-back");
    const goBack = within(back).getByRole("button", { name: "Go back to this phase" });
    expect(goBack).toBeDisabled();
    await userEvent.type(within(back).getByRole("textbox"), "The brief missed a field");
    await userEvent.click(goBack);
    await waitFor(() =>
      expect(moves.at(-1)).toEqual({ to: "intake", reason: "The brief missed a field" }),
    );

    // Feedback (2026-11-16): an open item says what it is, what settles it, and who has it; a
    // question's Answer starts the reply in the conversation's box.
    const items = within(view).getByTestId("build-items");
    expect(within(items).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(within(items).getByRole("columnheader", { name: "Who has it" })).toBeInTheDocument();
    expect(within(view).getByTestId(`build-item-${ITEM}-kind`)).toHaveTextContent("Question");
    expect(within(view).getByTestId(`build-item-${ITEM}-how`)).toHaveTextContent(
      "To settle it: Answer it to the Builder in the conversation",
    );
    await userEvent.click(within(view).getByTestId(`build-item-${ITEM}-answer`));
    expect(within(view).getByTestId("build-input")).toHaveValue("About “How many: still open”: ");
    expect(within(view).getByTestId("build-input")).toHaveFocus();

    // An open item's status changes in place.
    await userEvent.selectOptions(within(view).getByTestId(`build-item-${ITEM}-state`), "Done");
    await waitFor(() => expect(updates).toEqual([{ state: "done" }]));
  });

  it("shows the Builder at work beside a move, and keeps the column width you drag to", async () => {
    let answer: (v: unknown) => void = () => {};
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => detail(),
      [`POST /api/ops/builds/${ID}/phase`]: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");

    // Feedback (2026-11-16): agreeing the fit-gap takes a while; the loop and its words show it.
    expect(within(view).queryByTestId("build-agree-working")).toBeNull();
    await userEvent.click(within(view).getByTestId("build-agree"));
    expect(within(view).getByTestId("build-agree")).toHaveTextContent("Working…");
    expect(await within(view).findByTestId("build-agree-working")).toHaveTextContent(
      "The Builder is drafting the workflow from the brief and the fit-gap…",
    );
    answer(detail());
    await waitFor(() => expect(within(view).queryByTestId("build-agree-working")).toBeNull());

    // The line between the columns moves with the arrows, within bounds, and is kept.
    const split = within(view).getByTestId("build-split");
    expect(split).toHaveAttribute("aria-valuenow", "420");
    split.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(split).toHaveAttribute("aria-valuenow", "468");
    expect(localStorage.getItem("mezonas.build.chatWidth")).toBe("468");
    for (let i = 0; i < 10; i++) await userEvent.keyboard("{ArrowLeft}");
    expect(split).toHaveAttribute("aria-valuenow", "320");
    localStorage.removeItem("mezonas.build.chatWidth");
  });

  // QA on staging (2026-11-16): the fit-gap failed and the screen showed the raw error, lost the
  // words sent, offered no retry, and ran the move's "drafting the workflow" loop during a chat turn.
  it("says a failed turn in the conversation, retries it, and keeps a failed send's words", async () => {
    const failed = detail({
      build: { ...detail().build, fitgap: { rows: [], needsTrue: [], setup: [] } },
      messages: [
        detail().messages[0] as BuildDetail["messages"][number],
        {
          id: "m2",
          phase: "fitgap",
          role: "builder",
          text: "My answer came back in a form I couldn't save. The fit-gap isn't written yet. Press Retry; we've logged it.",
          chips: [],
          changes: [],
          failed: true,
          createdAt: at,
        },
      ],
    });
    const turns: unknown[] = [];
    let answer: (v: unknown) => void = () => {};
    let current = failed;
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => current,
      [`POST /api/ops/builds/${ID}/turns`]: ({ init }) => {
        turns.push(JSON.parse(String(init.body)));
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    expect(within(view).getByTestId("build-fitgap-empty")).toHaveTextContent(
      "The Builder's fit-gap didn't come through",
    );

    // Retry sends no words; the Builder's loop runs in the chat, not beside the move's button.
    await userEvent.click(within(view).getByTestId("build-retry"));
    expect(turns).toEqual([{}]);
    expect(await within(view).findByTestId("build-thinking")).toBeInTheDocument();
    expect(within(view).getByTestId("build-agree")).not.toHaveTextContent("Working…");
    expect(within(view).queryByTestId("build-agree-working")).toBeNull();
    answer(detail());
    await waitFor(() => expect(within(view).queryByTestId("build-retry")).toBeNull());
    await waitFor(() => expect(within(view).queryByTestId("build-fitgap-empty")).toBeNull());

    // A send that fails still shows the words, as the API saved them.
    current = detail({
      messages: [
        ...detail().messages,
        {
          id: "m3",
          phase: "fitgap",
          role: "operator",
          text: "Add a row for W-9s.",
          chips: [],
          changes: [],
          createdAt: at,
        },
      ],
    });
    await userEvent.type(within(view).getByTestId("build-input"), "Add a row for W-9s.");
    await userEvent.click(within(view).getByTestId("build-send"));
    await waitFor(() => expect(turns).toHaveLength(2));
    answer(new Reply(500, { error: { code: "internal", message: "something went wrong" } }));
    await waitFor(() => expect(within(view).queryByTestId("build-thinking")).toBeNull());
    expect(within(view).getByTestId("build-messages")).toHaveTextContent("Add a row for W-9s.");
  });

  // Owner (2026-11-17): talk through the issues one at a time, agree each fix, and go back to one.
  it("talks about one issue at a time, agrees a fix and goes back to an earlier issue", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000b0102";
    const PROPOSAL = "00000000-0000-4000-8000-0000000b0201";
    const item = detail().items[0] as BuildDetail["items"][number];
    const second = { ...item, id: OTHER, title: "Who approves new vendors", key: null };
    const proposal = {
      summary: "Close “How many: still open” as done",
      action: { do: "close_item" as const, itemId: ITEM, state: "done" as const },
      state: "proposed" as const,
    };
    const asked = (over: Partial<BuildDetail["messages"][number]> = {}) => ({
      id: PROPOSAL,
      phase: "fitgap" as const,
      role: "builder" as const,
      text: "About 40 a week, you said. I'd close the question as done.",
      chips: [],
      changes: [],
      about: `item:${ITEM}`,
      proposal: proposal as NonNullable<BuildDetail["messages"][number]["proposal"]>,
      createdAt: at,
      ...over,
    });
    const base = detail({ items: [item, second] });
    const withProposal = { ...base, messages: [...base.messages, asked()] };
    const turns: unknown[] = [];
    const decided: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => withProposal,
      [`POST /api/ops/builds/${ID}/turns`]: ({ init }) => {
        turns.push(JSON.parse(String(init.body)));
        return withProposal;
      },
      [`POST /api/ops/builds/${ID}/messages/${PROPOSAL}/proposal`]: ({ init }) => {
        decided.push(JSON.parse(String(init.body)));
        return {
          ...base,
          items: [{ ...item, state: "done", resolvedAt: at }, second],
          messages: [
            ...base.messages,
            asked({ proposal: { ...proposal, state: "agreed", undo: true } }),
            {
              id: "m9",
              phase: "fitgap",
              role: "operator",
              text: "Agreed.",
              chips: [],
              changes: [],
              about: `item:${ITEM}`,
              createdAt: at,
            },
            {
              id: "m10",
              phase: "fitgap",
              role: "builder",
              text: "Done: close the question. Next open issue: “Who approves new vendors”. Shall we take it?",
              chips: ["Yes, take it", "What's left?"],
              changes: [],
              about: `item:${OTHER}`,
              createdAt: at,
            },
          ],
        };
      },
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");

    // The Builder's message says which issue it's about, and proposes a fix to agree.
    expect(within(view).getByTestId("build-items")).toHaveTextContent("Issues");
    expect(within(view).getByTestId("build-about")).toHaveTextContent(
      "About: How many: still open",
    );
    expect(within(view).getByTestId("build-proposal")).toHaveTextContent(
      "Proposed: Close “How many: still open” as done",
    );

    // Talking about the other issue: the words carry it.
    await userEvent.click(within(view).getByTestId(`build-issue-item:${OTHER}-talk`));
    expect(within(view).getByTestId("build-focus")).toHaveTextContent(
      "About: Who approves new vendors",
    );
    await userEvent.type(within(view).getByTestId("build-input"), "Ann does.");
    await userEvent.click(within(view).getByTestId("build-send"));
    await waitFor(() => expect(turns).toEqual([{ text: "Ann does.", about: `item:${OTHER}` }]));

    // Agreeing makes the change; the conversation moves on with the Builder to the next issue.
    await userEvent.click(within(view).getByTestId("build-proposal-agree"));
    await waitFor(() => expect(decided).toEqual([{ decide: "agree" }]));
    expect(await within(view).findByTestId("build-proposal-undo")).toBeInTheDocument();
    expect(within(view).getByTestId("build-proposal-state")).toHaveTextContent("Agreed and done");
    expect(within(view).getByTestId("build-focus")).toHaveTextContent(
      "About: Who approves new vendors",
    );

    // Going back: a message's "About" puts the conversation on that issue again, and its thread
    // can be shown on its own.
    await userEvent.click(within(view).getAllByTestId("build-about")[0] as HTMLElement);
    expect(within(view).getByTestId("build-focus")).toHaveTextContent(
      "About: How many: still open",
    );
    await userEvent.click(within(view).getByTestId("build-focus-thread"));
    const chat = within(view).getByTestId("build-messages");
    expect(chat).toHaveTextContent("About 40 a week");
    expect(chat).not.toHaveTextContent("Review invoices against contracts.");
    await userEvent.click(within(view).getByTestId("build-focus-thread"));
    expect(chat).toHaveTextContent("Review invoices against contracts.");

    // Walking through starts from the top, on no one issue.
    await userEvent.click(within(view).getByTestId("build-focus-clear"));
    expect(within(view).queryByTestId("build-focus")).toBeNull();
    await userEvent.click(within(view).getByTestId("build-issues-walk"));
    await waitFor(() =>
      expect(turns.at(-1)).toEqual({ text: "Walk me through the open issues, one at a time." }),
    );
  });

  // Owner (2026-11-17): the draft changes from the build's conversation.
  // QA on staging (2026-11-17): an edit that didn't fix its issue read as "Done"; Confirm did
  // nothing while a brief change was unsaved.
  it("marks an edit that left its issue open, and confirms an unsaved brief by saving it", async () => {
    const PROPOSAL = "00000000-0000-4000-8000-0000000b0302";
    const base = detail();
    const message = {
      id: PROPOSAL,
      phase: "draft",
      role: "builder",
      text: "I changed the draft, but it isn't fixed.",
      chips: [],
      changes: [],
      proposal: {
        summary: "Build the filter and group skill",
        action: { do: "edit_draft", request: "On “Group”, group the invoices by customer." },
        state: "agreed",
        unresolved: true,
        result: "Changed, still open: I reworded the step.",
        changes: ["~ step group · need"],
      },
      createdAt: at,
    } as unknown as BuildDetail["messages"][number];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => ({ ...base, messages: [...base.messages, message] }),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    expect(within(view).getByTestId("build-proposal-state")).toHaveTextContent(
      "Changed, still open",
    );
    expect(within(view).getByTestId("build-proposal-changes")).toHaveTextContent(
      "What changed in the steps",
    );
    cleanup();

    const intake = detail({
      build: { ...detail().build, phase: "intake" },
      phases: detail().phases.map((p) => ({
        ...p,
        state: p.phase === "intake" ? ("current" as const) : ("todo" as const),
      })),
      gate: { next: "fitgap", reasons: [] },
    });
    const calls: string[] = [];
    const api2 = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => intake,
      [`PATCH /api/ops/builds/${ID}`]: ({ init }) => {
        calls.push(`save ${JSON.stringify(JSON.parse(String(init.body)).brief.goal)}`);
        return intake;
      },
      [`POST /api/ops/builds/${ID}/phase`]: () => {
        calls.push("move");
        return intake;
      },
    });
    renderAt(`/ops/builds/${ID}`, api2);
    const view2 = await screen.findByTestId("build-view");
    const goal = within(view2).getByTestId("build-brief-goal");
    await userEvent.type(goal, " monthly");
    expect(within(view2).getByTestId("build-confirm-brief")).toBeEnabled();
    await userEvent.click(within(view2).getByTestId("build-confirm-brief"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toContain("monthly");
    expect(calls[1]).toBe("move");
  });

  it("says what a draft edit asks for, then what it changed, with Undo", async () => {
    const PROPOSAL = "00000000-0000-4000-8000-0000000b0301";
    const editing = {
      summary: "Set the amount on “Pay” to the invoice total",
      action: {
        do: "edit_draft" as const,
        request: "On “Pay”, take the amount from the invoice total.",
      },
    };
    const message = (p: Record<string, unknown>) =>
      ({
        id: PROPOSAL,
        phase: "draft",
        role: "builder",
        text: "The amount is fixed at 12.00; it should come from the invoice.",
        chips: [],
        changes: [],
        proposal: { ...editing, ...p },
        createdAt: at,
      }) as unknown as BuildDetail["messages"][number];
    const base = detail();
    const decided: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => ({
        ...base,
        messages: [...base.messages, message({ state: "proposed" })],
      }),
      [`POST /api/ops/builds/${ID}/messages/${PROPOSAL}/proposal`]: ({ init }) => {
        decided.push(JSON.parse(String(init.body)));
        return {
          ...base,
          messages: [
            ...base.messages,
            message({
              state: "agreed",
              undo: true,
              result: "Changed: Pay: amount from the invoice total",
            }),
          ],
        };
      },
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    expect(within(view).getByTestId("build-proposal-request")).toHaveTextContent(
      "The change to the draft: On “Pay”, take the amount from the invoice total.",
    );
    await userEvent.click(within(view).getByTestId("build-proposal-agree"));
    await waitFor(() => expect(decided).toEqual([{ decide: "agree" }]));
    expect(await within(view).findByTestId("build-proposal-result")).toHaveTextContent(
      "Changed: Pay: amount from the invoice total",
    );
    expect(within(view).queryByTestId("build-proposal-request")).toBeNull();
    expect(within(view).getByTestId("build-proposal-undo")).toBeInTheDocument();
  });

  // QA on staging (2026-11-17): a draft that couldn't be made left only a banner of internals.
  it("offers to try a failed draft again, in plain words", async () => {
    const moves: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => detail(),
      [`POST /api/ops/builds/${ID}/phase`]: ({ init }) => {
        moves.push(JSON.parse(String(init.body)));
        return moves.length === 1
          ? new Reply(422, {
              error: {
                code: "builder_failed",
                message:
                  "The Builder's answer was too long to finish, even as a smaller first draft, so nothing changed.",
              },
            })
          : detail();
      },
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    await userEvent.click(within(view).getByTestId("build-agree"));
    const notice = await within(view).findByTestId("build-error");
    expect(notice).toHaveTextContent("too long to finish");
    await userEvent.click(within(notice).getByTestId("build-error-retry"));
    await waitFor(() => expect(moves).toEqual([{ to: "draft" }, { to: "draft" }]));
    await waitFor(() => expect(within(view).queryByTestId("build-error")).toBeNull());
  });

  it("filters the fit-gap by verdict and changes one only with a reason", async () => {
    const sent: unknown[] = [];
    const withTiers = () => {
      const d = detail();
      return detail({
        build: {
          ...d.build,
          fitgap: {
            ...d.build.fitgap,
            rows: [
              ...d.build.fitgap.rows,
              {
                id: "tiers",
                need: "Volume tiers",
                verdict: "build",
                how: "A new skill",
                dropped: false,
              },
            ],
          },
        },
      });
    };
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => withTiers(),
      [`POST /api/ops/builds/${ID}/verdicts`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return withTiers();
      },
    });
    renderAt(`/ops/builds/${ID}`, api);
    const fit = await screen.findByTestId("build-fitgap");
    // A verdict is a fact from the catalog, not a picker.
    expect(within(fit).queryByLabelText("Verdict: Read invoice PDFs")).toBeNull();
    expect(within(fit).getByTestId("build-fit-read-verdict")).toHaveTextContent("Native");
    expect(within(fit).getByTestId("build-fit-tiers-item")).toHaveTextContent(
      "Becomes an issue for Builder",
    );

    // A count shows which rows it counts.
    await userEvent.click(within(fit).getByTestId("build-fit-count-build"));
    expect(within(fit).getByTestId("build-fit-filter")).toHaveTextContent(
      "Showing the 1 build row",
    );
    expect(within(fit).queryByTestId("build-fit-read")).toBeNull();
    expect(within(fit).getByTestId("build-fit-tiers")).toBeInTheDocument();
    await userEvent.click(within(fit).getByRole("button", { name: "Show all" }));
    expect(within(fit).getByTestId("build-fit-read")).toBeInTheDocument();

    // Less work is a challenge to the Builder, with why.
    await userEvent.click(within(fit).getByTestId("build-fit-tiers-change"));
    // QA (2026-11-17): nothing is proposed until a verdict is picked.
    expect(within(fit).getByTestId("build-fit-tiers-to")).toHaveValue("");
    expect(within(fit).getByTestId("build-fit-tiers-send")).toBeDisabled();
    await userEvent.selectOptions(within(fit).getByTestId("build-fit-tiers-to"), "native");
    const send = within(fit).getByTestId("build-fit-tiers-send");
    expect(send).toHaveTextContent("Ask the Builder");
    expect(send).toBeDisabled();
    await userEvent.type(
      within(fit).getByTestId("build-fit-tiers-reason"),
      "The contract tool already reads volume breaks.",
    );
    await userEvent.click(send);
    await waitFor(() =>
      expect(sent).toEqual([
        { rowId: "tiers", to: "native", reason: "The contract tool already reads volume breaks." },
      ]),
    );

    // More work changes it at once.
    await userEvent.click(within(fit).getByTestId("build-fit-read-change"));
    await userEvent.selectOptions(within(fit).getByTestId("build-fit-read-to"), "figure_out");
    expect(within(fit).getByTestId("build-fit-read-send")).toHaveTextContent("Change it");
  });

  it("keeps a template's client intake form on the build", async () => {
    const saved: unknown[] = [];
    const withForm = () => {
      const d = detail();
      return detail({
        build: {
          ...d.build,
          fitgap: {
            ...d.build.fitgap,
            needsTrue: [],
            setup: [
              {
                id: "ap",
                label: "Your AP address",
                kind: "answer",
                hint: "Where invoices are forwarded",
                dropped: false,
                byOperator: false,
              },
            ],
          },
        },
      });
    };
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => withForm(),
      [`PATCH /api/ops/builds/${ID}`]: ({ init }) => {
        saved.push(JSON.parse(String(init.body)));
        return withForm();
      },
    });
    renderAt(`/ops/builds/${ID}`, api);
    const form = await screen.findByTestId("build-setup");
    expect(form).toHaveTextContent("What we get from each client to set up their copy · 1 field");
    expect(within(form).getByLabelText("Field: Your AP address")).toHaveValue("Your AP address");
    await userEvent.type(within(form).getByTestId("build-setup-new"), "Your vendor contracts");
    await userEvent.selectOptions(within(form).getByLabelText("Kind of field"), "file");
    await userEvent.click(within(form).getByTestId("build-setup-add"));
    await userEvent.click(screen.getByTestId("build-fitgap-save"));
    await waitFor(() => expect(saved).toHaveLength(1));
    const setup = (saved[0] as { fitgap: { setup: { label: string; kind: string }[] } }).fitgap
      .setup;
    expect(setup.map((f) => [f.label, f.kind])).toEqual([
      ["Your AP address", "answer"],
      ["Your vendor contracts", "file"],
    ]);
  });

  it("says why a phase can't close yet", async () => {
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () =>
        detail({
          build: { ...detail().build, phase: "intake", brief: {} },
          phases: detail().phases.map((p, i) => ({ ...p, state: i === 0 ? "current" : "todo" })),
          gate: { next: "fitgap", reasons: ["The brief has no goal yet."] },
        }),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const confirm = await screen.findByTestId("build-confirm-brief");
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId("build-confirm-brief-reasons")).toHaveTextContent(
      "The brief has no goal yet.",
    );
  });

  it("opens the draft's workflow, not the agent's overview", async () => {
    const AGENT = "00000000-0000-4000-8000-0000000a0001";
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () =>
        detail({
          build: { ...detail().build, phase: "draft", agentId: AGENT },
          phases: detail().phases.map((p, i) => ({
            ...p,
            state: i < 2 ? "done" : i === 2 ? "current" : "todo",
          })),
          gate: { next: "poc", reasons: [] },
          draft: {
            agentId: AGENT,
            skillId: null,
            sessionId: null,
            versionId: null,
            version: 1,
            live: false,
            problems: [],
          },
        }),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const open = await screen.findByTestId("build-open-draft");
    expect(open).toHaveTextContent("Open the workflow");
    expect(open).toHaveAttribute("href", `/ops/agents/${AGENT}/workflow`);
  });
});
