// A connector's page (`/connectors/:connector`, Connectors C5, docs/connectors-plan.md §3.2, §5.2,
// §7.1, §7.2): not connected, Connect and what it can do once connected (with the picked agent's
// needs); connected, What agents can do (Read On/Off, Change Ask me first/Off, On its own only where
// set), each row folding open to its tools and agents and saved on a click; `?for=` and the gold
// strip with Allow what Buyer needs; Used by; an open request from Mezonas to approve or decline,
// Out of date when the connection changed since; Changes by Mezonas; History. A client user reads it
// all and changes nothing.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import {
  accessRow,
  changeRequest,
  connectionPage,
  connectorCard,
  connectorPageView,
  mezonasMay,
} from "../../test/connectors";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const CONN = "00000000-0000-4000-8000-0000000c6a01";
const REQ = "00000000-0000-4000-8000-0000000c6a0f";
const BUYER = { id: "00000000-0000-4000-8000-0000000a6a01", name: "Buyer" };
const BOOKKEEPER = { id: "00000000-0000-4000-8000-0000000a6a02", name: "Bookkeeper" };

const QBO = connectorCard({
  connector: "qbo",
  name: "QuickBooks Online",
  description: "Bills, vendors and purchase orders in your QuickBooks Online.",
  group: "money",
});

const READ = [
  accessRow({ verb: "read", label: "Read", usedBy: [BUYER, BOOKKEEPER] }),
  accessRow({
    verb: "read",
    entity: "bill",
    label: "Bills",
    tools: [{ id: "qbo.bill.query", description: "Find bills" }],
    usedBy: [BUYER, BOOKKEEPER],
  }),
  accessRow({ verb: "read", entity: "vendor", label: "Vendors", usedBy: [BUYER] }),
];

/** Change rows: purchase orders off (the Buyer needs it), attachments asking first. */
function change(po: "off" | "approval" = "off") {
  return [
    accessRow({ verb: "create", label: "Create", level: "approval" }),
    accessRow({
      verb: "create",
      entity: "attachable",
      label: "Attach documents",
      tools: [{ id: "qbo.attachable.upload", description: "Attach a document" }],
      usedBy: [BOOKKEEPER],
    }),
    accessRow({
      verb: "create",
      entity: "purchaseorder",
      label: "Create purchase orders",
      level: po,
      tools: [{ id: "qbo.purchaseorder.create", description: "Create a purchase order" }],
      neededBy: po === "off" ? [BUYER] : [],
      usedBy: po === "off" ? [] : [BUYER],
    }),
    accessRow({
      verb: "create",
      entity: "bill",
      label: "Create bills",
      level: "off",
    }),
    // On its own, set with us: offered only lower.
    accessRow({
      verb: "update",
      label: "Update",
      level: "auto",
      choices: ["approval", "off"],
    }),
  ];
}

const PO_GAP = {
  kind: "off_on_connection" as const,
  connector: "qbo",
  connectionId: CONN,
  blocking: true,
  fixBy: "client" as const,
  words: "Allow creating purchase orders",
  needs: [
    {
      connector: "qbo",
      verb: "create" as const,
      entity: "purchaseorder",
      level: "ask" as const,
      wantsAuto: false,
      anyOf: null,
      label: "Create purchase orders",
    },
  ],
};

function connection(o: Parameters<typeof connectionPage>[0] = { id: CONN }) {
  return connectionPage({
    accountName: "Hartley Millwork LLC",
    lastSyncAt: "2026-11-20T09:56:00.000Z",
    read: READ,
    change: change(),
    access: { reads: 3, changesAsk: 1, changesAuto: 1 },
    usedBy: [
      { agent: BUYER, ready: false, gaps: [PO_GAP] },
      { agent: BOOKKEEPER, ready: true, gaps: [] },
    ],
    history: [
      {
        id: "00000000-0000-4000-8000-0000000c6a21",
        at: "2026-11-12T10:00:00.000Z",
        by: { id: "x", name: "Ana" },
        rows: [
          {
            kind: "level",
            verb: "create",
            entity: "bill",
            from: "approval",
            to: "off",
            direction: "tighter",
            label: "Create bills: Ask me first → Off",
          },
        ],
        note: null,
        requestId: null,
        authorization: null,
      },
    ],
    ...o,
  });
}

function renderAs(
  role: "client_admin" | "client_user",
  page: ReturnType<typeof connectorPageView>,
  routes: Parameters<typeof fakeApi>[0] = {},
  path = "/connectors/qbo",
) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Hartley Millwork", role }],
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/portal/connectors/qbo": () => ({ ...page, mayEdit: role === "client_admin" }),
    "GET /api/access": () => ({
      items: [],
      setup: [],
      browserSites: [],
      canEdit: role === "client_admin",
      people: [],
    }),
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

