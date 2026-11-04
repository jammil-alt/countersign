// Calls: the operator turns calls on for a client, sends a number's calls to us, sets forwarding and
// sees who answers and the recent calls (summaries as text); the client admin records a contact's
// consent to calls, and sees calls in the contact's messages.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const PAT = "00000000-0000-4000-8000-0000000c0001";
const PN = `PN${"2".repeat(32)}`;

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const base = `https://app.mezonas.test/api/twilio/${DEMO}/voice`;
function callsSetup(over: Record<string, unknown> = {}) {
  return {
    available: true,
    twilio: true,
    enabled: false,
    forwardTo: null,
    numbers: [{ sid: PN, phoneNumber: "+15125550101", voice: true, answering: false }],
    inbound: null,
    webhooks: {
      voice: base,
      answer: `${base}/answer`,
      status: `${base}/status`,
      tools: `https://app.mezonas.test/api/voice/${DEMO}/tools`,
      postCall: "https://app.mezonas.test/api/elevenlabs/post-call",
    },
    ...over,
  };
}

describe("back-office calls", () => {
  it("turns calls on, takes a number's calls and sets forwarding", async () => {
    let setup = callsSetup();
    const sent: unknown[] = [];
    const calls = [
      {
        sid: `CA${"3".repeat(32)}`,
        direction: "out",
        contactId: PAT,
        contactName: "Pat Lee",
        from: "+15125550101",
        to: "+15555550100",
        outcome: "answered",
        durationSecs: 95,
        summary: "<b>Pat confirmed Friday.</b>",
        agentName: "Front desk",
        startedAt: "2026-11-04T12:00:00.000Z",
      },
    ];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "America/Chicago" },
        agents: [],
      }),
      [`GET /api/ops/clients/${DEMO}/messaging`]: () => ({
        setup: {
          available: true,
          timezone: "America/Chicago",
          quietHours: { start: "21:00", end: "08:00" },
          twilio: null,
          webhooks: { messages: "m", status: "s" },
        },
      }),
      [`GET /api/ops/clients/${DEMO}/contacts`]: () => ({ items: [] }),
      [`GET /api/ops/clients/${DEMO}/calls`]: () => ({ setup, calls }),
      [`PUT /api/ops/clients/${DEMO}/calls`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        setup = callsSetup({
          enabled: body.enabled,
          forwardTo: body.forwardTo,
          inbound: {
            decision: body.forwardTo ? "forward" : "voicemail",
            agentId: null,
            agentName: null,
            reason: "no agent answers this client's calls, so the call goes to voicemail",
          },
        });
        return { setup, calls };
      },
      [`PUT /api/ops/clients/${DEMO}/calls/numbers/${PN}`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        setup = { ...setup, numbers: [{ ...setup.numbers[0], answering: true }] } as typeof setup;
        return { setup, calls };
      },
    });
    renderAt(`/ops/clients/${DEMO}/messaging`, api);
    const panel = await screen.findByTestId("ops-calls");
    // The summary is model-written from what was said: shown as text, never as markup.
    expect(within(panel).getByText("<b>Pat confirmed Friday.</b>")).toBeInTheDocument();
    expect(within(panel).getByText("Answered by an agent")).toBeInTheDocument();

    await userEvent.click(within(panel).getByTestId("ops-calls-on"));
    expect(await within(panel).findByTestId("ops-calls-inbound")).toHaveTextContent(
      "goes to voicemail",
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Take its calls" }));
    expect(await within(panel).findByText("Calls come to us")).toBeInTheDocument();
    await userEvent.type(within(panel).getByTestId("ops-calls-forward"), "+15555550199");
    await userEvent.click(within(panel).getByTestId("ops-calls-forward-save"));
    await waitFor(() =>
      expect(sent).toEqual([
        { enabled: true, forwardTo: null },
        { answering: true },
        { enabled: true, forwardTo: "+15555550199" },
      ]),
    );
  });
});

describe("portal: consent to calls", () => {
  it("records a contact's consent to calls and shows calls in their messages", async () => {
    const sent: unknown[] = [];
    let canCall = false;
    const contact = () => ({
      id: PAT,
      name: "Pat Lee",
      phone: "+15555550100",
      whatsapp: null,
      language: null,
      consent: {},
      optedOut: null,
      canMessage: { sms: false, whatsapp: false },
      canCall,
      createdAt: "2026-11-04T10:00:00.000Z",
      updatedAt: "2026-11-04T10:00:00.000Z",
    });
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/contacts": () => ({ items: [contact()] }),
      [`GET /api/contacts/${PAT}/messages`]: () => ({
        items: [
          {
            id: "m1",
            direction: "out",
            channel: "voice",
            text: "Call, 2 min: Pat confirmed Friday.",
            sid: `CA${"3".repeat(32)}`,
            status: "completed",
            at: "2026-11-04T12:00:00.000Z",
          },
        ],
      }),
      [`POST /api/contacts/${PAT}/consent`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        canCall = true;
        return { contact: contact() };
      },
    });
    renderAt("/contacts", api);
    expect(await screen.findByTestId(`contact-${PAT}-voice`)).toHaveTextContent(
      "Calls: not agreed",
    );
    await userEvent.click(screen.getByTestId(`contact-${PAT}-open`));
    expect(await screen.findByText("Call, 2 min: Pat confirmed Friday.")).toBeInTheDocument();
    expect(screen.getByText(/We called · Call/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId(`contact-${PAT}-channel`), "voice");
    await userEvent.type(screen.getByTestId(`contact-${PAT}-source`), "said yes on the phone");
    await userEvent.click(screen.getByTestId(`contact-${PAT}-grant`));
    await waitFor(() =>
      expect(sent).toEqual([
        { action: "grant", channel: "voice", source: "said yes on the phone" },
      ]),
    );
    expect(await screen.findByTestId(`contact-${PAT}-voice`)).toHaveTextContent("Calls: agreed");
  });
});
