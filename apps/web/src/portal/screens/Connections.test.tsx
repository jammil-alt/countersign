// The Connections page for Gmail (plan M10): its description in the reader's language, a client user
// may connect their own Gmail (not other tools), and disconnect it only if they connected it.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const GMAIL_CONN = "00000000-0000-4000-8000-0000000e0001";

const matrix = { read: "auto", create: "approval", update: "approval", delete: "off", scope: null };

function gmail(connection: null | { connectedByYou: boolean }) {
  return {
    connector: "gmail",
    name: "Gmail",
    description: "Send email from your Gmail. We can't read your mailbox.",
    icon: "mail",
    available: true,
    credentialForm: false,
    personal: true,
    connection: connection && {
      id: GMAIL_CONN,
      status: "connected",
      externalAccountId: "pat.lee@gmail.test",
      lastSyncAt: null,
      permissions: matrix,
      access: [],
      usedBy: [],
      connectedByYou: connection.connectedByYou,
    },
  };
}

const ZOHO = {
  connector: "zoho_crm",
  name: "Zoho CRM",
  description: "Leads, contacts, accounts and deals in your Zoho CRM.",
  icon: "users",
  available: true,
  credentialForm: false,
  personal: false,
  connection: null,
};

function renderAs(
  role: "client_admin" | "client_user",
  locale: "en" | "es",
  connections: unknown[],
) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Demo client", role }],
      language: { effective: locale, user: locale, client: null },
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/connections": () => ({ connections }),
    "GET /api/connections/upload/forwarding": () => new Reply(404, {}),
    "GET /api/documents": () => ({ items: [] }),
    "GET /api/approver-rules": () => new Reply(404, {}),
    "POST /api/connections/gmail/authorize": () => ({
      connection: gmail(null),
      redirectUrl: null,
    }),
  });
  render(
    <MemoryRouter initialEntries={["/connections"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("Gmail on the Connections page", () => {
  it("says what it does in Spanish, and lets a client user connect their own Gmail only", async () => {
    const api = renderAs("client_user", "es", [gmail(null), ZOHO]);
    const card = await screen.findByTestId("portal-connection-gmail");
    expect(
      within(card).getByText("Envíe correos desde su Gmail. No podemos leer su buzón."),
    ).toBeTruthy();
    const zoho = screen.getByTestId("portal-connection-zoho_crm");
    expect(within(zoho).queryByTestId("portal-connection-connect")).toBeNull();
    await userEvent.click(within(card).getByTestId("portal-connection-connect"));
    await waitFor(() => expect(api.calls).toContain("POST /api/connections/gmail/authorize"));
  });

  it("offers a client user Disconnect only for the Gmail they connected", async () => {
    renderAs("client_user", "en", [gmail({ connectedByYou: false })]);
    const theirs = await screen.findByTestId("portal-connection-gmail");
    expect(within(theirs).getByText("pat.lee@gmail.test")).toBeTruthy();
    expect(within(theirs).queryByTestId("portal-connection-disconnect-start")).toBeNull();
  });

  it("lets the person who connected it disconnect it", async () => {
    renderAs("client_user", "en", [gmail({ connectedByYou: true })]);
    const mine = await screen.findByTestId("portal-connection-gmail");
    expect(within(mine).getByTestId("portal-connection-disconnect-start")).toBeTruthy();
  });
});
