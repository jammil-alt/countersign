// Plan entry §1.233: the approve-to-pay card on an inbox item. The bills that need a person first,
// with their flags in words; the ready ones with Approve the ready bills; a flagged bill approved
// only with a note; each decision sent as the card's; Done sends the card back. Nothing is paid.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { InboxCard } from "../../inbox/InboxCard";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import type { Bill, PayList } from "./types";

const INBOX = "00000000-0000-4000-8000-0000000a9001";
const B1 = "00000000-0000-4000-8000-0000000a0001";
const B2 = "00000000-0000-4000-8000-0000000a0002";
const L1 = "00000000-0000-4000-8000-0000000a1001";
const ACCT = "00000000-0000-4000-8000-0000000a2001";

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

const item = {
  id: INBOX,
  kind: "request",
  title: "2 bills to approve for 2026-11-27",
  payload: { review: "ap.pay_list", nodeId: "approve", week: "2026-11-23" },
  status: "open",
  runId: null,
  dueAt: null,
  createdAt: "2026-11-25T15:00:00.000Z",
  resolvedAt: null,
};

const bill = (over: Partial<Bill>): Bill => ({
  id: B1,
  status: "open",
  vendorName: "Northline Lumber",
  invoiceNumber: "INV-20418",
  invoiceDate: "2026-11-16",
  dueDate: "2026-11-26",
  amount: "655.0000",
  currency: "USD",
  documentId: null,
  matchStatus: "partial",
  order: { id: "o", reference: "PO-1A2B3C4D" },
  flags: [],
  ready: true,
  decidedBy: null,
  decisionNote: null,
  lines: [],
  ...over,
});

const flagged = bill({
  flags: [
    {
      kind: "price_over_order",
      severity: "block",
      message: "Line 1 is billed at $63.00; the order says $60.00 (5.0% more).",
      lineNo: 1,
      impact: "30.0000",
      sources: [],
    },
  ],
  ready: false,
  lines: [
    {
      id: L1,
      lineNo: 1,
      description: "3/4 BB/BB BALTIC BIRCH",
      qty: "10.0000",
      unit: "sheet",
      unitPrice: "63.0000",
      amount: "630.0000",
      account: null,
      codedBy: null,
      proposal: { account: { id: ACCT, name: "Materials" }, reason: "Plywood" },
    },
  ],
});
const ready = bill({
  id: B2,
  vendorName: "Baltic Supply",
  invoiceNumber: "B-77",
  amount: "455.0000",
});

const list: PayList = {
  week: "2026-11-23",
  payDay: "2026-11-27",
  bills: [flagged, ready],
  count: 2,
  totals: [{ currency: "USD", listed: "1110.0000", approved: "0.0000", ready: "455.0000" }],
  ready: 1,
  needsYou: 1,
};
const view = () => ({
  review: "ap.pay_list",
  status: "open",
  canDecide: true,
  data: { list, accounts: [{ id: ACCT, name: "Materials", number: "5000" }] },
});

describe("the approve-to-pay card", () => {
  it("puts the flagged bill first, the ready ones after, and sends each decision", async () => {
    const bodies: unknown[] = [];
    const resolved: unknown[] = [];
    renderAt(<InboxCard item={item} onResolve={async (b) => void resolved.push(b)} />, {
      [`GET /api/inbox/${INBOX}/pack-review`]: () => view(),
      [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return view();
      },
    });
    const card = await screen.findByTestId("ap-pay-list-review", {}, { timeout: 3000 });
    expect(card).toHaveTextContent("2 bills for");
    expect(card).toHaveTextContent("1 needs you");
    const needs = within(card).getByTestId("ap-needs-you");
    expect(needs).toHaveTextContent("Northline Lumber");
    expect(needs).toHaveTextContent("Price above the order");
    const [row] = within(needs).getAllByTestId("ap-bill");
    if (!row) throw new Error("no row");
    // Flagged: Approve waits for a reason.
    expect(within(row).getByTestId("ap-approve")).toBeDisabled();
    await userEvent.click(within(row).getByRole("button", { expanded: false }));
    await userEvent.click(within(row).getByRole("button", { name: "Use Materials" }));
    await userEvent.type(within(row).getByRole("textbox"), "Agreed by phone");
    await userEvent.click(within(row).getByTestId("ap-approve"));
    await userEvent.click(within(card).getByTestId("ap-approve-ready"));
    expect(bodies).toEqual([
      { action: "take_proposal", input: { billLineId: L1 } },
      { action: "approve", input: { billId: B1, note: "Agreed by phone" } },
      { action: "approve_ready", input: {} },
    ]);
    await userEvent.click(within(card).getByTestId("ap-done"));
    expect(resolved).toEqual([{ decision: "approve" }]);
  });
});
