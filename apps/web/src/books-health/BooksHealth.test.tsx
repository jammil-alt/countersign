// Books health (docs/plan.md §1.216): the owner's one page on its QuickBooks, findings most dollars
// first, each with its area and whether it is switched on, its parts and examples; the clean
// checks named once; and the page before QuickBooks is connected or synced.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi } from "../test/fixtures";

const finding = (over: Record<string, unknown>) => ({
  currency: "USD",
  groups: [],
  examples: [],
  sources: ["00000000-0000-4000-8000-0000000aa001"],
  ...over,
});

const VIEW = {
  company: { name: "Harbor Joinery", lastSyncAt: "2026-11-20T08:00:00.000Z" },
  packs: ["bookkeeping"],
  report: {
    asOf: "2026-11-20",
    currency: "USD",
    since: "2026-07-01",
    records: 40,
    clean: ["duplicate_vendors"],
    findings: [
      finding({
        check: "receivables_aging",
        title: "Overdue invoices",
        summary: "$9,000 on 2 invoices is more than 30 days past due.",
        amount: "9000.0000",
        count: 2,
        area: "receivables",
        pack: null,
        groups: [{ label: "Over 90 days past due", amount: "6000.0000", count: 1, note: null }],
        examples: [
          {
            entity: "Invoice",
            externalId: "9401",
            source: "00000000-0000-4000-8000-0000000aa001",
            date: "2026-07-03",
            name: "Marin Builders",
            ref: "INV-9401",
            amount: "6000.0000",
            note: "110 days past due",
          },
        ],
      }),
      finding({
        check: "uncategorized",
        title: "Uncategorized transactions",
        summary: "3 transactions worth $1,830 have no category.",
        amount: "1830.0000",
        count: 3,
        area: "bookkeeping",
        pack: "bookkeeping",
      }),
      finding({
        check: "price_drift",
        title: "Vendor prices rising",
        summary: "1 item cost at least 10% more than earlier in the year.",
        amount: "384.0000",
        count: 2,
        area: "purchasing",
        pack: "materials",
      }),
    ],
  },
};

function renderAt(view: unknown) {
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/books-health": () => view,
  });
  render(
    <MemoryRouter initialEntries={["/books-health"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("books health", () => {
  it("ranks the findings by dollars, each with its area and whether it is on", async () => {
    renderAt(VIEW);
    await screen.findByTestId("books-health");
    const cards = screen.getAllByTestId(/^books-finding-[a-z_]+$/);
    expect(cards.map((c) => c.dataset.testid)).toEqual([
      "books-finding-receivables_aging",
      "books-finding-uncategorized",
      "books-finding-price_drift",
    ]);
    const ar = cards[0] as HTMLElement;
    expect(ar).toHaveTextContent("1. Overdue invoices");
    expect(within(ar).getByTestId("books-finding-receivables_aging-amount")).toHaveTextContent(
      "$9,000.00",
    );
    expect(ar).toHaveTextContent("Getting paid fixes this");
    expect(within(ar).getByTestId("books-finding-receivables_aging-groups")).toHaveTextContent(
      "Over 90 days past due",
    );
    expect(within(ar).getByTestId("books-finding-receivables_aging-examples")).toHaveTextContent(
      "Marin Builders",
    );
    expect(cards[1]).toHaveTextContent("Bookkeeping fixes this");
    expect(cards[1]).toHaveTextContent("Switched on");
    expect(cards[2]).toHaveTextContent("Not switched on");
    expect(screen.getByTestId("books-health-clean-list")).toHaveTextContent(
      "Nothing found in: Duplicate vendors.",
    );
    expect(screen.getByTestId("books-health-as-of")).toHaveTextContent("Harbor Joinery");
  });

  it("says what to do before QuickBooks is connected, and before its first sync", async () => {
    renderAt({ company: null, report: null, packs: [] });
    expect(
      await screen.findByText("Connect QuickBooks and we check your books here."),
    ).toBeTruthy();
  });

  it("says when every check is clean", async () => {
    renderAt({
      ...VIEW,
      report: { ...VIEW.report, findings: [], clean: ["uncategorized"] },
    });
    expect(await screen.findByTestId("books-health-clean")).toHaveTextContent(
      "Every check came back clean.",
    );
  });
});
