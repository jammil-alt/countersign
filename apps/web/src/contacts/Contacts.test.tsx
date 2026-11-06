// Contacts and texting setup: the client admin keeps contacts and their consent at /contacts (a
// STOP opt-out has no lift button); the operator makes the client's Twilio subaccount and buys a
// number at /ops/clients/:id/messaging.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const PAT = "00000000-0000-4000-8000-0000000c0001";
const SAM = "00000000-0000-4000-8000-0000000c0002";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const contact = (over: Record<string, unknown> = {}) => ({
  id: PAT,
  name: "Pat Lee",
  phone: "+15555550100",
  whatsapp: null,
  language: null,
  consent: { sms: { grantedAt: "2026-11-04T10:00:00.000Z", source: "signed the agreement" } },
  optedOut: null,
  canMessage: { sms: true, whatsapp: false },
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:00.000Z",
  ...over,
});

const portalBase = {
  "GET /api/session": () => CLIENT_SESSION,
  "GET /api/feedback/status": () => ({ enabled: false }),
  "GET /api/overview": () => ({
    client: { id: DEMO, name: "Demo client" },
    services: [],
    needsYou: { inbox: 0 },
    recentRuns: [],
  }),
};

describe("portal contacts", () => {
  it("adds a contact with consent, then opts them out", async () => {
    const items: ReturnType<typeof contact>[] = [];
    const sent: unknown[] = [];
    const api = fakeApi({
      ...portalBase,
      "GET /api/contacts": () => ({ items }),
      "POST /api/contacts": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        const c = contact();
        items.push(c);
        return { contact: c };
      },
      [`GET /api/contacts/${PAT}/messages`]: () => ({
        items: [
          {
            id: "m1",
            direction: "in",
            channel: "sms",
            text: "<b>Is it ready?</b>",
            sid: null,
            status: null,
            at: "2026-11-04T11:00:00.000Z",
          },
        ],
      }),
      [`POST /api/contacts/${PAT}/consent`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        items[0] = contact({
          optedOut: { at: "2026-11-04T12:00:00.000Z", source: "client" },
          canMessage: { sms: false, whatsapp: false },
        });
        return { contact: items[0] };
      },
    });
    renderAt("/contacts", api);
    expect(await screen.findByText(/No contacts yet/)).toBeInTheDocument();
    // Consent and messages are a tab of People (C5).
    expect(screen.getByTestId("portal-people")).toBeInTheDocument();
    const save = screen.getByTestId("contact-add-save");
    await userEvent.type(screen.getByTestId("contact-add-name"), "Pat Lee");
    await userEvent.type(screen.getByTestId("contact-add-phone"), "+1 555 555 0100");
    await userEvent.click(screen.getByTestId("contact-add-agreed"));
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByTestId("contact-add-source"), "signed the agreement");
    await userEvent.click(save);
    expect(sent[0]).toEqual({
      name: "Pat Lee",
      phone: "+1 555 555 0100",
      consent: { channels: ["sms"], source: "signed the agreement" },
    });
    expect(await screen.findByTestId(`contact-${PAT}-sms`)).toHaveTextContent("Texts: agreed");

    await userEvent.click(screen.getByTestId(`contact-${PAT}-open`));
    // Their words show as text, never as markup.
    const msgs = await screen.findByTestId(`contact-${PAT}-messages`);
    expect(within(msgs).getByText("<b>Is it ready?</b>")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId(`contact-${PAT}-opt-out`));
    expect(sent[1]).toEqual({ action: "opt_out" });
    expect(await screen.findByTestId(`contact-${PAT}-opted-out`)).toHaveTextContent("Opted out");
    expect(await screen.findByTestId(`contact-${PAT}-lift`)).toBeInTheDocument();
  });

  it("offers no lift for a contact who texted STOP", async () => {
    const api = fakeApi({
      ...portalBase,
      "GET /api/contacts": () => ({
        items: [
          contact({
            id: SAM,
            name: "Sam Ortiz",
            optedOut: { at: "2026-11-04T12:00:00.000Z", source: "keyword:STOP" },
            canMessage: { sms: false, whatsapp: false },
          }),
        ],
      }),
      [`GET /api/contacts/${SAM}/messages`]: () => ({ items: [] }),
    });
    renderAt("/contacts", api);
    await userEvent.click(await screen.findByTestId(`contact-${SAM}-open`));
    expect(
      await screen.findByText(/Only they can opt back in, by texting START/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(`contact-${SAM}-lift`)).toBeNull();
  });
});

describe("ops texting setup", () => {
  it("makes the subaccount and buys a number", async () => {
    const setup = {
      available: true,
      timezone: "America/Chicago",
      quietHours: { start: "21:00", end: "08:00" },
      twilio: null as null | Record<string, unknown>,
      webhooks: {
        messages: `https://app.mezonas.test/api/twilio/${DEMO}/messages`,
        status: `https://app.mezonas.test/api/twilio/${DEMO}/status`,
      },
    };
    const twilio = {
      connectionId: "00000000-0000-4000-8000-0000000e0001",
      status: "connected",
      subaccountSid: `AC${"1".repeat(32)}`,
      numbers: [] as unknown[],
      a2p: {
        brandSid: null,
        messagingServiceSid: null,
        brandStatus: null,
        campaignStatus: null,
        status: "not_started",
        checkedAt: null,
      },
    };
    const bought: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "America/Chicago" },
        agents: [],
      }),
      [`GET /api/ops/clients/${DEMO}/messaging`]: () => ({ setup }),
      [`POST /api/ops/clients/${DEMO}/messaging/twilio`]: () => ({ setup: { ...setup, twilio } }),
      [`GET /api/ops/clients/${DEMO}/messaging/numbers/available`]: () => ({
        items: [
          {
            phoneNumber: "+15125550101",
            friendlyName: null,
            locality: "Austin",
            region: "TX",
            capabilities: { sms: true, mms: true, voice: true },
          },
        ],
      }),
      [`POST /api/ops/clients/${DEMO}/messaging/numbers`]: ({ init }) => {
        bought.push(JSON.parse(String(init.body)));
        return {
          setup: {
            ...setup,
            twilio: {
              ...twilio,
              numbers: [
                {
                  sid: `PN${"2".repeat(32)}`,
                  phoneNumber: "+15125550101",
                  friendlyName: null,
                  capabilities: { sms: true, mms: true, voice: true },
                  whatsapp: false,
                  purchasedAt: "2026-11-04T12:00:00.000Z",
                },
              ],
            },
          },
        };
      },
      [`GET /api/ops/clients/${DEMO}/contacts`]: () => ({ items: [] }),
    });
    renderAt(`/ops/clients/${DEMO}/messaging`, api);
    await userEvent.click(await screen.findByTestId("ops-twilio-provision"));
    expect(await screen.findByTestId("ops-twilio-subaccount")).toHaveTextContent(
      twilio.subaccountSid,
    );
    expect(screen.getByTestId("ops-a2p-status")).toHaveTextContent("Not started");
    await userEvent.type(screen.getByTestId("ops-number-area"), "512");
    await userEvent.click(screen.getByTestId("ops-number-search"));
    await userEvent.click(await screen.findByTestId("ops-number-buy-+15125550101"));
    expect(bought).toEqual([{ phoneNumber: "+15125550101" }]);
    await waitFor(() => expect(screen.getByTestId("ops-number-+15125550101")).toBeInTheDocument());
    expect(api.calls).toContain(`GET /api/ops/clients/${DEMO}/messaging/numbers/available`);
  });
});
