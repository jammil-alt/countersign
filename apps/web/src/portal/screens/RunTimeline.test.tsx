// The client's run timeline renders only what the contract names: visible steps' labels,
// summaries, times and sources, approvals and changes. Anything else in a response (cost,
// inputs, prompts, internal steps' fields) is dropped by the contract parse and never shown.
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { PortalRunScreen } from "./RunTimeline";

const RUN_ID = "00000000-0000-4000-8000-0000000f1001";

/** A timeline as the API answers it, with fields a portal response must never carry mixed in. */
const LEAKY_TIMELINE = {
  run: {
    id: RUN_ID,
    service: { id: "00000000-0000-4000-8000-00000000b001", name: "Record keeping" },
    status: "succeeded",
    startedAt: "2026-11-03T10:00:00.000Z",
    finishedAt: "2026-11-03T10:02:00.000Z",
    costUsd: "0.0900",
  },
  steps: [
    {
      id: "00000000-0000-4000-8000-0000000f2001",
      label: "Corrected the record",
      status: "succeeded",
      summary: "Updated record r1",
      sources: ["r1", "00000000-0000-4000-8000-0000000f5001"],
      startedAt: "2026-11-03T10:00:10.000Z",
      finishedAt: "2026-11-03T10:00:20.000Z",
      costUsd: "0.0400",
      input: { secret: "internal input" },
      output: { reasoning: "model text the client must not see" },
      prompt: "You are a records clerk",
      nodeType: "action",
    },
    {
      id: "00000000-0000-4000-8000-0000000f2002",
      label: "Confirm",
      status: "succeeded",
      summary: null,
      sources: [],
      startedAt: "2026-11-03T10:01:00.000Z",
      finishedAt: "2026-11-03T10:01:30.000Z",
    },
  ],
  approvals: [
    {
      id: "00000000-0000-4000-8000-0000000f3001",
      title: "Is the record right now?",
      status: "resolved",
      approved: true,
      by: { id: CLIENT_SESSION.user.id, name: "Demo admin" },
      resolvedAt: "2026-11-03T10:01:30.000Z",
    },
  ],
  actions: [
    {
      id: "00000000-0000-4000-8000-0000000f4001",
      tool: "testkit.record.update",
      description: "Change a record's name or amount.",
      status: "done",
      executedAt: "2026-11-03T10:00:20.000Z",
      before: { amount: "10.00" },
      instructions: "never shown",
    },
  ],
};

function renderTimeline(body: unknown, more: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    [`GET /api/runs/${RUN_ID}`]: () => body,
    ...more,
  });
  render(
    <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="/runs/:id" element={<PortalRunScreen />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("portal run timeline", () => {
  it("shows the visible steps with labels, summaries and sources, and nothing internal", async () => {
    renderTimeline(LEAKY_TIMELINE);
    const timeline = await screen.findByTestId("portal-run-timeline");
    const steps = within(timeline).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent("Corrected the record");
    expect(steps[0]).toHaveTextContent("Updated record r1");
    expect(
      within(steps[0] as HTMLElement).getByTestId("portal-run-step-sources"),
    ).toHaveTextContent("r1");
    // A record id opens the client's record page.
    expect(
      within(steps[0] as HTMLElement).getByTestId("source-00000000-0000-4000-8000-0000000f5001"),
    ).toHaveAttribute("href", "/records/00000000-0000-4000-8000-0000000f5001");
    // A step without a summary says its status instead.
    expect(steps[1]).toHaveTextContent("Confirm");
    expect(steps[1]).toHaveTextContent("Done");
    expect(within(timeline).getByText("2 of 2 steps")).toBeInTheDocument();

    expect(screen.getByTestId("portal-run-status")).toHaveTextContent("Done");
    expect(screen.getByTestId("portal-run-approvals")).toHaveTextContent("Approved by Demo admin");
    expect(screen.getByTestId("portal-run-actions")).toHaveTextContent("Testkit");
    expect(screen.getByTestId("portal-run-actions")).toHaveTextContent("Made");

    const page = document.body.textContent ?? "";
    for (const leak of [
      "$",
      "0.09",
      "0.04",
      "internal input",
      "model text",
      "records clerk",
      "never shown",
      "10.00",
    ]) {
      expect(page, leak).not.toContain(leak);
    }
  });

  it("says when nothing visible has happened yet", async () => {
    renderTimeline({
      ...LEAKY_TIMELINE,
      run: { ...LEAKY_TIMELINE.run, status: "queued", startedAt: null, finishedAt: null },
      steps: [],
      approvals: [],
      actions: [],
    });
    expect(await screen.findByText("Nothing to show yet.")).toBeInTheDocument();
    expect(screen.getByText("Not started yet")).toBeInTheDocument();
  });

  it("shows the audit trail, the changes waiting with before and after, and the way to sign", async () => {
    const ITEM = "00000000-0000-4000-8000-0000000f3002";
    renderTimeline(
      {
        ...LEAKY_TIMELINE,
        run: { ...LEAKY_TIMELINE.run, status: "waiting", finishedAt: null },
        approvals: [
          {
            id: ITEM,
            title: "Update record r1",
            status: "open",
            approved: null,
            by: null,
            resolvedAt: null,
          },
        ],
      },
      {
        [`GET /api/runs/${RUN_ID}/audit`]: () => ({
          entries: [
            {
              at: "2026-11-03T10:05:00.000Z",
              who: "Ana Ruiz",
              side: "mezonas",
              kind: "opened_run",
              itemId: null,
              times: 2,
            },
            {
              at: "2026-11-03T10:06:00.000Z",
              who: "Demo admin",
              side: "client",
              kind: "signed",
              itemId: ITEM,
              times: 1,
            },
          ],
        }),
        "GET /api/inbox": () => ({
          items: [
            {
              id: ITEM,
              kind: "external_action",
              title: "Update record r1",
              payload: {
                tool: "testkit.record.update",
                before: { id: "r1", name: "Oak board" },
                input: { id: "r1", name: "Oak board, 3/4 in" },
              },
              display: null,
              status: "open",
              runId: RUN_ID,
              dueAt: null,
              createdAt: "2026-11-03T10:00:00.000Z",
              resolvedAt: null,
              resolvedBy: null,
            },
          ],
        }),
      },
    );
    const audit = await screen.findByTestId("portal-run-audit");
    await waitFor(() => expect(audit).toHaveTextContent("Ana Ruiz opened this run"));
    expect(audit).toHaveTextContent("2 times");
    expect(audit).toHaveTextContent("Demo admin signed");
    const waiting = await screen.findByTestId("portal-run-waiting");
    expect(within(waiting).getByTestId("change-fields")).toHaveTextContent("Oak board");
    expect(within(waiting).getByTestId("change-fields")).toHaveTextContent("Oak board, 3/4 in");
    expect(screen.getByTestId("portal-run-review")).toHaveAttribute("href", "/desk");
    expect(screen.getByTestId("portal-run-status")).toHaveTextContent("Waiting on you");
    expect(within(screen.getByTestId("portal-run-ask-sloan")).getByRole("link")).toHaveAttribute(
      "href",
      `/sloan?ask=${encodeURIComponent("About run R-0f1001: ")}`,
    );
  });
});
