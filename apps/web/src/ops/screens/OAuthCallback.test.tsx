// The back office's sign-in callback page (docs/plan.md §1.5): it passes the provider's parameters to
// the ops callback route once, then opens the Sandbox client's Connections; a refusal stays on the
// page with a way back. An operator returned to the portal's callback page (Zoho, Podio) goes on to
// this page with the parameters; a client user's sign-in stays in the portal.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

const SANDBOX = "00000000-0000-4000-8000-00000000a001";

const CONNECTED = {
  clientId: SANDBOX,
  connection: {
    id: "00000000-0000-4000-8000-0000000000c9",
    tenantId: SANDBOX,
    connector: "qbo",
    status: "connected",
    externalAccountId: "9341458640918607",
    config: {},
    permissions: {
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
      scope: null,
    },
    lastSyncAt: null,
    connectedBy: OPERATOR_SESSION.user.id,
    createdAt: "2026-11-05T18:00:00.000Z",
  },
};

function renderAt(
  path: string,
  reply: () => unknown,
  session: typeof OPERATOR_SESSION = OPERATOR_SESSION,
) {
  const sent: { route: string; body: unknown }[] = [];
  const api = fakeApi({
    "GET /api/session": () => session,
    [`GET /api/ops/clients/${SANDBOX}/connections`]: () => ({
      connections: [CONNECTED.connection],
      offered: ["qbo"],
      connectors: [],
      usedBy: {},
      sandbox: true,
    }),
    "GET /api/connections": () => ({ connections: [] }),
    "GET /api/approver-rules": () => ({ rules: [], defaultApprover: "client_admin" }),
  });
  for (const connector of ["qbo", "zoho_crm"]) {
    for (const route of [
      `POST /api/ops/connections/${connector}/callback`,
      `POST /api/connections/${connector}/callback`,
    ]) {
      api.on(route, ({ init }) => {
        sent.push({ route, body: JSON.parse(String(init.body)) });
        return reply();
      });
    }
  }
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>
    </StrictMode>,
  );
  return { sent, api, user: userEvent.setup() };
}

describe("OpsOAuthCallbackScreen", () => {
  it("sends the provider's parameters once, then opens the Sandbox's Connections", async () => {
    const { sent, api } = renderAt(
      "/ops/connections/qbo/callback?code=abc&state=s1&realmId=9341458640918607",
      () => CONNECTED,
    );
    expect(await screen.findByTestId("ops-connections-list")).toHaveTextContent("Connected");
    // StrictMode runs effects twice in development: the code must still go only once.
    expect(sent).toEqual([
      {
        route: "POST /api/ops/connections/qbo/callback",
        body: { params: { code: "abc", state: "s1", realmId: "9341458640918607" } },
      },
    ]);
    expect(api.calls).toContain(`GET /api/ops/clients/${SANDBOX}/connections`);
  });

  it("shows a refused sign-in and a way back, and doesn't leave the page", async () => {
    const { sent, user } = renderAt(
      "/ops/connections/qbo/callback?code=abc&state=tampered",
      () =>
        new Reply(400, { error: { code: "signature", message: "invalid OAuth state: signature" } }),
    );
    expect(await screen.findByText(/invalid OAuth state/)).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(screen.queryByTestId("ops-connections-list")).toBeNull();
    await user.click(screen.getByRole("link", { name: "Back to clients" }));
    expect(screen.queryByText(/invalid OAuth state/)).toBeNull();
  });

  it("takes an operator returned to the portal's callback page on to the back office's", async () => {
    const { sent } = renderAt("/connections/zoho_crm/callback?code=abc&state=s1", () => ({
      ...CONNECTED,
      connection: { ...CONNECTED.connection, connector: "zoho_crm" },
    }));
    expect(await screen.findByTestId("ops-connections-list")).toBeInTheDocument();
    expect(sent).toEqual([
      {
        route: "POST /api/ops/connections/zoho_crm/callback",
        body: { params: { code: "abc", state: "s1" } },
      },
    ]);
  });

  it("leaves a client's sign-in in the portal", async () => {
    const { sent } = renderAt(
      "/connections/zoho_crm/callback?code=abc&state=s1",
      () => ({
        connection: {
          connector: "zoho_crm",
          name: "Zoho CRM",
          description: "Leads.",
          icon: null,
          available: true,
          credentialForm: false,
          personal: false,
          connection: null,
        },
      }),
      CLIENT_SESSION,
    );
    await waitFor(() =>
      expect(sent.map((s) => s.route)).toEqual(["POST /api/connections/zoho_crm/callback"]),
    );
    expect(screen.queryByText("Finishing your sign-in to the Sandbox's tool.")).toBeNull();
  });
});
