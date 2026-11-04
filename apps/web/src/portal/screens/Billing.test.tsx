// The portal's billing page (client admin): the plan, the allowance, credits used as a meter and
// Stripe's invoices. Cost, tokens or prompts mixed into a response are dropped by the contract
// parse and never shown; a client user has no Billing link.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const usd = (amount: string) => ({ amount, currency: "USD" });

/** A billing answer with fields a portal response must never carry mixed in. */
const LEAKY_BILLING = {
  setUp: true,
  plan: { agents: 2, baseFee: usd("250.0000"), monthly: usd("500.0000"), costUsd: "43.1150" },
  period: { start: "2026-11-01", end: "2026-11-30", through: "2026-11-04" },
  allowance: 4000,
  creditsUsed: 4312,
  extraCredits: 312,
  extraCreditPrice: usd("0.0150"),
  paymentProblem: true,
  invoices: [
    {
      id: "in_1",
      number: "MZ-0001",
      status: "paid",
      total: usd("265.0000"),
      amountDue: usd("0.0000"),
      createdAt: "2026-11-01T00:00:00.000Z",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      dueAt: null,
      hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/in_1",
      pdfUrl: "https://pay.stripe.com/invoice/acct/in_1/pdf",
    },
  ],
  invoicesUnavailable: false,
  modelCost: "43.1150",
  tokensIn: 123456,
  prompt: "You are a records clerk",
};

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const portal = (billing: unknown, session = CLIENT_SESSION) =>
  fakeApi({
    "GET /api/session": () => session,
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/billing": () => billing,
  });

describe("portal billing", () => {
  it("shows the plan, the allowance, credits used and invoices, never our cost", async () => {
    const { container } = renderAt("/billing", portal(LEAKY_BILLING));
    expect(await screen.findByTestId("portal-billing-plan")).toHaveTextContent("$500.00a month");
    expect(screen.getByTestId("portal-billing-plan")).toHaveTextContent("2 services × $250.00");
    expect(screen.getByTestId("portal-billing-allowance")).toHaveTextContent("4,000credits");
    expect(screen.getByTestId("portal-billing-extra")).toHaveTextContent("312");
    expect(screen.getByTestId("portal-billing-extra")).toHaveTextContent("$0.015 each");
    const meter = within(screen.getByTestId("portal-billing-meter")).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "4000");
    expect(screen.getByTestId("portal-billing-meter")).toHaveTextContent(
      "4,312 of 4,000 credits used · 312 credits over the allowance",
    );
    expect(screen.getByTestId("portal-billing-payment-problem")).toHaveTextContent(
      "didn't go through",
    );
    const row = screen.getByTestId("portal-billing-invoices-row-in_1");
    expect(row).toHaveTextContent("Paid");
    expect(within(row).getByRole("link", { name: "View" })).toHaveAttribute(
      "href",
      "https://invoice.stripe.com/i/acct/in_1",
    );
    expect(within(row).getByRole("link", { name: "PDF" })).toBeInTheDocument();
    // Nothing of cost, tokens or prompts reaches the page.
    expect(container.textContent).not.toMatch(/43\.1|123456|123,456|records clerk/);
    expect(screen.getByTestId("portal-nav-billing")).toBeInTheDocument();
  });

  it("says when billing isn't set up yet", async () => {
    renderAt(
      "/billing",
      portal({
        setUp: false,
        plan: null,
        period: { start: "2026-11-01", end: "2026-11-30", through: "2026-11-04" },
        allowance: 0,
        creditsUsed: 0,
        extraCredits: 0,
        extraCreditPrice: null,
        paymentProblem: false,
        invoices: [],
        invoicesUnavailable: false,
      }),
    );
    expect(await screen.findByText(/Billing is not set up yet/)).toBeInTheDocument();
  });

  it("gives a client user no Billing link", async () => {
    const userSession = {
      ...CLIENT_SESSION,
      tenants: CLIENT_SESSION.tenants.map((t) => ({ ...t, role: "client_user" as const })),
    };
    renderAt("/", portal(LEAKY_BILLING, userSession));
    expect(await screen.findByTestId("portal-nav-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-nav-billing")).toBeNull();
  });
});
