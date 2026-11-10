// C4 Accounts and vault (docs/ui-plan.md): the tools with their state and the agents that use
// them, the numbers on top, each tool's matrix opened on request (a client admin is offered only
// stricter levels), the vault in the rail with its website logins (never a secret), and the tools
// still to connect. A client user reads it all and changes nothing.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const QBO_CONN = "00000000-0000-4000-8000-0000000c0a01";
const GMAIL_CONN = "00000000-0000-4000-8000-0000000c0a02";
const SITE_CONN = "00000000-0000-4000-8000-0000000c0a03";
const AGENT = "00000000-0000-4000-8000-0000000a0a01";

const MATRIX = { read: "auto", create: "approval", update: "approval", delete: "off" };
const RELEASE_OFF = {
  mode: "off",
  person: null,
  channel: "email",
  window: "run",
  sentTo: null,
  updatedAt: null,
  live: [],
};

const QBO = {
  connector: "qbo",
  name: "QuickBooks Online",
  description: "Bills, vendors and items.",
  icon: null,
  available: true,
  credentialForm: false,
  personal: false,
  connection: {
    id: QBO_CONN,
    status: "connected",
    externalAccountId: "9130357766900456",
    accountName: "Harbor Millwork LLC",
    lastSyncAt: "2026-11-05T18:00:00.000Z",
    permissions: MATRIX,
    access: [
      {
        toolId: "qbo.bill.query",
        description: "Find bills",
        verb: "read",
        level: "auto",
        access: "runs",
      },
    ],
    usedBy: [{ id: AGENT, name: "Pia" }],
    connectedByYou: true,
  },
};

const GMAIL_BROKEN = {
  connector: "gmail",
  name: "Gmail",
  description: "Send email from your Gmail.",
  icon: null,
  available: true,
  credentialForm: false,
  personal: true,
  connection: {
    id: GMAIL_CONN,
    status: "error",
    externalAccountId: "ap@harbor.example.com",
    accountName: null,
    lastSyncAt: null,
    permissions: MATRIX,
    access: [],
    usedBy: [],
    connectedByYou: false,
  },
};

const ZOHO = {
  connector: "zoho_crm",
  name: "Zoho CRM",
  description: "Leads, contacts, accounts and deals in your Zoho CRM.",
  icon: null,
  available: true,
  credentialForm: false,
  personal: false,
  connection: null,
};

function qboItem() {
  return {
    connectionId: QBO_CONN,
    connector: "qbo",
    name: "QuickBooks Online",
    kind: "oauth",
    status: "connected",
    externalAccountId: null,
    secret: { set: true, fields: [], updatedAt: null },
    credentialForm: false,
    matrix: MATRIX,
    tools: [{ id: "qbo.bill.query", description: "Find bills", verb: "read" }],
    agents: [
      {
        agentId: AGENT,
        name: "Pia",
        limits: {},
        effective: MATRIX,
        tools: null,
        revoked: false,
        updatedAt: null,
      },
    ],
    browser: null,
    release: RELEASE_OFF,
  };
}

function siteItem() {
  return {
    ...qboItem(),
    connectionId: SITE_CONN,
    connector: "browser",
    name: "Hafele dealer portal",
    kind: "browser",
    secret: {
      set: true,
      fields: [
        {
          name: "username",
          label: "Agent account username",
          secret: false,
          hint: null,
          set: true,
          value: "agent@harbor.example.com",
        },
        {
          name: "password",
          label: "Agent account password",
          secret: true,
          hint: null,
          set: true,
          value: null,
        },
      ],
      updatedAt: "2026-11-03T10:00:00.000Z",
    },
    credentialForm: true,
    agents: [],
    browser: {
      site: { slug: "hafele", name: "Hafele dealer portal", tier: "low" },
      effectiveTier: "low",
      siteVersion: 1,
      identity: { email: "agent-abc@agents.mezonas.com", phone: null },
      stricter: { noWrites: false, personSignIn: false },
      signInsPerDay: 10,
      signInsToday: 0,
      stopped: { reason: "the password stopped working", at: "2026-11-04T10:00:00.000Z" },
    },
  };
}

