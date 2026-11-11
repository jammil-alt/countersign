// The client settings' Business hours and Channels (R8, docs/plan.md §1.86): the client's week and
// its people's own hours, read-only (the client admin sets them in the portal); the account's
// channels bound by us, and what each agent sends on.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const DANA = "00000000-0000-4000-8000-00000000d101";
const MARCO = "00000000-0000-4000-8000-0000000c0b01";
const LISA = "00000000-0000-4000-8000-0000000c0b02";
const TWILIO = "00000000-0000-4000-8000-0000000c0001";
const TWILIO_2 = "00000000-0000-4000-8000-0000000c0004";
const RESEND = "00000000-0000-4000-8000-0000000c0002";
const PIA = "00000000-0000-4000-8000-0000000a0001";
const NINE_TO_SIX = [{ from: "08:00", to: "18:00" }];

function setup(
  section: "hours" | "channels",
  handlers: Record<string, Parameters<typeof fakeApi>[0][string]>,
) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${DEMO}`]: () => ({
      client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
      agents: [],
      connections: [],
      members: [],
    }),
    ...handlers,
  });
  render(
    <MemoryRouter initialEntries={[`/ops/clients/${DEMO}/settings/${section}`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("client business hours, from the back office", () => {
  it("shows the client's week and its people's own hours, with nothing to change", async () => {
    const api = setup("hours", {
      [`GET /api/ops/clients/${DEMO}/hours`]: () => ({
        business: {
          hours: {
            tz: "America/Chicago",
            week: { mon: NINE_TO_SIX, tue: NINE_TO_SIX, wed: NINE_TO_SIX, thu: NINE_TO_SIX },
            usHolidays: false,
            closed: ["2026-12-24"],
          },
          isDefault: false,
        },
        people: [
          {
            kind: "user",
            id: DANA,
            name: "Dana Kim",
            hours: {
              hours: {
                tz: "America/Chicago",
                week: { mon: [{ from: "07:00", to: "15:00" }] },
                usHolidays: true,
                closed: [],
              },
              away: [],
            },
          },
          {
            kind: "contact",
            id: MARCO,
            name: "Marco Díaz",
            hours: { away: [{ from: "2026-12-21", to: "2027-01-02" }] },
          },
          { kind: "contact", id: LISA, name: "Lisa Park", hours: null },
        ],
      }),
    });
    expect(await screen.findByTestId("ops-client-settings-nav-hours")).toHaveTextContent(
      "Business hours",
    );
    const week = await screen.findByTestId("ops-client-business-hours");
    expect(week).toHaveTextContent("Their week");
    expect(within(week).getByTestId("ops-client-business-hours-summary-week")).toHaveTextContent(
      "Mon to Thu8:00 AM to 6:00 PM",
    );
    expect(week).toHaveTextContent("Time zone: America/Chicago");
    expect(week).toHaveTextContent("Open on US federal holidays.");
    expect(week).toHaveTextContent("Dec 24, 2026");
    const people = screen.getByTestId("ops-client-people-hours");
    expect(people).toHaveTextContent("2 of 3");
    expect(screen.getByTestId(`ops-client-person-hours-${DANA}`)).toHaveTextContent(
      "Mon7:00 AM to 3:00 PM",
    );
    expect(screen.getByTestId(`ops-client-person-hours-${MARCO}`)).toHaveTextContent(
      "Dec 21, 2026 to Jan 2, 2027",
    );
    expect(screen.queryByTestId(`ops-client-person-hours-${LISA}`)).toBeNull();
    expect(people).toHaveTextContent("Everyone else works the business's hours.");
    // The client's own: no editor, no save.
    expect(
      screen.getByTestId("ops-client-settings-hours").querySelector("input, select"),
    ).toBeNull();
    expect(api.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });
});

describe("client channels, from the back office", () => {
  it("binds the account's text channel and shows what each agent sends on", async () => {
    const puts: unknown[] = [];
    let bindings: Record<string, string> = {};
    const view = () => ({
      clientId: DEMO,
      bindings,
      account: [
        {
          kind: "email",
          connectionId: RESEND,
          connector: "resend",
          address: "office@demo.mezonas.email",
          source: "default",
        },
        {
          kind: "sms",
          connectionId: bindings.sms ?? TWILIO,
          connector: "twilio",
          address: bindings.sms ? "+15125550199" : "+15125550100",
          source: bindings.sms ? "account" : "default",
        },
      ],
      agents: [
        {
          agentId: PIA,
          name: "Purchasing",
          channels: [
            {
              kind: "email",
              connectionId: RESEND,
              connector: "resend",
              address: "pia@demo.mezonas.email",
              source: "agent",
            },
          ],
        },
      ],
      options: [
        {
          connectionId: TWILIO,
          connector: "twilio",
          label: "Twilio · +15125550100",
          status: "connected",
          channels: ["sms", "voice"],
        },
        {
          connectionId: TWILIO_2,
          connector: "twilio",
          label: "Twilio · +15125550199",
          status: "connected",
          channels: ["sms", "voice"],
        },
        {
          connectionId: RESEND,
          connector: "resend",
          label: "Resend",
          status: "connected",
          channels: ["email"],
        },
      ],
    });
    setup("channels", {
      [`GET /api/ops/clients/${DEMO}/channels`]: view,
      [`PUT /api/ops/clients/${DEMO}/channels`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        bindings = body.channels;
        return view();
      },
    });
    const editor = await screen.findByTestId("ops-client-channels");
    expect(editor).toHaveTextContent("The account's channels");
    const sms = within(editor).getByTestId("ops-client-channel-sms");
    expect(sms).toHaveValue("");
    expect(within(sms).getAllByRole("option")[0]).toHaveTextContent("The default");
    expect(
      within(screen.getByTestId("ops-client-channels-account-lines")).getByTestId(
        "ops-client-channels-account-lines-sms",
      ),
    ).toHaveTextContent("+15125550100The default");

    await userEvent.selectOptions(sms, TWILIO_2);
    await userEvent.click(within(editor).getByTestId("ops-client-channels-save"));
    await waitFor(() => expect(puts).toEqual([{ channels: { sms: TWILIO_2 } }]));
    await waitFor(() =>
      expect(screen.getByTestId("ops-client-channels-account-lines-sms")).toHaveTextContent(
        "+15125550199The account's",
      ),
    );
    expect(within(editor).getByText("Saved.")).toBeInTheDocument();
    // Each agent: its own first; its own are set on its page.
    const pia = screen.getByTestId(`ops-client-channels-agent-${PIA}`);
    expect(pia).toHaveTextContent("pia@demo.mezonas.emailIts own");
    expect(within(pia).getByRole("link")).toHaveAttribute("href", `/ops/agents/${PIA}`);
  });
});
