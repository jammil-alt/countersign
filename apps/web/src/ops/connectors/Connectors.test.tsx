// Connectors C6 (docs/connectors-plan.md §7, §7.1, §7.2): the client's Connectors tab, a
// connector's page where we edit as if it were ours (the footer previews and the button follows
// the outcome, a reason is required, the result shows), Withdraw, and the agent's Needs and
// Readiness panels with Send to client.
import {
  type ChangeRequestView,
  type ConnectorCardView,
  connectorAccessRoutes,
  type OpsConnectionPageView,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";
import { NeedsPanel, ReadinessPanel } from "./AgentPanels";
import { changeButtonWords, changeSummaryWords, mezonasMayWords } from "./words";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const CONN = "00000000-0000-4000-8000-0000000000c1";
const AGENT = "00000000-0000-4000-8000-0000000000b7";
const REQ = "00000000-0000-4000-8000-0000000000d1";
const AT = "2026-11-20T12:00:00.000Z";

const DETAIL = {
  client: { id: CLIENT, name: "Hartley Millwork", timezone: "UTC", settings: {}, createdAt: AT },
  agents: [],
  connections: [],
  members: [],
};

const MAY = {
  choice: "needs" as const,
  until: "2026-12-20T12:00:00.000Z",
  setBy: { id: "u1", name: "Pat Lee" },
  setAt: AT,
  active: true,
};

const REQUEST: ChangeRequestView = {
  id: REQ,
  connectionId: CONN,
  connector: "qbo",
  connectorName: "QuickBooks Online",
  status: "open",
  direction: "looser",
  rows: [
    {
      kind: "level",
      verb: "create",
      entity: "purchase_order",
      from: "off",
      to: "approval",
      direction: "looser",
      label: "Create purchase orders: Off → Ask me first",
    },
  ],
  reason: "The Buyer sends the POs you approve.",
  requestedBy: { id: "u2", name: "Ana Ruiz" },
  forAgent: { id: AGENT, name: "Buyer" },
  outOfDate: false,
  createdAt: AT,
  expiresAt: "2026-12-04T12:00:00.000Z",
  closedAt: null,
  closedBy: null,
  answerNote: null,
};

const GAP = {
  kind: "off_on_connection" as const,
  connector: "qbo",
  connectionId: CONN,
  blocking: true,
  fixBy: "client" as const,
  words: "Allow creating purchase orders",
  needs: [],
};

function card(over: Partial<ConnectorCardView> = {}): ConnectorCardView {
  return {
    connector: "qbo",
    name: "QuickBooks Online",
    description: "Bills and vendors. You sign in to QuickBooks yourself.",
    icon: null,
    auth: "oauth2",
    personal: false,
    multiple: false,
    available: true,
    beta: false,
    recommended: false,
    custom: false,
    group: "Money",
    connections: [
      {
        id: CONN,
        status: "connected",
        accountName: "Hartley Millwork LLC",
        lastSyncAt: AT,
        usedBy: [{ id: AGENT, name: "Buyer" }],
        access: { reads: 9, changesAsk: 3, changesAuto: 0 },
        needsSomething: true,
        openRequest: true,
        mezonasMay: MAY,
      },
    ],
    ...over,
  };
}

function tab(over: Record<string, unknown> = {}) {
  return {
    connected: [card()],
    builtForYou: [],
    recommended: [
      card({
        connector: "gmail",
        name: "Gmail",
        description: "Send email from your mailbox.",
        recommended: true,
        group: "Email",
        connections: [],
      }),
    ],
    requests: [REQUEST],
    agents: [
      {
        agent: { id: AGENT, name: "Buyer" },
        ready: false,
        gaps: [
          GAP,
          {
            ...GAP,
            kind: "not_connected" as const,
            connector: "gmail",
            connectionId: null,
            words: "Connect Gmail",
          },
        ],
      },
    ],
    sandbox: false,
    ...over,
  };
}

/** The older list: what is offered, and each connection's stored matrix. */
function oldList(over: Record<string, unknown> = {}) {
  return {
    connections: [
      {
        id: CONN,
        tenantId: CLIENT,
        connector: "qbo",
        status: "connected",
        externalAccountId: "9341458640918607",
        config: { accountName: "Hartley Millwork LLC" },
        permissions: {
          read: "auto",
          create: "approval",
          update: "approval",
          delete: "off",
          entities: { purchase_order: { create: "off" }, bill: { create: "off" } },
        },
        lastSyncAt: AT,
        connectedBy: null,
        createdAt: AT,
      },
    ],
    offered: ["gmail"],
    connectors: [],
    usedBy: {},
    sandbox: false,
    ...over,
  };
}

const row = (over: Partial<OpsConnectionPageView["read"][number]>) => ({
  group: "change" as const,
  verb: "create" as const,
  entity: null,
  label: "Create",
  level: "approval" as const,
  choices: ["auto" as const, "approval" as const, "off" as const],
  scope: null,
  tools: [],
  usedBy: [],
  neededBy: [],
  ...over,
});

function connectorPage(over: Partial<OpsConnectionPageView> = {}, sandbox = false) {
  const connection: OpsConnectionPageView = {
    id: CONN,
    status: "connected",
    accountName: "Hartley Millwork LLC",
    lastSyncAt: AT,
    connectedByYou: false,
    read: [
      row({
        group: "read",
        verb: "read",
        label: "Bills",
        entity: "bill",
        level: "auto",
        choices: ["auto", "off"],
      }),
    ],
    change: [
      row({
        entity: "purchase_order",
        label: "Create purchase orders",
        level: "off",
        tools: [{ id: "qbo.purchaseorder.create", description: "Create a PO" }],
        neededBy: [{ id: AGENT, name: "Buyer" }],
      }),
      row({ entity: "bill", label: "Create bills", level: "off" }),
      row({ verb: "update", label: "Update", level: "approval" }),
    ],
    access: { reads: 9, changesAsk: 3, changesAuto: 0 },
    usedBy: [{ agent: { id: AGENT, name: "Buyer" }, ready: false, gaps: [GAP] }],
    mezonasMay: MAY,
    openRequest: REQUEST,
    history: [
      {
        id: "h1",
        at: AT,
        by: { id: "u1", name: "Pat Lee" },
        rows: [REQUEST.rows[0] as ChangeRequestView["rows"][number]],
        note: null,
        requestId: null,
        authorization: null,
      },
    ],
    config: { query: "from:vendors" },
    ...over,
  };
  return {
    connector: card({ connections: [] }),
    permissionEntities: [],
    connections: [connection],
    forAgent: null,
    sandbox,
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

const base = () => ({
  "GET /api/session": () => OPERATOR_SESSION,
  [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
  [`GET /api/ops/clients/${CLIENT}/connections`]: () => oldList(),
});

describe("the words", () => {
  it("say the client's go-ahead, and what the button does", () => {
    expect(mezonasMayWords("Hartley Millwork", MAY)).toBe(
      "Hartley Millwork lets us: make changes agents need, until 20 Dec",
    );
    expect(mezonasMayWords("Hartley Millwork", null)).toBe(
      "Hartley Millwork asks to approve each change here.",
    );
    const p = (outcome: "apply" | "apply_under_authorization" | "request") => ({
      outcome,
      mezonasMay: MAY,
    });
    expect(changeButtonWords(p("apply"), "Hartley Millwork", false)).toBe("Apply now");
    expect(changeButtonWords(p("apply_under_authorization"), "Hartley Millwork", false)).toBe(
      "Apply now (Pat is told)",
    );
    expect(changeButtonWords(p("request"), "Hartley Millwork", false)).toBe(
      "Send to Hartley Millwork for approval",
    );
    expect(changeButtonWords(p("request"), "Sandbox", true)).toBe("Apply now");
    expect(changeSummaryWords(2, "looser")).toBe("2 changes, both looser");
  });

  it("fixtures hold to the contract", () => {
    expect(connectorAccessRoutes.opsClientConnectors.response.safeParse(tab()).success).toBe(true);
    expect(
      connectorAccessRoutes.opsClientConnector.response.safeParse(connectorPage()).success,
    ).toBe(true);
  });
});

describe("the client's Connectors tab", () => {
  it("shows connected, recommended, the agents waiting and the open requests, with Withdraw", async () => {
    let status: "open" | "withdrawn" = "open";
    const api = fakeApi({
      ...base(),
      [`GET /api/ops/clients/${CLIENT}/connectors`]: () =>
        tab({ requests: status === "open" ? [REQUEST] : [] }),
      [`POST /api/ops/clients/${CLIENT}/connection-requests/${REQ}/withdraw`]: () => {
        status = "withdrawn";
        return { request: { ...REQUEST, status } };
      },
    });
    renderAt(`/ops/clients/${CLIENT}/connections`, api);
    const list = await screen.findByTestId("ops-connections-list", {}, { timeout: 10_000 });
    const conn = within(list).getByTestId(`ops-connection-${CONN}`);
    expect(within(conn).getByTestId("ops-connection-account")).toHaveTextContent(
      "Hartley Millwork LLC",
    );
    expect(conn).not.toHaveTextContent("9341458640918607");
    expect(within(conn).getByTestId("ops-connection-access")).toHaveTextContent(
      "Reads 9 · changes 3 with approval",
    );
    expect(within(conn).getByTestId("ops-connection-open-request")).toHaveTextContent(
      "Waiting on Hartley Millwork",
    );
    expect(within(conn).getByTestId("ops-connection-may")).toHaveTextContent(
      "Hartley Millwork lets us: make changes agents need, until 20 Dec",
    );
    expect(within(conn).getByTestId("ops-connection-open")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/connectors/qbo`,
    );

    expect(screen.getByTestId("ops-recommended-gmail")).toHaveTextContent("Buyer needs it");
    const agents = screen.getByTestId("ops-connections-agents");
    expect(agents).toHaveTextContent("Allow creating purchase orders");
    expect(agents).toHaveTextContent("Connect Gmail");

    const req = within(screen.getByTestId("ops-connections-requests")).getByTestId(
      `ops-request-${REQ}`,
    );
    expect(req).toHaveTextContent("Create purchase orders: Off → Ask me first");
    expect(req).toHaveTextContent("Why: The Buyer sends the POs you approve.");
    expect(within(req).getByTestId("ops-request-state")).toHaveTextContent(
      "Waiting on Hartley Millwork",
    );
    await userEvent.setup().click(within(req).getByTestId("ops-request-withdraw"));
    expect(api.calls).toContain(
      `POST /api/ops/clients/${CLIENT}/connection-requests/${REQ}/withdraw`,
    );
    await waitFor(() => expect(screen.queryByTestId("ops-connections-requests")).toBeNull());
  });
});

describe("a connector's page: we change it as if it were ours", () => {
  it("previews the edit, needs a reason, and sends what the go-ahead doesn't cover", async () => {
    const previews: unknown[] = [];
    const sent: unknown[] = [];
    const api = fakeApi({
      ...base(),
      [`GET /api/ops/clients/${CLIENT}/connectors/qbo`]: () => connectorPage(),
      [`POST /api/ops/clients/${CLIENT}/connections/${CONN}/changes/preview`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        previews.push(body);
        const bill = body.permissions?.entities?.bill?.create === "approval";
        return {
          direction: "looser",
          rows: [
            ...(body.permissions?.entities?.purchase_order?.create === "approval"
              ? [{ ...REQUEST.rows[0] }]
              : []),
            ...(bill
              ? [
                  {
                    ...REQUEST.rows[0],
                    entity: "bill",
                    label: "Create bills: Off → Ask me first",
                  },
                ]
              : []),
          ],
          outcome: bill ? "request" : "apply_under_authorization",
          whyNot: bill ? "Create bills isn't something an agent needs." : null,
          mezonasMay: MAY,
        };
      },
      [`POST /api/ops/clients/${CLIENT}/connections/${CONN}/changes`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return {
          outcome: "request_sent",
          request: REQUEST,
          whyNot: "Create bills isn't something an agent needs.",
          replaced: REQ,
        };
      },
    });
    renderAt(`/ops/clients/${CLIENT}/connectors/qbo`, api);
    const conn = await screen.findByTestId(
      `ops-client-connection-${CONN}`,
      {},
      { timeout: 10_000 },
    );
    const user = userEvent.setup();
    expect(screen.getByTestId("ops-client-connector-note")).toHaveTextContent(
      "Tighter changes apply at once; anything looser goes to Hartley Millwork to approve.",
    );
    expect(within(conn).getByTestId("ops-client-connection-may")).toHaveTextContent(
      "Hartley Millwork lets us: make changes agents need, until 20 Dec",
    );
    expect(within(conn).getByTestId("ops-access-row-create:purchase_order")).toHaveTextContent(
      "Buyer needs this",
    );
    // Nothing edited yet: no footer.
    expect(within(conn).queryByTestId("ops-change-footer")).toBeNull();

    // A need the go-ahead covers: Apply now, and the client admin is told.
    await user.click(within(conn).getByTestId("ops-access-set-create:purchase_order-approval"));
    const footer = await within(conn).findByTestId("ops-change-footer");
    await waitFor(() =>
      expect(within(footer).getByTestId("ops-change-submit")).toHaveTextContent(
        "Apply now (Pat is told)",
      ),
    );
    expect(within(footer).getByTestId("ops-change-summary")).toHaveTextContent("1 change, looser");
    expect(within(footer).getByTestId("ops-change-rows")).toHaveTextContent(
      "Create purchase orders: Off → Ask me first",
    );
    // The record type goes with the others as stored.
    expect(previews.at(-1)).toEqual({
      permissions: {
        entities: { purchase_order: { create: "approval" }, bill: { create: "off" } },
      },
    });

    // One it doesn't cover: the whole edit goes to the client, saying why.
    await user.click(within(conn).getByTestId("ops-access-set-create:bill-approval"));
    await waitFor(() =>
      expect(within(footer).getByTestId("ops-change-submit")).toHaveTextContent(
        "Send to Hartley Millwork for approval",
      ),
    );
    expect(within(footer).getByTestId("ops-change-why-not")).toHaveTextContent(
      "Create bills isn't something an agent needs.",
    );

    // The reason is required.
    expect(within(footer).getByTestId("ops-change-submit")).toBeDisabled();
    await user.type(within(footer).getByTestId("ops-change-reason"), "The Buyer files bills.");
    await user.click(within(footer).getByTestId("ops-change-submit"));
    expect(sent).toEqual([
      {
        permissions: {
          entities: { purchase_order: { create: "approval" }, bill: { create: "approval" } },
        },
        reason: "The Buyer files bills.",
      },
    ]);
    expect(await within(conn).findByTestId("ops-client-connection-result")).toHaveTextContent(
      "Sent to Hartley Millwork for approval: Create bills isn't something an agent needs. Nothing changes until a client admin approves. It replaces the request that was open.",
    );
    expect(within(conn).queryByTestId("ops-change-footer")).toBeNull();
  });

  it("applies a tighter change now, and sends the setup with it", async () => {
    const sent: unknown[] = [];
    const page = connectorPage({ openRequest: null });
    const api = fakeApi({
      ...base(),
      [`GET /api/ops/clients/${CLIENT}/connectors/qbo`]: () => page,
      [`POST /api/ops/clients/${CLIENT}/connections/${CONN}/changes/preview`]: () => ({
        direction: "tighter",
        rows: [
          {
            kind: "level",
            verb: "update",
            entity: null,
            from: "approval",
            to: "off",
            direction: "tighter",
            label: "Update: Ask me first → Off",
          },
        ],
        outcome: "apply",
        whyNot: null,
        mezonasMay: null,
      }),
      [`POST /api/ops/clients/${CLIENT}/connections/${CONN}/changes`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return {
          outcome: "applied",
          rows: [],
          connection: page.connections[0],
        };
      },
    });
    renderAt(`/ops/clients/${CLIENT}/connectors/qbo`, api);
    const conn = await screen.findByTestId(
      `ops-client-connection-${CONN}`,
      {},
      { timeout: 10_000 },
    );
    const user = userEvent.setup();
    await user.click(within(conn).getByTestId("ops-access-set-update:-off"));
    const footer = await within(conn).findByTestId("ops-change-footer");
    await waitFor(() =>
      expect(within(footer).getByTestId("ops-change-submit")).toHaveTextContent(/^Apply now$/),
    );
    await user.type(within(footer).getByTestId("ops-change-reason"), "Not needed.");
    await user.click(within(footer).getByTestId("ops-change-submit"));
    expect(sent).toEqual([{ permissions: { update: "off" }, reason: "Not needed." }]);
    expect(await within(conn).findByTestId("ops-client-connection-result")).toHaveTextContent(
      "Applied. Hartley Millwork is told in their Inbox.",
    );
  });

  it("applies directly in the Sandbox", async () => {
    const api = fakeApi({
      ...base(),
      [`GET /api/ops/clients/${CLIENT}/connectors/qbo`]: () =>
        connectorPage({ mezonasMay: null, openRequest: null }, true),
      [`POST /api/ops/clients/${CLIENT}/connections/${CONN}/changes/preview`]: () => ({
        direction: "looser",
        rows: [{ ...REQUEST.rows[0] }],
        outcome: "apply",
        whyNot: null,
        mezonasMay: null,
      }),
    });
    renderAt(`/ops/clients/${CLIENT}/connectors/qbo`, api);
    const conn = await screen.findByTestId(
      `ops-client-connection-${CONN}`,
      {},
      { timeout: 10_000 },
    );
    expect(screen.getByTestId("ops-client-connector-note")).toHaveTextContent(
      "Your own test client",
    );
    await userEvent
      .setup()
      .click(within(conn).getByTestId("ops-access-set-create:purchase_order-approval"));
    const footer = await within(conn).findByTestId("ops-change-footer");
    await waitFor(() =>
      expect(within(footer).getByTestId("ops-change-submit")).toHaveTextContent(/^Apply now$/),
    );
  });

  it("shows a failed preview, and the open request's Withdraw", async () => {
    const api = fakeApi({
      ...base(),
      [`GET /api/ops/clients/${CLIENT}/connectors/qbo`]: () => connectorPage(),
      [`POST /api/ops/clients/${CLIENT}/connections/${CONN}/changes/preview`]: () =>
        new Reply(422, { error: { code: "invalid", message: "That record type isn't known." } }),
      [`POST /api/ops/clients/${CLIENT}/connection-requests/${REQ}/withdraw`]: () => ({
        request: { ...REQUEST, status: "withdrawn" },
      }),
    });
    renderAt(`/ops/clients/${CLIENT}/connectors/qbo`, api);
    const conn = await screen.findByTestId(
      `ops-client-connection-${CONN}`,
      {},
      { timeout: 10_000 },
    );
    const user = userEvent.setup();
    await user.click(within(conn).getByTestId("ops-access-set-create:bill-approval"));
    const footer = await within(conn).findByTestId("ops-change-footer");
    expect(await within(footer).findByRole("alert")).toHaveTextContent(
      "That record type isn't known.",
    );
    expect(within(footer).getByTestId("ops-change-submit")).toBeDisabled();
    await user.click(within(footer).getByTestId("ops-change-discard"));
    expect(within(conn).queryByTestId("ops-change-footer")).toBeNull();

    await user.click(within(conn).getByTestId("ops-request-withdraw"));
    expect(api.calls).toContain(
      `POST /api/ops/clients/${CLIENT}/connection-requests/${REQ}/withdraw`,
    );
  });
});

// ── The agent's panels ───────────────────────────────────────────────────────────────────────

const NEEDS = {
  agent: { id: AGENT, name: "Buyer", template: false },
  connectors: [
    {
      connector: "qbo",
      name: "QuickBooks Online",
      needs: [
        {
          connector: "qbo",
          verb: "read" as const,
          entity: "bill",
          level: "on" as const,
          wantsAuto: false,
          anyOf: null,
          label: "Bills",
          tool: "qbo.bill.query",
          why: [],
          because: [],
        },
        {
          connector: "qbo",
          verb: "create" as const,
          entity: "purchase_order",
          level: "ask" as const,
          wantsAuto: false,
          anyOf: null,
          label: "Create purchase orders",
          tool: "qbo.purchaseorder.create",
          why: [],
          because: [],
        },
      ],
    },
  ],
};

const READINESS = {
  agent: { id: AGENT, name: "Buyer", template: false },
  clientId: CLIENT,
  ready: false,
  connectors: [
    {
      connector: "qbo",
      name: "QuickBooks Online",
      state: "needs_access" as const,
      connectionId: CONN,
      gaps: [GAP],
      openRequest: null,
    },
    {
      connector: "gdrive",
      name: "Google Drive",
      state: "not_bound" as const,
      connectionId: "00000000-0000-4000-8000-0000000000c2",
      gaps: [
        {
          ...GAP,
          kind: "not_bound" as const,
          connector: "gdrive",
          connectionId: "00000000-0000-4000-8000-0000000000c2",
          fixBy: "mezonas" as const,
          words: "Bind the connection",
        },
      ],
      openRequest: null,
    },
    {
      connector: "slack",
      name: "Slack",
      state: "ready" as const,
      connectionId: "00000000-0000-4000-8000-0000000000c3",
      gaps: [],
      openRequest: null,
    },
  ],
};

describe("the Needs and Readiness panels", () => {
  function renderPanel(node: ReactNode, api: ReturnType<typeof fakeApi>) {
    return render(
      <MemoryRouter>
        <AppProviders client={api.client}>{node}</AppProviders>
      </MemoryRouter>,
    );
  }

  it("lists per connector what it reads and changes", async () => {
    expect(connectorAccessRoutes.opsAgentNeeds.response.safeParse(NEEDS).success).toBe(true);
    const api = fakeApi({ [`GET /api/ops/agents/${AGENT}/needs`]: () => NEEDS });
    renderPanel(<NeedsPanel agentId={AGENT} />, api);
    const qbo = await screen.findByTestId("agent-needs-qbo");
    expect(qbo).toHaveTextContent("QuickBooks Online");
    expect(qbo).toHaveTextContent("Reads: Bills");
    expect(qbo).toHaveTextContent("Changes: Create purchase orders (asks first)");
  });

  it("says what each connector is missing, our fixes and Send to client with a reason", async () => {
    expect(connectorAccessRoutes.opsAgentReadiness.response.safeParse(READINESS).success).toBe(
      true,
    );
    const sent: unknown[] = [];
    const api = fakeApi({
      [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
      [`GET /api/ops/agents/${AGENT}/needs`]: () => NEEDS,
      [`GET /api/ops/agents/${AGENT}/readiness`]: () => READINESS,
      [`POST /api/ops/agents/${AGENT}/readiness/send`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return {
          outcome: "request_sent",
          request: REQUEST,
          whyNot: "Hartley Millwork asks to approve each change here.",
          replaced: null,
        };
      },
    });
    renderPanel(<ReadinessPanel agentId={AGENT} clientId={CLIENT} />, api);
    const panel = await screen.findByTestId("agent-readiness");
    const qbo = await within(panel).findByTestId("agent-readiness-qbo");
    expect(within(panel).getByTestId("agent-readiness-state")).toHaveTextContent(
      "Waiting on connectors",
    );
    expect(within(qbo).getByTestId("agent-readiness-row-state")).toHaveTextContent("Needs access");
    await waitFor(() => expect(qbo).toHaveTextContent("Create purchase orders (asks first)"));
    expect(qbo).toHaveTextContent("Allow creating purchase orders");
    const drive = within(panel).getByTestId("agent-readiness-gdrive");
    expect(within(drive).getByTestId("agent-readiness-fix-not_bound")).toHaveTextContent("Bind");
    expect(within(drive).queryByTestId("agent-readiness-send-start")).toBeNull();
    expect(
      within(within(panel).getByTestId("agent-readiness-slack")).getByTestId(
        "agent-readiness-row-state",
      ),
    ).toHaveTextContent("Ready");

    const user = userEvent.setup();
    await user.click(within(qbo).getByTestId("agent-readiness-send-start"));
    // No reason: nothing is sent.
    await user.click(within(qbo).getByTestId("agent-readiness-send-confirm"));
    expect(sent).toEqual([]);
    expect(within(qbo).getByTestId("agent-readiness-send")).toHaveTextContent(
      "Say why: it's required.",
    );
    await user.type(
      within(qbo).getByTestId("agent-readiness-send-reason"),
      "The Buyer sends the POs you approve.",
    );
    await user.click(within(qbo).getByTestId("agent-readiness-send-confirm"));
    expect(sent).toEqual([{ connectionId: CONN, reason: "The Buyer sends the POs you approve." }]);
    expect(await within(panel).findByTestId("agent-readiness-sent")).toHaveTextContent(
      "Sent to Hartley Millwork for approval",
    );
  });
});
