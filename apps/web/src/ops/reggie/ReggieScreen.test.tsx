// Reggie in the back office (docs/plan.md §1.101): the conversation, Reggie's answers with what it
// read, a proposed change's card that does nothing until confirmed, and a new conversation (about a
// client from its page's "Ask Reggie") ready to type into, saved only with its first message.
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
    // What it read, in words; the change it proposed is its card.
    expect(screen.getByTestId("reggie-tools")).toHaveTextContent("Looked at the client's account");

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

  it("sends on Enter, shows Reggie at work, and reads its answer as a chat reply", async () => {
    let answer: (v: unknown) => void = () => {};
    const api = fakeApi({
      ...common,
      [`GET /api/ops/reggie/conversations/${CONV}`]: () => ({
        conversation,
        messages: [],
        actions: [],
      }),
      [`POST /api/ops/reggie/conversations/${CONV}/turns`]: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    renderAt(`/ops/reggie/${CONV}`, api);
    const box = await screen.findByTestId("reggie-input");
    await userEvent.type(box, "How are Sloan's runs?{Shift>}{Enter}{/Shift}Any failed?");
    expect(box).toHaveValue("How are Sloan's runs?\nAny failed?");
    await userEvent.type(box, "{Enter}");
    // The words leave the box at once; Reggie is at work on them.
    expect(box).toHaveValue("");
    expect(await screen.findByTestId("reggie-thinking")).toHaveTextContent(
      "Reggie is looking into it",
    );
    answer({
      conversation,
      messages: [
        {
          id: "m1",
          role: "operator",
          text: "How are Sloan's runs?\nAny failed?",
          tools: [],
          createdAt: "2026-11-14T10:01:00.000Z",
        },
        {
          id: "m2",
          role: "reggie",
          text: "**All 9 went through.**\n\n- Demo client: 5\n- Consulting: 4\n\nWant the list?",
          tools: ["clients_list", "runs_list", "run_get"],
          createdAt: "2026-11-14T10:01:02.000Z",
        },
      ],
      actions: [],
    });
    const reply = await screen.findByTestId("reggie-answer");
    expect(reply).not.toHaveTextContent("**");
    expect(reply).toHaveTextContent("All 9 went through.");
    expect(reply.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByTestId("reggie-tools")).toHaveTextContent("Looked at clients and runs");
    expect(screen.queryByTestId("reggie-thinking")).toBeNull();
  });

  it("puts your words back in the box when the turn fails", async () => {
    const api = fakeApi({
      ...common,
      [`GET /api/ops/reggie/conversations/${CONV}`]: () => ({
        conversation,
        messages: [],
        actions: [],
      }),
      [`POST /api/ops/reggie/conversations/${CONV}/turns`]: () => {
        throw new Error("down");
      },
    });
    renderAt(`/ops/reggie/${CONV}`, api);
    const box = await screen.findByTestId("reggie-input");
    await userEvent.type(box, "Ask Sandbox which area code{Enter}");
    await waitFor(() => expect(box).toHaveValue("Ask Sandbox which area code"));
  });

  it("is ready to type into at once, and saves a conversation only with its first message", async () => {
    // QA (2026-11-22): opening Reggie needed a click on New conversation, which saved an empty one.
    const starts: unknown[] = [];
    const turns: unknown[] = [];
    const answered = {
      conversation: { ...conversation, title: "How is Sandbox doing?" },
      messages: [
        {
          id: "m1",
          role: "operator",
          text: "How is Sandbox doing?",
          tools: [],
          createdAt: "2026-11-14T10:01:00.000Z",
        },
        {
          id: "m2",
          role: "reggie",
          text: "Sandbox has 1 agent and nothing waiting.",
          tools: ["client_review"],
          createdAt: "2026-11-14T10:01:02.000Z",
        },
      ],
      actions: [],
    };
    const api = fakeApi({
      ...common,
      "GET /api/ops/clients": () => ({ clients: [{ id: CLIENT, name: "Sandbox" }] }),
      "GET /api/ops/reggie/conversations": () => ({ items: [] }),
      "POST /api/ops/reggie/conversations": ({ init }) => {
        starts.push(JSON.parse(String(init.body)));
        return { conversation, messages: [], actions: [] };
      },
      [`POST /api/ops/reggie/conversations/${CONV}/turns`]: ({ init }) => {
        turns.push(JSON.parse(String(init.body)));
        return answered;
      },
      [`GET /api/ops/reggie/conversations/${CONV}`]: () => answered,
    });
    // The top bar's "Ask Reggie" on Sandbox's page.
    renderAt(`/ops/reggie?client=${CLIENT}`, api);
    const box = await screen.findByTestId("reggie-input");
    await waitFor(() => expect(box).toHaveFocus());
    expect(screen.getByTestId("reggie-about")).toHaveValue(CLIENT);
    expect(screen.queryByTestId("reggie-new")).toBeNull();
    // Opening it saved nothing.
    expect(api.calls).not.toContain("POST /api/ops/reggie/conversations");

    await userEvent.type(box, "How is Sandbox doing?{Enter}");
    const conv = await screen.findByTestId("reggie-conversation");
    expect(conv).toHaveTextContent("Sandbox has 1 agent and nothing waiting.");
    expect(starts).toEqual([{ clientId: CLIENT }]);
    expect(turns).toEqual([{ text: "How is Sandbox doing?" }]);
    // Its page has New conversation, which opens an unsaved one again.
    await userEvent.click(screen.getByTestId("reggie-new"));
    expect(await screen.findByTestId("reggie-new-conversation")).toBeInTheDocument();
    expect(starts).toHaveLength(1);
  });

  it("sends a second try to the conversation its failed first turn started", async () => {
    const starts: unknown[] = [];
    let fail = true;
    const api = fakeApi({
      ...common,
      "POST /api/ops/reggie/conversations": ({ init }) => {
        starts.push(JSON.parse(String(init.body)));
        return { conversation: { ...conversation, client: null }, messages: [], actions: [] };
      },
      [`POST /api/ops/reggie/conversations/${CONV}/turns`]: () => {
        if (fail) throw new Error("down");
        return { conversation, messages: [], actions: [] };
      },
      [`GET /api/ops/reggie/conversations/${CONV}`]: () => ({
        conversation,
        messages: [],
        actions: [],
      }),
    });
    renderAt("/ops/reggie", api);
    const box = await screen.findByTestId("reggie-input");
    await userEvent.type(box, "Anything waiting?{Enter}");
    await waitFor(() => expect(box).toHaveValue("Anything waiting?"));
    fail = false;
    await userEvent.type(box, "{Enter}");
    await screen.findByTestId("reggie-conversation");
    expect(starts).toEqual([{}]);
  });
});
