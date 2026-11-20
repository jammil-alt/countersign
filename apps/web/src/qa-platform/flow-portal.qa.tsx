// FLOW lens: the portal's Accounts vault, Home's owners and Settings, as a small-business client
// meets them: what they read when something fails, and whether they can back out of a step.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, Reply, tableView } from "../test/fixtures";

for (const level of ["warn", "error"] as const)
  vi.spyOn(console, level).mockImplementation(() => {});

const TENANT = CLIENT_SESSION.activeTenantId as string;
type Handler = Parameters<typeof fakeApi>[0][string];

function renderAt(path: string, routes: Record<string, Handler>) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Harbor Millwork", role: "client_admin" }],
    }),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/overview": () => ({
      client: { id: TENANT, name: "Harbor Millwork" },
      services: [],
      needsYou: { inbox: 0 },
      recentRuns: [],
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

const TWILIO_TEXT =
  "Twilio: The requested resource /2010-04-01/Accounts/AC0000000000000000000000000000beef/IncomingPhoneNumbers.json was not found";

describe("FLOW: the portal", () => {
  it("FLOW-6: setting up a website login that fails shows our words, not Twilio's", async () => {
    // As apps/api answers today when the code service can't buy the agent a number
    // (routes/browser.ts codesError: 503 with the code service's message; see flow-browser.qa.ts).
    renderAt("/accounts", {
      "GET /api/connections": () => ({ connections: [] }),
      "GET /api/access": () => ({
        items: [],
        setup: [],
        browserSites: [
          { slug: "texter", name: "Texting supplier", tier: "low", secondFactor: "sms" },
        ],
        canEdit: true,
        people: [],
      }),
      "POST /api/access/browser": () =>
        new Reply(503, { error: { code: "codes_unavailable", message: TWILIO_TEXT } }),
    });
    const offer = await screen.findByTestId("vault-browser-offer-texter");
    await userEvent.click(within(offer).getByTestId("vault-browser-confirm"));
    await userEvent.click(within(offer).getByTestId("vault-browser-setup-submit"));
    const alert = await within(offer).findByRole("alert");
    expect(alert.textContent).not.toMatch(/Twilio|Accounts\/AC/);
  });

  it("FLOW-7: the owner rename can be closed without saving", async () => {
    const OWNER = "00000000-0000-4000-8000-0000000a0a01";
    renderAt("/", {
      "GET /api/table": () =>
        tableView({
          owners: [
            {
              id: OWNER,
              name: "Pia",
              area: "purchasing",
              processes: 1,
              health: "working",
              runs: 0,
              corrected: 0,
              last: null,
            },
          ],
        }),
      "GET /api/access": () => ({
        items: [],
        setup: [],
        browserSites: [],
        canEdit: true,
        people: [],
      }),
      "GET /api/weekly": () => ({ table: null, weeks: [] }),
    });
    await userEvent.click(await screen.findByTestId("home-owner-rename-purchasing"));
    const card = screen.getByTestId("home-owner-purchasing");
    expect(within(card).getByTestId("home-owner-rename-input-purchasing")).toBeInTheDocument();
    // Expected: a Cancel (or Escape) that closes the form and keeps "Pia".
    const cancel = within(card).queryByRole("button", { name: /cancel/i });
    expect(cancel).not.toBeNull();
  });

  it("FLOW-8: notification settings that fail to load say so, instead of vanishing", async () => {
    renderAt("/settings", {
      "GET /api/settings": () => ({
        client: { id: TENANT, name: "Harbor Millwork", timezone: "UTC" },
        approvals: "operator",
        notifications: { itemsWaiting: true, weeklyDigest: true },
        emailsOn: true,
      }),
      "GET /api/settings/my-notifications": () =>
        new Reply(500, { error: { code: "internal", message: "boom" } }),
      "GET /api/team": () => ({ members: [], settings: { undoSeconds: 60 } }),
    });
    await screen.findByRole("navigation", { name: "Sections" });
    await screen.findByTestId("portal-settings-language");
    // Expected: a notice with a retry where "Your notifications" would be. Today the section and
    // the team's emails are simply missing: nowhere to turn the emails off, and no word why.
    await waitFor(() => expect(screen.queryByTestId("error-failure")).not.toBeNull(), {
      timeout: 2000,
    });
  });
});
