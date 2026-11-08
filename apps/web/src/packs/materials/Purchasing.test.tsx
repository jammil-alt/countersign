// P-9 (docs/plan.md §1.71): the Purchasing area's screens and cards. The Requests list, a request's
// page (lines, a line with no quantity yet, quotes, the comparison, the orders and the documents),
// the request line review card (pick an item, set how many, then Done) and the vendor choice card
// (the comparison as a table, pick a vendor, then Done).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { InboxCard } from "../../inbox/InboxCard";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { RequestsView, RequestView } from "./Requests";

const REQ = "00000000-0000-4000-8000-0000000e0001";
const L1 = "00000000-0000-4000-8000-0000000e1001";
const L2 = "00000000-0000-4000-8000-0000000e1002";
const ITEM = "00000000-0000-4000-8000-0000000c0001";
const OTHER = "00000000-0000-4000-8000-0000000c0002";
const Q1 = "00000000-0000-4000-8000-0000000e2001";
const Q2 = "00000000-0000-4000-8000-0000000e2002";
const INBOX = "00000000-0000-4000-8000-0000000e3001";
const DOC = "00000000-0000-4000-8000-0000000d0009";

function renderAt(
  node: React.ReactNode,
  routes: Parameters<typeof fakeApi>[0],
  path = "*",
  at = "/",
) {
  const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={[at]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path={path} element={node} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

const COMPARISON = {
  requestId: REQ,
  neededBy: "2026-12-01",
  asOf: "2026-11-08",
  lines: [
    {
      requestLineId: L1,
      lineNo: 1,
      description: "3/4 BB/BB BALTIC BIRCH 5X5",
      qty: "12.0000",
      unit: "sheets",
      offers: [
        {
          quoteRequestId: Q1,
          vendorId: "v1",
          vendorName: "Keystone Lumber",
          unitPrice: "58.0000",
          unit: "SHT",
          currency: "USD",
          cost: "696.0000",
          leadTimeDays: 2,
          available: true,
          comparable: true,
        },
        {
          quoteRequestId: Q2,
          vendorId: "v2",
          vendorName: "Northline Panel Supply",
          unitPrice: "61.0000",
          unit: "EA",
          currency: "USD",
          cost: "732.0000",
          leadTimeDays: 1,
          available: true,
          comparable: true,
        },
      ],
      best: { quoteRequestId: Q1, vendorId: "v1" },
    },
  ],
  vendors: [
    {
      quoteRequestId: Q1,
      vendorId: "v1",
      vendorName: "Keystone Lumber",
      total: "696.0000",
      currency: "USD",
      complete: true,
      late: false,
      maxLeadTimeDays: 2,
    },
    {
      quoteRequestId: Q2,
      vendorId: "v2",
      vendorName: "Northline Panel Supply",
      total: "732.0000",
      currency: "USD",
      complete: true,
      late: false,
      maxLeadTimeDays: 1,
    },
  ],
  suggestion: {
    kind: "single",
    quoteRequestId: Q1,
    vendorId: "v1",
    total: "696.0000",
    currency: "USD",
    split: [],
    reasons: ["Keystone Lumber is cheapest for every line: $696.00."],
  },
  sources: [REQ],
};

describe("the Requests screen", () => {
  it("lists the client's requests with what was asked, the quotes in and the status", async () => {
    renderAt(<RequestsView />, {
      "GET /api/reports/materials/requests": () => ({
        report: {
          requests: [
            {
              id: REQ,
              createdAt: "2026-11-08T15:00:00.000Z",
              status: "quoted",
              channel: "email",
              neededBy: "2026-12-01",
              fulfillment: "pickup",
              lines: [
                {
                  description: "3/4 BB/BB BALTIC BIRCH 5X5",
                  qty: "12",
                  unit: "sheets",
                  matched: true,
                },
                { description: "edge banding", qty: null, unit: null, matched: false },
              ],
              quotes: [
                { vendor: "Keystone Lumber", status: "received", receivedAt: "2026-11-09" },
                { vendor: "Northline Panel Supply", status: "expired", receivedAt: null },
              ],
              order: null,
            },
          ],
        },
      }),
    });
    const rows = await screen.findAllByTestId("materials-request-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("3/4 BB/BB BALTIC BIRCH 5X5, edge banding");
    expect(rows[0]).toHaveTextContent("2 items");
    expect(rows[0]).toHaveTextContent("1 of 2 quotes in");
    expect(
      within(rows[0] as HTMLElement).getByTestId("materials-request-status"),
    ).toHaveTextContent("Quotes in");
    expect(within(rows[0] as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      `/reports/materials/requests/${REQ}`,
    );
  });

  it("shows one request: its lines, quotes, the comparison, the vendor picked, orders and documents", async () => {
    renderAt(
      <RequestView />,
      {
        [`GET /api/reports/materials/requests/items/${REQ}`]: () => ({
          report: {
            request: {
              id: REQ,
              status: "ordered",
              channel: "email",
              neededBy: "2026-12-01",
              fulfillment: "delivery",
              deliverTo: "12 Mill Road",
              notes: null,
              createdAt: "2026-11-08T15:00:00.000Z",
              orders: [
                { connector: "qbo", externalId: "1001", quoteRequestId: Q1, at: "2026-11-10" },
              ],
              lines: [
                {
                  id: L1,
                  lineNo: 1,
                  description: "3/4 BB/BB BALTIC BIRCH 5X5",
                  qty: "12.0000",
                  unit: "sheets",
                  catalogItemName: "Baltic birch plywood 3/4in",
                  matched: true,
                },
                {
                  id: L2,
                  lineNo: 2,
                  description: "edge banding",
                  qty: null,
                  unit: null,
                  catalogItemName: null,
                  matched: false,
                },
              ],
              quotes: [
                {
                  id: Q1,
                  vendorId: "v1",
                  vendorName: "Keystone Lumber",
                  status: "received",
                  sentAt: null,
                  receivedAt: null,
                  lines: [],
                },
                {
                  id: Q2,
                  vendorId: "v2",
                  vendorName: "Northline Panel Supply",
                  status: "expired",
                  sentAt: null,
                  receivedAt: null,
                  lines: [],
                },
              ],
              comparison: COMPARISON,
              choice: { kind: "single", quoteRequestId: Q1, split: [], at: "2026-11-09" },
              documents: [{ id: DOC, filename: "PO-0000000E.pdf", kind: "purchase_order" }],
            },
          },
        }),
      },
      "/r/:id",
      `/r/${REQ}`,
    );
    const page = await screen.findByTestId("materials-request");
    expect(within(page).getByTestId("materials-request-status")).toHaveTextContent("Ordered");
    const lines = within(page).getAllByTestId("materials-request-line");
    expect(lines[1]).toHaveTextContent("How many?");
    expect(lines[1]).toHaveTextContent("Not matched yet");
    const quotes = within(page).getAllByTestId("materials-request-quote");
    expect(quotes[1]).toHaveTextContent("No answer");
    expect(within(page).getByTestId("materials-compare-table")).toHaveTextContent("$696.00");
    expect(within(page).getByTestId("materials-request-choice")).toHaveTextContent(
      "You picked Keystone Lumber",
    );
    expect(within(page).getByTestId("materials-request-orders")).toHaveTextContent("Order 1001");
    expect(
      within(page).getByTestId("materials-request-document").querySelector("a"),
    ).toHaveAttribute("href", `/documents/${DOC}`);
    // Nothing an agent is made of.
    expect(page.textContent).not.toMatch(/prompt|model|cost/i);
  });
});

const item = (review: string) => ({
  id: INBOX,
  kind: "request",
  title: "A question about your request",
  payload: { review, requestId: REQ, nodeId: "check" },
  status: "open",
  runId: null,
  dueAt: null,
  createdAt: "2026-11-08T15:00:00.000Z",
  resolvedAt: null,
});

describe("the request line review card", () => {
  const data = (settled: boolean) => ({
    requestId: REQ,
    status: "open",
    lines: [
      {
        id: L2,
        lineNo: 2,
        description: "baltic birch 5x5",
        qty: settled ? "4.0000" : null,
        unit: "sheets",
        catalogItemId: settled ? ITEM : null,
        catalogItemName: settled ? "Baltic birch plywood 3/4in" : null,
        matchMethod: settled ? "chosen" : null,
        candidates: settled
          ? []
          : [{ catalogItemId: ITEM, name: "Baltic birch plywood 3/4in", confidence: 0.5 }],
        settled,
      },
    ],
    catalog: [
      { id: ITEM, name: "Baltic birch plywood 3/4in", standardUom: "sheet" },
      { id: OTHER, name: "Baltic birch plywood 1/2in", standardUom: "sheet" },
    ],
  });

  it("picks the item and sets how many for an unsure line, then sends the review back", async () => {
    const bodies: unknown[] = [];
    const resolved: unknown[] = [];
    renderAt(
      <InboxCard
        item={item("materials.request-lines")}
        onResolve={async (b) => void resolved.push(b)}
      />,
      {
        [`GET /api/inbox/${INBOX}/pack-review`]: () => ({
          review: "materials.request-lines",
          status: "open",
          canDecide: true,
          data: data(false),
        }),
        [`POST /api/inbox/${INBOX}/pack-review`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return {
            review: "materials.request-lines",
            status: "open",
            canDecide: true,
            data: data(true),
          };
        },
      },
    );
    const card = await screen.findByTestId("request-lines-review");
    expect(within(card).getByTestId("request-lines-state")).toHaveTextContent("Waiting on you");
    expect(within(card).getByTestId("request-lines-finish")).toBeDisabled();
    await userEvent.selectOptions(within(card).getByTestId("request-lines-item"), OTHER);
    await userEvent.type(within(card).getByTestId("request-lines-qty"), "4");
    await userEvent.click(within(card).getByTestId("request-lines-save"));
    await waitFor(() =>
      expect(bodies).toEqual([
        { action: "line", input: { lineId: L2, catalogItemId: OTHER, qty: "4" } },
      ]),
    );
    expect(await within(card).findByText("Settled")).toBeInTheDocument();
    await userEvent.click(within(card).getByTestId("request-lines-finish"));
    expect(resolved).toEqual([{ decision: "approve", answer: { settled: 1 } }]);
  });
});

describe("the vendor choice card", () => {
  it("shows the quotes compared as a table, picks a vendor, then sends the choice back", async () => {
    const bodies: unknown[] = [];
    const resolved: unknown[] = [];
    const view = (picked: boolean) => ({
      review: "materials.vendor-choice",
      status: "open",
      canDecide: true,
      data: {
        requestId: REQ,
        status: "quoted",
        comparison: COMPARISON,
        choice: picked ? { kind: "single", quoteRequestId: Q2, split: [], at: "2026-11-09" } : null,
      },
    });
    renderAt(
      <InboxCard
        item={item("materials.vendor-choice")}
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
    const card = await screen.findByTestId("vendor-choice");
    const table = within(card).getByTestId("materials-compare-table");
    expect(within(table).getAllByTestId("materials-compare-row")[0]).toHaveTextContent(
      "$58.00 / SHT",
    );
    expect(within(table).getByTestId("materials-compare-total")).toHaveTextContent("$732.00");
    expect(within(card).getByTestId("vendor-choice-reasons")).toHaveTextContent("cheapest");
    expect(within(card).getByTestId("vendor-choice-finish")).toBeDisabled();
    const vendors = within(card).getAllByTestId("vendor-choice-vendor");
    expect(vendors[0]).toHaveTextContent("Suggested");
    await userEvent.click(within(vendors[1] as HTMLElement).getByTestId("vendor-choice-pick"));
    await waitFor(() =>
      expect(bodies).toEqual([{ action: "choose", input: { kind: "single", quoteRequestId: Q2 } }]),
    );
    expect(await within(card).findByText("Picked")).toBeInTheDocument();
    await userEvent.click(within(card).getByTestId("vendor-choice-finish"));
    expect(resolved).toEqual([
      { decision: "approve", answer: { kind: "single", quoteRequestId: Q2, split: [] } },
    ]);
  });
});
