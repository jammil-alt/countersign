// docs/plan.md §1.232: the Close pack's screens. The sign-off card (waive an open line with a
// reason, turn down an entry, sign the month off once nothing is open) and the portal's close
// report (the month's result, its checklist and its journal entries with their lines).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { InboxCard } from "../../inbox/InboxCard";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { CloseReportView } from "./Close";
import type { CloseMonth } from "./types";

const INBOX = "00000000-0000-4000-8000-0000000c1001";
const PERIOD = "00000000-0000-4000-8000-0000000c2001";
const LINE = "00000000-0000-4000-8000-0000000c3001";
const ENTRY = "00000000-0000-4000-8000-0000000c4001";

function renderAt(node: React.ReactNode, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="*" element={node} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

function month(step: "open" | "waived" | "rejected" | "signed"): CloseMonth {
  const waived = step !== "open";
  const rejected = step === "rejected" || step === "signed";
  return {
    period: {
      id: PERIOD,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      currency: "USD",
      status: step === "signed" ? "signed_off" : "open",
      checkedAt: "2026-11-05T14:00:00.000Z",
      signedOffAt: step === "signed" ? "2026-11-06T10:00:00.000Z" : null,
      signedOffBy: step === "signed" ? "Dana Ortiz" : null,
      note: step === "signed" ? "October closed" : null,
    },
    items: [
      {
        id: "00000000-0000-4000-8000-0000000c3000",
        key: "reconciliation:x",
        kind: "reconciliation",
        title: "Checking reconciled",
        status: "done",
        amount: "0.0000",
        count: 0,
        summary: "Checking is reconciled through Oct 31.",
        note: null,
      },
      {
        id: LINE,
        key: "uncategorized",
        kind: "uncategorized",
        title: "Every transaction categorized",
        status: waived ? "waived" : "open",
        amount: "75.0000",
        count: 1,
        summary: "1 transaction ($75.00) is on Uncategorized Expense.",
        note: waived ? "The owner's draw, booked in January" : null,
      },
    ],
    entries: [
      {
        id: ENTRY,
        kind: "accrual",
        status: rejected ? "rejected" : "proposed",
        txnDate: "2026-10-31",
        reverseOn: "2026-11-01",
        amount: "1250.0000",
        currency: "USD",
        memo: "Accrued Landlord LLC, October 2026",
        reason: "Landlord LLC billed Rent every month before ($1,250.00, $1,250.00).",
        qboId: null,
        error: null,
        write: null,
        lines: [
          { accountName: "Rent", posting: "debit", amount: "1250.0000", description: null },
          {
            accountName: "Accrued Liabilities",
            posting: "credit",
            amount: "1250.0000",
            description: null,
          },
        ],
      },
    ],
    open: waived ? 0 : 1,
    readyToSignOff: rejected && step !== "signed",
    blockers:
      step === "signed"
        ? []
        : [
            ...(waived ? [] : ["1 checklist lines are still open: finish or waive each."]),
            ...(rejected ? [] : ["1 journal entries aren't decided: sign or turn down each."]),
          ],
  };
}

const card = (step: Parameters<typeof month>[0]) => ({
  review: "close.signoff",
  status: "open",
  canDecide: true,
  data: { close: month(step) },
});

describe("the close sign-off card", () => {
  it("waives a line with a reason, turns down an entry, then signs the month off", async () => {
    const bodies: { action: string; input: unknown }[] = [];
    const resolved: unknown[] = [];
    const steps = ["waived", "rejected", "signed"] as const;
    renderAt(
      <InboxCard
        item={{
          id: INBOX,
          kind: "request",
          title: "October 2026: 2 of 2 lines still open.",
          payload: { review: "close.signoff", nodeId: "sign-off", periodId: PERIOD },
          status: "open",
          runId: null,
          dueAt: null,
          createdAt: "2026-11-05T15:00:00.000Z",
          resolvedAt: null,
        }}
        onResolve={async (b) => void resolved.push(b)}
      />,
      {
        [`GET /api/inbox/${INBOX}/pack-review`]: () => card("open"),
        [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return card(steps[bodies.length - 1] ?? "signed");
        },
      },
    );
    const view = await screen.findByTestId("close-signoff");
    expect(within(view).getByTestId("close-open")).toHaveTextContent("Lines open: 1");
    expect(within(view).getByTestId("close-blockers")).toHaveTextContent(
      "1 journal entries aren't decided",
    );
    expect(within(view).getByTestId("close-signoff-button")).toBeDisabled();
    const entries = within(view).getByTestId("close-entries");
    expect(entries).toHaveTextContent("Accrual");
    expect(entries).toHaveTextContent("Debit Rent $1,250.00");
    expect(entries).toHaveTextContent("Credit Accrued Liabilities $1,250.00");

    await userEvent.click(within(view).getByTestId("close-waive"));
    await userEvent.type(
      within(view).getByTestId("close-waive-note"),
      "The owner's draw, booked in January",
    );
    await userEvent.click(within(view).getByTestId("close-waive-save"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      action: "waive",
      input: { itemId: LINE, note: "The owner's draw, booked in January" },
    });
    expect(
      await within(view).findByText("Waived: The owner's draw, booked in January"),
    ).toBeInTheDocument();

    await userEvent.click(within(view).getByTestId("close-reject"));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ action: "reject", input: { entryId: ENTRY } });
    await waitFor(() =>
      expect(within(view).getByTestId("close-signoff-button")).not.toBeDisabled(),
    );
    await userEvent.type(within(view).getByTestId("close-signoff-note"), "October closed");
    await userEvent.click(within(view).getByTestId("close-signoff-button"));
    await waitFor(() => expect(resolved).toEqual([{ decision: "approve" }]));
    expect(bodies[2]).toEqual({ action: "sign_off", input: { note: "October closed" } });
  });
});

describe("the close report", () => {
  it("leads with the month's result, then its checklist and entries, read only", async () => {
    renderAt(<CloseReportView />, {
      "GET /api/reports/close/close": () => ({
        report: {
          periods: [
            {
              id: PERIOD,
              periodStart: "2026-10-01",
              periodEnd: "2026-10-31",
              status: "signed_off",
              signedOffAt: "2026-11-06T10:00:00.000Z",
              open: 0,
              items: 2,
            },
          ],
          close: month("signed"),
        },
      }),
    });
    const report = await screen.findByTestId("close-report");
    expect(within(report).getByTestId("close-signed-off")).toHaveTextContent("Signed off");
    expect(report).toHaveTextContent("Signed off by Dana Ortiz");
    expect(report).toHaveTextContent("October closed");
    expect(within(report).getAllByTestId("close-item")).toHaveLength(2);
    expect(within(report).getByTestId("close-entries")).toHaveTextContent("Turned down");
    // Read only: no decisions on the report.
    expect(within(report).queryByTestId("close-waive")).toBeNull();
    expect(within(report).queryByTestId("close-reject")).toBeNull();
  });

  it("says when no month has been checked", async () => {
    renderAt(<CloseReportView />, {
      "GET /api/reports/close/close": () => ({ report: { periods: [], close: null } }),
    });
    expect(await screen.findByText("No month has been checked yet.")).toBeInTheDocument();
  });
});
