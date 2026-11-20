// Connectors (`/connectors`, Connectors C5, docs/connectors-plan.md §3.1): the needs banner (signal,
// with words, each opening the connector's page with the agent picked), Connected (a row per
// connection: account, who uses it, its access in a line, its state), Built for you (custom
// connectors, the website logins, Ask for a connector as a Request to the lead), and Browse
// (recommended first, by kind, Beta tagged, with a search). `/accounts` lands here.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { connectionSummary, connectorCard, NO_CONNECTORS } from "../../test/connectors";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const QBO_CONN = "00000000-0000-4000-8000-0000000c5a01";
const BANK_CONN = "00000000-0000-4000-8000-0000000c5a02";
const MILL_CONN = "00000000-0000-4000-8000-0000000c5a03";
const BUYER = { id: "00000000-0000-4000-8000-0000000a5a01", name: "Buyer" };
const BOOKKEEPER = { id: "00000000-0000-4000-8000-0000000a5a02", name: "Bookkeeper" };

const QBO = connectorCard({
  connector: "qbo",
  name: "QuickBooks Online",
  group: "money",
  connections: [
    connectionSummary({
      id: QBO_CONN,
      accountName: "Hartley Millwork LLC",
      usedBy: [BUYER, BOOKKEEPER],
      access: { reads: 9, changesAsk: 2, changesAuto: 0 },
      needsSomething: true,
      openRequest: true,
    }),
  ],
});
const BANK = connectorCard({
  connector: "bankfeed",
  name: "Bank feed",
  group: "money",
  connections: [
    connectionSummary({
      id: BANK_CONN,
      status: "error",
      accountName: "Chase ····4410",
      usedBy: [BOOKKEEPER],
      access: { reads: 3, changesAsk: 0, changesAuto: 0 },
    }),
  ],
});
const MILLSOFT = connectorCard({
  connector: "millsoft",
  name: "MillSoft ERP",
  description: "Your shop's job and stock system.",
  auth: "api_key",
  custom: true,
  connections: [connectionSummary({ id: MILL_CONN })],
});

const LIST = {
  connected: [QBO, BANK],
  builtForYou: [MILLSOFT],
  browse: [
    QBO,
    BANK,
    MILLSOFT,
    connectorCard({
      connector: "gmail",
      name: "Gmail",
      description: "Send email from your mailbox.",
      group: "email",
      personal: true,
      recommended: true,
    }),
    connectorCard({ connector: "billcom", name: "BILL", group: "money", beta: true }),
    connectorCard({ connector: "stripe", name: "Stripe", group: "money", auth: "api_key" }),
    connectorCard({ connector: "outlook", name: "Outlook", group: "email" }),
  ],
  waiting: [
    {
      agent: BUYER,
      connector: "qbo",
      connectorName: "QuickBooks Online",
      kind: "off_on_connection" as const,
      words: "Buyer: allow creating purchase orders",
    },
    {
      agent: BUYER,
      connector: "gmail",
      connectorName: "Gmail",
      kind: "not_connected" as const,
      words: "Buyer: connect Gmail",
    },
  ],
  openRequests: 1,
};

const VAULT = {
  items: [
    {
      connectionId: "00000000-0000-4000-8000-0000000c5a09",
      connector: "browser",
      name: "Northside Lumber portal",
      kind: "browser",
      status: "connected",
      externalAccountId: null,
      secret: { set: true, fields: [], updatedAt: null },
      credentialForm: true,
      matrix: { read: "auto", create: "off", update: "off", delete: "off" },
      tools: [],
      agents: [],
      browser: {
        site: { slug: "northside", name: "Northside Lumber portal", tier: "low" },
        effectiveTier: "low",
        siteVersion: 1,
        identity: { email: "agent-abc@agents.mezonas.com", phone: null },
        stricter: { noWrites: false, personSignIn: false },
        signInsPerDay: 10,
        signInsToday: 0,
        stopped: null,
      },
      release: {
        mode: "off",
        person: null,
        channel: "email",
        window: "run",
        sentTo: null,
        updatedAt: null,
        live: [],
      },
    },
  ],
  setup: [],
  browserSites: [],
  canEdit: true,
  people: [],
};

