// Reach out screens (plan §1.25): the client admin binds people to an agent's roles in the portal
// (and sees no channels there); the operator's People and Channels sections on a client agent; the
// builder's reach-out inspector; contact details with email, preferences, hours and roles; and the
// back office's email setup with its DNS records.
import type { AgentBundle, Step } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { ApiProvider } from "../api/useApi";
import { ReachOutFields } from "../ops/builder/ReachOutFields";
import { EmailPanel } from "../ops/screens/EmailSetup";
import { CLIENT_SESSION, fakeApi } from "../test/fixtures";
import { OpsChannelsSection, OpsPeopleSection } from "./PeoplePanel";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const AGENT = "00000000-0000-4000-8000-0000000a9001";
const PAT = "00000000-0000-4000-8000-0000000c0001";
const SAM = "00000000-0000-4000-8000-0000000c0002";
const TWILIO = "00000000-0000-4000-8000-0000000d0001";

function peopleOf(people: Record<string, unknown> = {}) {
  return {
    agentId: AGENT,
    agentName: "Orders desk",
    roles: [
      {
        role: "purchaser",
        description: "Buys the materials",
        required: true,
        channels: ["sms", "voice"],
      },
    ],
    people,
    missing: Object.keys(people).length ? [] : ["purchaser"],
    contacts: [
      {
        id: PAT,
        name: "Pat Lee",
        roles: ["purchaser"],
        reachable: ["sms", "voice"],
        optedOut: false,
      },
      { id: SAM, name: "Sam Roe", roles: [], reachable: ["email"], optedOut: true },
    ],
  };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("portal: People", () => {
  it("lets the client admin bind a contact to a role, with conditions; no channels here", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/people": () => ({ items: [peopleOf()] }),
      [`PUT /api/people/${AGENT}`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        return { people: peopleOf(body.people) };
      },
    });
    renderAt("/people/reach", api);
    const role = await screen.findByTestId("role-purchaser", {}, { timeout: 5000 });
    expect(within(role).getByTestId("role-purchaser-required")).toHaveTextContent(
      "Required: nobody yet",
    );
    expect(screen.getByTestId("people-missing")).toHaveTextContent("Waiting on you");
    expect(screen.queryByTestId("agent-channels")).toBeNull();
    // The opted-out contact says so.
    expect(within(role).getByText("Opted out")).toBeInTheDocument();
    await userEvent.click(within(role).getByTestId(`role-purchaser-contact-${PAT}`));
    await userEvent.click(within(role).getByTestId("role-purchaser-channel-voice"));
    // A number and a unit (hours by default), stored as the platform's duration.
    await userEvent.type(within(role).getByTestId("role-purchaser-escalate"), "1");
    expect(within(role).getByTestId("role-purchaser-escalate-unit")).toHaveValue("hour");
    await userEvent.click(within(role).getByTestId("role-purchaser-urgent-hours"));
    await userEvent.click(screen.getByTestId(`people-${AGENT}-save`));
    await waitFor(() =>
      expect(sent).toEqual([
        {
          people: {
            purchaser: {
              contactIds: [PAT],
              conditions: { channels: ["sms"], escalateAfter: "1 hour", urgentOutsideHours: true },
            },
          },
        },
      ]),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(screen.queryByTestId("people-missing")).toBeNull();
  });
});

