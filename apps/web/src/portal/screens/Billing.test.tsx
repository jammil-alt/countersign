// The portal's billing page (client admin; docs/plan.md §1.32): the month so far by service, the
// credits included and used, the price of an extra credit, and past statements with Stripe's
// links. Cost, tokens or prompts mixed into a response are dropped by the contract parse and never
// shown; a client user has no Billing link.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const usd = (amount: string) => ({ amount, currency: "USD" });
const STATEMENT = "00000000-0000-4000-8000-0000000b5001";

const lines = [
  {
    id: null,
    kind: "agent",
    agentId: "a1",
    description: "Orders desk",
    amount: usd("40.0000"),
    days: 4,
    prices: [{ monthlyPrice: usd("300.0000"), days: 4 }],
    costUsd: "12.0000",
  },
  {
    id: null,
    kind: "agent",
    agentId: "a2",
    description: "Account check",
    amount: usd("0.0000"),
    days: 4,
    prices: [{ monthlyPrice: usd("0.0000"), days: 4 }],
  },
  {
    id: null,
    kind: "usage",
    agentId: null,
    description: "Extra usage",
    amount: usd("6.2400"),
    days: null,
    prices: [],
  },
];

/** A billing answer with fields a portal response must never carry mixed in. */
const LEAKY_BILLING = {
  setUp: true,
  monthSoFar: {
    period: { start: "2026-11-01", end: "2026-11-30", through: "2026-11-04" },
    daysInMonth: 30,
    lines,
    creditsUsed: 4312,
    creditsIncluded: 4000,
    extraCredits: 312,
    creditPrice: usd("0.0200"),
    total: usd("46.2400"),
    costUsd: "43.1150",
  },
  paymentProblem: true,
  statements: [
    {
      id: STATEMENT,
      period: { start: "2026-10-01", end: "2026-10-31" },
      status: "payment_failed",
      total: usd("265.0000"),
      creditsUsed: 100,
      creditsIncluded: 4000,
      extraCredits: 0,
      creditPrice: usd("0.0200"),
      lines: [
        {
          ...lines[0],
          id: "l1",
          amount: usd("265.0000"),
          days: 31,
          prices: [{ monthlyPrice: usd("265.0000"), days: 31 }],
        },
        { ...lines[2], id: "l2", amount: usd("0.0000") },
      ],
      invoiceNumber: "MZ-0001",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/in_1",
      pdfUrl: "https://pay.stripe.com/invoice/acct/in_1/pdf",
      dueAt: "2026-12-01T00:00:00.000Z",
      sentAt: "2026-11-01T00:07:00.000Z",
      paidAt: null,
      sendError: "internal detail",
    },
  ],
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
  it("shows the month so far by service, credits and statements, never our cost", async () => {
    const { container } = renderAt("/billing", portal(LEAKY_BILLING));
    expect(await screen.findByTestId("portal-billing-so-far")).toHaveTextContent("$46.24");
    expect(screen.getByTestId("portal-billing-allowance")).toHaveTextContent("4,000credits");
    expect(screen.getByTestId("portal-billing-extra")).toHaveTextContent("312");
    expect(screen.getByTestId("portal-billing-extra")).toHaveTextContent("$0.02 each");
    const meter = within(screen.getByTestId("portal-billing-meter")).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "4000");
    const month = screen.getByTestId("portal-billing-month");
    expect(month).toHaveTextContent("Orders desk");
    expect(month).toHaveTextContent("$300.00 a month · 4 of 30 days");
    expect(month).toHaveTextContent("$40.00");
    expect(
      within(screen.getByTestId("portal-billing-month-agent-1")).getByText("Included"),
    ).toBeInTheDocument();
    expect(month).toHaveTextContent("Extra usage");
    expect(month).toHaveTextContent("Total so far$46.24");
    expect(screen.getByTestId("portal-billing-payment-problem")).toHaveTextContent(
      "didn't go through",
    );
    const card = screen.getByTestId(`portal-billing-statement-${STATEMENT}`);
    expect(card).toHaveTextContent("October 2026");
    expect(card).toHaveTextContent("MZ-0001 · Due Dec 1, 2026");
    expect(card).toHaveTextContent("Payment failed");
    expect(within(card).getByRole("link", { name: "View and pay" })).toHaveAttribute(
      "href",
      "https://invoice.stripe.com/i/acct/in_1",
    );
    expect(within(card).getByRole("link", { name: "PDF" })).toBeInTheDocument();
    await userEvent.click(within(card).getByTestId(`portal-billing-statement-${STATEMENT}-toggle`));
    expect(
      within(card).getByTestId(`portal-billing-statement-${STATEMENT}-lines`),
    ).toHaveTextContent("$265.00 a month · 31 of 31 days");
    // Nothing of cost, tokens, prompts or our internals reaches the page.
    expect(container.textContent).not.toMatch(
      /43\.1|12\.0000|123456|123,456|records clerk|internal detail/,
    );
    // Billing lives only in Settings (QA round 1): no sidebar item.
    expect(screen.queryByTestId("portal-nav-billing")).toBeNull();
  });

  it("says when billing isn't set up yet", async () => {
    renderAt(
      "/billing",
      portal({ setUp: false, monthSoFar: null, paymentProblem: false, statements: [] }),
    );
    expect(await screen.findByText(/Billing is not set up yet/)).toBeInTheDocument();
  });

  it("says when there are no statements yet", async () => {
    renderAt("/billing", portal({ ...LEAKY_BILLING, paymentProblem: false, statements: [] }));
    expect(await screen.findByText(/No statements yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("portal-billing-payment-problem")).toBeNull();
  });

  it("keeps Billing under Settings for the admin, and gives a client user no Billing link", async () => {
    renderAt("/settings", portal(LEAKY_BILLING));
    expect(await screen.findByTestId("portal-settings-statements")).toHaveAttribute(
      "href",
      "/settings/billing",
    );
    cleanup();
    const userSession = {
      ...CLIENT_SESSION,
      tenants: CLIENT_SESSION.tenants.map((t) => ({ ...t, role: "client_user" as const })),
    };
    renderAt("/", portal(LEAKY_BILLING, userSession));
    expect(await screen.findByTestId("portal-nav-table")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-nav-billing")).toBeNull();
  });
});
