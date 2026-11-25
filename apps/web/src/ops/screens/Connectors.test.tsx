// O3 Connectors (`/ops/connectors`, v0.12 W2-A): the catalog table shows each connector's kind,
// status, clients connected and errors in the last 24 hours; the rail shows the selected one with
// its tools, default access and who waits; the operator sets the status, default access and offers.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const MATRIX = { read: "auto", create: "approval", update: "approval", delete: "off" };
const CLIENT_ID = "00000000-0000-4000-8000-00000000a002";

const qbo = (over: Record<string, unknown> = {}) => ({
  id: "qbo",
  name: "QuickBooks Online",
  description: "Bills and invoices in your QuickBooks.",
  icon: "book",
  auth: "oauth2",
  status: "live",
  statusSource: "operator",
  testOnly: false,
  note: "",
  available: true,
  clientsConnected: 2,
  tools: [
    { id: "qbo.invoice.add_note", description: "Add a note", verb: "update", entity: "invoice" },
  ],
  actions: [
    {
      id: "qbo.invoice.add_note",
      label: "Qbo invoice add note",
      description: "Add a note",
      kind: "change",
      entity: "invoice",
      on: true,
      isNew: false,
    },
    {
      id: "qbo.bill.attach",
      label: "Qbo bill attach",
      description: "Attach a file to a bill",
      kind: "change",
      entity: "bill",
      on: false,
      isNew: true,
    },
  ],
  syncs: ["Bill", "Invoice"],
  builtIn: false,
  permissionEntities: [
    {
      id: "invoice",
      label: "Invoices",
      verbs: ["read", "update"],
      scopes: [
        { id: "notes_only", label: "Notes only", verb: "update", tools: ["qbo.invoice.add_note"] },
      ],
    },
  ],
  errors: { toolCalls: 3, connections: 1 },
  defaultAccess: { matrix: MATRIX, source: "platform" },
  waiting: [
    {
      clientId: "00000000-0000-4000-8000-00000000000b",
      clientName: "Lakeside Millwork",
      offered: true,
      agents: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Pia" }],
    },
  ],
  updatedAt: null,
  ...over,
});

const gmail = qbo({
  id: "gmail",
  name: "Gmail",
  description: "Send only",
  status: "in_review",
  errors: { toolCalls: 0, connections: 0 },
  tools: [],
  waiting: [],
});

