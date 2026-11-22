// The client page's Interviews (docs/plan.md §1.217): start one for a contact and copy its link; a
// finished one shows the map with its estimates and reuse check, the open questions, and drafts
// the client's agent, which opens Check the steps.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../../test/fixtures";

const CLIENT = SANDBOX_DETAIL.client.id;
const DANA = "00000000-0000-4000-8000-00000000c101";
const ID = "00000000-0000-4000-8000-00000000c201";
const BUILD = "00000000-0000-4000-8000-00000000c301";
const at = "2026-11-22T10:00:00.000Z";

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
  [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
};

const interview = (over: Record<string, unknown> = {}) => ({
  id: ID,
  contact: { id: DANA, name: "Dana Reyes" },
  process: "Invoice reconciliation",
  area: null,
  status: "open",
  answered: 0,
  buildId: null,
  createdAt: at,
  finishedAt: null,
  link: "https://app.mezonas.test/i/abc.def",
  expiresAt: at,
  turns: [{ role: "agent", text: "What starts invoice reconciliation today?", at }],
  question: "What starts invoice reconciliation today?",
  files: [],
  outputs: null,
  reuse: null,
  costUsd: "0.0000",
  ...over,
});

const finished = interview({
  status: "finished",
  answered: 2,
  link: null,
  question: null,
  finishedAt: at,
  outputs: {
    map: {
      process: "Invoice reconciliation",
      trigger: null,
      steps: [
        {
          id: "match",
          name: "Match each deposit to an open invoice",
          who: "Dana",
          tool: "QuickBooks",
          detail: null,
          volume: "About 150 a month",
          estimate: true,
          from: [1],
        },
      ],
      outcome: null,
    },
    openQuestions: [
      { question: "Who approves a write-off?", why: "It decides who signs.", stepId: null },
    ],
    description: "Invoice reconciliation, as it is done today.\n1. Match each deposit",
    ungrounded: 1,
  },
  reuse: {
    ranAt: at,
    steps: [
      {
        stepId: "match",
        candidates: [
          {
            partType: "tool",
            partId: "qbo.find_invoice",
            name: "qbo.find_invoice",
            score: 0.4,
            relevant: true,
            verdict: null,
            reason: "",
            missing: "",
            judgedBy: null,
            number: null,
            open: null,
          },
        ],
      },
    ],
  },
  costUsd: "0.0123",
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("interviews in the back office", () => {
  it("starts an interview for a contact and shows the link to send", async () => {
    const made: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/clients/${CLIENT}/interviews`]: () => ({
        interviews: [],
        contacts: [{ id: DANA, name: "Dana Reyes" }],
      }),
      [`POST /api/ops/clients/${CLIENT}/interviews`]: ({ init }) => {
        made.push(JSON.parse(String(init.body)));
        return interview();
      },
    });
    renderAt(`/ops/clients/${CLIENT}/interviews`, api);
    await userEvent.selectOptions(await screen.findByLabelText("Who to ask"), DANA);
    await userEvent.type(screen.getByLabelText(/Which process/), "Invoice reconciliation");
    await userEvent.click(screen.getByText("Start"));
    expect(await screen.findByTestId("interview-link")).toHaveValue(
      "https://app.mezonas.test/i/abc.def",
    );
    expect(made).toEqual([{ contactId: DANA, process: "Invoice reconciliation", area: null }]);
  });

  it("shows a finished interview's map and open questions, and drafts the agent", async () => {
    let drafted = false;
    const api = fakeApi({
      ...common,
      [`GET /api/ops/clients/${CLIENT}/interviews/${ID}`]: () => finished,
      [`POST /api/ops/clients/${CLIENT}/interviews/${ID}/draft`]: () => {
        drafted = true;
        return { ...finished, buildId: BUILD };
      },
    });
    renderAt(`/ops/clients/${CLIENT}/interviews/${ID}`, api);
    const map = await screen.findByTestId("interview-map");
    expect(map).toHaveTextContent("Match each deposit to an open invoice");
    expect(map).toHaveTextContent("Estimate");
    expect(map).toHaveTextContent("May reuse: qbo.find_invoice (tool)");
    expect(screen.getByTestId("interview-open")).toHaveTextContent("Who approves a write-off?");
    expect(screen.getByText(/1 step was left off/)).toBeTruthy();
    await userEvent.click(screen.getByText("Draft the agent"));
    await waitFor(() => expect(drafted).toBe(true));
  });
});
