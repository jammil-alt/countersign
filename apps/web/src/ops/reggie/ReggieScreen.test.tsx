// Reggie in the back office (docs/plan.md §1.101): the conversation, Reggie's answers with what it
// read, a proposed change's card that does nothing until confirmed, and "Ask Reggie" from a
// client's page starting a conversation about that client.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const CONV = "00000000-0000-4000-8000-0000000e9001";
const CLIENT = "00000000-0000-4000-8000-00000000a001";
const ACTION = "00000000-0000-4000-8000-0000000e9101";

const conversation = {
  id: CONV,
  title: "",
  client: { id: CLIENT, name: "Sandbox" },
  createdAt: "2026-11-14T10:00:00.000Z",
  updatedAt: "2026-11-14T10:00:00.000Z",
};
const card = {
  id: ACTION,
  messageId: null,
  tool: "lead_request_create",
  title: "Ask Sandbox's admin",
  lines: [
    "On Sandbox's admin's Desk, from you as their Mezonas lead:",
    "Which area code do you want?",
  ],
  client: { id: CLIENT, name: "Sandbox" },
  status: "proposed",
  outcome: null,
  createdAt: "2026-11-14T10:01:01.000Z",
  decidedAt: null,
};

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/clients": () => ({ clients: [] }),
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
  "GET /api/ops/reggie/conversations": () => ({ items: [conversation] }),
};

describe("Reggie", () => {
  it("answers, shows what it read, and makes a change only when you confirm its card", async () => {
    const turns: unknown[] = [];
    const confirms: string[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/reggie/conversations/${CONV}`]: () => ({
        conversation,
        messages: [],
        actions: [],
      }),
      [`POST /api/ops/reggie/conversations/${CONV}/turns`]: ({ init }) => {
        turns.push(JSON.parse(String(init.body)));
        return {
          conversation: { ...conversation, title: "Ask Sandbox which area code" },
          messages: [
            {
              id: "m1",
              role: "operator",
              text: "Ask Sandbox which area code",
              tools: [],
              createdAt: "2026-11-14T10:01:00.000Z",
            },
            {
              id: "m2",
              role: "reggie",
              text: "I proposed a question for Sandbox's admin. Confirm the card to send it.",
              tools: ["client_review", "lead_request_create"],
              createdAt: "2026-11-14T10:01:02.000Z",
            },
          ],
          actions: [card],
        };
      },
      [`POST /api/ops/reggie/actions/${ACTION}/confirm`]: () => {
        confirms.push(ACTION);
        return {
          action: {
            ...card,
            status: "done",
            outcome: "Asked on Sandbox's admin's Desk.",
            decidedAt: "2026-11-14T10:02:00.000Z",
          },
        };
      },
    });
    renderAt(`/ops/reggie/${CONV}`, api);
    await screen.findByTestId("reggie-conversation");
    expect(screen.getByTestId("reggie-conversation")).toHaveTextContent("About Sandbox");
    const send = screen.getByTestId("reggie-send");
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByTestId("reggie-input"), "Ask Sandbox which area code");
    await userEvent.click(send);
    await screen.findByText(
      "I proposed a question for Sandbox's admin. Confirm the card to send it.",
    );
    expect(turns).toEqual([{ text: "Ask Sandbox which area code" }]);
    expect(screen.getByTestId("reggie-tools")).toHaveTextContent(
      "Read: client_review, lead_request_create",
    );

    const cardEl = screen.getByTestId(`reggie-action-${ACTION}`);
    expect(cardEl).toHaveTextContent("Ask Sandbox's admin");
    expect(cardEl).toHaveTextContent("Which area code do you want?");
    expect(within(cardEl).getByTestId(`reggie-action-${ACTION}-status`)).toHaveTextContent(
      "Waiting on you",
    );
    expect(confirms).toEqual([]);
    await userEvent.click(within(cardEl).getByTestId(`reggie-action-${ACTION}-confirm`));
    await waitFor(() =>
      expect(within(cardEl).getByTestId(`reggie-action-${ACTION}-status`)).toHaveTextContent(
        "Done",
      ),
    );
    expect(confirms).toEqual([ACTION]);
    expect(within(cardEl).getByTestId(`reggie-action-${ACTION}-outcome`)).toHaveTextContent(
      "Asked on Sandbox's admin's Desk.",
    );
    expect(within(cardEl).queryByTestId(`reggie-action-${ACTION}-confirm`)).toBeNull();
  });

  it("starts a conversation about a client from its page's Ask Reggie", async () => {
    const starts: unknown[] = [];
    const api = fakeApi({
      ...common,
      "POST /api/ops/reggie/conversations": ({ init }) => {
        starts.push(JSON.parse(String(init.body)));
        return { conversation, messages: [], actions: [] };
      },
      [`GET /api/ops/reggie/conversations/${CONV}`]: () => ({
        conversation,
        messages: [],
        actions: [],
      }),
    });
    renderAt(`/ops/reggie?client=${CLIENT}`, api);
    await screen.findByTestId("reggie-conversation");
    expect(starts).toEqual([{ clientId: CLIENT }]);
    expect(screen.getByTestId("ops-nav-reggie")).toBeInTheDocument();
  });
});
