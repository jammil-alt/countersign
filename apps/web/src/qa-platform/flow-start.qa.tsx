// FLOW lens: Getting started (`/start`), the first page a new client works through: the questions
// card and the Connect card.
import type { PortalIntakeView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi } from "../test/fixtures";

const INTAKE = "00000000-0000-4000-8000-0000000f0001";
const T = "00000000-0000-4000-8000-0000000f00a1";
const QBO = {
  connector: "qbo",
  name: "QuickBooks Online",
  description: "",
  icon: null,
  available: true,
  credentialForm: false,
  auth: "oauth2" as const,
  personal: false,
  connection: null,
};

const field = (over: Partial<PortalIntakeView["sections"][number]["fields"][number]>) => ({
  key: "general.what",
  sectionKey: "general",
  alsoIn: [],
  label: "What does your business do, and where?",
  kind: "long_text" as const,
  hint: "",
  requiredToStart: false,
  state: "to_ask" as const,
  weThink: null,
  fileSection: null,
  connector: null,
  ...over,
});

function intakeView(): PortalIntakeView {
  return {
    intake: {
      id: INTAKE,
      status: "sent",
      startMode: "point",
      leadNote: "Jammil suggested we start with how Acme handles bills.",
      lead: { name: "Jammil Lead", photoUrl: null },
      createdAt: "2026-11-17T10:00:00.000Z",
    },
    sections: [
      {
        key: "area:purchasing",
        kind: "area",
        area: "purchasing",
        templateId: null,
        title: "Purchasing",
        intro: "How you buy materials and pay for them today.",
        fields: [
          field({
            key: "purchasing.bills",
            sectionKey: "area:purchasing",
            label: "About how many bills do you get in a month?",
            kind: "number",
          }),
          field({
            key: "purchasing.spend",
            sectionKey: "area:purchasing",
            label: "About how much do you spend on materials in a month?",
            kind: "money",
          }),
        ],
      },
      {
        key: `agent:${T}`,
        kind: "agent",
        area: null,
        templateId: T,
        title: "Contracts check",
        intro: "Checks each bill against the vendor's contract before you pay it.",
        fields: [
          field({
            key: "tool.qbo",
            sectionKey: `agent:${T}`,
            label: "Connect QuickBooks",
            kind: "tool",
            connector: "qbo",
            requiredToStart: true,
          }),
        ],
      },
    ],
    answers: [],
    progress: [
      {
        sectionKey: "area:purchasing",
        answered: 0,
        total: 2,
        notSure: 0,
        missing: [],
        decision: null,
      },
      { sectionKey: `agent:${T}`, answered: 0, total: 1, notSure: 0, missing: [], decision: null },
    ],
    people: [{ id: "p1", name: "Dana Admin", sections: null, isAdmin: true }],
    you: { personId: "p1", sections: null, isAdmin: true },
  };
}

function setup(over: Record<string, Parameters<typeof fakeApi>[0][string]> = {}) {
  const sent: { route: string; body: unknown }[] = [];
  const view = intakeView();
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/intake": () => ({ intake: view }),
    "GET /api/connections": () => ({ connections: [QBO] }),
    "GET /api/team": () => ({ members: [], settings: { undoSeconds: 0 } }),
    [`POST /api/intake/${INTAKE}/answers`]: ({ init }) => {
      sent.push({ route: "answers", body: JSON.parse(String(init.body)) });
      return view;
    },
    ...over,
  });
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, sent };
}

describe("FLOW: Getting started", () => {
  it("FLOW-2: an amount typed as people write it ($12,500) is neither dropped nor wiped", {
    timeout: 15_000,
  }, async () => {
    const { sent } = setup();
    const card = await screen.findByTestId("start-card-area:purchasing");
    await userEvent.type(within(card).getByTestId("start-input-purchasing.bills"), "340");
    await userEvent.type(within(card).getByTestId("start-input-purchasing.spend"), "$12,500");
    await userEvent.click(within(card).getByTestId("start-save"));
    await waitFor(() => expect(sent.some((s) => s.route === "answers")).toBe(true));
    // What was sent: the bills only. The amount went nowhere.
    const body = sent.find((s) => s.route === "answers")?.body as {
      answers: { fieldKey: string }[];
    };
    const keys = body.answers.map((a) => a.fieldKey);
    // Expected: the amount is sent (read as 12500), or it stays in its box with a word on why.
    const box = (within(card).getByTestId("start-input-purchasing.spend") as HTMLInputElement)
      .value;
    expect({ sent: keys, box }).toSatisfy(
      (o: { sent: string[]; box: string }) =>
        o.sent.includes("purchasing.spend") || o.box === "$12,500",
    );
  });
});
