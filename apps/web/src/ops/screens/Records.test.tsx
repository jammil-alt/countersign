// The back office's Records page: the client's counts and last sync, transactions with their
// columns and a link to each record page, the kind tabs, the search and source filter in the
// query, pages, and plain empty states.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const QBO = "00000000-0000-4000-8000-0000000b0001";
const UPLOAD = "00000000-0000-4000-8000-0000000b0002";
const BILL = "00000000-0000-4000-8000-0000000b1001";
const VENDOR = "00000000-0000-4000-8000-0000000b2001";
const ITEM = "00000000-0000-4000-8000-0000000b3001";
const SYNCED = new Date();
SYNCED.setHours(12, 41, 0, 0);

const SOURCES = [
  {
    id: QBO,
    connector: "qbo",
    connectorName: "QuickBooks Online",
    accountName: "Sandbox Company_US_1",
    externalAccountId: "9341455",
    status: "connected",
    lastSyncAt: SYNCED.toISOString(),
  },
  {
    id: UPLOAD,
    connector: "upload",
    connectorName: "Upload",
    accountName: null,
    externalAccountId: null,
    status: "connected",
    lastSyncAt: null,
  },
];

const TXN = {
  id: BILL,
  txnKind: "bill",
  txnDate: "2026-11-05",
  vendor: { id: VENDOR, name: "Cal Telephone" },
  docNumber: "WH-1",
  memo: "Mezonas webhook test",
  total: "123.4500",
  currency: "USD",
  lines: 1,
  attachments: 2,
  syncedAt: SYNCED.toISOString(),
  sourceId: QBO,
  deleted: false,
};

function list(over: Record<string, unknown> = {}) {
  return {
    counts: { transactions: 312, vendors: 41, items: 18, receivables: 0 },
    lastSyncAt: SYNCED.toISOString(),
    sources: SOURCES,
    total: 312,
    offset: 0,
    limit: 50,
    page: { kind: "transactions", rows: [TXN] },
    ...over,
  };
}