const body = (init: RequestInit) => JSON.parse(String(init.body));

describe("a connector's page, not connected yet", () => {
  it("offers Connect and shows what it can do once connected, with the agent's needs", async () => {
    const api = renderAs(
      "client_admin",
      connectorPageView(QBO, [], {
        start: {
          read: READ.map((r) => ({ ...r, usedBy: [] })),
          change: [
            accessRow({ verb: "create", entity: "attachable", label: "Attach documents" }),
            accessRow({
              verb: "create",
              entity: "purchaseorder",
              label: "Create purchase orders",
              neededBy: [BUYER],
            }),
          ],
        },
        forAgent: {
          agent: BUYER,
          ready: false,
          gaps: [
            { ...PO_GAP, kind: "not_connected", connectionId: null, words: "Connect QuickBooks" },
          ],
        },
      }),
      {
        "POST /api/connections/qbo/authorize": () => ({
          connection: {
            connector: "qbo",
            name: "QuickBooks Online",
            description: "",
            icon: null,
            available: true,
            credentialForm: false,
            personal: false,
            connection: null,
          },
          redirectUrl: null,
        }),
      },
      `/connectors/qbo?for=${BUYER.id}`,
    );
    const start = await screen.findByTestId("connector-start");
    expect(start).toHaveTextContent("What it can do once connected");
    expect(within(start).getByTestId("access-row-read-bill-level")).toHaveTextContent("On");
    expect(within(start).getByTestId("access-row-create-purchaseorder-level")).toHaveTextContent(
      "Ask me first",
    );
    expect(within(start).getByTestId("access-row-create-purchaseorder-needed")).toHaveTextContent(
      "Buyer needs this",
    );
    // Nothing to set before signing in.
    expect(within(start).queryByTestId("access-group-read-control")).toBeNull();
    const strip = screen.getByTestId("for-agent-needs");
    expect(strip).toHaveTextContent("Buyer needs this");
    expect(strip).toHaveTextContent("Connecting turns on what Buyer needs, asking you first.");
    expect(within(strip).queryByTestId("for-agent-allow")).toBeNull();
    await userEvent.click(screen.getByTestId("connector-connect"));
    await waitFor(() => expect(api.calls).toContain("POST /api/connections/qbo/authorize"));
    // The way back from the provider lands on this page with the Buyer picked.
    expect(sessionStorage.getItem("mezonas.connect-for")).toContain(BUYER.id);
  });
});

