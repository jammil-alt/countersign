// The portal's records list (v0.12 W1-H): the client's own records by kind, each opening its
// record page, with the search in the URL.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { PortalRecordsScreen } from "./Records";

const TXN = "00000000-0000-4000-8000-0000000b7001";
const VENDOR = "00000000-0000-4000-8000-0000000b7003";
const SOURCE = "00000000-0000-4000-8000-0000000b7009";

const base = {
  counts: { transactions: 1, vendors: 1, items: 0, receivables: 0 },
  lastSyncAt: "2026-11-05T10:00:00.000Z",
  sources: [
    {
      id: SOURCE,
      connector: "qbo",
      connectorName: "QuickBooks Online",
      accountName: "Harbor Millwork",
      externalAccountId: "9130",
      status: "connected",
      lastSyncAt: "2026-11-05T10:00:00.000Z",
    },
  ],
  offset: 0,
  limit: 50,
};

const transactions = {
  ...base,
  total: 1,
  page: {
    kind: "transactions",
    rows: [
      {
        id: TXN,
        txnKind: "bill",
        txnDate: "2026-10-28",
        vendor: { id: VENDOR, name: "Northline Panel Supply" },
        docNumber: "20418",
        memo: null,
        total: "9742.3500",
        currency: "USD",
        lines: 6,
        attachments: 1,
        syncedAt: "2026-11-05T10:00:00.000Z",
        sourceId: SOURCE,
        deleted: false,
      },
    ],
  },
};

const vendors = {
  ...base,
  total: 1,
  page: {
    kind: "vendors",
    rows: [
      {
        id: VENDOR,
        name: "Northline Panel Supply",
        aliases: [],
        transactions: 1,
        externalId: "60",
        sourceId: SOURCE,
        syncedAt: "2026-11-05T10:00:00.000Z",
        createdAt: "2026-11-05T10:00:00.000Z",
      },
    ],
  },
};

function show() {
  const asked: string[] = [];
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/records": ({ url }) => {
      asked.push(url.search);
      const q = url.searchParams.get("q");
      if (q) return { ...transactions, total: 0, page: { kind: "transactions", rows: [] } };
      return url.searchParams.get("kind") === "vendors" ? vendors : transactions;
    },
  });
  render(
    <MemoryRouter initialEntries={["/records"]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="/records" element={<PortalRecordsScreen />} />
          <Route path="/records/:id" element={<p>The record page</p>} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return asked;
}

describe("portal records list", () => {
  it("lists the client's transactions, each opening its record page", async () => {
    show();
    const table = await screen.findByTestId("portal-records-transactions");
    const row = within(table).getByTestId(`portal-records-row-${TXN}`);
    expect(row).toHaveTextContent("Northline Panel Supply");
    expect(row).toHaveTextContent("20418");
    expect(row).toHaveTextContent("$9,742.35");
    // One account: named once above the table, not on every row.
    expect(row).not.toHaveTextContent("Harbor Millwork");
    expect(screen.getByTestId("portal-records-account")).toHaveTextContent("From Harbor Millwork");
    expect(within(row).getByRole("link")).toHaveAttribute("href", `/records/${TXN}`);
  });

  it("names each row's account when records come from more than one", async () => {
    const two = {
      ...transactions,
      sources: [
        ...base.sources,
        {
          ...base.sources[0],
          id: "00000000-0000-4000-8000-0000000b700a",
          accountName: "Second Co",
        },
      ],
    };
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/records": () => two,
    });
    render(
      <MemoryRouter initialEntries={["/records"]}>
        <AppProviders client={api.client}>
          <Routes>
            <Route path="/records" element={<PortalRecordsScreen />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    const row = await screen.findByTestId(`portal-records-row-${TXN}`);
    expect(row).toHaveTextContent("Harbor Millwork");
    expect(screen.queryByTestId("portal-records-account")).toBeNull();
  });

  it("switches to vendors and searches", async () => {
    const asked = show();
    await screen.findByTestId("portal-records-transactions");
    await userEvent.click(screen.getByRole("link", { name: /Vendors/ }));
    expect(await screen.findByTestId("portal-records-vendors")).toHaveTextContent(
      "Northline Panel Supply",
    );
    await userEvent.type(screen.getByTestId("portal-records-search"), "nothing");
    expect(await screen.findByText("Nothing matches “nothing”.")).toBeInTheDocument();
    expect(asked.some((s) => s.includes("q=nothing"))).toBe(true);
  });

  it("lists receivables: what each customer still owes, an open one past due marked overdue", async () => {
    const OPEN = "00000000-0000-4000-8000-0000000b7101";
    const PAID = "00000000-0000-4000-8000-0000000b7102";
    const receivable = (id: string, o: Record<string, unknown>) => ({
      id,
      docNumber: "1042",
      customer: { name: "Lakeside Builders", organizationId: null },
      txnDate: "2026-09-01",
      dueDate: "2026-10-01",
      total: "6200.0000",
      balance: "6200.0000",
      currency: "USD",
      status: "open",
      syncedAt: "2026-11-05T10:00:00.000Z",
      sourceId: SOURCE,
      ...o,
    });
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/records": () => ({
        ...base,
        counts: { transactions: 1, vendors: 1, items: 0, receivables: 2 },
        total: 2,
        page: {
          kind: "receivables",
          rows: [
            receivable(OPEN, { balance: "4100.0000" }),
            receivable(PAID, { docNumber: "1043", status: "paid", balance: "0.0000" }),
          ],
        },
      }),
    });
    render(
      <MemoryRouter initialEntries={["/records?kind=receivables"]}>
        <AppProviders client={api.client}>
          <Routes>
            <Route path="/records" element={<PortalRecordsScreen />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    const table = await screen.findByTestId("portal-records-receivables");
    const open = within(table).getByTestId(`portal-records-row-${OPEN}`);
    expect(open).toHaveTextContent("Lakeside Builders");
    expect(open).toHaveTextContent("$4,100.00");
    expect(open).toHaveTextContent("Overdue");
    expect(open).toHaveTextContent("Open");
    const paid = within(table).getByTestId(`portal-records-row-${PAID}`);
    expect(paid).toHaveTextContent("Paid");
    expect(paid).not.toHaveTextContent("Overdue");
    // No route serves one receivable yet: its row opens nothing.
    expect(within(table).queryByRole("link")).toBeNull();
    expect(screen.getByRole("link", { name: /Receivables/ })).toHaveTextContent("2");
    expect(screen.getByTestId("portal-records-upload")).toHaveAttribute("href", "/upload");
  });
});
