// `/ops/connectors` (v0.12 W2-A): the connectors catalog shows each connector's status, clients
// connected, errors in the last 24 hours, default access and who is waiting to connect; the
// operator sets the status, and the default access with entity rows.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const MATRIX = { read: "auto", create: "approval", update: "approval", delete: "off" };

const qbo = (over: Record<string, unknown> = {}) => ({
  id: "qbo",
  name: "QuickBooks Online",
  description: "Bills and invoices in your QuickBooks.",
  icon: "book",
  auth: "oauth2",
  status: "live",
  note: "",
  available: true,
  clientsConnected: 2,
  tools: [
    { id: "qbo.invoice.add_note", description: "Add a note", verb: "update", entity: "invoice" },
  ],
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
  it("shows status, clients, errors, default access and who is waiting", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/connectors": () => ({ connectors: [qbo()] }),
    });
    renderAt(api);
    const card = await screen.findByTestId("connector-qbo");
    expect(within(card).getByTestId("connector-qbo-status")).toHaveValue("live");
    expect(within(card).getByTestId("connector-qbo-clients")).toHaveTextContent("2");
    expect(within(card).getByTestId("connector-qbo-errors")).toHaveTextContent(
      "3 failed calls, 1 connections in error",
    );
    expect(within(card).getByTestId("connector-qbo-waiting")).toHaveTextContent(
      "Lakeside Millwork (Pia)",
    );
    expect(card).toHaveTextContent("Platform defaults");
    // The default access shows the connector's entities under it.
    expect(screen.getByTestId("matrix-entity-qbo-invoice")).toHaveTextContent("Invoices");
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
    const card = await screen.findByTestId("connector-qbo");
    await userEvent.selectOptions(within(card).getByTestId("connector-qbo-status"), "beta");
    await waitFor(() => expect(puts).toEqual([{ status: "beta" }]));
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
});
