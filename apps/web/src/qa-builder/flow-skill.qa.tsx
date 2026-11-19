// QA (flow and usability lens, 2026-11-19): New skill by conversation.
// Each test asserts the expected behaviour and fails while its defect is there.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";

await import("../ops/OpsApp");

const SESSION_ID = "00000000-0000-4000-8000-00000000a301";
const at = "2026-11-06T00:00:00.000Z";

const session = {
  id: SESSION_ID,
  kind: "skill",
  clientId: null,
  clientName: null,
  agentId: null,
  skillId: null,
  baseVersionId: null,
  status: "open",
  bundle: { definition: null, cases: [] },
  errors: [],
  closest: [],
  createdAt: at,
  updatedAt: at,
};

function Probe() {
  const loc = useLocation();
  return <span data-testid="location">{`${loc.pathname}${loc.search}`}</span>;
}

function renderAt(path: string, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <Probe />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

describe("QA flow: New skill", () => {
  // FLOW-4: StartConversation starts the session, then sends the first turn, then navigates to
  // `?session=` whatever the turn's answer. A failed skill turn saves nothing on the API (the
  // operator's turn is added only after the model answers, ops-builder.ts), and the navigation
  // unmounts StartConversation with its composer text, its examples and its error.
  it("FLOW-4 keeps the first message and says the Builder failed when the first skill turn fails", async () => {
    const words = "Match each card charge to its receipt by amount and date";
    const { user } = renderAt("/ops/skills/new", {
      "POST /api/ops/builder/sessions": () => ({ session, turns: [] }),
      [`POST /api/ops/builder/sessions/${SESSION_ID}/turns`]: () =>
        new Reply(502, {
          error: {
            code: "builder_unavailable",
            message: "The Builder can't reach its model right now.",
          },
        }),
      // As the API answers after the failed turn: the conversation has no words in it.
      [`GET /api/ops/builder/sessions/${SESSION_ID}`]: () => ({ session, turns: [] }),
    });
    await user.type(await screen.findByTestId("builder-input"), words);
    await user.click(screen.getByTestId("builder-send"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`session=${SESSION_ID}`),
    );
    await screen.findByTestId("new-skill-conversation");

    // Expected: the failure is said, and the words typed are still there to send again.
    expect(screen.getByTestId("new-skill-conversation")).toHaveTextContent(
      "The Builder can't reach its model right now.",
    );
    expect(screen.getByTestId("builder-input")).toHaveValue(words);
  });
});