function renderAs(
  role: "client_admin" | "client_user",
  routes: Parameters<typeof fakeApi>[0] = {},
  path = "/connectors",
) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Hartley Millwork", role }],
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/portal/connectors": () => LIST,
    "GET /api/access": () => ({ ...VAULT, canEdit: role === "client_admin" }),
    "GET /api/access/browser-scripts": () => ({ scripts: [], logins: [] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("Connectors", () => {
  it("says who waits on what, each opening the connector's page with that agent picked", async () => {
    renderAs("client_admin");
    expect(await screen.findByRole("heading", { name: "Connectors", level: 1 })).toBeVisible();
    const needs = await screen.findByTestId("connectors-needs");
    expect(needs).toHaveTextContent("Buyer needs 2 things from you");
    expect(within(needs).getByRole("link", { name: "Buyer: connect Gmail" })).toHaveAttribute(
      "href",
      `/connectors/gmail?for=${BUYER.id}`,
    );
    expect(
      within(needs).getByRole("link", { name: "Buyer: allow creating purchase orders" }),
    ).toHaveAttribute("href", `/connectors/qbo?for=${BUYER.id}`);
    expect(screen.getByTestId("connectors-open-requests")).toHaveTextContent(
      "Mezonas asks to change 1 connection. Answer in your Inbox",
    );
  });

  it("lists each connection with its account, its agents, its access in a line and its state", async () => {
    renderAs("client_admin");
    const qbo = await screen.findByTestId("connectors-row-qbo");
    expect(qbo).toHaveAttribute("href", "/connectors/qbo");
    expect(qbo).toHaveTextContent(
      "Hartley Millwork LLC · Used by Buyer, Bookkeeper · Reads 9 · changes 2, asking you first",
    );
    expect(within(qbo).getByTestId("connectors-row-needs")).toHaveTextContent("Needs something");
    expect(within(qbo).getByTestId("connectors-row-request")).toHaveTextContent(
      "Change to approve",
    );
    expect(within(qbo).getByTestId("connectors-row-status")).toHaveTextContent("Connected");
    // A broken one says so, in risk, with what to do.
    const bank = screen.getByTestId("connectors-row-bankfeed");
    expect(bank).toHaveTextContent("Reads 3, changes nothing");
    expect(within(bank).getByTestId("connectors-row-status")).toHaveTextContent("Sign in again");
  });

  it("shows what was built for this client, its website logins, and Ask for a connector", async () => {
    const asked: unknown[] = [];
    renderAs("client_admin", {
      "POST /api/requests": ({ init }) => {
        asked.push(JSON.parse(String(init.body)));
        return {
          item: {
            id: "00000000-0000-4000-8000-0000000e5a01",
            subject: "A connector for Procore",
            text: "Read the job list.",
            service: null,
            status: "open",
            raisedBy: null,
            createdAt: "2026-11-20T10:00:00.000Z",
            resolvedAt: null,
            note: null,
            changes: [],
          },
        };
      },
    });
    const built = await screen.findByTestId("connectors-built");
    expect(within(built).getByTestId("connectors-tile-millsoft")).toHaveTextContent("MillSoft ERP");
    // The vault is a part of Built for you now: the website logins, never a secret.
    expect(await within(built).findByTestId("vault-item-browser-northside")).toHaveTextContent(
      "Agent login · agent-abc@agents.mezonas.com",
    );
    // Built for you's connectors aren't listed again under Browse.
    expect(
      within(screen.getByTestId("connectors-browse")).queryByTestId("connectors-tile-millsoft"),
    ).toBeNull();

    await userEvent.click(within(built).getByTestId("connectors-ask"));
    await userEvent.type(screen.getByTestId("connectors-ask-tool"), "Procore");
    await userEvent.type(
      screen.getByTestId("connectors-ask-what"),
      "Read the job list so the Buyer knows which job a PO is for.",
    );
    await userEvent.click(screen.getByTestId("connectors-ask-send"));
    await waitFor(() =>
      expect(asked).toEqual([
        {
          kind: "idea",
          subject: "A connector for Procore",
          text: "Read the job list so the Buyer knows which job a PO is for.",
        },
      ]),
    );
    expect(await screen.findByTestId("connectors-ask-sent")).toHaveAttribute(
      "href",
      "/requests/00000000-0000-4000-8000-0000000e5a01",
    );
  });

  it("browses every live connector: recommended first, then by kind, Beta tagged, with a search", async () => {
    renderAs("client_admin");
    const browse = await screen.findByTestId("connectors-browse");
    const recommended = within(browse).getByTestId("connectors-group-recommended");
    const gmail = within(recommended).getByTestId("connectors-tile-gmail");
    expect(gmail).toHaveTextContent("You sign in");
    expect(within(gmail).getByTestId("connectors-tile-needed")).toHaveTextContent(
      "Buyer needs this",
    );
    expect(gmail).toHaveAttribute("href", `/connectors/gmail?for=${BUYER.id}`);
    const money = within(browse).getByTestId("connectors-group-money");
    expect(within(money).getByTestId("connectors-tile-billcom")).toHaveTextContent("Beta");
    expect(within(money).getByTestId("connectors-tile-stripe")).toHaveTextContent(
      "You enter a key",
    );
    expect(within(money).getByTestId("connectors-tile-qbo")).toHaveTextContent("Connected");
    expect(within(browse).getByTestId("connectors-group-email")).toHaveTextContent("Outlook");

    await userEvent.type(within(browse).getByTestId("connectors-search"), "look");
    expect(within(browse).queryByTestId("connectors-group-recommended")).toBeNull();
    expect(within(browse).getByTestId("connectors-tile-outlook")).toBeVisible();
    expect(within(browse).queryByTestId("connectors-tile-gmail")).toBeNull();
    await userEvent.clear(within(browse).getByTestId("connectors-search"));
    await userEvent.type(within(browse).getByTestId("connectors-search"), "nothing like it");
    expect(browse).toHaveTextContent("No connector matches that.");
  });

  it("a client user reads it all: no login to add", async () => {
    renderAs("client_user");
    await screen.findByTestId("connectors-row-qbo");
    expect(await screen.findByTestId("vault-item-browser-northside")).toBeVisible();
    expect(screen.queryByTestId("vault-add")).toBeNull();
    expect(screen.queryByTestId("portal-scripts")).toBeNull();
  });

  it("says when nothing is connected yet", async () => {
    renderAs("client_admin", {
      "GET /api/portal/connectors": () => NO_CONNECTORS,
      "GET /api/access": () => ({ ...VAULT, items: [] }),
    });
    expect(await screen.findByTestId("connectors-connected")).toHaveTextContent(
      "Nothing connected yet.",
    );
    expect(screen.queryByTestId("connectors-needs")).toBeNull();
  });

  it("is where `/accounts` and `/accounts#vault` land", async () => {
    renderAs("client_admin", {}, "/accounts#vault");
    expect(await screen.findByTestId("portal-connectors")).toBeVisible();
    expect(await screen.findByTestId("vault-item-browser-northside")).toBeVisible();
  });
});
