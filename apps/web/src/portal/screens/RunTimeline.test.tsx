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

  it("shows the audit trail, the changes waiting with before and after, and the way to approve", async () => {
    const ITEM = "00000000-0000-4000-8000-0000000f3002";
    renderTimeline(
      {
        ...LEAKY_TIMELINE,
        // QA round 1: as the API answers a workflow run held by an approval.
        run: {
          ...LEAKY_TIMELINE.run,
          status: "running",
          finishedAt: null,
          waitingOnYou: true,
          waitedMs: 21 * 3_600_000,
        },
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
    expect(audit).toHaveTextContent("Demo admin approved");
    const waiting = await screen.findByTestId("portal-run-waiting");
    expect(waiting).toHaveTextContent("Changes waiting for your approval");
    expect(within(waiting).getByTestId("change-fields")).toHaveTextContent("Oak board");
    expect(within(waiting).getByTestId("change-fields")).toHaveTextContent("Oak board, 3/4 in");
    // At the top: what waits on the reader, and the way to the item in the Inbox.
    const approve = screen.getByTestId("portal-run-approve");
    expect(approve).toHaveTextContent("Waiting on you since");
    expect(approve).toHaveTextContent("1 item waits for your approval.");
    expect(screen.getByTestId("portal-run-review")).toHaveTextContent("Review and approve");
    expect(screen.getByTestId("portal-run-review")).toHaveAttribute("href", `/inbox?item=${ITEM}`);
    expect(screen.getByTestId("portal-run-status")).toHaveTextContent("Waiting on you");
    expect(screen.getByTestId("portal-run-status")).not.toHaveTextContent("Running");
    expect(screen.getByTestId("portal-run-took")).toHaveTextContent("—Waited 21 h on you");
    expect(within(screen.getByTestId("portal-run-ask-sloan")).getByRole("link")).toHaveAttribute(
      "href",
      `/sloan?ask=${encodeURIComponent("About run R-0f1001: ")}`,
    );
  });

  it("titles the run by what it is about and names the records its steps cite", async () => {
    const VENDOR = "00000000-0000-4000-8000-0000000f5001";
    renderTimeline({
      ...LEAKY_TIMELINE,
      run: {
        ...LEAKY_TIMELINE.run,
        subject: {
          kind: "document",
          vendor: "Northline Panel Supply",
          number: "20418",
          filename: "northline-20418.pdf",
        },
      },
      sourceNames: { [VENDOR]: "Northline Panel Supply" },
    });
    expect(
      await screen.findByText("Northline Panel Supply · Invoice 20418", { selector: "h1" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`source-${VENDOR}`)).toHaveTextContent("Northline Panel Supply");
    expect(document.body.textContent).not.toContain("Record ·");
    // Nothing waits on the reader: no call to action.
    expect(screen.queryByTestId("portal-run-approve")).toBeNull();
  });
});

// R8 (ARCHITECTURE §10.14 "Checks", "Deadlines"): a step's checks on the client's timeline.
describe("portal run timeline: checks", () => {
  const S = (n: number) => `00000000-0000-4000-8000-0000000f6${String(n).padStart(3, "0")}`;
  const step = (n: number, over: Record<string, unknown>) => ({
    id: S(n),
    label: "Read the invoice",
    status: "succeeded",
    summary: null,
    sources: [],
    startedAt: "2026-11-10T10:00:00.000Z",
    finishedAt: "2026-11-10T10:01:00.000Z",
    ...over,
  });
  const CHECKED = {
    ...LEAKY_TIMELINE,
    steps: [
      step(1, {
        label: "Read the invoice",
        confer: {
          reviewer: "ai",
          who: null,
          verdict: "agree",
          note: null,
          name: null,
        },
      }),
      step(2, {
        label: "Read the invoice",
        confer: {
          reviewer: "person",
          who: CLIENT_SESSION.user.id,
          name: "Dana",
          verdict: "disagree",
          note: "The freight line is missing",
        },
      }),
      step(3, {
        label: "Updated the bill",
        noAnswer: "proceeded",
        approval: {
          mode: "in_turn",
          approvers: [
            {
              itemId: S(11),
              role: "client_admin",
              userId: null,
              name: null,
              state: "no_answer",
              at: null,
            },
            {
              itemId: S(12),
              role: null,
              userId: CLIENT_SESSION.user.id,
              name: "Dana",
              state: "no_answer",
              at: null,
            },
          ],
        },
      }),
      step(4, {
        label: "Told the team",
        urgent: { dueAt: "2026-11-10T11:00:00.000Z", state: "waiting", seenAt: null },
      }),
      step(5, { label: "Asked for the PO", status: "failed", noAnswer: "stopped" }),
    ],
  };

  it("shows confers as their own steps, approvers in their mode, and no-answer outcomes", async () => {
    renderTimeline(CHECKED);
    const ai = await screen.findByTestId(`portal-run-step-${S(1)}`);
    expect(ai).toHaveTextContent("A second check: agrees");
    expect(ai).toHaveTextContent("Checked: Read the invoice");
    const dana = screen.getByTestId(`portal-run-step-${S(2)}`);
    expect(dana).toHaveTextContent("Checked with Dana: disagrees");
    expect(dana).toHaveTextContent("“The freight line is missing”");
    // A person's answer is a person's step.
    expect(dana).toHaveAttribute("data-state", "person");

    const write = screen.getByTestId(`portal-run-step-${S(3)}`);
    const approval = within(write).getByTestId("portal-run-step-checks-approval");
    expect(approval).toHaveTextContent("Asked one at a time, in order");
    expect(
      within(approval)
        .getAllByTestId("portal-run-step-checks-approver")
        .map((a) => a.textContent),
    ).toEqual(["your admin: no answer in time", "Dana: no answer in time"]);
    expect(within(write).getByTestId("portal-run-step-checks-no-answer")).toHaveTextContent(
      "Went ahead: nobody answered in time",
    );
    expect(
      screen.getByTestId(`portal-run-step-${S(4)}`).querySelector("[data-state=waiting]"),
    ).toHaveTextContent(/^Urgent: waiting for Seen until /);
    expect(
      within(screen.getByTestId(`portal-run-step-${S(5)}`)).getByTestId(
        "portal-run-step-checks-no-answer",
      ),
    ).toHaveTextContent("Stopped: nobody answered in time");
  });

  it("reads in the client's language", async () => {
    renderTimeline(CHECKED, {
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "es", user: "es", client: null },
      }),
    });
    expect(await screen.findByTestId(`portal-run-step-${S(2)}`)).toHaveTextContent(
      "Consultado con Dana: no está de acuerdo",
    );
  });

  // Wave 5: the route an if took and why; a step that failed and the run carried on past.
  const FORKED = {
    ...LEAKY_TIMELINE,
    steps: [
      step(1, { label: "Approve the bill", status: "skipped", outcome: "rejected" }),
      step(2, {
        label: "Look the PO up",
        status: "failed",
        outcome: "failed",
        carriedOn: true,
      }),
      step(3, {
        label: "Pick the way",
        summary: "Pick the way: Rejected",
        route: {
          path: "Rejected",
          because: [
            { label: "Approve the bill", outcome: "rejected" },
            { label: "Look the PO up", outcome: "failed" },
          ],
        },
      }),
      step(4, { label: "Pick again", route: { path: null, because: [] } }),
    ],
  };

  it("says which route an if took and why, and a failure the run carried on past", async () => {
    renderTimeline(FORKED);
    const fork = await screen.findByTestId(`portal-run-step-${S(3)}`);
    expect(within(fork).getByTestId("portal-run-step-checks-route")).toHaveTextContent(
      "Took the route “Rejected”: Approve the bill was rejected, Look the PO up failed",
    );
    expect(
      within(screen.getByTestId(`portal-run-step-${S(4)}`)).getByTestId(
        "portal-run-step-checks-route",
      ),
    ).toHaveTextContent("None of the routes matched, so it went on the usual way");
    const look = screen.getByTestId(`portal-run-step-${S(2)}`);
    const carried = within(look).getByTestId("portal-run-step-checks-carried-on");
    expect(carried).toHaveTextContent("Failed, and the run carried on");
    expect(carried).toHaveClass("ui-tone-risk");
    expect(
      within(screen.getByTestId(`portal-run-step-${S(1)}`)).queryByTestId(
        "portal-run-step-checks-carried-on",
      ),
    ).toBeNull();
  });

  it("says the route in the client's language", async () => {
    renderTimeline(FORKED, {
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "de", user: "de", client: null },
      }),
    });
    expect(
      within(await screen.findByTestId(`portal-run-step-${S(3)}`)).getByTestId(
        "portal-run-step-checks-route",
      ),
    ).toHaveTextContent(
      "Weg „Rejected“ genommen: Approve the bill: abgelehnt, Look the PO up: fehlgeschlagen",
    );
  });
});
