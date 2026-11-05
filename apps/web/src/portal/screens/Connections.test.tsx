// The portal's Connections page with QuickBooks Online (plan M9): offered and not yet connected, the
// client admin signs in through Intuit (the API answers where); connected, the card names the
// company and when it last synced.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const QBO = {
  connector: "qbo",
  name: "QuickBooks Online",
  description:
    "Bills, purchases, vendors, items and attachments in your QuickBooks Online. You sign in to QuickBooks yourself.",
  icon: "book",
  available: true,
  credentialForm: false,
};
const MATRIX = {
  read: "auto",
  create: "approval",
  update: "approval",
  delete: "off",
  scope: null,
};

function renderAt(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={["/connections"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const common = {
  "GET /api/session": () => CLIENT_SESSION,
  "GET /api/approver-rules": () => ({ rules: [], defaultApprover: "client_admin" }),
};

afterEach(() => vi.restoreAllMocks());

describe("portal connections: QuickBooks Online", () => {
  it("offers QuickBooks to sign in to, and starts Intuit's sign-in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const api = fakeApi({
      ...common,
      "GET /api/connections": () => ({ connections: [{ ...QBO, connection: null }] }),
      "POST /api/connections/qbo/authorize": () => ({
        connection: { ...QBO, connection: null },
        redirectUrl: "https://appcenter.intuit.com/connect/oauth2?client_id=x&state=s",
      }),
    });
    renderAt(api);
    const card = await screen.findByTestId("portal-connection-qbo");
    expect(card).toHaveTextContent("QuickBooks Online");
    expect(card).toHaveTextContent("You sign in to QuickBooks yourself.");
    await userEvent.setup().click(within(card).getByTestId("portal-connection-connect"));
    expect(api.calls).toContain("POST /api/connections/qbo/authorize");
    expect(assign).toHaveBeenCalledWith(
      "https://appcenter.intuit.com/connect/oauth2?client_id=x&state=s",
    );
    vi.unstubAllGlobals();
  });

  it("shows the connected company and its tools", async () => {
    const api = fakeApi({
      ...common,
      "GET /api/connections": () => ({
        connections: [
          {
            ...QBO,
            connection: {
              id: "00000000-0000-4000-8000-0000000000c9",
              status: "connected",
              externalAccountId: "9130357766900456",
              accountName: "Harbor Millwork (sandbox)",
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
                {
                  toolId: "qbo.bill.update_lines",
                  description: "Itemize a bill",
                  verb: "update",
                  level: "approval",
                  access: "asks_first",
                },
              ],
              usedBy: [],
            },
          },
        ],
      }),
    });
    renderAt(api);
    const card = await screen.findByTestId("portal-connection-qbo");
    expect(card).toHaveTextContent("Harbor Millwork (sandbox)");
    expect(card).not.toHaveTextContent("9130357766900456");
    expect(card).toHaveTextContent("Connected");
    await userEvent.setup().click(within(card).getByTestId("portal-connection-permissions-toggle"));
    const tools = within(card).getByTestId("portal-connection-tools");
    expect(tools).toHaveTextContent("Itemize a bill");
  });
});