describe("portal: People picked from the directory", () => {
  it("shows each person's title and organization, and narrows a long list by search", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000c01${String(i).padStart(2, "0")}`,
      name: `Person ${i}`,
      roles: [],
      reachable: ["email" as const],
      optedOut: false,
      title: "Driver",
      organization: "Elm Haulage",
    }));
    const base = peopleOf();
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/people": () => ({
        items: [
          {
            ...base,
            contacts: [
              { ...base.contacts[0], title: "Buyer", organization: "Birch & Co" },
              ...many,
            ],
          },
        ],
      }),
    });
    renderAt("/people/reach", api);
    const role = await screen.findByTestId("role-purchaser", {}, { timeout: 5000 });
    expect(within(role).getByText("Buyer, Birch & Co")).toBeInTheDocument();
    await userEvent.type(within(role).getByTestId("role-purchaser-find"), "birch");
    expect(within(role).getByTestId(`role-purchaser-contact-${PAT}`)).toBeInTheDocument();
    expect(within(role).queryByText("Person 3")).toBeNull();
  });
});

describe("back office: People and Channels", () => {
  it("binds people and the agent's channels", async () => {
    const sent: { route: string; body: unknown }[] = [];
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT}/people`]: () => ({
        people: peopleOf({ purchaser: { contactIds: [PAT], conditions: {} } }),
      }),
      [`PUT /api/ops/agents/${AGENT}/people`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push({ route: "people", body });
        return { people: peopleOf(body.people) };
      },
      [`GET /api/ops/agents/${AGENT}/channels`]: () => ({
        channels: {
          agentId: AGENT,
          channels: {},
          options: [
            {
              connectionId: TWILIO,
              connector: "twilio",
              label: "twilio (AC1)",
              status: "connected",
              channels: ["sms", "whatsapp", "voice"],
            },
          ],
        },
      }),
      [`PUT /api/ops/agents/${AGENT}/channels`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push({ route: "channels", body });
        return { channels: { agentId: AGENT, channels: body.channels, options: [] } };
      },
    });
    render(
      <ApiProvider client={api.client}>
        <OpsPeopleSection agentId={AGENT} />
        <OpsChannelsSection agentId={AGENT} />
      </ApiProvider>,
    );
    const role = await screen.findByTestId("role-purchaser");
    expect(within(role).getByTestId(`role-purchaser-contact-${PAT}`)).toBeChecked();
    await userEvent.type(
      within(role).getByTestId("role-purchaser-only-field"),
      "{{{{trigger.total}}",
    );
    await userEvent.click(screen.getByTestId(`people-${AGENT}-save`));

    const channels = await screen.findByTestId("agent-channels");
    // Email has no connection that can carry it.
    expect(within(channels).getByTestId("agent-channel-email")).toHaveTextContent(
      "No connection can carry it",
    );
    await userEvent.selectOptions(within(channels).getByTestId("agent-channel-sms"), TWILIO);
    await userEvent.selectOptions(within(channels).getByTestId("agent-channel-voice"), TWILIO);
    await userEvent.click(within(channels).getByTestId("agent-channels-save"));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toEqual({
      route: "people",
      body: {
        people: {
          purchaser: {
            contactIds: [PAT],
            conditions: {
              onlyIf: { match: "all", rules: [{ field: "{{trigger.total}}", op: ">" }] },
            },
          },
        },
      },
    });
    expect(sent[1]).toEqual({
      route: "channels",
      body: { channels: { sms: TWILIO, voice: TWILIO } },
    });
  });

  it("shows the email domain's DNS records and checks them", async () => {
    let verified = false;
    const setup = () => ({
      available: true,
      fallbackDomain: "mail.mezonas.test",
      connection: {
        connectionId: "c1",
        status: "connected",
        domain: "shop.example",
        domainStatus: verified ? "verified" : "not_started",
        from: verified ? "orders@shop.example" : "orders@mail.mezonas.test",
        records: [
          {
            record: "DKIM",
            name: "resend._domainkey.shop.example",
            type: "TXT",
            value: "p=MIGf",
            ttl: "Auto",
            priority: null,
            status: verified ? "verified" : "not_started",
          },
        ],
        checkedAt: null,
      },
      replyTo: "client-a-xyz@in.mezonas.test",
    });
    const api = fakeApi({
      [`GET /api/ops/clients/${DEMO}/email`]: () => ({ setup: setup() }),
      [`POST /api/ops/clients/${DEMO}/email/verify`]: () => {
        verified = true;
        return { setup: setup() };
      },
    });
    render(
      <ApiProvider client={api.client}>
        <EmailPanel clientId={DEMO} />
      </ApiProvider>,
    );
    const records = await screen.findByTestId("ops-email-records");
    expect(within(records).getByText("resend._domainkey.shop.example")).toBeInTheDocument();
    expect(screen.getByTestId("ops-email-domain-status")).toHaveTextContent("waiting on DNS");
    expect(screen.getByText(/orders@mail\.mezonas\.test/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("ops-email-verify"));
    expect(await screen.findByText(/orders@shop\.example/)).toBeInTheDocument();
    expect(screen.getByTestId("ops-email-domain-status")).toHaveTextContent("verified");
  });
});

