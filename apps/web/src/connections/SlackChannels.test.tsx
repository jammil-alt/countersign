// v0.14 W4-C: Slack on the portal's Connections page (docs/plan.md §1.56): its description in the
// reader's language; the client admin picks channels (the bot's membership shown, the picks saved
// by id); a client user never sees the picker.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../test/fixtures";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const SLACK_CONN = "00000000-0000-4000-8000-0000000e0051";
const matrix = { read: "auto", create: "approval", update: "approval", delete: "off", scope: null };

const SLACK = {
  connector: "slack",
  name: "Slack",
  description: "Post messages to the Slack channels you pick. We can't read your messages.",
  icon: "message",
  available: true,
  credentialForm: false,
  personal: false,
  connection: {
    id: SLACK_CONN,
    status: "connected",
    externalAccountId: "T0ACMEMILL",
    accountName: "Acme Millwork",
    lastSyncAt: null,
    permissions: matrix,
    access: [],
    usedBy: [],
    connectedByYou: true,
  },
};

const CHANNELS = {
  connectionId: SLACK_CONN,
  workspace: "Acme Millwork",
  channels: [
    { id: "C0ACCTS001", name: "accounts", isMember: true, picked: false },
    { id: "C0GENERAL1", name: "general", isMember: false, picked: false },
    { id: "C0ORDERS01", name: "orders", isMember: true, picked: true },
  ],
  picked: [{ id: "C0ORDERS01", name: "orders" }],
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
    "GET /api/connections/slack/channels": () => CHANNELS,
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

describe("Slack on the Connections page", () => {
  it("says what it does in the reader's language", async () => {
    renderAs("client_user", "es", [{ ...SLACK, connection: null }]);
    const card = await screen.findByTestId("portal-connection-slack");
    expect(
      within(card).getByText(
        "Publique mensajes en los canales de Slack que elija. No podemos leer sus mensajes.",
      ),
    ).toBeTruthy();
  });

  it("lets the client admin pick channels, saved by id", async () => {
    const api = renderAs("client_admin", "en", [SLACK]);
    const bodies: unknown[] = [];
    api.on("PUT /api/connections/slack/channels", ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      return CHANNELS;
    });
    const picker = await screen.findByTestId("slack-channels");
    expect(await within(picker).findByText("Workspace: Acme Millwork")).toBeTruthy();
    expect(within(picker).getByTestId("slack-picked-count").textContent).toBe("1 channel picked");
    expect(
      (within(picker).getByTestId("slack-channel-C0ORDERS01") as HTMLInputElement).checked,
    ).toBe(true);
    // The bot isn't in #general yet: the admin is told what to do, in words.
    expect(within(picker).getByTestId("slack-channel-C0GENERAL1-not-member").textContent).toBe(
      "Add Mezonas to this channel in Slack",
    );
    expect(within(picker).queryByTestId("slack-channel-C0ACCTS001-not-member")).toBeNull();
    const save = within(picker).getByTestId("slack-channels-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.click(within(picker).getByTestId("slack-channel-C0ACCTS001"));
    await userEvent.click(within(picker).getByTestId("slack-channel-C0ORDERS01"));
    expect(within(picker).getByTestId("slack-picked-count").textContent).toBe("1 channel picked");
    await userEvent.click(save);
    await within(picker).findByTestId("slack-channels-saved");
    expect(bodies).toEqual([{ channels: ["C0ACCTS001"] }]);
  });

  it("isn't shown to a client user", async () => {
    const api = renderAs("client_user", "en", [SLACK]);
    await screen.findByTestId("portal-connection-slack");
    expect(screen.queryByTestId("slack-channels")).toBeNull();
    await waitFor(() => expect(api.calls).toContain("GET /api/connections"));
    expect(api.calls).not.toContain("GET /api/connections/slack/channels");
  });
});
