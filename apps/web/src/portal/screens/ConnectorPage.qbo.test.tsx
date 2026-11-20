// QuickBooks Online's page (plan M9; Connectors C5): not connected, the client admin signs in
// through Intuit (the API answers where); connected, the page names the company (never its realm
// id) and opens each row to the tools behind it.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { accessRow, connectionPage, connectorCard, connectorPageView } from "../../test/connectors";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const QBO = connectorCard({
  connector: "qbo",
  name: "QuickBooks Online",
  description:
    "Bills, purchases, vendors, items and attachments in your QuickBooks Online. You sign in to QuickBooks yourself.",
  group: "money",
});

/** The tool as `POST /api/connections/:connector/authorize` answers it, not connected yet. */
const OFFERED = {
  connector: "qbo",
  name: "QuickBooks Online",
  description: "",
  icon: null,
  available: true,
  credentialForm: false,
  personal: false,
  connection: null,
};

function renderAt(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={["/connectors/qbo"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const common = {
  "GET /api/session": () => CLIENT_SESSION,
  "GET /api/access": () => ({ items: [], setup: [], browserSites: [], canEdit: true, people: [] }),
};

afterEach(() => vi.restoreAllMocks());

describe("QuickBooks Online's page", () => {
  it("offers QuickBooks to sign in to, and starts Intuit's sign-in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const api = fakeApi({
      ...common,
      "GET /api/portal/connectors/qbo": () => connectorPageView(QBO, []),
      "POST /api/connections/qbo/authorize": () => ({
        connection: OFFERED,
        redirectUrl: "https://appcenter.intuit.com/connect/oauth2?client_id=x&state=s",
      }),
    });
    renderAt(api);
    const page = await screen.findByTestId("portal-connector");
    expect(await within(page).findByRole("heading", { name: "QuickBooks Online" })).toBeVisible();
    expect(page).toHaveTextContent("You sign in to QuickBooks yourself.");
    await userEvent.setup().click(within(page).getByTestId("connector-connect"));
    expect(api.calls).toContain("POST /api/connections/qbo/authorize");
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "https://appcenter.intuit.com/connect/oauth2?client_id=x&state=s",
      ),
    );
    vi.unstubAllGlobals();
  });

  it("shows the connected company and the tools behind a row", async () => {
    const api = fakeApi({
      ...common,
      "GET /api/portal/connectors/qbo": () =>
        connectorPageView(QBO, [
          connectionPage({
            id: "00000000-0000-4000-8000-0000000000c9",
            accountName: "Harbor Millwork (sandbox)",
            lastSyncAt: "2026-11-05T18:00:00.000Z",
            connectedByYou: true,
            read: [
              accessRow({
                verb: "read",
                entity: "bill",
                label: "Bills",
                tools: [{ id: "qbo.bill.query", description: "Find bills" }],
              }),
            ],
            change: [
              accessRow({
                verb: "update",
                entity: "bill",
                label: "Update bill lines",
                tools: [{ id: "qbo.bill.update_lines", description: "Itemize a bill" }],
              }),
            ],
            access: { reads: 1, changesAsk: 1, changesAuto: 0 },
          }),
        ]),
    });
    renderAt(api);
    const head = await screen.findByTestId("portal-connection-qbo");
    expect(head).toHaveTextContent("Harbor Millwork (sandbox)");
    expect(head).toHaveTextContent("Connected");
    expect(head).toHaveTextContent("Reads 1 · changes 1, asking you first");
    expect(document.body).not.toHaveTextContent("9130357766900456");
    await userEvent.setup().click(screen.getByTestId("access-row-update-bill-open"));
    expect(screen.getByTestId("access-row-update-bill-detail")).toHaveTextContent("Itemize a bill");
  });
});