describe("builder: the reach-out inspector", () => {
  it("edits urgency, expect reply, timeout and the message per language", async () => {
    const bundle = {
      people: [{ role: "purchaser", description: "", required: true }],
    } as unknown as AgentBundle;
    let latest: Step | null = null;
    function Harness() {
      const [step, setStep] = useState<Step>({
        id: "reach",
        name: "Ask",
        kind: "skill",
        skill: "comms.reach-out",
        input: { message: { template: { en: "" } } },
      } as Step);
      latest = step;
      return (
        <ReachOutFields
          step={step as Extract<Step, { kind: "skill" }>}
          bundle={bundle}
          paths={[]}
          fieldErrors={{ at: () => [] } as never}
          set={(_key, fn) => setStep((s) => fn(s))}
        />
      );
    }
    render(<Harness />);
    await userEvent.selectOptions(screen.getByTestId("builder-reach-role"), "purchaser");
    await userEvent.type(screen.getByTestId("builder-reach-purpose"), "Confirm Friday");
    await userEvent.selectOptions(screen.getByTestId("builder-reach-urgency"), "urgent");
    await userEvent.clear(screen.getByTestId("builder-reach-timeout"));
    await userEvent.type(screen.getByTestId("builder-reach-timeout"), "4 hours");
    await userEvent.type(screen.getByTestId("builder-reach-message-en"), "Can you confirm?");
    await userEvent.type(screen.getByTestId("builder-reach-message-es"), "¿Puede confirmar?");
    await userEvent.click(screen.getByTestId("builder-reach-expect-reply"));
    expect((latest as unknown as { input: unknown }).input).toEqual({
      to: { role: "purchaser" },
      purpose: "Confirm Friday",
      urgency: "urgent",
      timeout: "4 hours",
      expectReply: false,
      message: { template: { en: "Can you confirm?", es: "¿Puede confirmar?" } },
    });
    // Composing instead hides the per-language texts.
    await userEvent.selectOptions(screen.getByTestId("builder-reach-message-kind"), "compose");
    expect(screen.queryByTestId("builder-reach-message-en")).toBeNull();
    expect((latest as unknown as { input: { message: unknown } }).input.message).toEqual({
      compose: true,
    });
  });
});

describe("contacts: reach-out details", () => {
  it("edits email, preferred channels, timezone and roles", async () => {
    const sent: unknown[] = [];
    const contact = {
      id: PAT,
      name: "Pat Lee",
      phone: "+15555550100",
      whatsapp: null,
      email: null,
      language: null,
      preferredChannels: [],
      timezone: null,
      quietHours: null,
      roles: [],
      notes: null,
      consent: {},
      optedOut: null,
      canMessage: { sms: false, whatsapp: false },
      canCall: false,
      canEmail: false,
      createdAt: "2026-11-04T10:00:00.000Z",
      updatedAt: "2026-11-04T10:00:00.000Z",
    };
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/contacts": () => ({ items: [contact] }),
      [`GET /api/contacts/${PAT}/messages`]: () => ({ items: [] }),
      [`PATCH /api/contacts/${PAT}`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        return { contact: { ...contact, ...body, canEmail: false } };
      },
    });
    renderAt("/contacts", api);
    await userEvent.click(await screen.findByTestId(`contact-${PAT}-open`, {}, { timeout: 5000 }));
    await userEvent.type(screen.getByTestId(`contact-${PAT}-email-input`), "pat@shop.example");
    await userEvent.selectOptions(screen.getByTestId(`contact-${PAT}-preferred-0`), "whatsapp");
    await userEvent.selectOptions(screen.getByTestId(`contact-${PAT}-preferred-1`), "voice");
    await userEvent.type(screen.getByTestId(`contact-${PAT}-timezone`), "America/Chicago");
    await userEvent.type(screen.getByTestId(`contact-${PAT}-roles`), "Purchaser, owner");
    await userEvent.click(screen.getByTestId(`contact-${PAT}-save`));
    await waitFor(() =>
      expect(sent).toEqual([
        {
          email: "pat@shop.example",
          phone: "+15555550100",
          whatsapp: null,
          // The language is sent only when it changed.
          preferredChannels: ["whatsapp", "voice"],
          timezone: "America/Chicago",
          quietHours: null,
          roles: ["purchaser", "owner"],
          notes: null,
        },
      ]),
    );
  });
});
