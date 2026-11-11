// `/settings/channels` (R8, docs/plan.md §1.86): the account's number and email, each agent's own
// apart from the account's, read by everyone on the team; nothing here changes them (we set them
// up), and the page says how to ask.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const DEMO = CLIENT_SESSION.activeTenantId as string;
const TWILIO = "00000000-0000-4000-8000-0000000c0001";
const RESEND = "00000000-0000-4000-8000-0000000c0002";
const OWN = "00000000-0000-4000-8000-0000000c0003";
const PIA = "00000000-0000-4000-8000-0000000a0001";
const SAM = "00000000-0000-4000-8000-0000000a0002";

const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

const account = [
  {
    kind: "email",
    connectionId: RESEND,
    connector: "resend",
    address: "office@demo.mezonas.email",
    source: "default",
  },
  {
    kind: "sms",
    connectionId: TWILIO,
    connector: "twilio",
    address: "+15125550100",
    source: "account",
  },
  { kind: "voice", connectionId: TWILIO, connector: "twilio", address: null, source: "account" },
];

function renderAs(role: "client_admin" | "client_user", locale: string, body: unknown) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: DEMO, name: "Demo client", role }],
      language: { effective: locale, user: locale, client: null },
    }),
    "GET /api/overview": () => overview,
    "GET /api/settings/channels": () => body,
  });
  render(
    <MemoryRouter initialEntries={["/settings/channels"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("channels in the portal", () => {
  it("shows the account's number and email and each agent's own, with nothing to change", async () => {
    const api = renderAs("client_admin", "en", {
      account,
      agents: [
        {
          agentId: PIA,
          name: "Purchasing",
          channels: [
            {
              kind: "email",
              connectionId: OWN,
              connector: "resend",
              address: "pia@demo.mezonas.email",
              source: "agent",
            },
            account[1],
          ],
        },
        { agentId: SAM, name: "Collections", channels: account },
      ],
    });
    const lines = await screen.findByTestId("portal-channels-account-lines");
    expect(within(lines).getByTestId("portal-channels-account-lines-email")).toHaveTextContent(
      "Emailoffice@demo.mezonas.email",
    );
    expect(within(lines).getByTestId("portal-channels-account-lines-sms")).toHaveTextContent(
      "Text+15125550100",
    );
    // A number not ready yet says so.
    expect(within(lines).getByTestId("portal-channels-account-lines-voice")).toHaveTextContent(
      "Not set up yet",
    );
    // An agent with its own address: its own marked apart from the account's.
    const pia = screen.getByTestId(`portal-channels-agent-${PIA}-lines`);
    expect(within(pia).getByTestId(`portal-channels-agent-${PIA}-lines-email`)).toHaveTextContent(
      "pia@demo.mezonas.emailIts own",
    );
    expect(within(pia).getByTestId(`portal-channels-agent-${PIA}-lines-sms`)).toHaveTextContent(
      "Your account's",
    );
    // An agent with none of its own uses the account's.
    expect(screen.getByTestId(`portal-channels-agent-${SAM}`)).toHaveTextContent(
      "Uses your account's number and email address.",
    );
    expect(screen.getByTestId("portal-channels-change")).toHaveTextContent(
      "We set up numbers and addresses. To change one, ask us.",
    );
    // Read-only: no control changes a channel, and only the read route is called.
    expect(screen.getByTestId("portal-channels").querySelector("select, input")).toBeNull();
    expect(api.calls.filter((c) => c.includes("channels"))).toEqual(["GET /api/settings/channels"]);
  });

  it("says when the account has none yet, in a client user's language", async () => {
    renderAs("client_user", "de", { account: [], agents: [] });
    expect(await screen.findByTestId("portal-channels-account-none")).toHaveTextContent(
      "Ihr Konto hat noch keine Nummer und keine E-Mail-Adresse.",
    );
    expect(screen.getByTestId("portal-channels-agents")).toHaveTextContent("Noch keine Agenten.");
  });
});
