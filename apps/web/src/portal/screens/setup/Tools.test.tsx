// Your tools (docs/setup-plan.md §5; docs/plan.md §1.185, SU3): one card per tool with what the
// agents read, change and never do; the account check said yes to, a different company going to
// the tool's own page; the first look's lines; Connect through the connector's page; Someone else
// sends just the card to a colleague; a client user who isn't the admin reads only.
import type { SetupTool, ToolsChapterView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../../test/fixtures";

const SLOW = 15_000;
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const ME = CLIENT_SESSION.user.id;
const MARK = "00000000-0000-4000-8000-00000000d003";
const LUIS = "00000000-0000-4000-8000-00000000d004";

const BOOKS: SetupTool = {
  connector: "qbo",
  name: "QuickBooks Online",
  connected: true,
  connectionId: "00000000-0000-4000-8000-0000000c0001",
  account: "Hartley Millwork LLC",
  accountConfirmed: false,
  agents: [{ id: AGENT, name: "Bill clerk" }],
  reads: ["Bills", "Vendors", "Accounts"],
  changes: ["Create bills (asks you first)"],
  never: ["Delete anything", "Pay or move money", "Change anything not listed here"],
  firstLook: [
    { key: "vendors", text: "41 active vendors.", confirmed: false },
    {
      key: "bills_month",
      text: "About 330 bills a month over the last three months.",
      confirmed: false,
    },
  ],
  askedOf: null,
};

const MAIL: SetupTool = {
  connector: "gmail",
  name: "Gmail",
  connected: false,
  connectionId: null,
  account: null,
  accountConfirmed: false,
  agents: [{ id: AGENT, name: "Bill clerk" }],
  reads: [],
  changes: [],
  never: ["Delete anything", "Pay or move money", "Change anything"],
  firstLook: null,
  askedOf: null,
};

function view(over: Partial<ToolsChapterView> = {}): ToolsChapterView {
  return { tools: [BOOKS, MAIL], canEdit: true, ...over };
}

function setup(initial = view()) {
  const sent: { route: string; body: unknown }[] = [];
  let current = initial;
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/getting-started/tools": () => current,
    "GET /api/team": () => ({
      members: [
        {
          userId: ME,
          name: "Demo admin",
          email: "admin@demo.example.com",
          role: "client_admin",
          canSign: true,
          signs: [],
        },
        {
          userId: MARK,
          name: "Mark Lee",
          email: "mark@demo.example.com",
          role: "client_user",
          canSign: true,
          signs: [],
        },
        {
          userId: LUIS,
          name: "Luis Ortega",
          email: "luis@demo.example.com",
          role: "client_admin",
          canSign: true,
          signs: [],
        },
      ],
      settings: { undoSeconds: 0 },
    }),
    "POST /api/getting-started/tools/qbo/confirm": ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ route: "confirm", body });
      current = {
        ...current,
        tools: current.tools.map((t) =>
          t.connector !== "qbo"
            ? t
            : body.what === "account"
              ? { ...t, accountConfirmed: true }
              : {
                  ...t,
                  firstLook: (t.firstLook ?? []).map((l) =>
                    l.key === body.key ? { ...l, confirmed: true } : l,
                  ),
                },
        ),
      };
      return current;
    },
    "POST /api/getting-started/tools/gmail/ask": ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ route: "ask", body });
      current = {
        ...current,
        tools: current.tools.map((t) =>
          t.connector === "gmail"
            ? { ...t, askedOf: { userId: body.userId, name: "Mark Lee", me: false } }
            : t,
        ),
      };
      return current;
    },
  });
  render(
    <MemoryRouter initialEntries={["/getting-started/tools"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, sent };
}

describe("Your tools", () => {
  it(
    "shows what the agents do in each tool, and says yes to the account and a line",
    async () => {
      const { sent } = setup();
      const books = await screen.findByTestId("start-tool-qbo");
      expect(books).toHaveTextContent("QuickBooks Online");
      expect(books).toHaveTextContent("Used by Bill clerk");
      expect(within(books).getByTestId("start-tool-qbo-state")).toHaveTextContent("Connected");
      const words = within(books).getByTestId("start-tool-qbo-words");
      expect(words).toHaveTextContent("We'll read");
      expect(words).toHaveTextContent("Bills, Vendors, Accounts");
      expect(words).toHaveTextContent(
        "Create bills (asks you first) We ask you first, every time.",
      );
      expect(words).toHaveTextContent("Delete anything, Pay or move money");
      expect(within(books).getByTestId("start-tool-qbo-access")).toHaveAttribute(
        "href",
        `/connectors/qbo?for=${AGENT}`,
      );
      const account = within(books).getByTestId("start-tool-qbo-account");
      expect(account).toHaveTextContent(
        "You signed in to Hartley Millwork LLC. Is that the company the agents should use?",
      );
      // A different company goes to the tool's own page, where it signs in again.
      expect(within(books).getByTestId("start-tool-qbo-different")).toHaveAttribute(
        "href",
        `/connectors/qbo?for=${AGENT}`,
      );
      await userEvent.click(within(books).getByTestId("start-tool-qbo-account-yes"));
      await waitFor(() => expect(sent[0]).toEqual({ route: "confirm", body: { what: "account" } }));
      await waitFor(() => expect(account).toHaveTextContent("The agents use that company."));

      const look = within(books).getByTestId("start-tool-qbo-look");
      expect(look).toHaveTextContent("What we see in QuickBooks Online");
      const line = within(look).getByTestId("start-tool-qbo-line-vendors");
      expect(line).toHaveTextContent("41 active vendors.");
      await userEvent.click(within(line).getByRole("button", { name: "Yes" }));
      await waitFor(() =>
        expect(sent[1]).toEqual({ route: "confirm", body: { what: "line", key: "vendors" } }),
      );
      await waitFor(() => expect(line).toHaveTextContent("Checked"));
    },
    SLOW,
  );

  it(
    "connects through the tool's own page, or asks someone else",
    async () => {
      const { sent } = setup();
      const mail = await screen.findByTestId("start-tool-gmail");
      expect(within(mail).getByTestId("start-tool-gmail-state")).toHaveTextContent(
        "Waiting on you",
      );
      expect(within(mail).getByTestId("start-tool-gmail-words")).toHaveTextContent(
        "We may changeNothing",
      );
      expect(within(mail).getByTestId("start-tool-gmail-connect")).toHaveAttribute(
        "href",
        `/connectors/gmail?for=${AGENT}`,
      );
      await userEvent.click(within(mail).getByTestId("start-tool-gmail-ask"));
      const who = await within(mail).findByTestId("start-tool-gmail-ask-who");
      // Not the person asking.
      expect(within(who).queryByText(/Demo admin/)).toBeNull();
      await userEvent.selectOptions(who, MARK);
      await userEvent.click(within(mail).getByTestId("start-tool-gmail-ask-send"));
      await waitFor(() => expect(sent[0]).toEqual({ route: "ask", body: { userId: MARK } }));
      expect(await within(mail).findByTestId("start-tool-gmail-asked")).toHaveTextContent(
        "We asked Mark Lee. It's in their inbox.",
      );
      expect(within(mail).getByTestId("start-tool-gmail-state")).toHaveTextContent(
        "Waiting on Mark Lee",
      );
    },
    SLOW,
  );

  it(
    "says in words when the person asked can't connect it",
    async () => {
      const { api } = setup();
      api.on(
        "POST /api/getting-started/tools/gmail/ask",
        () =>
          new Reply(422, {
            error: { code: "cannot_connect", message: "Only an admin can connect Gmail." },
          }),
      );
      const mail = await screen.findByTestId("start-tool-gmail");
      await userEvent.click(within(mail).getByTestId("start-tool-gmail-ask"));
      await userEvent.selectOptions(
        await within(mail).findByTestId("start-tool-gmail-ask-who"),
        MARK,
      );
      await userEvent.click(within(mail).getByTestId("start-tool-gmail-ask-send"));
      expect(
        await within(mail).findByText(
          /Only an admin can connect Gmail. Make them an admin on Team/,
        ),
      ).toBeInTheDocument();
    },
    SLOW,
  );

  it("reads only, for someone who isn't the admin", async () => {
    setup(view({ canEdit: false }));
    const books = await screen.findByTestId("start-tool-qbo");
    expect(screen.getByText("Your admin connects these and checks them.")).toBeInTheDocument();
    expect(within(books).queryByTestId("start-tool-qbo-account-yes")).toBeNull();
    expect(within(books).queryByRole("button", { name: "Yes" })).toBeNull();
    const mail = screen.getByTestId("start-tool-gmail");
    expect(within(mail).queryByTestId("start-tool-gmail-connect")).toBeNull();
    expect(within(mail).queryByTestId("start-tool-gmail-ask")).toBeNull();
    expect(mail).toHaveTextContent("Your admin connects this.");
  });

  it("lets the person asked connect it", async () => {
    setup(
      view({
        canEdit: false,
        tools: [{ ...MAIL, askedOf: { userId: ME, name: "Demo admin", me: true } }],
      }),
    );
    const mail = await screen.findByTestId("start-tool-gmail");
    expect(mail).toHaveTextContent("You were asked to connect this one.");
    expect(within(mail).getByTestId("start-tool-gmail-connect")).toBeInTheDocument();
    expect(within(mail).queryByTestId("start-tool-gmail-ask")).toBeNull();
  });
});
