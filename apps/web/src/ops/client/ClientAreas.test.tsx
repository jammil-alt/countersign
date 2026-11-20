// The client page's Areas tab (docs/plan.md §1.162): each business area with its switch, the
// connections it needs with this client's status (and the Connectors tab's flags), each linking to
// its connector on Setup's Connectors (§1.161), Recommend for one not yet recommended, and its
// reports. The old Packs address opens it; Connectors stays on Setup.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const QBO = "00000000-0000-4000-8000-0000000000b1";
const GMAIL = "00000000-0000-4000-8000-0000000000b2";

const connector = (id: string, name: string, auth: string) => ({
  id,
  name,
  description: `${name} tools.`,
  icon: null,
  auth,
  available: true,
  tools: [],
});

const CONNECTORS = [
  connector("upload", "Upload", "none"),
  connector("qbo", "QuickBooks Online", "oauth2"),
  connector("gmail", "Gmail", "oauth2"),
  connector("outlook", "Outlook", "oauth2"),
  connector("bankfeed", "Bank feed", "oauth2"),
];

const connection = (id: string, kind: string, status: string) => ({
  id,
  tenantId: DEMO,
  connector: kind,
  status,
  externalAccountId: null,
  config: {},
  permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
  lastSyncAt: "2026-11-19T12:00:00.000Z",
  connectedBy: null,
  createdAt: "2026-11-01T12:00:00.000Z",
});

/** The Connectors tab's view of a connection (§1.161), with its flags. */
const card = (kind: string, name: string, id: string, status: string, needsSomething: boolean) => ({
  connector: kind,
  name,
  description: "",
  icon: null,
  auth: "oauth2",
  personal: false,
  multiple: false,
  available: true,
  beta: false,
  recommended: false,
  custom: false,
  group: "Other",
  connections: [
    {
      id,
      status,
      accountName: null,
      lastSyncAt: null,
      usedBy: [],
      access: { reads: 1, changesAsk: 1, changesAuto: 0 },
      needsSomething,
      openRequest: false,
      mezonasMay: null,
    },
  ],
});

const AREAS = [
  {
    id: "materials",
    name: "Materials",
    area: "Purchasing",
    description: "Material cost management and purchasing.",
    enabled: true,
    enabledAt: "2026-11-01T00:00:00.000Z",
    screens: [{ route: "/reports/materials/prices", title: "Price watch" }],
    connections: [
      { connectors: ["upload"], use: "Invoices and quotes the client uploads." },
      { connectors: ["qbo"], use: "Vendors, bills and their prices." },
      { connectors: ["gmail", "outlook"], use: "Requests for quotes, sent by email." },
    ],
  },
  {
    id: "bookkeeping",
    name: "Bookkeeping",
    area: "Bookkeeping",
    description: "Bookkeeping from the bank feed.",
    enabled: false,
    enabledAt: null,
    screens: [{ route: "/reports/bookkeeping/transactions", title: "Bank transactions" }],
    connections: [
      { connectors: ["bankfeed"], use: "Bank and card transactions." },
      { connectors: ["qbo"], use: "The chart of accounts." },
    ],
  },
];

