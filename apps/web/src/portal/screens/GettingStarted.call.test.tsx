// Answers from a call on Getting started (docs/setup-plan.md §8; docs/plan.md §1.199 q4): an answer
// the lead gave on a call shows "From our call: please check" until the client says yes, which
// sends it as their own answer; Change opens the card's own editor.
import type { PortalIntakeView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const INTAKE = "00000000-0000-4000-8000-0000000f0001";
const SLOW = 15_000;

const field = (over: Partial<PortalIntakeView["sections"][number]["fields"][number]>) => ({
  key: "general.approver",
  sectionKey: "general",
  alsoIn: [],
  label: "Who approves payments and changes?",
  kind: "text" as const,
  hint: "",
  requiredToStart: false,
  state: "to_ask" as const,
  weThink: null,
  fileSection: null,
  connector: null,
  ...over,
});

const fromCall = (fieldKey: string, value: unknown) => ({
  fieldKey,
  value,
  state: "answered" as const,
  source: "call" as const,
  by: { id: "00000000-0000-4000-8000-00000000d001", name: "Ana" },
  at: "2026-11-22T10:00:00.000Z",
});

function view(answers: PortalIntakeView["answers"]): PortalIntakeView {
  return {
    intake: {
      id: INTAKE,
      status: "open",
      startMode: "point",
      leadNote: "",
      lead: { name: "Ana Navarro", photoUrl: null },
      createdAt: "2026-11-17T10:00:00.000Z",
    },
    sections: [
      {
        key: "general",
        kind: "general",
        area: null,
        templateId: null,
        title: "The business",
        intro: "",
        fields: [
          field({}),
          field({
            key: "fact.abc",
            label: "Tools you use",
            fileSection: "systems",
            state: "to_confirm",
            weThink: { value: "QuickBooks Online", text: "They use QuickBooks Online" },
          }),
        ],
      },
    ],
    answers,
    progress: [
      { sectionKey: "general", answered: 0, total: 2, notSure: 0, missing: [], decision: null },
    ],
    people: [{ id: "p1", name: "Dana Admin", sections: null, isAdmin: true }],
    you: { personId: "p1", sections: null, isAdmin: true },
  };
}

function setup() {
  const sent: unknown[] = [];
  const first = view([
    fromCall("general.approver", "Luis signs over $5,000"),
    fromCall("fact.abc", "QuickBooks Online and Gmail"),
  ]);
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/intake": () => ({ intake: first }),
    [`POST /api/intake/${INTAKE}/answers`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      return view([
        { ...fromCall("general.approver", "Luis signs over $5,000"), source: "form" },
        fromCall("fact.abc", "QuickBooks Online and Gmail"),
      ]);
    },
  });
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { sent };
}

describe("answers from a call", () => {
  it(
    "asks the client to check them, and Yes makes it their own answer",
    async () => {
      const { sent } = setup();
      // The card and the plain form both ask it; the card's is first.
      const [question] = await screen.findAllByTestId("start-from-call-general.approver");
      if (!question) throw new Error("no question");
      expect(question).toHaveTextContent("From our call: please check");
      const line = screen.getByTestId("start-line-fact.abc");
      expect(line).toHaveTextContent("QuickBooks Online and Gmail");
      expect(within(line).getByTestId("start-from-call-fact.abc")).toHaveTextContent(
        "From our call: please check",
      );
      expect(within(line).queryByText("Confirmed")).toBeNull();

      await userEvent.click(within(question).getByTestId("start-call-yes"));
      await waitFor(() =>
        expect(sent).toEqual([
          {
            answers: [
              { fieldKey: "general.approver", state: "answered", value: "Luis signs over $5,000" },
            ],
          },
        ]),
      );
      await waitFor(() =>
        expect(screen.queryAllByTestId("start-from-call-general.approver")).toEqual([]),
      );
      // Change on a line opens its editor.
      await userEvent.click(within(line).getByRole("button", { name: "Change" }));
      expect(within(line).getByTestId("start-change-save")).toBeInTheDocument();
    },
    SLOW,
  );
});
