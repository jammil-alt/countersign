// B-6 (docs/plan.md §1.79): the Bookkeeping area's screens and cards. The portal's Bank transactions
// (statuses in words, money signed by direction), the booking review card (book an unsure
// transaction to another account with a word on why, then Done) and the account questions card
// (answer what an account is for, then Done). R-1 (§1.80): the reconciliation card (accept our
// suggestion, add what one side is missing, sign off once explained) and the Reconciliations list.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { InboxCard } from "../../inbox/InboxCard";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { BankTransactionsView } from "./BankTransactions";
import { ReconciliationsView } from "./Reconciliations";

const INBOX = "00000000-0000-4000-8000-0000000b3001";
const TXN = "00000000-0000-4000-8000-0000000b1001";
const FUEL = "00000000-0000-4000-8000-0000000a0086";
const SUPPLIES = "00000000-0000-4000-8000-0000000a0084";

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

const item = (review: string, payload: Record<string, unknown>) => ({
  id: INBOX,
  kind: "request",
  title: "A question about your books",
  payload: { review, nodeId: "ask", ...payload },
  status: "open",
  runId: null,
  dueAt: null,
  createdAt: "2026-11-08T15:00:00.000Z",
  resolvedAt: null,
});

describe("the Bank transactions screen", () => {
  it("lists the client's transactions with their status in words and where each was booked", async () => {
    renderAt(<BankTransactionsView />, {
      "GET /api/reports/bookkeeping/transactions": () => ({
        report: {
          counts: { posted: 2, matched: 1, needs_review: 1 },
          accounts: [],
          transactions: [
            {
              id: TXN,
              date: "2026-11-03",
              account: "Checking",
              mask: "0001",
              payee: "Shell",
              direction: "out",
              amount: "41.2000",
              currency: "USD",
              status: "needs_review",
              kind: "expense",
              bookedTo: "Fuel",
            },
            {
              id: "00000000-0000-4000-8000-0000000b1002",
              date: "2026-11-05",
              account: "Amex Gold",
              mask: "1009",
              payee: "PAYMENT THANK YOU",
              direction: "in",
              amount: "500.0000",
              currency: "USD",
              status: "matched",
              kind: null,
              bookedTo: null,
            },
          ],
        },
      }),
    });
    const page = await screen.findByTestId("bookkeeping-transactions");
    expect(within(page).getByTestId("bookkeeping-counts")).toHaveTextContent("3 booked");
    expect(within(page).getByTestId("bookkeeping-counts")).toHaveTextContent("1 waiting on you");
    const rows = within(page).getAllByTestId("bookkeeping-transaction-row");
    expect(rows[0]).toHaveTextContent("Shell");
    expect(rows[0]).toHaveTextContent("−$41.20");
    expect(rows[0]).toHaveTextContent("Waiting on you");
    expect(rows[1]).toHaveTextContent("+$500.00");
    expect(rows[1]).toHaveTextContent("Already in QuickBooks");
    // The back office's parts are not in the portal, nor anything an agent is made of.
    expect(within(page).queryByTestId("bookkeeping-feed-accounts")).toBeNull();
    expect(page.textContent).not.toMatch(/prompt|model|cost/i);
  });
});

describe("the booking review card", () => {
  const view = (decided: boolean) => ({
    review: "bookkeeping.bookings",
    status: "open",
    canDecide: true,
    data: {
      transactions: [
        {
          id: TXN,
          date: "2026-11-03",
          amount: "41.2000",
          currency: "USD",
          direction: "out",
          payee: "Shell",
          description: null,
          status: decided ? "approved" : "needs_review",
          account: { id: "l1", name: "Checking", mask: "0001", kind: "bank" },
          booking: {
            id: "b1",
            kind: "expense",
            status: decided ? "approved" : "proposed",
            decidedBy: decided ? "person" : "model",
            confidence: "0.550",
            reason: "A gas station",
            alternatives: [],
            lines: [
              {
                ledgerAccountId: decided ? FUEL : SUPPLIES,
                account: decided ? "Fuel" : "Shop Supplies",
                amount: "41.2000",
                classRef: null,
                description: null,
              },
            ],
          },
        },
      ],
      accounts: [
        {
          id: FUEL,
          fullName: "Fuel",
          number: null,
          type: "Expense",
          classification: "expense",
          description: null,
          note: null,
        },
        {
          id: SUPPLIES,
          fullName: "Shop Supplies",
          number: null,
          type: "Expense",
          classification: "expense",
          description: null,
          note: null,
        },
      ],
    },
  });

  it("books an unsure transaction to another account with the person's why, then sends the review back", async () => {
    const bodies: unknown[] = [];
    const resolved: unknown[] = [];
    renderAt(
      <InboxCard
        item={item("bookkeeping.bookings", { bankTxnIds: [TXN] })}
        onResolve={async (b) => void resolved.push(b)}
      />,
      {
        [`GET /api/inbox/${INBOX}/pack-review`]: () => view(false),
        [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return view(true);
        },
      },
    );
    const card = await screen.findByTestId("bookings-review");
    expect(card).toHaveTextContent("We suggest Shop Supplies");
    expect(card).toHaveTextContent("A gas station");
    expect(within(card).getByTestId("bookings-review-state")).toHaveTextContent("Waiting on you");
    await userEvent.selectOptions(within(card).getByTestId("bookings-review-account"), FUEL);
    await userEvent.type(
      within(card).getByPlaceholderText("Why, in a few words (optional)"),
      "Gas for the van",
    );
    await userEvent.click(within(card).getByTestId("bookings-review-book"));
    await waitFor(() =>
      expect(bodies).toEqual([
        {
          action: "book",
          input: { bankTxnId: TXN, lines: [{ ledgerAccountId: FUEL }], why: "Gas for the van" },
        },
      ]),
    );
    expect(await within(card).findByText("Approved")).toBeInTheDocument();
    expect(card).toHaveTextContent("All decided");
    await userEvent.click(within(card).getByTestId("bookings-review-finish"));
    expect(resolved).toEqual([{ decision: "approve", answer: { left: 0 } }]);
  });

  it("approves our suggestion as it is", async () => {
    const bodies: unknown[] = [];
    renderAt(
      <InboxCard
        item={item("bookkeeping.bookings", { bankTxnIds: [TXN] })}
        onResolve={async () => {}}
      />,
      {
        [`GET /api/inbox/${INBOX}/pack-review`]: () => view(false),
        [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return view(true);
        },
      },
    );
    const card = await screen.findByTestId("bookings-review");
    await userEvent.click(within(card).getByTestId("bookings-review-approve"));
    await waitFor(() => expect(bodies).toEqual([{ action: "approve", input: { bankTxnId: TXN } }]));
  });
});

