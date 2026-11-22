// §1.234: the work statement on both surfaces, from the API's one answer: the totals, by area and
// by agent, the month in the address, the PDF's link, and nothing of our cost (invariant 11).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { ClientWorkStatement } from "../ops/screens/ClientWorkStatement";
import { CLIENT_SESSION, fakeApi, Reply } from "../test/fixtures";

afterEach(cleanup);

const CLIENT = "00000000-0000-4000-8000-0000000c1001";

const counts = (n: number, dollars: { currency: string; total: string }[] = []) => ({
  itemsProcessed: n,
  autoPosted: n - 1,
  sentForApproval: 1,
  exceptionsCaught: n - 2,
  dollarsIdentified: dollars,
});

const STATEMENT = {
  client: { name: "Sandbox" },
  month: "2026-10",
  from: "2026-10-01",
  to: "2026-10-31",
  partial: false,
  totals: counts(6, [
    { currency: "USD", total: "165.75" },
    { currency: "EUR", total: "10.00" },
  ]),
  areas: [
    { area: "purchasing", agents: 1, counts: counts(4, [{ currency: "USD", total: "165.75" }]) },
    { area: "bookkeeping", agents: 1, counts: counts(2) },
  ],
  agents: [
    { id: "a2", name: "Bookkeeper", area: "bookkeeping", runs: 1, counts: counts(2) },
    {
      id: "a1",
      name: "Invoice review",
      area: "purchasing",
      runs: 4,
      counts: counts(4, [{ currency: "USD", total: "165.75" }]),
    },
  ],
  invoiceNumber: "MZ-0007",
  // What a portal answer must never carry, mixed in to prove the page shows none of it.
  costUsd: "43.1150",
  prompt: "You are a records clerk",
};

describe("the work statement", () => {
  it("the portal's page shows the month's counts by area and agent, never our cost", async () => {
    const months: (string | null)[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/billing/work": ({ url }) => {
        months.push(url.searchParams.get("month"));
        return STATEMENT;
      },
    });
    const { container } = render(
      <MemoryRouter initialEntries={["/billing/work?month=2026-10"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const page = await screen.findByTestId("work-statement", {}, { timeout: 10_000 });
    expect(months).toEqual(["2026-10"]);
    expect(within(page).getByTestId("work-statement-month")).toHaveTextContent(
      "October 2026 · With invoice MZ-0007",
    );
    expect(screen.getByTestId("work-total-itemsProcessed")).toHaveTextContent("6");
    expect(screen.getByTestId("work-total-autoPosted")).toHaveTextContent("5");
    expect(screen.getByTestId("work-total-sentForApproval")).toHaveTextContent("1");
    expect(screen.getByTestId("work-total-exceptionsCaught")).toHaveTextContent("4");
    expect(screen.getByTestId("work-total-dollars")).toHaveTextContent("$165.75, €10.00");
    expect(screen.getByTestId("work-by-area-purchasing")).toHaveTextContent("Purchasing");
    expect(screen.getByTestId("work-by-agent-a1")).toHaveTextContent(
      "Invoice review (Purchasing, 4 runs)",
    );
    expect(within(page).getByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "href",
      "/api/billing/work.pdf?month=2026-10",
    );
    expect(container.textContent).not.toMatch(/43\.1|records clerk/);

    // Another month, from the picker.
    await userEvent.clear(screen.getByTestId("work-month-input"));
    await userEvent.type(screen.getByTestId("work-month-input"), "2026-09");
    await userEvent.click(screen.getByTestId("work-month-show"));
    expect(await screen.findByTestId("work-statement")).toBeInTheDocument();
    expect(months.at(-1)).toBe("2026-09");
  });

  it("the back office's view reads the client's statement, with the same PDF", async () => {
    const api = fakeApi({
      [`GET /api/ops/billing/clients/${CLIENT}/work`]: () => ({
        ...STATEMENT,
        client: { id: CLIENT, name: "Sandbox" },
      }),
    });
    render(
      <MemoryRouter>
        <AppProviders client={api.client}>
          <ClientWorkStatement clientId={CLIENT} />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("work-total-itemsProcessed")).toHaveTextContent("6");
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "href",
      `/api/ops/billing/clients/${CLIENT}/work.pdf`,
    );
  });
});