function renderAs(
  role: "client_admin" | "client_user",
  routes: Record<string, Parameters<typeof fakeApi>[0][string]> = {},
) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Harbor Millwork", role }],
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/connections": () => ({ connections: [QBO, GMAIL_BROKEN, ZOHO] }),
    "GET /api/access": () => ({
      items: [qboItem(), siteItem()],
      setup: [],
      browserSites: [
        { slug: "rugby", name: "Rugby Architectural", tier: "low", secondFactor: "email" },
      ],
      canEdit: role === "client_admin",
      people: [],
    }),
    "GET /api/connections/upload/forwarding": () => new Reply(404, {}),
    "GET /api/documents": () => ({ items: [] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={["/accounts"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("C4 Accounts and vault", () => {
  it("shows each tool as a row with its agents, the vault and the tools to add; no tiles", async () => {
    renderAs("client_admin");
    expect(await screen.findByRole("heading", { name: "Accounts", level: 1 })).toBeVisible();
    // Connections and the vault only (Review 1): no stat tiles, no upload or documents here.
    expect(screen.queryByTestId("accounts-stat-connected")).toBeNull();
    expect(screen.queryByTestId("portal-upload")).toBeNull();
    expect(screen.queryByTestId("portal-recent-documents")).toBeNull();

    const qbo = await screen.findByTestId("portal-connection-qbo");
    expect(screen.getByTestId("portal-connections-list")).toContainElement(qbo);
    // Folded: what agents may do opens from the row.
    expect(within(qbo).queryByTestId("matrix")).toBeNull();
    expect(qbo).toHaveTextContent("Harbor Millwork LLC");
    expect(within(qbo).getByTestId("portal-connection-status")).toHaveTextContent("Connected");
    expect(qbo).toHaveTextContent("Pia");
    // A broken tool says so in words, and the admin reconnects it from its card.
    const gmail = screen.getByTestId("portal-connection-gmail");
    expect(within(gmail).getByTestId("portal-connection-status")).toHaveTextContent(
      "Needs reconnecting",
    );
    expect(within(gmail).getByTestId("portal-connection-connect")).toHaveTextContent("Reconnect");

    // The vault: the website login and why it needs you; never a secret.
    const site = await screen.findByTestId("vault-item-browser-hafele");
    expect(within(site).getByTestId("vault-item-state")).toHaveTextContent("Needs you");
    expect(within(site).getByTestId("vault-browser-stopped")).toHaveTextContent(
      "the password stopped working",
    );
    expect(site).toHaveTextContent("Agent login · agent-abc@agents.mezonas.com");
    expect(screen.queryByTestId("vault-add-panel")).toBeNull();

    // Who approves what is in Settings, under Approvals: a link, not a second copy here.
    expect(
      within(screen.getByTestId("accounts-signoff")).getByRole("link", {
        name: "Settings, under Approvals",
      }),
    ).toHaveAttribute("href", "/settings/approvals");

    const add = screen.getByTestId("portal-connections-available");
    expect(within(add).getByTestId("portal-connection-zoho_crm")).toHaveTextContent("Zoho CRM");

    // Accounts holds the tools and the vault only: upload and forwarding are on the agents that
    // read documents (and `/upload`).
    expect(screen.queryByTestId("portal-upload-input")).toBeNull();
    expect(screen.queryByTestId("portal-recent-documents")).toBeNull();
    expect(screen.queryByTestId("portal-forwarding")).toBeNull();
  });

  it("opens a tool's matrix and tightens it: only the saved level or stricter", async () => {
    const patches: unknown[] = [];
    renderAs("client_admin", {
      [`PATCH /api/connections/${QBO_CONN}/permissions`]: ({ init }) => {
        patches.push(JSON.parse(String(init.body)));
        return { connection: QBO };
      },
    });
    const qbo = await screen.findByTestId("portal-connection-qbo");
    expect(within(qbo).queryByTestId("matrix")).toBeNull();
    await userEvent.click(within(qbo).getByTestId("portal-connection-permissions-toggle"));
    const matrix = within(qbo).getByTestId("matrix");
    const create = within(matrix).getByTestId("matrix-create-select");
    expect(
      within(create)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Needs approval", "Off"]);
    await userEvent.selectOptions(create, "off");
    await userEvent.click(within(qbo).getByTestId("matrix-changes-save"));
    await waitFor(() => expect(patches).toEqual([{ create: "off" }]));
    // The agent's grant and its tools are there too.
    expect(within(qbo).getByTestId(`vault-agent-${AGENT}`)).toHaveTextContent("Pia");
    expect(within(qbo).getByTestId("portal-connection-tools")).toHaveTextContent("Find bills");
  });

  it("Add a login to the vault opens the sites a login can be set up on", async () => {
    renderAs("client_admin");
    await screen.findByTestId("vault-item-browser-hafele");
    await userEvent.click(screen.getByTestId("accounts-add-login"));
    const panel = screen.getByTestId("vault-add-panel");
    expect(within(panel).getByTestId("vault-browser-offer-rugby")).toHaveTextContent(
      "Rugby Architectural",
    );
    await userEvent.click(screen.getByTestId("vault-add"));
    expect(screen.queryByTestId("vault-add-panel")).toBeNull();
  });

  it("lands `/access` on the vault", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/connections": () => ({ connections: [] }),
      "GET /api/access": () => ({ items: [], setup: [], canEdit: true, people: [] }),
    });
    render(
      <MemoryRouter initialEntries={["/access"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("vault-card")).toBeInTheDocument();
    expect(screen.getByTestId("vault-empty")).toHaveTextContent("No logins in your vault yet.");
  });

  it("a client user reads it all and changes nothing", async () => {
    renderAs("client_user");
    const qbo = await screen.findByTestId("portal-connection-qbo");
    expect(screen.queryByTestId("accounts-add-login")).toBeNull();
    expect(screen.queryByTestId("accounts-connect")).toBeNull();
    await userEvent.click(within(qbo).getByTestId("portal-connection-permissions-toggle"));
    expect(within(qbo).queryByTestId("matrix-create-select")).toBeNull();
    expect(within(qbo).getByTestId("matrix-create-level")).toHaveTextContent("Needs approval");
    expect(within(qbo).queryByTestId("portal-connection-disconnect-start")).toBeNull();
    const site = await screen.findByTestId("vault-item-browser-hafele");
    expect(within(site).queryByTestId("vault-replace")).toBeNull();
    expect(screen.queryByTestId("vault-add")).toBeNull();
    // The admin connects tools; a client user is told so.
    expect(screen.getByTestId("portal-connection-zoho_crm")).toHaveTextContent(
      "Your admin can connect it.",
    );
  });
});

// R8 (docs/plan.md §1.86; ARCHITECTURE §10.14 "Connections"): the tools still to connect, grouped
// by kind, each saying how it connects; the websites an agent may be given a login for, with them.
describe("the tools to connect, grouped", () => {
  const offered = (connector: string, name: string, over: Record<string, unknown> = {}) => ({
    connector,
    name,
    description: `${name}, for your agents.`,
    icon: null,
    available: true,
    credentialForm: false,
    personal: false,
    connection: null,
    ...over,
  });
  const LIST = [
    offered("zoho_crm", "Zoho CRM"),
    offered("gsheets", "Google Sheets"),
    offered("bankfeed", "Bank feed"),
    offered("ramp", "Ramp", { credentialForm: true }),
    offered("slack", "Slack", { available: false }),
    offered("mystery", "Something new"),
  ];

  it("lists them by kind with how each connects, and website logins open the vault", async () => {
    renderAs("client_admin", { "GET /api/connections": () => ({ connections: LIST }) });
    const add = await screen.findByTestId("portal-connections-available");
    expect(
      within(add)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      "Add another tool",
      "Accounting and money",
      "Messages and calls",
      "Files and sheets",
      "Customers and sales",
      "Other tools",
      "Website logins",
    ]);
    const money = within(add).getByTestId("portal-connections-group-money");
    expect(within(money).getByTestId("portal-connection-bankfeed")).toBeInTheDocument();
    // You sign in, or you enter a key: each says which.
    expect(
      within(within(money).getByTestId("portal-connection-bankfeed")).getByTestId(
        "portal-connection-how",
      ),
    ).toHaveTextContent("You sign in to it. We never see your password.");
    expect(
      within(within(money).getByTestId("portal-connection-ramp")).getByTestId(
        "portal-connection-how",
      ),
    ).toHaveTextContent("You enter its key in your vault.");
    // Not offered yet: no how.
    const slack = within(add).getByTestId("portal-connection-slack");
    expect(within(slack).getByTestId("portal-connection-unavailable")).toBeInTheDocument();
    expect(within(slack).queryByTestId("portal-connection-how")).toBeNull();
    expect(within(add).getByTestId("portal-connections-group-other")).toHaveTextContent(
      "Something new",
    );
    // A website: the login of an account made for the agents, into the vault.
    const logins = within(add).getByTestId("portal-connections-group-logins");
    expect(logins).toHaveTextContent("You enter the login of an account made for your agents.");
    await userEvent.click(within(logins).getByTestId("portal-connections-site-rugby-login"));
    expect(
      within(screen.getByTestId("vault-add-panel")).getByTestId("vault-browser-offer-rugby"),
    ).toBeInTheDocument();
  });

  it("offers a client user no website logins, in their language", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: TENANT, name: "Harbor Millwork", role: "client_user" }],
        language: { effective: "fr", user: "fr", client: null },
      }),
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/connections": () => ({ connections: LIST }),
      "GET /api/access": () => ({
        items: [],
        setup: [],
        browserSites: [
          { slug: "rugby", name: "Rugby Architectural", tier: "low", secondFactor: "email" },
        ],
        canEdit: false,
        people: [],
      }),
    });
    render(
      <MemoryRouter initialEntries={["/accounts"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const add = await screen.findByTestId("portal-connections-available");
    expect(within(add).getByTestId("portal-connections-group-sales")).toHaveTextContent(
      "Clients et ventes",
    );
    expect(within(add).queryByTestId("portal-connections-group-logins")).toBeNull();
  });
});
