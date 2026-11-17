// Getting started (docs/plan.md §1.125.2; docs/cases-plan.md §4.5): the lead's note, a card per
// part with "We think" lines (Yes or Change), at most five questions then "Show more", a Connect
// card through the Accounts page's own flow, Not sure, Start with this or Not now, Ask someone
// else, Different process in mind?, Rather talk it through? (coming soon), the plain form, core's
// questions in the reader's language, and Home sending a client with no live agent here.
import type { PortalIntakeView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, tableService, tableView } from "../../test/fixtures";

const INTAKE = "00000000-0000-4000-8000-0000000f0001";
const T = "00000000-0000-4000-8000-0000000f00a1";
const SLOW = 15_000;
const QBO = {
  connector: "qbo",
  name: "QuickBooks Online",
  description: "",
  icon: null,
  available: true,
  credentialForm: false,
  auth: "oauth2" as const,
  personal: false,
  connection: null,
};

const field = (over: Partial<PortalIntakeView["sections"][number]["fields"][number]>) => ({
  key: "general.what",
  sectionKey: "general",
  alsoIn: [],
  label: "What does your business do, and where?",
  kind: "long_text" as const,
  hint: "",
  requiredToStart: false,
  state: "to_ask" as const,
  weThink: null,
  fileSection: null,
  connector: null,
  ...over,
});

function intakeView(over: Partial<PortalIntakeView> = {}): PortalIntakeView {
  return {
    intake: {
      id: INTAKE,
      status: "sent",
      startMode: "point",
      leadNote: "Jammil suggested we start with how Acme handles bills.",
      lead: { name: "Jammil Lead", photoUrl: null },
      createdAt: "2026-11-17T10:00:00.000Z",
    },
    sections: [
      {
        key: "general",
        kind: "general",
        area: null,
        templateId: null,
        title: "The business",
        intro: "A few questions about your business, so every agent starts from how you work.",
        fields: [
          field({}),
          field({
            key: "general.approver",
            label: "Who approves payments and changes?",
            kind: "text",
            hint: "A name and their role is enough.",
            alsoIn: ["area:purchasing"],
          }),
          field({
            key: "general.team",
            label: "Who does what? For example, who keeps the books and who buys.",
          }),
          field({
            key: "general.systems",
            label: "Which tools do you use day to day?",
            kind: "text",
          }),
          field({
            key: "general.first",
            label: "What takes too much time today, and what would you hand off first?",
          }),
          field({ key: "general.limits", label: "Is there anything an agent should never do?" }),
          field({
            key: "fact.abc",
            label: "Tools you use",
            fileSection: "systems",
            state: "to_confirm",
            weThink: { value: "QuickBooks Online", text: "They use QuickBooks Online" },
          }),
        ],
      },
      {
        key: "area:purchasing",
        kind: "area",
        area: "purchasing",
        templateId: null,
        title: "Purchasing",
        intro: "How you buy materials and pay for them today.",
        fields: [
          field({
            key: "purchasing.bills",
            sectionKey: "area:purchasing",
            label: "About how many bills do you get in a month?",
            kind: "number",
          }),
        ],
      },
      {
        key: `agent:${T}`,
        kind: "agent",
        area: null,
        templateId: T,
        title: "Contracts check",
        intro: "Checks each bill against the vendor's contract before you pay it.",
        fields: [
          field({
            key: "tool.qbo",
            sectionKey: `agent:${T}`,
            label: "Connect QuickBooks",
            kind: "tool",
            connector: "qbo",
            requiredToStart: true,
          }),
        ],
      },
    ],
    answers: [],
    progress: [
      { sectionKey: "general", answered: 0, total: 7, notSure: 0, missing: [], decision: null },
      {
        sectionKey: "area:purchasing",
        answered: 0,
        total: 2,
        notSure: 0,
        missing: [],
        decision: null,
      },
      { sectionKey: `agent:${T}`, answered: 0, total: 1, notSure: 0, missing: [], decision: null },
    ],
    people: [{ id: "p1", name: "Dana Admin", sections: null, isAdmin: true }],
    you: { personId: "p1", sections: null, isAdmin: true },
    ...over,
  };
}

