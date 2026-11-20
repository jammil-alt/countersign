// Getting started's setup checklists (docs/builder-plan.md §6, B4): a card per agent with what it
// needs before its trial and go-live, waiting items marked with a word, the client admin answering
// and confirming there, a connect item sending them to Accounts, who did what, and a client user
// seeing it without answering. Shown on its own when no intake is open.
import type { PortalSetupAgent, SessionResponse, SetupRowView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const AGENT = "00000000-0000-4000-8000-0000000f0b01";
const SLOW = 15_000;

const row = (over: Partial<SetupRowView>): SetupRowView => ({
  id: "x",
  label: "x",
  kind: "answer",
  hint: "",
  guards: "setup",
  done: false,
  byConnection: false,
  setsValue: false,
  suggested: null,
  options: null,
  min: null,
  max: null,
  connector: null,
  value: null,
  files: 0,
  byName: null,
  side: null,
  at: null,
  ...over,
});

function agentView(items: SetupRowView[]): PortalSetupAgent {
  const done = items.filter((i) => i.done).length;
  const waitingTrial = items.some((i) => !i.done && i.guards !== "live");
  return {
    agentId: AGENT,
    name: "Bills in",
    stage: "bench",
    setup: {
      items,
      holds: {
        trial: waitingTrial ? "The setup checklist isn't done: …" : "",
        live: done < items.length ? "The setup checklist isn't done: …" : "",
      },
      done,
      total: items.length,
    },
  };
}

const ITEMS = [
  row({
    id: "connect-qbo",
    label: "Connect QuickBooks Online",
    kind: "connect",
    byConnection: true,
    connector: "qbo",
  }),
  row({
    id: "decision-tol",
    label: "How far may a price move before we ask?",
    setsValue: true,
    suggested: "2%",
    min: "0",
    max: "5",
  }),
  row({
    id: "write-start-qbo",
    label: "When do we start writing into QuickBooks Online?",
    kind: "confirm",
    guards: "trial",
    done: true,
    side: "operator",
    byName: null,
    at: "2026-11-18T10:00:00.000Z",
    value: "From the trial",
  }),
  row({ id: "go-date", label: "Your go-live date", guards: "live" }),
];

function setup(session: SessionResponse = CLIENT_SESSION, intake: unknown = null) {
  const sent: { path: string; body: unknown }[] = [];
  let items = ITEMS;
  const api = fakeApi({
    "GET /api/session": () => session,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/intake": () => ({ intake }),
    "GET /api/setup": () => ({ agents: [agentView(items)] }),
    [`POST /api/setup/${AGENT}/items/decision-tol`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ path: "decision-tol", body });
      items = items.map((i) =>
        i.id === "decision-tol"
          ? {
              ...i,
              done: true,
              value: body.value,
              byName: "Demo admin",
              side: "client" as const,
              at: "2026-11-19T10:00:00.000Z",
            }
          : i,
      );
      return { agent: agentView(items) };
    },
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

describe("Getting started: the setup checklists", () => {
  it(
    "shows each agent's items, waiting ones with a word, and who did the rest",
    async () => {
      setup();
      const card = await screen.findByTestId(`start-setup-${AGENT}`);
      // No intake open: the page's title, and the checklist rather than "nothing to answer".
      expect(screen.getByText("Getting started")).toBeInTheDocument();
      expect(screen.queryByText("Nothing to answer right now")).toBeNull();
      expect(card).toHaveTextContent("Bills in");
      expect(card).toHaveTextContent("1 of 4 done");
      expect(within(card).getByTestId("start-setup-holds")).toHaveTextContent(
        "Its trial starts when the items before the trial are done.",
      );
      const tol = screen.getByTestId("start-setup-item-decision-tol");
      expect(tol).toHaveTextContent("Waiting on you");
      expect(tol).toHaveTextContent("We suggest 2%");
      expect(tol).toHaveTextContent("Between 0 and 5");
      expect(tol).toHaveTextContent("Your answer becomes this agent's setting.");
      // Done by us: never an operator's name.
      const confirm = screen.getByTestId("start-setup-item-write-start-qbo");
      expect(confirm).toHaveTextContent("Done");
      expect(confirm).toHaveTextContent("From the trial");
      expect(confirm).toHaveTextContent("Done by us on");
      // A connect item opens the connector's page with this agent picked (Connectors C5).
      const connect = screen.getByTestId("start-setup-item-connect-qbo");
      expect(within(connect).getByRole("link", { name: "Connect it" })).toHaveAttribute(
        "href",
        `/connectors/qbo?for=${AGENT}`,
      );
      expect(screen.getByTestId("start-setup-item-go-date")).toHaveTextContent("Before go-live");
    },
    SLOW,
  );

  it(
    "lets the client admin answer, and shows the answer and who gave it",
    async () => {
      const { sent } = setup();
      const user = userEvent.setup();
      const input = await screen.findByTestId("start-setup-input-decision-tol");
      // The suggestion is the starting answer.
      expect(input).toHaveValue("2%");
      await user.clear(input);
      await user.type(input, "3");
      await user.click(screen.getByTestId("start-setup-save-decision-tol"));
      await waitFor(() => expect(sent).toEqual([{ path: "decision-tol", body: { value: "3" } }]));
      const tol = await screen.findByTestId("start-setup-value-decision-tol");
      expect(tol).toHaveTextContent("3");
      expect(screen.getByTestId("start-setup-item-decision-tol")).toHaveTextContent(
        "Done by Demo admin on",
      );
      expect(await screen.findByText("2 of 4 done")).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    "shows a client user where things stand without answering",
    async () => {
      setup({
        ...CLIENT_SESSION,
        tenants: CLIENT_SESSION.tenants.map((t) => ({ ...t, role: "client_user" as const })),
      });
      expect(await screen.findByText("Your admin answers these.")).toBeInTheDocument();
      expect(screen.queryByTestId("start-setup-input-decision-tol")).toBeNull();
      expect(screen.queryByRole("link", { name: "Connect it" })).toBeNull();
    },
    SLOW,
  );
});