function renderAt(path: string, handler: (url: URL) => unknown) {
  const urls: URL[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${CLIENT}/records`]: ({ url }) => {
      urls.push(url);
      return handler(url);
    },
    [`GET /api/ops/clients/${CLIENT}/records/${BILL}`]: () => ({
      record: {
        kind: "transaction",
        id: BILL,
        txnKind: "bill",
        connector: "qbo",
        externalId: "Bill:146",
        vendor: { id: VENDOR, name: "Cal Telephone" },
        txnDate: "2026-11-05",
        total: "123.4500",
        currency: "USD",
        purchaserRef: null,
        paymentType: null,
        memo: "Mezonas webhook test",
        status: "needs_doc",
        createdAt: SYNCED.toISOString(),
        lines: [],
        documents: [],
        rawRecordId: null,
      },
    }),
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, urls };
}

afterEach(() => vi.restoreAllMocks());

describe("back-office records", () => {
  it("lists the client's transactions with counts, and opens one", async () => {
    // Counts say 312, but only one matches: one page.
    renderAt(`/ops/clients/${CLIENT}/records`, () => list({ total: 1 }));
    // The back office is a lazy chunk: give it time to load on a busy machine.
    const table = await screen.findByTestId("ops-records-transactions", {}, { timeout: 10_000 });
    expect(screen.getByTestId("ops-records-counts")).toHaveTextContent(
      "312 transactions · 41 vendors · 18 items, last synced 12:41",
    );
    const row = within(table).getByTestId(`ops-records-row-${BILL}`);
    for (const text of [
      "Nov 5, 2026",
      "Bill",
      "Cal Telephone",
      "WH-1",
      "Mezonas webhook test",
      "$123.45",
      "Sandbox Company_US_1",
    ]) {
      expect(row).toHaveTextContent(text);
    }
    const cells = within(row).getAllByRole("cell");
    expect(cells[6]).toHaveTextContent(/^1$/);
    expect(cells[7]).toHaveTextContent(/^2$/);
    expect(screen.getByTestId("ops-nav-records")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/records`,
    );
    // One page: no pager.
    expect(screen.queryByTestId("ops-records-range")).toBeNull();
    const link = within(row).getByRole("link", { name: "Bill" });
    expect(link).toHaveAttribute("href", `/ops/clients/${CLIENT}/records/${BILL}`);
    await userEvent.setup().click(link);
    expect(await screen.findByText("Mezonas webhook test")).toBeInTheDocument();
  }, 20_000);

  it("searches, filters by source and pages in the query", async () => {
    const { urls } = renderAt(`/ops/clients/${CLIENT}/records`, (url) =>
      list({
        offset: Number(url.searchParams.get("offset") ?? 0),
        total: url.searchParams.get("q") ? 1 : 312,
      }),
    );
    await screen.findByTestId("ops-records-transactions", {}, { timeout: 10_000 });
    expect(screen.getByTestId("ops-records-range")).toHaveTextContent("1–1 of 312");
    const user = userEvent.setup();

    await user.click(screen.getByTestId("ops-records-next"));
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("offset")).toBe("50"));

    await user.selectOptions(screen.getByTestId("ops-records-source"), QBO);
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("source")).toBe(QBO));
    // A new filter starts at the first page.
    expect(urls.at(-1)?.searchParams.get("offset")).toBe("0");
    expect(
      within(screen.getByTestId("ops-records-source")).getByRole("option", {
        name: "Sandbox Company_US_1 (QuickBooks Online)",
      }),
    ).toBeInTheDocument();

    await user.type(screen.getByTestId("ops-records-search"), "webhook test");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("q")).toBe("webhook test"));
    expect(urls.at(-1)?.searchParams.get("source")).toBe(QBO);
    expect(urls.at(-1)?.searchParams.get("kind")).toBe("transactions");
  }, 20_000);

  it("shows vendors and items under their tabs", async () => {
    const { urls } = renderAt(`/ops/clients/${CLIENT}/records?kind=vendors`, (url) =>
      url.searchParams.get("kind") === "items"
        ? list({
            page: {
              kind: "items",
              rows: [
                {
                  id: ITEM,
                  externalId: "11",
                  name: "Birch plywood 3/4in",
                  sku: "BB34",
                  type: "NonInventory",
                  description: null,
                  purchaseCost: "42.5000",
                  active: true,
                  deleted: false,
                  sourceId: QBO,
                  syncedAt: SYNCED.toISOString(),
                },
              ],
            },
          })
        : list({
            page: {
              kind: "vendors",
              rows: [
                {
                  id: VENDOR,
                  name: "Cal Telephone",
                  aliases: ["caltel billing"],
                  transactions: 2,
                  externalId: "56",
                  sourceId: QBO,
                  syncedAt: SYNCED.toISOString(),
                  createdAt: SYNCED.toISOString(),
                },
              ],
            },
          }),
    );
    const vendors = await screen.findByTestId("ops-records-vendors", {}, { timeout: 10_000 });
    const row = within(vendors).getByTestId(`ops-records-row-${VENDOR}`);
    expect(row).toHaveTextContent("caltel billing");
    expect(row).toHaveTextContent("Sandbox Company_US_1");
    expect(within(row).getByRole("link", { name: "Cal Telephone" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/records/${VENDOR}`,
    );

    await userEvent.setup().click(screen.getByRole("link", { name: /^Items/ }));
    const items = await screen.findByTestId("ops-records-items");
    expect(urls.at(-1)?.searchParams.get("kind")).toBe("items");
    const item = within(items).getByTestId(`ops-records-row-${ITEM}`);
    expect(item).toHaveTextContent("SKU BB34");
    expect(item).toHaveTextContent("42.50");
    expect(item).toHaveTextContent("Active");
    expect(within(item).getByRole("link", { name: "Birch plywood 3/4in" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/records/${ITEM}`,
    );
  }, 20_000);

  it("says plainly when there is nothing yet, or nothing matches", async () => {
    const empty = {
      counts: { transactions: 0, vendors: 0, items: 0, receivables: 0 },
      lastSyncAt: null,
      sources: [],
      total: 0,
      page: { kind: "transactions", rows: [] },
    };
    renderAt(`/ops/clients/${CLIENT}/records`, () => list(empty));
    expect(
      await screen.findByText(/^No transactions yet\./, {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ops-records-counts")).toHaveTextContent(
      /^0 transactions · 0 vendors · 0 items$/,
    );
  }, 20_000);

  it("says when a search finds nothing", async () => {
    renderAt(`/ops/clients/${CLIENT}/records?q=nope`, () =>
      list({ total: 0, page: { kind: "transactions", rows: [] } }),
    );
    expect(
      await screen.findByText('Nothing matches "nope".', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ops-records-search")).toHaveValue("nope");
  }, 20_000);
});