describe("a connector's page, connected", () => {
  it("shows the account, Read and Change rows, who uses it, and the history", async () => {
    renderAs("client_admin", connectorPageView(QBO, [connection()]));
    const head = await screen.findByTestId("portal-connection-qbo");
    expect(head).toHaveTextContent("Hartley Millwork LLC");
    expect(head).toHaveTextContent("Reads 3 · changes 1, asking you first · 1 on its own");
    expect(within(head).getByTestId("portal-connection-status")).toHaveTextContent("Connected");

    const read = screen.getByTestId("access-group-read");
    expect(within(read).getByTestId("access-group-read-control-auto")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(read).getByTestId("access-row-read-bill-used")).toHaveTextContent(
      "Buyer, Bookkeeper",
    );
    const changes = screen.getByTestId("access-group-change");
    expect(changes).toHaveTextContent("Delete is always off");
    expect(changes).not.toHaveTextContent("Delete bills");
    // Reads are On or Off; writes Ask me first or Off; On its own only where it is already set.
    expect(
      within(screen.getByTestId("access-row-read-bill-control"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["On", "Off"]);
    expect(
      within(screen.getByTestId("access-row-create-bill-control"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Ask me first", "Off"]);
    expect(
      within(screen.getByTestId("access-row-update-all-control"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["On its own", "Ask me first", "Off"]);
    // A row folds open to its tools and the agents behind it.
    await userEvent.click(screen.getByTestId("access-row-create-purchaseorder-open"));
    const detail = screen.getByTestId("access-row-create-purchaseorder-detail");
    expect(detail).toHaveTextContent("Create a purchase order");
    expect(detail).toHaveTextContent("qbo.purchaseorder.create");
    expect(detail).toHaveTextContent("Buyer needs this");

    const usedBy = screen.getByTestId("connection-used-by");
    expect(within(usedBy).getByTestId(`used-by-${BOOKKEEPER.id}-state`)).toHaveTextContent(
      "Has what it needs",
    );
    expect(within(usedBy).getByTestId(`used-by-${BUYER.id}`)).toHaveTextContent(
      "Needs: Create purchase orders",
    );
    const history = screen.getByTestId("connection-history");
    expect(history).toHaveTextContent("Ana");
    expect(history).toHaveTextContent("Create bills");
    expect(history).toHaveTextContent("Ask me first→changes toOff");
  });

  it("saves a row on a click: a record type turned on, as the client admin's own change", async () => {
    const puts: unknown[] = [];
    let now = connection();
    renderAs("client_admin", connectorPageView(QBO, [now]), {
      "GET /api/portal/connectors/qbo": () => connectorPageView(QBO, [now]),
      [`PUT /api/portal/connections/${CONN}/access`]: ({ init }) => {
        puts.push(body(init));
        now = connection({ id: CONN, change: change("approval") });
        return { connection: now, rows: [] };
      },
    });
    const row = await screen.findByTestId("access-row-create-purchaseorder-control");
    await userEvent.click(
      within(row).getByTestId("access-row-create-purchaseorder-control-approval"),
    );
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      permissions: {
        entities: {
          bill: { read: "auto", create: "off" },
          vendor: { read: "auto" },
          attachable: { create: "approval" },
          purchaseorder: { create: "approval" },
        },
      },
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("access-row-create-purchaseorder-control-approval"),
      ).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("sets a whole group from its control, and shows a refusal in the API's words", async () => {
    const puts: unknown[] = [];
    renderAs("client_admin", connectorPageView(QBO, [connection()]), {
      [`PUT /api/portal/connections/${CONN}/access`]: ({ init }) => {
        puts.push(body(init));
        return new Reply(422, {
          error: {
            code: "not_allowed",
            message: "Delete stays off.",
            details: { refused: [{ row: {}, reason: "Delete stays off." }] },
          },
        });
      },
    });
    await userEvent.click(await screen.findByTestId("access-group-read-control-off"));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      permissions: {
        read: "off",
        entities: {
          bill: { read: "off", create: "off" },
          vendor: { read: "off" },
          attachable: { create: "approval" },
          purchaseorder: { create: "off" },
        },
      },
    });
    expect(await screen.findByTestId("access-refused")).toHaveTextContent("Delete stays off.");
  });

  it("with an agent picked: the gold strip, and Allow what Buyer needs sets exactly those rows", async () => {
    const allowed: string[] = [];
    renderAs(
      "client_admin",
      connectorPageView(QBO, [connection()], {
        forAgent: { agent: BUYER, ready: false, gaps: [PO_GAP] },
      }),
      {
        [`POST /api/portal/connections/${CONN}/allow-for/${BUYER.id}`]: ({ init }) => {
          allowed.push(String(init.body));
          return {
            connection: connection({ id: CONN, change: change("approval") }),
            rows: [
              {
                kind: "level",
                verb: "create",
                entity: "purchaseorder",
                from: "off",
                to: "approval",
                direction: "looser",
                label: "Create purchase orders: Off → Ask me first",
              },
            ],
            unresolved: [],
          };
        },
      },
      `/connectors/qbo?for=${BUYER.id}`,
    );
    const strip = await screen.findByTestId("for-agent-needs");
    expect(strip).toHaveTextContent("Buyer needs 1 more thing here");
    expect(within(strip).getByTestId("for-agent-list")).toHaveTextContent("Create purchase orders");
    expect(strip).toHaveTextContent("Each one still waits for your approval before it's written.");
    expect(screen.getByTestId("access-row-create-purchaseorder")).toHaveAttribute(
      "data-needed",
      "true",
    );
    await userEvent.click(within(strip).getByTestId("for-agent-allow"));
    const done = await screen.findByTestId("for-agent-allowed");
    expect(allowed).toEqual(["{}"]);
    expect(done).toHaveTextContent("Buyer has what it needs here");
    expect(done).toHaveTextContent("Create purchase orders: Off → Ask me first");
    expect(done).toHaveTextContent("Allowed by you just now.");
    expect(screen.queryByTestId("for-agent-needs")).toBeNull();
  });

  it("a client user reads it all and changes nothing", async () => {
    renderAs(
      "client_user",
      connectorPageView(
        QBO,
        [
          connection({
            id: CONN,
            mezonasMay: mezonasMay(),
            openRequest: changeRequest({ id: REQ, connectionId: CONN }),
          }),
        ],
        { forAgent: { agent: BUYER, ready: false, gaps: [PO_GAP] } },
      ),
      {},
      `/connectors/qbo?for=${BUYER.id}`,
    );
    await screen.findByTestId("portal-connection-qbo");
    expect(screen.queryByTestId("access-group-read-control")).toBeNull();
    expect(screen.queryByTestId("access-row-create-bill-control")).toBeNull();
    expect(screen.getByTestId("access-row-create-bill-level")).toHaveTextContent("Off");
    expect(screen.getByTestId("access-row-update-all-level")).toHaveTextContent("On its own");
    expect(screen.queryByTestId("for-agent-allow")).toBeNull();
    expect(screen.getByTestId("for-agent-admin-only")).toHaveTextContent(
      "A client admin can allow this.",
    );
    expect(screen.queryByTestId(`used-by-${BUYER.id}-allow`)).toBeNull();
    expect(screen.queryByTestId("portal-connection-disconnect-start")).toBeNull();
    for (const choice of ["ask", "needs", "any"]) {
      expect(screen.getByTestId(`mezonas-may-${choice}`)).toBeDisabled();
    }
    expect(screen.getByTestId("mezonas-may-admin-only")).toBeVisible();
    const request = screen.getByTestId("change-request");
    expect(within(request).queryByTestId("change-request-approve")).toBeNull();
    expect(within(request).getByTestId("change-request-admin-only")).toHaveTextContent(
      "A client admin answers this.",
    );
  });
});

describe("a change Mezonas asks to make, on the page", () => {
  const rows = [
    {
      kind: "level" as const,
      verb: "create" as const,
      entity: "purchaseorder",
      from: "off" as const,
      to: "approval" as const,
      direction: "looser" as const,
      label: "Create purchase orders: Off → Ask me first",
    },
  ];
  const request = (o: Partial<Parameters<typeof changeRequest>[0]> = {}) =>
    changeRequest({
      id: REQ,
      connectionId: CONN,
      rows,
      reason: "The Buyer sends the POs you approve to QuickBooks.",
      forAgent: BUYER,
      ...o,
    });

  it("approves it with a note back", async () => {
    const posts: unknown[] = [];
    renderAs(
      "client_admin",
      connectorPageView(QBO, [connection({ id: CONN, openRequest: request() })]),
      {
        [`POST /api/portal/connection-requests/${REQ}/approve`]: ({ init }) => {
          posts.push(body(init));
          return {
            request: request({ status: "approved" }),
            connection: connection({ id: CONN, change: change("approval") }),
          };
        },
      },
    );
    const card = await screen.findByTestId("change-request");
    expect(card).toHaveTextContent("Mezonas asks to change QuickBooks Online access");
    expect(card).toHaveTextContent("For Buyer · asked by Ana, your Mezonas lead");
    expect(within(card).getByTestId("change-request-state")).toHaveTextContent("Waiting on you");
    expect(within(card).getByTestId("change-request-rows")).toHaveTextContent(
      "Create purchase ordersOff→changes toAsk me first",
    );
    expect(within(card).getByTestId("change-request-reason")).toHaveTextContent(
      "The Buyer sends the POs you approve to QuickBooks.",
    );
    await userEvent.click(within(card).getByTestId("change-request-add-note"));
    await userEvent.type(within(card).getByTestId("change-request-note"), "Thanks");
    await userEvent.click(within(card).getByTestId("change-request-approve"));
    await waitFor(() => expect(posts).toEqual([{ note: "Thanks" }]));
    expect(await within(card).findByTestId("change-request-answered")).toHaveTextContent(
      "Approved by you just now.",
    );
  });

  it("declines it: nothing changes", async () => {
    const posts: unknown[] = [];
    renderAs(
      "client_admin",
      connectorPageView(QBO, [connection({ id: CONN, openRequest: request() })]),
      {
        [`POST /api/portal/connection-requests/${REQ}/decline`]: ({ init }) => {
          posts.push(body(init));
          return { request: request({ status: "declined" }) };
        },
      },
    );
    const card = await screen.findByTestId("change-request");
    await userEvent.click(within(card).getByTestId("change-request-decline"));
    await waitFor(() => expect(posts).toEqual([{}]));
    expect(await within(card).findByTestId("change-request-answered")).toHaveTextContent(
      "Declined by you just now. Nothing changed; your lead is told.",
    );
    expect(within(card).getByTestId("change-request-state")).toHaveTextContent("Declined");
  });

  it("says Out of date when the connection changed since, and offers no Approve", async () => {
    renderAs(
      "client_admin",
      connectorPageView(QBO, [connection({ id: CONN, openRequest: request({ outOfDate: true }) })]),
    );
    const card = await screen.findByTestId("change-request");
    expect(within(card).getByTestId("change-request-state")).toHaveTextContent("Out of date");
    expect(within(card).getByTestId("change-request-out-of-date")).toHaveTextContent(
      "approving it would change nothing",
    );
    expect(within(card).queryByTestId("change-request-approve")).toBeNull();
    expect(within(card).getByTestId("change-request-decline")).toBeVisible();
  });

  it("turns Out of date when approving is refused as out of date", async () => {
    renderAs(
      "client_admin",
      connectorPageView(QBO, [connection({ id: CONN, openRequest: request() })]),
      {
        [`POST /api/portal/connection-requests/${REQ}/approve`]: () =>
          new Reply(409, { error: { code: "out_of_date", message: "the connection changed" } }),
      },
    );
    const card = await screen.findByTestId("change-request");
    await userEvent.click(within(card).getByTestId("change-request-approve"));
    expect(await within(card).findByTestId("change-request-out-of-date")).toBeVisible();
    expect(within(card).getByTestId("change-request-state")).toHaveTextContent("Out of date");
    expect(within(card).queryByTestId("change-request-approve")).toBeNull();
  });
});

describe("Changes by Mezonas", () => {
  it("starts at Ask me each time; the client admin allows what agents need for 30 days", async () => {
    const puts: unknown[] = [];
    renderAs("client_admin", connectorPageView(QBO, [connection()]), {
      [`PUT /api/portal/connections/${CONN}/mezonas-may`]: ({ init }) => {
        puts.push(body(init));
        return {
          mezonasMay: mezonasMay({ until: "2026-12-20T09:00:00.000Z" }),
        };
      },
    });
    const may = await screen.findByTestId("mezonas-may");
    expect(within(may).getByTestId("mezonas-may-ask")).toHaveAttribute("aria-checked", "true");
    expect(within(may).queryByTestId("mezonas-may-duration")).toBeNull();
    await userEvent.click(within(may).getByTestId("mezonas-may-needs"));
    await waitFor(() => expect(puts).toEqual([{ choice: "needs", duration: "30_days" }]));
    expect(within(may).getByTestId("mezonas-may-needs")).toHaveAttribute("aria-checked", "true");
    expect(within(may).getByTestId("mezonas-may-note")).toHaveTextContent(
      /Set by Pat Lee on .*, until .*\. You're told about every change/,
    );
    await userEvent.click(within(may).getByTestId("mezonas-may-duration-until_off"));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ choice: "needs", duration: "until_off" });
  });

  it("shows who set it and until when, takes it back, and says when one has ended", async () => {
    const puts: unknown[] = [];
    let held: ReturnType<typeof mezonasMay> | null = mezonasMay({ choice: "any" });
    const page = () => connectorPageView(QBO, [connection({ id: CONN, mezonasMay: held })]);
    renderAs("client_admin", page(), {
      "GET /api/portal/connectors/qbo": page,
      [`PUT /api/portal/connections/${CONN}/mezonas-may`]: ({ init }) => {
        puts.push(body(init));
        held = null;
        return { mezonasMay: null };
      },
    });
    const may = await screen.findByTestId("mezonas-may");
    expect(within(may).getByTestId("mezonas-may-any")).toHaveAttribute("aria-checked", "true");
    expect(within(may).getByTestId("mezonas-may-duration-until_off")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(may).getByTestId("mezonas-may-note")).toHaveTextContent(
      /Set by Pat Lee on .*, until you turn it off\./,
    );
    await userEvent.click(within(may).getByTestId("mezonas-may-ask"));
    await waitFor(() => expect(puts).toEqual([{ choice: "ask", duration: "until_off" }]));
    expect(within(may).getByTestId("mezonas-may-ask")).toHaveAttribute("aria-checked", "true");
  });

  it("reads an ended one as Ask me each time, and says it ended", async () => {
    renderAs(
      "client_admin",
      connectorPageView(QBO, [
        connection({
          id: CONN,
          mezonasMay: mezonasMay({ until: "2026-11-01T09:00:00.000Z", active: false }),
        }),
      ]),
    );
    const may = await screen.findByTestId("mezonas-may");
    expect(within(may).getByTestId("mezonas-may-ask")).toHaveAttribute("aria-checked", "true");
    expect(within(may).getByTestId("mezonas-may-note")).toHaveTextContent(
      /What Pat Lee allowed ended .*: Mezonas asks you each time again\./,
    );
  });
});
