// The client page's Messaging (Setup): when Mezonas' own Twilio or ElevenLabs keys aren't set, it
// says in plain words what's missing and who sets it up, never the variables' names.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";

describe("back-office messaging, not set up yet", () => {
  it("says what is missing and who adds it, without variable names", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "America/Chicago", settings: {} },
        agents: [],
        connections: [],
        members: [],
      }),
      [`GET /api/ops/clients/${DEMO}/messaging`]: () => ({
        setup: {
          available: false,
          timezone: "America/Chicago",
          quietHours: { start: "21:00", end: "08:00" },
          twilio: null,
          webhooks: { messages: "m", status: "s" },
        },
      }),
      [`GET /api/ops/clients/${DEMO}/calls`]: () => ({
        setup: {
          available: false,
          twilio: false,
          enabled: false,
          forwardTo: null,
          numbers: [],
          inbound: null,
          webhooks: { voice: "v", answer: "a", status: "s", tools: "t", postCall: "p" },
        },
        calls: [],
      }),
      [`GET /api/ops/clients/${DEMO}/contacts`]: () => ({ items: [] }),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/clients/${DEMO}/messaging`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(
      await screen.findByTestId("ops-twilio-unavailable", {}, { timeout: 10_000 }),
    ).toHaveTextContent("Texts and WhatsApp aren't set up for Mezonas yet. An engineer adds");
    expect(await screen.findByTestId("ops-calls-unavailable")).toHaveTextContent(
      "An engineer adds our ElevenLabs key.",
    );
    expect(document.body).not.toHaveTextContent(/TWILIO_|ELEVENLABS_|_API_KEY|_SECRET/);
  });
});
