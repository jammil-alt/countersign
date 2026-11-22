// `/i/:token` (docs/plan.md §1.217): a process interview, with no sign-in. One question waits; the
// person answers it (marking an estimate), or says they don't know, and finishes once nothing
// waits. A finished, closed or unknown link says so.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { fakeApi, Reply } from "../test/fixtures";

const TOKEN = "eyJ0IjoiYSJ9.c2lnbmF0dXJl";

const view = (over: Record<string, unknown> = {}) => ({
  client: "Rivera Supply",
  name: "Dana Reyes",
  process: "Invoice reconciliation",
  state: "open",
  turns: [{ role: "agent", text: "What starts invoice reconciliation today?", at: "t" }],
  question: "What starts invoice reconciliation today?",
  files: [],
  answered: 0,
  maxAnswers: 30,
  maxFiles: 10,
  language: "en",
  ...over,
});

const signedOut = () => new Reply(401, { error: { code: "unauthenticated" } });

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("the interview page", () => {
  it("asks one question, sends the answer with its estimate, then finishes", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/interviews/${TOKEN}`]: () => view(),
      [`POST /api/interviews/${TOKEN}/answers`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return view({
          turns: [
            { role: "agent", text: "What starts invoice reconciliation today?", at: "t" },
            {
              role: "contact",
              text: "About 150 a month.",
              at: "t",
              estimate: true,
              skipped: false,
            },
          ],
          question: null,
          answered: 1,
        });
      },
      [`POST /api/interviews/${TOKEN}/finish`]: () => view({ state: "finished", question: null }),
    });
    renderAt(`/i/${TOKEN}`, api);
    expect(await screen.findByTestId("interview-question")).toHaveTextContent(
      "What starts invoice reconciliation today?",
    );
    expect(screen.queryByTestId("signin-frame")).toBeNull();
    expect(screen.getByText("Rivera Supply")).toBeTruthy();

    await userEvent.type(screen.getByTestId("interview-answer"), "About 150 a month.");
    await userEvent.click(screen.getByText("The numbers are an estimate"));
    await userEvent.click(screen.getByText("Answer"));
    expect(await screen.findByTestId("interview-done")).toBeTruthy();
    expect(sent).toEqual([{ text: "About 150 a month.", estimate: true }]);
    expect(screen.getByTestId("interview-transcript")).toHaveTextContent("(an estimate)");

    await userEvent.click(screen.getByText("Finish"));
    expect(await screen.findByTestId("interview-thanks")).toHaveTextContent(
      "We have what we need about invoice reconciliation.",
    );
  });

  it("sends I don't know as a skip", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/interviews/${TOKEN}`]: () => view(),
      [`POST /api/interviews/${TOKEN}/answers`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return view({ question: "Who does it?", answered: 1 });
      },
    });
    renderAt(`/i/${TOKEN}`, api);
    await userEvent.click(await screen.findByText("I don't know"));
    expect(await screen.findByText("Who does it?")).toBeTruthy();
    expect(sent).toEqual([{ skip: true }]);
  });

  it("says when the interview is closed, and when the link is unknown", async () => {
    const closed = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/interviews/${TOKEN}`]: () => view({ state: "closed", turns: [], question: null }),
    });
    renderAt(`/i/${TOKEN}`, closed);
    expect(await screen.findByTestId("interview-closed")).toHaveTextContent(
      "Ask Rivera Supply if you'd like to add something.",
    );
  });

  it("says a link that doesn't exist has expired", async () => {
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/interviews/${TOKEN}`]: () => new Reply(404, { error: { code: "not_found" } }),
    });
    renderAt(`/i/${TOKEN}`, api);
    expect(await screen.findByTestId("interview-gone")).toHaveTextContent(
      "This link has expired or doesn't exist.",
    );
  });
});
