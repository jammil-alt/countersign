// The page a tool's sign-in returns to: it passes the provider's parameters to the API once, then
// goes back to Connections; a refusal stays on the page with a way back.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi, Reply } from "../../test/fixtures";
import { OAuthCallbackScreen } from "./OAuthCallback";

const CONNECTED = {
  connection: {
    connector: "zoho_crm",
    name: "Zoho CRM",
    description: "Leads, contacts, accounts and deals.",
    icon: null,
    available: true,
    connection: null,
  },
};

function renderAt(path: string, reply: () => unknown) {
  const sent: { connector: string; body: unknown }[] = [];
  const api = fakeApi({});
  for (const connector of ["zoho_crm", "podio"]) {
    api.on(`POST /api/connections/${connector}/callback`, ({ init }) => {
      sent.push({ connector, body: JSON.parse(String(init.body)) });
      return reply();
    });
  }
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <ApiProvider client={api.client}>
          <Routes>
            <Route path="/connections/:connector/callback" element={<OAuthCallbackScreen />} />
            <Route path="/connections" element={<p>connections page</p>} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>
    </StrictMode>,
  );
  return { sent, user: userEvent.setup() };
}

describe("OAuthCallbackScreen", () => {
  it("sends the provider's parameters once, then returns to Connections", async () => {
    const { sent } = renderAt(
      "/connections/zoho_crm/callback?code=abc&state=s1&location=eu&accounts-server=https%3A%2F%2Faccounts.zoho.eu",
      () => CONNECTED,
    );
    expect(await screen.findByText("connections page")).toBeInTheDocument();
    // StrictMode runs effects twice in development: the code must still go only once.
    expect(sent).toEqual([
      {
        connector: "zoho_crm",
        body: {
          params: {
            code: "abc",
            state: "s1",
            location: "eu",
            "accounts-server": "https://accounts.zoho.eu",
          },
        },
      },
    ]);
  });

  it("says it is connecting while the API answers", async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      release = r;
    });
    renderAt("/connections/podio/callback?code=abc&state=s1", () => pending);
    expect(await screen.findByText("Connecting…")).toBeInTheDocument();
    release(CONNECTED);
  });

  it("shows a refused sign-in and a way back, and doesn't leave the page", async () => {
    const { sent, user } = renderAt(
      "/connections/podio/callback?code=abc&state=tampered",
      () =>
        new Reply(400, { error: { code: "signature", message: "invalid OAuth state: signature" } }),
    );
    expect(await screen.findByText(/invalid OAuth state/)).toBeInTheDocument();
    expect(sent.map((s) => s.connector)).toEqual(["podio"]);
    expect(screen.queryByText("connections page")).toBeNull();
    await user.click(screen.getByRole("link", { name: "Back to Connections" }));
    expect(await screen.findByText("connections page")).toBeInTheDocument();
  });

  it("passes a provider's own refusal through to the API", async () => {
    const { sent } = renderAt(
      "/connections/zoho_crm/callback?error=access_denied&state=s1",
      () =>
        new Reply(400, {
          error: { code: "provider_error", message: "the provider refused: access_denied" },
        }),
    );
    expect(await screen.findByText(/the provider refused: access_denied/)).toBeInTheDocument();
    expect(sent[0]?.body).toEqual({ params: { error: "access_denied", state: "s1" } });
  });
});