function renderAt(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={["/ops/connectors"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("ops connectors catalog", () => {
  it("lists connectors with status, clients and errors, and opens one in a side sheet", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/connectors": () => ({ connectors: [qbo(), gmail] }),
    });
    renderAt(api);
    // Feedback (2026-11-10): the catalog's figures on top, then a card per connector.
    const figures = await screen.findByTestId("connectors-figures");
    expect(figures).toHaveTextContent("Connectors2");
    expect(within(figures).getByTestId("connectors-figures-errors")).toHaveTextContent(
      "1 connector with errors",
    );
    const row = await screen.findByTestId("connector-qbo");
    expect(row.tagName).toBe("ARTICLE");
    expect(within(row).getByText("Live")).toBeInTheDocument();
    expect(within(row).getByText("API · OAuth")).toBeInTheDocument();
    expect(within(row).getByTestId("connector-qbo-clients")).toHaveTextContent("2");
    expect(within(row).getByTestId("connector-qbo-errors")).toHaveTextContent(
      "3 failed calls, 1 connection in error",
    );
    // The row says it in one line; the sheet opens from it with the whole description.
    expect(screen.getByTestId("connector-qbo-line")).toHaveTextContent(
      "Bills, invoices, vendors, customers and payments in your QuickBooks Online.",
    );
    expect(screen.queryByTestId("connector-panel")).toBeNull();
    await userEvent.click(screen.getByTestId("connector-qbo-open"));
    const panel = screen.getByTestId("connector-panel");
    expect(within(panel).getByRole("heading", { name: "QuickBooks Online" })).toBeInTheDocument();
    expect(within(panel).getByTestId("connector-panel-description")).toHaveTextContent(
      "Bills and invoices in your QuickBooks.",
    );
    expect(within(panel).getByTestId("connector-qbo-status")).toHaveValue("live");
    const waiting = within(panel).getByTestId("connector-qbo-waiting");
    expect(waiting).toHaveTextContent("Lakeside Millwork");
    expect(waiting).toHaveTextContent("Pia needs it");
    expect(within(panel).getAllByText("Needs approval")).toHaveLength(2);
    expect(panel).toHaveTextContent("Platform defaults");
    // Its tools by their plain names.
    expect(within(panel).getByText("Add a note to a customer invoice")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("connector-panel-close"));
    expect(screen.queryByTestId("connector-panel")).toBeNull();
    // The default access shows the connector's entities under it, on demand.
    await userEvent.click(screen.getByTestId("matrix-entities-toggle-qbo"));
    expect(screen.getByTestId("matrix-entity-qbo-invoice")).toHaveTextContent("Invoices");

    // Filter by status, then open what's left.
    await userEvent.click(screen.getByTestId("connectors-filter-in_review"));
    expect(screen.queryByTestId("connector-qbo")).toBeNull();
    await userEvent.click(screen.getByTestId("connector-gmail-open"));
    const gmailPanel = screen.getByTestId("connector-panel");
    expect(within(gmailPanel).getByRole("heading", { name: "Gmail" })).toBeInTheDocument();
    // No internal ids on the page.
    expect(gmailPanel).not.toHaveTextContent("connectors/gmail");
    expect(screen.getByTestId("connector-gmail")).toHaveAttribute("aria-current", "true");
  });

  it("reads a status nobody set from the deployment, never as 'Not set'", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/connectors": () => ({
        connectors: [
          qbo({ statusSource: "deployment" }),
          qbo({
            id: "zoho_crm",
            name: "Zoho CRM",
            status: null,
            statusSource: "deployment",
            available: false,
            clientsConnected: 0,
            errors: { toolCalls: 0, connections: 0 },
          }),
          qbo({
            id: "testkit",
            name: "Testkit",
            auth: "none",
            statusSource: "deployment",
            testOnly: true,
            errors: { toolCalls: 0, connections: 0 },
          }),
        ],
      }),
    });
    renderAt(api);
    const row = await screen.findByTestId("connector-qbo");
    expect(within(row).getByText("Live")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("connector-qbo-open"));
    expect(screen.getByTestId("connector-panel")).toHaveTextContent(
      "Live because clients can connect it here.",
    );
    expect(within(screen.getByTestId("connector-zoho_crm")).getByText("Not set up")).toBeVisible();
    expect(screen.queryByText("Not set")).toBeNull();
    await userEvent.click(screen.getByTestId("connector-panel-close"));
    await userEvent.click(screen.getByTestId("connector-testkit-open"));
    expect(screen.getByTestId("connector-panel-test-only")).toHaveTextContent(
      "real clients never see it",
    );
  });

  it("sets the status, and the default access with an entity scope", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/connectors": () => ({ connectors: [qbo()] }),
      "PUT /api/ops/connectors/qbo": ({ init }) => {
        puts.push(JSON.parse(String(init.body)));
        return { connector: qbo() };
      },
    });
    renderAt(api);
    await userEvent.click(await screen.findByTestId("connector-qbo-open"));
    const panel = screen.getByTestId("connector-panel");
    await userEvent.selectOptions(within(panel).getByTestId("connector-qbo-status"), "beta");
    await waitFor(() => expect(puts).toEqual([{ status: "beta" }]));
    await userEvent.click(screen.getByTestId("connector-panel-close"));
    await userEvent.click(screen.getByTestId("matrix-entities-toggle-qbo"));
    await userEvent.selectOptions(
      screen.getByTestId("matrix-entity-invoice-scope-select"),
      "notes_only",
    );
    await userEvent.click(screen.getByTestId("matrix-changes-save"));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({
      defaultPermissions: {
        ...MATRIX,
        entities: { invoice: { scope: { update: "notes_only" } } },
      },
    });
  });

  it("offers the connector to a client, keeping what it was already offered", async () => {
    const offers: unknown[] = [];
    let offered = ["gmail"];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/connectors": () => ({ connectors: [qbo()] }),
      [`GET /api/ops/clients/${CLIENT_ID}/connections`]: () => ({
        connections: [],
        offered,
        connectors: [],
        usedBy: {},
        sandbox: false,
      }),
      [`PUT /api/ops/clients/${CLIENT_ID}/connectors`]: ({ init }) => {
        const body = JSON.parse(String(init.body)) as { offered: string[] };
        offers.push(body);
        offered = body.offered;
        return { offered };
      },
    });
    renderAt(api);
    await userEvent.click(await screen.findByTestId("connector-qbo-open"));
    await userEvent.selectOptions(screen.getByTestId("connector-offer-client"), CLIENT_ID);
    expect(await screen.findByTestId("connector-offer-state")).toHaveTextContent("Not offered.");
    await userEvent.click(screen.getByTestId("connector-offer-toggle"));
    await waitFor(() => expect(offers).toEqual([{ offered: ["gmail", "qbo"] }]));
    await waitFor(() =>
      expect(screen.getByTestId("connector-offer-state")).toHaveTextContent("Offered:"),
    );
  });

  it("lists a connector's actions with their kind, what it syncs, and switches an action on or off", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/connectors": () => ({ connectors: [qbo()] }),
      "PUT /api/ops/connectors/qbo": ({ init }) => {
        puts.push(JSON.parse(String(init.body)));
        return { connector: qbo() };
      },
    });
    renderAt(api);
    await userEvent.click(await screen.findByTestId("connector-qbo-open"));
    const panel = screen.getByTestId("connector-panel");
    expect(within(panel).getByTestId("connector-panel-syncs")).toHaveTextContent("Bill");
    expect(within(panel).getByTestId("connector-panel-syncs")).toHaveTextContent("Invoice");
    const on = within(panel).getByTestId("connector-action-qbo.invoice.add_note");
    expect(on).toHaveTextContent("Change");
    const onSwitch = within(panel).getByTestId("connector-action-qbo.invoice.add_note-switch");
    expect(onSwitch).toHaveAttribute("aria-checked", "true");
    // A new action waits, off, to be turned on here.
    const waiting = within(panel).getByTestId("connector-action-qbo.bill.attach");
    expect(waiting).toHaveTextContent("New: waiting to be turned on");
    const offSwitch = within(panel).getByTestId("connector-action-qbo.bill.attach-switch");
    expect(offSwitch).toHaveAttribute("aria-checked", "false");
    await userEvent.click(offSwitch);
    await waitFor(() => expect(puts).toEqual([{ actions: { "qbo.bill.attach": true } }]));
    await userEvent.click(onSwitch);
    await waitFor(() => expect(puts[1]).toEqual({ actions: { "qbo.invoice.add_note": false } }));
  });

  it("requests an action from the connector's page: the words go to the Dev queue with the connector", async () => {
    const asks: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/connectors": () => ({ connectors: [qbo()] }),
      "POST /api/ops/action-requests": ({ init }) => {
        asks.push(JSON.parse(String(init.body)));
        return { ref: "DQ-014", duplicate: null };
      },
    });
    renderAt(api);
    await userEvent.click(await screen.findByTestId("connector-qbo-open"));
    const send = screen.getByTestId("connector-request-action-send");
    expect(send).toBeDisabled();
    await userEvent.type(
      screen.getByTestId("connector-request-action-text"),
      "Attach the vendor's PDF to the bill.",
    );
    await userEvent.click(send);
    expect(await screen.findByTestId("connector-request-action-done")).toHaveTextContent("DQ-014");
    expect(asks).toEqual([{ what: "Attach the vendor's PDF to the bill.", connector: "qbo" }]);
  });
});