describe("the account questions card", () => {
  it("asks what an account is for, keeps the answer, then sends the card back", async () => {
    const bodies: unknown[] = [];
    const resolved: unknown[] = [];
    const view = (answered: boolean) => ({
      review: "bookkeeping.account-questions",
      status: "open",
      canDecide: true,
      data: {
        accounts: [
          {
            id: FUEL,
            fullName: "Fuel",
            number: "6120",
            type: "Expense",
            description: null,
            notes: answered
              ? [
                  {
                    id: "n1",
                    note: "Gas for the vans",
                    source: "client",
                    createdAt: "2026-11-08T15:00:00.000Z",
                  },
                ]
              : [],
            examples: [{ payee: "Shell", times: 3 }],
          },
        ],
      },
    });
    renderAt(
      <InboxCard
        item={item("bookkeeping.account-questions", { ledgerAccountIds: [FUEL] })}
        onResolve={async (b) => void resolved.push(b)}
      />,
      {
        [`GET /api/inbox/${INBOX}/pack-review`]: () => view(false),
        [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return view(true);
        },
      },
    );
    const card = await screen.findByTestId("account-questions");
    expect(card).toHaveTextContent("What do you use 6120 Fuel for?");
    expect(card).toHaveTextContent("Booked here before: Shell");
    await userEvent.type(within(card).getByTestId("account-questions-answer"), "Gas for the vans");
    await userEvent.click(within(card).getByTestId("account-questions-save"));
    await waitFor(() =>
      expect(bodies).toEqual([
        { action: "answer", input: { ledgerAccountId: FUEL, answer: "Gas for the vans" } },
      ]),
    );
    expect(await within(card).findByText("Answered")).toBeInTheDocument();
    await userEvent.click(within(card).getByTestId("account-questions-finish"));
    expect(resolved).toEqual([{ decision: "approve" }]);
  });
});

// R-1 (docs/plan.md §1.80).
const REC = "00000000-0000-4000-8000-0000000c0001";
const A1 = "00000000-0000-4000-8000-0000000c0a01";
const B1 = "00000000-0000-4000-8000-0000000c0b01";
const B2 = "00000000-0000-4000-8000-0000000c0b02";
const M1 = "00000000-0000-4000-8000-0000000c0d01";