function setup(
  over: Record<string, Parameters<typeof fakeApi>[0][string]> = {},
  session = CLIENT_SESSION,
) {
  const sent: { route: string; body: unknown }[] = [];
  const view = intakeView();
  const record =
    (route: string) =>
    ({ init }: { init: RequestInit }) => {
      sent.push({ route, body: JSON.parse(String(init.body)) });
      return view;
    };
  const api = fakeApi({
    "GET /api/session": () => session,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/intake": () => ({ intake: view }),
    "GET /api/connections": () => ({ connections: [QBO] }),
    "GET /api/team": () => ({
      members: [
        {
          userId: "00000000-0000-4000-8000-00000000d003",
          name: "Mark User",
          email: "mark@demo.example.com",
          role: "client_user",
          canSign: true,
          signs: [],
        },
      ],
      settings: { undoSeconds: 0 },
    }),
    [`POST /api/intake/${INTAKE}/answers`]: record("answers"),
    [`POST /api/intake/${INTAKE}/confirm`]: record("confirm"),
    [`POST /api/intake/${INTAKE}/ask`]: ({ init }) => {
      sent.push({ route: "ask", body: JSON.parse(String(init.body)) });
      return {
        person: {
          id: "p2",
          userId: "00000000-0000-4000-8000-00000000d003",
          email: "mark@demo.example.com",
          name: "Mark User",
          sections: ["general"],
          isAdmin: false,
          invitedBy: null,
          createdAt: "2026-11-17T10:00:00.000Z",
        },
        emailed: true,
      };
    },
    [`POST /api/intake/${INTAKE}/different-process`]: ({ init }) => {
      sent.push({ route: "different", body: JSON.parse(String(init.body)) });
      return { ok: true };
    },
    "POST /api/connections/qbo/authorize": () => {
      sent.push({ route: "authorize", body: null });
      return { connection: QBO, redirectUrl: null };
    },
    ...over,
  });
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, sent };
}

