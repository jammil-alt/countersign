// Gmail's page (plan M10; Connectors C5): its description in the reader's language, a client user
// may connect their own Gmail (not other tools), and disconnect it only if they connected it;
// whoever may disconnect it may send a test email from it to itself (plan §1.31).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { connectionPage, connectorCard, connectorPageView } from "../../test/connectors";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const GMAIL_CONN = "00000000-0000-4000-8000-0000000e0001";

const GMAIL = connectorCard({
  connector: "gmail",
  name: "Gmail",
  description: "Send email from your Gmail. We can't read your mailbox.",
  personal: true,
  group: "email",
});

function gmail(connection: null | { connectedByYou: boolean; status?: string }) {
  return connection
    ? [
        connectionPage({
          id: GMAIL_CONN,
          status: connection.status ?? "connected",
          // The API names a mail account by its address (core connectionLabel).
          accountName: "pat.lee@gmail.test",
          connectedByYou: connection.connectedByYou,
        }),
      ]
    : [];
}

/** The tool as `POST /api/connections/:connector/authorize` answers it, not connected yet. */
const OFFERED = {
  connector: "gmail",
  name: "Gmail",
  description: "",
  icon: null,
  available: true,
  credentialForm: false,
  personal: false,
  connection: null,
};

function renderAs(
  role: "client_admin" | "client_user",
  locale: "en" | "es",
  connections: ReturnType<typeof gmail>,
  path = "/connectors/gmail",
) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Demo client", role }],
      language: { effective: locale, user: locale, client: null },
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/portal/connectors/gmail": () =>
      connectorPageView(GMAIL, connections, { mayEdit: role === "client_admin" }),
    "GET /api/portal/connectors/zoho_crm": () =>
      connectorPageView(connectorCard({ connector: "zoho_crm", name: "Zoho CRM" }), [], {
        mayEdit: role === "client_admin",
      }),
    "GET /api/access": () => ({
      items: [],
      setup: [],
      browserSites: [],
      canEdit: role === "client_admin",
      people: [],
    }),
    "POST /api/connections/gmail/authorize": () => ({ connection: OFFERED, redirectUrl: null }),
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

describe("Gmail's page", () => {
  it("says what it does in Spanish, and lets a client user connect their own Gmail", async () => {
    const api = renderAs("client_user", "es", gmail(null));
    const page = await screen.findByTestId("portal-connector");
    expect(
      await within(page).findByText("Envíe correos desde su Gmail. No podemos leer su buzón."),
    ).toBeTruthy();
    await userEvent.click(within(page).getByTestId("connector-connect"));
    await waitFor(() => expect(api.calls).toContain("POST /api/connections/gmail/authorize"));
  });

  it("doesn't let a client user connect a tool that isn't their own account", async () => {
    renderAs("client_user", "en", [], "/connectors/zoho_crm");
    expect(await screen.findByTestId("connector-admin-connects")).toHaveTextContent(
      "Your admin can connect it.",
    );
    expect(screen.queryByTestId("connector-connect")).toBeNull();
  });

  it("offers a client user Disconnect only for the Gmail they connected", async () => {
    renderAs("client_user", "en", gmail({ connectedByYou: false }));
    const theirs = await screen.findByTestId("portal-connection-gmail");
    expect(theirs).toHaveTextContent("pat.lee@gmail.test");
    expect(within(theirs).queryByTestId("portal-connection-disconnect-start")).toBeNull();
  });

  it("lets the person who connected it disconnect it", async () => {
    renderAs("client_user", "en", gmail({ connectedByYou: true }));
    const mine = await screen.findByTestId("portal-connection-gmail");
    expect(within(mine).getByTestId("portal-connection-disconnect-start")).toBeTruthy();
  });
});

describe("Send a test email on Gmail's page", () => {
  it("sends with an empty body and says where it went", async () => {
    const api = renderAs("client_user", "en", gmail({ connectedByYou: true }));
    const bodies: unknown[] = [];
    api.on("POST /api/connections/gmail/test-send", ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      return { to: "pat.lee@gmail.test", sentAt: "2026-11-05T10:00:00.000Z" };
    });
    const card = await screen.findByTestId("portal-connection-gmail");
    const button = within(card).getByTestId("portal-gmail-test-send");
    expect(button.textContent).toBe("Send a test email");
    expect(button.className).toContain("ds-btn--secondary");
    await userEvent.click(button);
    const sent = await within(card).findByTestId("portal-gmail-test-sent");
    expect(sent.textContent).toBe(
      "Sent to pat.lee@gmail.test. Check that mailbox's Sent folder and inbox.",
    );
    expect(sent.getAttribute("role")).toBe("status");
    expect(bodies).toEqual([{}]);
  });

  it("shows the plain error, in the reader's language", async () => {
    const api = renderAs("client_admin", "es", gmail({ connectedByYou: false }));
    api.on(
      "POST /api/connections/gmail/test-send",
      () =>
        new Reply(429, {
          error: {
            code: "rate_limited",
            message: "we sent a test email less than a minute ago; wait a minute and try again",
          },
        }),
    );
    const card = await screen.findByTestId("portal-connection-gmail");
    const button = within(card).getByTestId("portal-gmail-test-send");
    expect(button.textContent).toBe("Enviar un correo de prueba");
    await userEvent.click(button);
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toContain("Espere un minuto e inténtelo de nuevo.");
    expect(within(card).queryByTestId("portal-gmail-test-sent")).toBeNull();
  });

  it("is only for the client admin and the person who connected it, and only while connected", async () => {
    renderAs("client_user", "en", gmail({ connectedByYou: false }));
    const theirs = await screen.findByTestId("portal-connection-gmail");
    expect(within(theirs).queryByTestId("portal-gmail-test-send")).toBeNull();
  });

  it("isn't offered on a disconnected Gmail, which offers Sign in again", async () => {
    renderAs("client_admin", "en", gmail({ connectedByYou: true, status: "disconnected" }));
    const card = await screen.findByTestId("portal-connection-gmail");
    expect(within(card).getByTestId("portal-connection-connect")).toHaveTextContent(
      "Sign in again",
    );
    expect(screen.queryByTestId("portal-gmail-test-send")).toBeNull();
  });
});