function recView(step: "proposed" | "accepted" | "added" | "signed") {
  const accepted = step !== "proposed";
  const added = step === "added" || step === "signed";
  const items = [
    {
      id: A1,
      side: "a",
      ref: "txn-1",
      date: "2026-10-01",
      effect: "300.0000",
      description: "WIRE 77",
      reference: null,
      carried: false,
      addedByPerson: false,
      state: accepted ? "matched" : "unmatched",
      label: accepted ? null : "missing",
    },
    {
      id: B1,
      side: "b",
      ref: "qbo:Deposit:9",
      date: "2026-10-22",
      effect: "300.0000",
      description: "Smith job",
      reference: null,
      carried: false,
      addedByPerson: false,
      state: accepted ? "matched" : "unmatched",
      label: accepted ? null : "missing",
    },
    {
      id: B2,
      side: "b",
      ref: "qbo:Purchase:3",
      date: "2026-10-30",
      effect: "-12.0000",
      description: "Bank fee",
      reference: null,
      carried: false,
      addedByPerson: false,
      state: "unmatched",
      label: "missing",
    },
    ...(added
      ? [
          {
            id: "00000000-0000-4000-8000-0000000c0a02",
            side: "a",
            ref: "person:1",
            date: null,
            effect: "-2.0000",
            description: "Wire fee",
            reference: null,
            carried: false,
            addedByPerson: true,
            state: "unmatched",
            label: "missing",
          },
        ]
      : []),
  ];
  return {
    review: "bookkeeping.reconciliation",
    status: "open",
    canDecide: true,
    data: {
      reconciliation: {
        id: REC,
        aLabel: "Checking …0001",
        bLabel: "QuickBooks",
        periodStart: "2026-10-01",
        asOf: "2026-10-31",
        currency: "USD",
        aOpening: null,
        aClosing: "1000.0000",
        bOpening: null,
        bClosing: "1010.0000",
        difference: "-10.0000",
        residual: added ? "0.0000" : "2.0000",
        outcome: added ? "explained" : "unexplained",
        status: step === "signed" ? "signed_off" : "open",
        signedOffAt: null,
        note: null,
        summary: "",
        items,
        matches: [
          {
            id: M1,
            method: "model",
            status: accepted ? "accepted" : "proposed",
            aItemIds: [A1],
            bItemIds: [B1],
            confidence: "0.800",
            reason: "The same wire, three weeks apart",
          },
        ],
      },
    },
  };
}

describe("the reconciliation card", () => {
  it("leads with the numbers, accepts our suggestion, adds what is missing, then signs off", async () => {
    const bodies: { action: string }[] = [];
    const resolved: unknown[] = [];
    const steps = ["accepted", "added", "signed"] as const;
    renderAt(
      <InboxCard
        item={item("bookkeeping.reconciliation", { reconciliationId: REC })}
        onResolve={async (b) => void resolved.push(b)}
      />,
      {
        [`GET /api/inbox/${INBOX}/pack-review`]: () => recView("proposed"),
        [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return recView(steps[bodies.length - 1] ?? "signed");
        },
      },
    );
    const card = await screen.findByTestId("reconciliation-review");
    const numbers = within(card).getByTestId("reconciliation-numbers");
    expect(numbers).toHaveTextContent("Checking …0001");
    expect(numbers).toHaveTextContent("$1,000.00");
    expect(numbers).toHaveTextContent("$1,010.00");
    expect(numbers).toHaveTextContent("-$10.00");
    expect(within(card).getByTestId("reconciliation-outcome")).toHaveTextContent("Not explained");
    expect(within(card).getByTestId("reconciliation-residual")).toHaveTextContent(
      "$2.00 isn't explained",
    );
    // Signing off waits until nothing is unexplained.
    expect(within(card).getByTestId("reconciliation-sign-off")).toBeDisabled();
    expect(within(card).getByTestId("reconciliation-proposal")).toHaveTextContent(
      "The same wire, three weeks apart",
    );
    await userEvent.click(within(card).getByTestId("reconciliation-accept"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ action: "accept", input: { matchId: M1 } });
    expect(await within(card).findByText("Matched (1)")).toBeInTheDocument();

    const add = within(card).getByTestId("reconciliation-add");
    await userEvent.type(within(add).getByLabelText("Amount"), "-2.00");
    await userEvent.type(within(add).getByLabelText("What it is"), "Wire fee");
    await userEvent.click(within(add).getByTestId("reconciliation-add-button"));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({
      action: "add_item",
      input: { side: "a", date: null, effect: "-2.00", description: "Wire fee" },
    });
    await waitFor(() =>
      expect(within(card).getByTestId("reconciliation-sign-off")).not.toBeDisabled(),
    );
    expect(within(card).getByTestId("reconciliation-outcome")).toHaveTextContent("Explained");
    await userEvent.click(within(card).getByTestId("reconciliation-sign-off"));
    await waitFor(() => expect(resolved).toEqual([{ decision: "approve" }]));
    expect(bodies[2]).toEqual({ action: "sign_off", input: { note: null } });
  });
});

describe("the Reconciliations screen", () => {
  it("lists each reconciliation with its numbers, result and sign-off", async () => {
    renderAt(<ReconciliationsView />, {
      "GET /api/reports/bookkeeping/reconciliations": () => ({
        report: {
          reconciliations: [
            {
              id: REC,
              asOf: "2026-10-31",
              periodStart: "2026-10-01",
              aLabel: "Checking …0001",
              bLabel: "QuickBooks",
              aClosing: "10380.0000",
              bClosing: "10630.0000",
              difference: "-250.0000",
              residual: "0.0000",
              currency: "USD",
              outcome: "explained",
              status: "open",
              signedOffAt: null,
            },
          ],
        },
      }),
    });
    const rows = await screen.findAllByTestId("bookkeeping-reconciliation-row");
    expect(rows[0]).toHaveTextContent("Checking …0001 $10,380.00");
    expect(rows[0]).toHaveTextContent("-$250.00");
    expect(rows[0]).toHaveTextContent("Explained");
    expect(screen.getByText("1 waiting on you")).toBeInTheDocument();
  });
});