describe("Getting started", () => {
  it("opens with the lead's note and a card per part, with progress", async () => {
    setup();
    expect(await screen.findByTestId("start-page")).toBeInTheDocument();
    expect(screen.getByTestId("start-lead-note")).toHaveTextContent(
      "From Jammil Lead, your Mezonas lead",
    );
    expect(screen.getByTestId("start-lead-note")).toHaveTextContent("how Acme handles bills");
    expect(screen.getByTestId("start-progress")).toHaveTextContent("0 of 10 answered");
    expect(screen.getByTestId("start-card-general")).toHaveTextContent("The business");
    expect(screen.getByTestId(`start-card-agent:${T}`)).toHaveTextContent(
      "Checks each bill against the vendor's contract",
    );
    // Rather talk it through? is next wave's: shown, off.
    expect(screen.getByTestId("start-talk-button")).toBeDisabled();
    expect(screen.getByTestId("start-talk")).toHaveTextContent("Coming soon");
    expect(screen.getByTestId("start-never")).toHaveTextContent("We never ask for passwords");
  });

  it('says yes to a "We think" line, or changes it', { timeout: SLOW }, async () => {
    const { sent } = setup();
    const line = await screen.findByTestId("start-line-fact.abc");
    expect(line).toHaveTextContent("We think: They use QuickBooks Online");
    await userEvent.click(within(line).getByTestId("start-yes"));
    await waitFor(() =>
      expect(sent).toContainEqual({
        route: "confirm",
        body: { sectionKey: "general", fields: [{ fieldKey: "fact.abc" }] },
      }),
    );
    await userEvent.click(within(line).getByTestId("start-change"));
    await userEvent.type(within(line).getByTestId("start-input-fact.abc"), "QuickBooks and Excel");
    await userEvent.click(within(line).getByTestId("start-change-save"));
    await waitFor(() =>
      expect(sent).toContainEqual({
        route: "confirm",
        body: {
          sectionKey: "general",
          fields: [{ fieldKey: "fact.abc", value: "QuickBooks and Excel" }],
        },
      }),
    );
  });

  it("shows at most five questions a card, then the rest on request", async () => {
    setup();
    const card = await screen.findByTestId("start-card-general");
    const list = within(card).getByTestId("start-questions-general");
    expect(within(list).getAllByTestId(/^start-field-/)).toHaveLength(5);
    await userEvent.click(within(card).getByTestId("start-more"));
    expect(within(card).getAllByTestId(/^start-field-/).length).toBe(6);
    // "Who approves" is the general card's: Purchasing names it, asked there.
    expect(screen.getByTestId("start-asked-in-general.approver")).toHaveTextContent(
      "(asked in The business)",
    );
  });

  it("saves answers by kind, and marks one not sure", { timeout: SLOW }, async () => {
    const { sent } = setup();
    const card = await screen.findByTestId("start-card-area:purchasing");
    await userEvent.type(within(card).getByTestId("start-input-purchasing.bills"), "340");
    await userEvent.click(within(card).getByTestId("start-save"));
    await waitFor(() =>
      expect(sent).toContainEqual({
        route: "answers",
        body: { answers: [{ fieldKey: "purchasing.bills", state: "answered", value: 340 }] },
      }),
    );
    await userEvent.click(
      within(screen.getByTestId("start-card-general")).getByTestId("start-not-sure-general.what"),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        route: "answers",
        body: { answers: [{ fieldKey: "general.what", state: "not_sure" }] },
      }),
    );
  });

  it("connects a tool through the Accounts page's own flow, or says not now", async () => {
    const { sent } = setup();
    const connect = await screen.findByTestId("start-connect-qbo");
    expect(connect).toHaveTextContent("Connect QuickBooks");
    await waitFor(() => expect(within(connect).getByTestId("start-connect")).toBeEnabled());
    await userEvent.click(within(connect).getByTestId("start-connect"));
    await waitFor(() => expect(sent.some((s) => s.route === "authorize")).toBe(true));
    await userEvent.click(within(connect).getByTestId("start-cant-connect"));
    await waitFor(() =>
      expect(sent).toContainEqual({
        route: "answers",
        body: { answers: [{ fieldKey: "tool.qbo", state: "not_sure" }] },
      }),
    );
  });

  it("says Start with this or Not now for a card", async () => {
    const { sent } = setup();
    const card = await screen.findByTestId(`start-card-agent:${T}`);
    await userEvent.click(within(card).getByTestId("start-start"));
    await waitFor(() =>
      expect(sent).toContainEqual({
        route: "confirm",
        body: { sectionKey: `agent:${T}`, decision: "start" },
      }),
    );
  });

  it("asks a colleague for a card", { timeout: SLOW }, async () => {
    const { sent } = setup();
    const card = await screen.findByTestId("start-card-general");
    await userEvent.click(within(card).getByTestId("start-ask-open"));
    const ask = within(card).getByTestId("start-ask");
    await within(ask).findByRole("option", { name: "Mark User" });
    await userEvent.selectOptions(
      within(ask).getByTestId("start-ask-who"),
      "00000000-0000-4000-8000-00000000d003",
    );
    await userEvent.type(within(ask).getByTestId("start-ask-note"), "You know this best");
    await userEvent.click(within(ask).getByTestId("start-ask-send"));
    expect(await within(card).findByTestId("start-ask-done")).toHaveTextContent(
      "We've emailed Mark User.",
    );
    expect(sent).toContainEqual({
      route: "ask",
      body: {
        sectionKey: "general",
        userId: "00000000-0000-4000-8000-00000000d003",
        note: "You know this best",
      },
    });
  });

  it("sends a different process to the lead", { timeout: SLOW }, async () => {
    const { sent } = setup();
    const box = await screen.findByTestId("start-different");
    expect(box).toHaveTextContent("It goes to Jammil Lead.");
    await userEvent.type(
      within(box).getByTestId("start-different-text"),
      "Bills go to Dana first.",
    );
    await userEvent.click(within(box).getByTestId("start-different-send"));
    expect(await within(box).findByTestId("start-different-sent")).toBeInTheDocument();
    expect(sent).toContainEqual({ route: "different", body: { text: "Bills go to Dana first." } });
  });

  it("reads core's questions in the person's language, a pack's as written", async () => {
    setup({}, { ...CLIENT_SESSION, language: { effective: "de", user: "de", client: null } });
    const card = await screen.findByTestId("start-card-general");
    expect(card).toHaveTextContent("Das Unternehmen");
    expect(card).toHaveTextContent("Was macht Ihr Unternehmen, und wo?");
    expect(screen.getByTestId("start-card-area:purchasing")).toHaveTextContent("Einkauf");
    expect(screen.getByTestId("start-card-area:purchasing")).toHaveTextContent(
      "About how many bills do you get in a month?",
    );
  });

  it("says when there's nothing to answer", async () => {
    setup({ "GET /api/intake": () => ({ intake: null }) });
    expect(await screen.findByText("Nothing to answer right now")).toBeInTheDocument();
  });
});

describe("Home while an intake is open", () => {
  it("is Getting started when no agent is live", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/table": () =>
        tableView({
          services: [
            tableService("00000000-0000-4000-8000-0000000a9001", "Pia", { stage: "bench" }),
          ],
        }),
      "GET /api/intake": () => ({ intake: intakeView() }),
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("start-page")).toBeInTheDocument();
  });

  it("stays Home, asking nothing more, once an agent is live", async () => {
    const live = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/table": () =>
        tableView({ services: [tableService("00000000-0000-4000-8000-0000000a9001", "Pia")] }),
      "GET /api/intake": () => ({ intake: intakeView() }),
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders client={live.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("portal-home")).toBeInTheDocument();
    expect(live.calls).not.toContain("GET /api/intake");
  });
});
