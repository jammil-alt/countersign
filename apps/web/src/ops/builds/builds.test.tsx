// Builds in the back office (docs/plan.md §1.108): the board by phase with New build, and a build:
// its stepper, the conversation (chips answer, the words leave the box at once), the brief with the
// gate's reasons on Confirm, a done phase looked at again and gone back to with a reason, and open
// items whose state changes.
import type { BuildDetail } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

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
    expect(within(fit).getByTestId(`builds-card-${ID}`)).toHaveTextContent("1 open item");
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
      "Becomes an open item for Builder",
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
});
