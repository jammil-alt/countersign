// The client page's Areas tab (docs/plan.md §1.162): each business area with its switch, the
// connections it works through with this client's status and the way to connect or fix one, and
// its reports; connections no area uses under Other connections. The old Packs and Connections
// addresses open it.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const SANDBOX = SANDBOX_DETAIL.client.id;
const QBO = "00000000-0000-4000-8000-0000000000b1";
const GMAIL = "00000000-0000-4000-8000-0000000000b2";
const SLACK = "00000000-0000-4000-8000-0000000000b3";

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
  connector("slack", "Slack", "oauth2"),
];

const connection = (id: string, tenantId: string, kind: string, status: string) => ({
  id,
  tenantId,
  connector: kind,
  status,
  externalAccountId: null,
  config: kind === "qbo" ? { accountName: "Hartley Millwork LLC" } : {},
  permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
  lastSyncAt: "2026-11-19T12:00:00.000Z",
  connectedBy: null,
  createdAt: "2026-11-01T12:00:00.000Z",
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
      connections: [
        connection(QBO, DEMO, "qbo", "connected"),
        connection(GMAIL, DEMO, "gmail", "error"),
        connection(SLACK, DEMO, "slack", "connected"),
      ],
      offered: ["qbo", "gmail", "slack"],
      connectors: CONNECTORS,
      usedBy: {},
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
  it("shows each area's switch, its connections with the client's status, and its reports", async () => {
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
    // Its card (configuration, what it synced) opens in place.
    expect(screen.queryByTestId(`ops-connection-${QBO}`)).toBeNull();
    await userEvent.click(within(qbo).getByTestId("ops-area-connection-materials-qbo-manage"));
    expect(within(qbo).getByTestId(`ops-connection-${QBO}`)).toHaveTextContent(
      "Hartley Millwork LLC",
    );

    // Gmail or Outlook: the client's Gmail needs signing in again, which only the client can do.
    const email = within(purchasing).getByTestId("ops-area-connection-materials-gmail");
    expect(email).toHaveTextContent("Needs reconnecting");
    expect(email).toHaveTextContent("The client signs in again from their portal");

    // Not offered yet: we offer it, and the client connects it from their portal.
    const upload = within(purchasing).getByTestId("ops-area-connection-materials-upload");
    expect(upload).toHaveTextContent("Not connected");
    await userEvent.click(within(upload).getByTestId("ops-area-connection-materials-upload-offer"));
    await waitFor(() => expect(offers).toEqual([{ offered: ["qbo", "gmail", "slack", "upload"] }]));

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
      within(bank).getByTestId("ops-area-connection-bookkeeping-bankfeed-offer"),
    ).toHaveTextContent("Offer Bank feed");
    expect(within(books).queryByRole("link", { name: "Bank transactions" })).toBeNull();

    // A connection no area uses is under Other connections; the areas' are not.
    const other = screen.getByTestId("ops-connections-other");
    expect(other).toHaveTextContent("Other connections · 1");
    expect(within(other).getByTestId(`ops-connection-${SLACK}`)).toBeInTheDocument();
    expect(within(other).queryByTestId(`ops-connection-${GMAIL}`)).toBeNull();
    // The matrix and the offering stay on the tab.
    expect(screen.getByTestId("ops-connections-offering")).toBeInTheDocument();
  });

  it("opens from the old Packs and Connections addresses, with Setup keeping its other pages", async () => {
    for (const old of ["packs", "connections"]) {
      const { api } = demoApi();
      const view = renderAt(`/ops/clients/${DEMO}/${old}`, api);
      expect(await screen.findByTestId("ops-client-areas")).toBeInTheDocument();
      const tabs = within(screen.getByTestId("ops-client-tabs"));
      expect(tabs.getByRole("link", { name: "Areas" })).toHaveAttribute(
        "href",
        `/ops/clients/${DEMO}/areas`,
      );
      expect(tabs.queryByRole("link", { name: "Packs" })).toBeNull();
      view.unmount();
    }
  });

  it("connects a Sandbox area's no-sign-in connection here", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/packs`]: () => ({ packs: [AREAS[0]] }),
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () => ({
        connections: [],
        offered: [],
        connectors: CONNECTORS,
        usedBy: {},
        sandbox: true,
      }),
      [`POST /api/ops/clients/${SANDBOX}/connections/upload/connect`]: () => ({
        connection: connection(QBO, SANDBOX, "upload", "connected"),
      }),
    });
    renderAt(`/ops/clients/${SANDBOX}/areas`, api);
    const upload = await screen.findByTestId("ops-area-connection-materials-upload");
    await userEvent.click(
      within(upload).getByTestId("ops-area-connection-materials-upload-connect"),
    );
    expect(api.calls).toContain(`POST /api/ops/clients/${SANDBOX}/connections/upload/connect`);
    // An OAuth tool in the Sandbox is offered first, then the operator signs in.
    expect(screen.getByTestId("ops-area-connection-materials-qbo-offer")).toHaveTextContent(
      "Offer QuickBooks Online",
    );
  });
});