function demoApi() {
  const offers: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${DEMO}/packs`]: () => ({ packs: AREAS }),
    [`GET /api/ops/clients/${DEMO}/connections`]: () => ({
      connections: [connection(QBO, "qbo", "connected"), connection(GMAIL, "gmail", "error")],
      offered: ["qbo", "gmail"],
      connectors: CONNECTORS,
      usedBy: {},
      sandbox: false,
    }),
    [`GET /api/ops/clients/${DEMO}/connectors`]: () => ({
      connected: [
        card("qbo", "QuickBooks Online", QBO, "connected", true),
        card("gmail", "Gmail", GMAIL, "error", false),
      ],
      builtForYou: [],
      recommended: [],
      requests: [],
      agents: [],
      sandbox: false,
    }),
    [`PUT /api/ops/clients/${DEMO}/connectors`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as { offered: string[] };
      offers.push(body);
      return body;
    },
  });
  return { api, offers };
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

describe("the client page's Areas tab", () => {
  it("shows each area's switch, the connections it needs with their status, and its reports", async () => {
    const { api, offers } = demoApi();
    renderAt(`/ops/clients/${DEMO}/areas`, api);
    const purchasing = await screen.findByTestId("ops-client-area-materials");
    // The area's name as people see it, not the pack's.
    expect(within(purchasing).getByRole("heading", { name: "Purchasing" })).toBeInTheDocument();
    expect(within(purchasing).getByTestId("ops-client-area-on-materials")).toHaveTextContent("On");

    const qbo = within(purchasing).getByTestId("ops-area-connection-materials-qbo");
    expect(qbo).toHaveTextContent("QuickBooks Online");
    expect(qbo).toHaveTextContent("Vendors, bills and their prices.");
    expect(qbo).toHaveTextContent("Connected");
    // The Connectors tab's flag, read from its route (§1.161), not worked out again.
    expect(
      await within(qbo).findByTestId("ops-area-connection-materials-qbo-needs"),
    ).toHaveTextContent("An agent needs something here");
    // Changes happen on the connector's own page, on Setup's Connectors.
    expect(within(qbo).getByTestId("ops-area-connection-materials-qbo-open")).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/connectors/qbo`,
    );
    expect(within(qbo).queryByTestId("ops-area-connection-materials-qbo-recommend")).toBeNull();

    // Gmail or Outlook: the client's Gmail needs signing in again, which only the client can do.
    const email = within(purchasing).getByTestId("ops-area-connection-materials-gmail");
    expect(email).toHaveTextContent("Needs reconnecting");
    expect(email).toHaveTextContent("The client signs in again from their portal");

    // Not recommended yet: we recommend it, and the client connects it from their portal.
    const upload = within(purchasing).getByTestId("ops-area-connection-materials-upload");
    expect(upload).toHaveTextContent("Not connected");
    await userEvent.click(
      within(upload).getByTestId("ops-area-connection-materials-upload-recommend"),
    );
    await waitFor(() => expect(offers).toEqual([{ offered: ["qbo", "gmail", "upload"] }]));

    expect(within(purchasing).getByRole("link", { name: "Price watch" })).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/reports/materials/prices`,
    );

    // An area that's off: its switch, what it would need, and no reports yet.
    const books = screen.getByTestId("ops-client-area-bookkeeping");
    expect(within(books).getByTestId(`pack-enable-bookkeeping-${DEMO}`)).toHaveTextContent(
      "Switch on",
    );
    const bank = within(books).getByTestId("ops-area-connection-bookkeeping-bankfeed");
    expect(bank).toHaveTextContent("Not connected");
    expect(
      within(bank).getByTestId("ops-area-connection-bookkeeping-bankfeed-open"),
    ).toHaveAttribute("href", `/ops/clients/${DEMO}/connectors/bankfeed`);
    expect(within(books).queryByRole("link", { name: "Bank transactions" })).toBeNull();

    // The client's connections themselves are not here: they are Setup's Connectors.
    expect(screen.queryByTestId("ops-connections-offering")).toBeNull();
  });

  it("opens from the old Packs address; Setup keeps Connectors", async () => {
    const { api } = demoApi();
    renderAt(`/ops/clients/${DEMO}/packs`, api);
    expect(await screen.findByTestId("ops-client-areas")).toBeInTheDocument();
    const tabs = within(screen.getByTestId("ops-client-tabs"));
    expect(tabs.getByRole("link", { name: "Areas" })).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/areas`,
    );
    expect(tabs.queryByRole("link", { name: "Packs" })).toBeNull();
    expect(tabs.getByRole("link", { name: "Setup" })).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/connections`,
    );
  });
});
