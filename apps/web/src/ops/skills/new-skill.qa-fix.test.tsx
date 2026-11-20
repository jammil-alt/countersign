// New skill keeps the first message and says why when the Builder's first turn fails (FLOW-4,
// BUILDER_QA.md, the flow lens of 2026-11-19).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

await import("../OpsApp");

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

const turn = {
  id: "00000000-0000-4000-8000-00000000a402",
  seq: 2,
  role: "builder",
  text: "Here is a first draft.",
  command: null,
  changes: [],
  questions: [],
  gaps: [],
  notes: [],
  errors: [],
  savedVersionId: null,
  costUsd: "0.01",
  undoneAt: null,
  createdAt: at,
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

describe("New skill's first message", () => {
  // FLOW-4: StartConversation went to `?session=` whatever the first turn's answer. A failed skill
  // turn saves nothing on the API (the operator's turn is added only with the Builder's answer),
  // so the conversation page was empty: no words, no examples, no error.
  it("keeps the first message and says the Builder failed when the first skill turn fails", async () => {
    const words = "Match each card charge to its receipt by amount and date";
    const examples = '[{ "name": "One charge", "input": { "amount": "12.50" } }]';
    let turns = 0;
    const { api, user } = renderAt("/ops/skills/new", {
      "POST /api/ops/builder/sessions": () => ({ session, turns: [] }),
      [`POST /api/ops/builder/sessions/${SESSION_ID}/turns`]: () => {
        turns += 1;
        if (turns === 1) {
          return new Reply(502, {
            error: {
              code: "builder_unavailable",
              message: "The Builder can't reach its model right now.",
            },
          });
        }
        return { session, turns: [turn], turn };
      },
      [`GET /api/ops/builder/sessions/${SESSION_ID}`]: () => ({ session, turns: [] }),
    });
    await user.type(await screen.findByTestId("builder-input"), words);
    await user.click(screen.getByTestId("builder-attach"));
    await user.click(screen.getByTestId("builder-examples"));
    await user.paste(examples);
    await user.click(screen.getByTestId("builder-send"));
    await waitFor(() => expect(turns).toBe(1));

    // The failure is said, on the form, and the words and examples typed are still there.
    expect(await screen.findByTestId("new-skill-error")).toHaveTextContent(
      "The Builder can't reach its model right now.",
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("session=");
    expect(screen.getByTestId("builder-input")).toHaveValue(words);
    expect(screen.getByTestId("builder-examples")).toHaveValue(examples);

    // Sending again uses the conversation already started, then opens it.
    await user.click(screen.getByTestId("builder-send"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`session=${SESSION_ID}`),
    );
    expect(api.calls.filter((c) => c === "POST /api/ops/builder/sessions")).toHaveLength(1);
  });
});
