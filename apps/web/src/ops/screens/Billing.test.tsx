// `/ops/billing` and the client page's billing section: the settings are saved as decimal strings
// (never floats) after the form checks them; each client's period shows base, credits, allowance,
// extra and our cost; a client is set up from either place; invoices link to Stripe.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { amountText, price } from "../../billing/parts";
import { fakeApi, OPERATOR_SESSION, Reply, SANDBOX_DETAIL } from "../../test/fixtures";
import { settingsFromDraft } from "./Billing";

const SANDBOX = "00000000-0000-4000-8000-00000000a001";
const DEMO = "00000000-0000-4000-8000-00000000a002";

const period = { start: "2026-11-01", end: "2026-11-30", through: "2026-11-04" };
const usd = (amount: string) => ({ amount, currency: "USD" });

function client(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    setUp: false,
    customerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    billedAgents: 0,
    activeAgents: 2,
    period,
    base: usd("500.0000"),
    allowance: 4000,
    creditsUsed: 4312,
    overageCredits: 312,
    reportedCredits: 300,
    costUsd: "43.1150",
    lastInvoice: null,
    ...over,
  };
}

const SETTINGS = {
  allowanceCreditsPerAgent: 2000,
  basePriceId: "price_base",
  overagePriceId: "price_credit",
  meterEventName: "mezonas_credits",
  daysUntilDue: 30,
  unitCosts: [
    { measure: "cost_usd", unitCost: "1.0000", perUnits: 1 },
    { measure: "call_seconds", unitCost: "0.1000", perUnits: 60 },
  ],
  baseFee: usd("250.0000"),
  overagePrice: usd("0.0150"),
  updatedAt: "2026-11-04T00:00:00.000Z",
};

const BILLING = {
  stripeConfigured: true,
  webhookConfigured: false,
  settings: SETTINGS,
  measures: [
    { measure: "call_seconds", available: false, priced: true },
    { measure: "cost_usd", available: true, priced: true },
    { measure: "runs", available: true, priced: false },
  ],
  clients: [
    client(DEMO, "Demo client", {
      setUp: true,
      customerId: "cus_1",
      subscriptionId: "sub_1",
      billedAgents: 2,
      lastInvoice: {
        id: "in_1",
        number: "MZ-1",
        status: "payment_failed",
        at: "2026-11-02T00:00:00.000Z",
      },
    }),
    client(SANDBOX, "Sandbox", { creditsUsed: 10, overageCredits: 0, costUsd: "0.0003" }),
  ],
};

const INVOICE = {
  id: "in_1",
  number: "MZ-0001",
  status: "open",
  total: usd("265.0000"),
  amountDue: usd("265.0000"),
  createdAt: "2026-11-01T00:00:00.000Z",
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  dueAt: "2026-12-01T00:00:00.000Z",
  hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/in_1",
  pdfUrl: "https://pay.stripe.com/invoice/acct/in_1/pdf",
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

describe("billing amounts", () => {
  it("keep fractions of a cent and group thousands, without floats", () => {
    expect(amountText("250.0000")).toBe("250.00");
    expect(amountText("0.0150")).toBe("0.015");
    expect(amountText("1234567.5000")).toBe("1,234,567.50");
    expect(price(usd("0.0125"))).toBe("$0.0125");
    expect(price({ amount: "12.0000", currency: "EUR" })).toBe("12.00 EUR");
  });

  it("are checked before they are sent: decimal strings, whole units", () => {
    const draft = {
      allowance: "2000",
      basePriceId: " price_base ",
      overagePriceId: "",
      meterEventName: "mezonas_credits",
      daysUntilDue: "30",
      unitCosts: [{ measure: "cost_usd", unitCost: "1.25", perUnits: "1" }],
    };
    expect(settingsFromDraft(draft)).toEqual({
      settings: {
        allowanceCreditsPerAgent: 2000,
        basePriceId: "price_base",
        overagePriceId: null,
        meterEventName: "mezonas_credits",
        daysUntilDue: 30,
        unitCosts: [{ measure: "cost_usd", unitCost: "1.25", perUnits: 1 }],
      },
    });
    expect(settingsFromDraft({ ...draft, allowance: "20.5" })).toHaveProperty("problem");
    expect(
      settingsFromDraft({
        ...draft,
        unitCosts: [{ measure: "cost_usd", unitCost: "0.00001", perUnits: "1" }],
      }),
    ).toHaveProperty("problem");
    expect(settingsFromDraft({ ...draft, daysUntilDue: "0" })).toHaveProperty("problem");
  });
});

describe("ops billing", () => {
  it("shows each client's period with our cost, and saves the settings", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/billing": () => BILLING,
      "PUT /api/ops/billing/settings": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return SETTINGS;
      },
    });
    renderAt("/ops/billing", api);
    const demo = await screen.findByTestId(`ops-billing-row-${DEMO}`);
    expect(demo).toHaveTextContent("$500.00");
    expect(demo).toHaveTextContent("4,312");
    expect(demo).toHaveTextContent("4,000");
    expect(demo).toHaveTextContent("312");
    expect(demo).toHaveTextContent("$43.12");
    expect(demo).toHaveTextContent("Payment failed");
    const sandbox = screen.getByTestId(`ops-billing-row-${SANDBOX}`);
    expect(sandbox).toHaveTextContent("$0.0003");
    expect(within(sandbox).getByRole("button", { name: "Set up billing" })).toBeEnabled();
    expect(screen.getByTestId("ops-billing-stripe-status")).toHaveTextContent(/webhook secret/);
    expect(screen.getByTestId("ops-billing-settings")).toHaveTextContent(
      "$250.00 a month per active agent, extra credits $0.015 each",
    );
    // A priced measure the rollup doesn't have yet says so.
    expect(screen.getByTestId("ops-billing-cost-call_seconds")).toHaveTextContent(
      "Counts once usage has it",
    );

    const allowance = screen.getByTestId("ops-billing-allowance");
    await userEvent.clear(allowance);
    await userEvent.type(allowance, "2500");
    await userEvent.click(screen.getByRole("button", { name: "Price this measure" }));
    const added = await screen.findByTestId("ops-billing-cost-runs");
    const costInput = within(added).getByLabelText("Cost of runs");
    await userEvent.clear(costInput);
    await userEvent.type(costInput, "0.0010");
    await userEvent.click(screen.getByTestId("ops-billing-save"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      allowanceCreditsPerAgent: 2500,
      basePriceId: "price_base",
      unitCosts: [
        { measure: "cost_usd", unitCost: "1.0000", perUnits: 1 },
        { measure: "call_seconds", unitCost: "0.1000", perUnits: 60 },
        { measure: "runs", unitCost: "0.0010", perUnits: 1 },
      ],
    });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("refuses a bad amount in the form without calling the API", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/billing": () => BILLING,
    });
    renderAt("/ops/billing", api);
    const input = await screen.findByLabelText("Cost of cost_usd");
    await userEvent.clear(input);
    await userEvent.type(input, "1.5e3");
    await userEvent.click(screen.getByTestId("ops-billing-save"));
    expect(await screen.findByText(/dollar amount with up to 4 places/)).toBeInTheDocument();
    expect(api.calls).not.toContain("PUT /api/ops/billing/settings");
  });

  it("sets a client up from the list and shows Stripe's refusal", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/billing": () => BILLING,
      [`POST /api/ops/billing/clients/${SANDBOX}/setup`]: () =>
        new Reply(502, { error: { code: "stripe_error", message: "Stripe: card declined" } }),
    });
    renderAt("/ops/billing", api);
    await userEvent.click(await screen.findByTestId(`ops-billing-setup-${SANDBOX}`));
    expect(await screen.findByText("Stripe: card declined")).toBeInTheDocument();
    expect(api.calls).toContain(`POST /api/ops/billing/clients/${SANDBOX}/setup`);
  });
});

describe("the client page's billing", () => {
  const detail = (over: Record<string, unknown>) => ({
    stripeConfigured: true,
    client: client(SANDBOX, "Sandbox", over),
    reports: [],
    invoices: [],
    invoicesUnavailable: false,
    events: [],
  });

  it("sets up a client with its billing email", async () => {
    const bodies: unknown[] = [];
    let setUp = false;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/billing/clients/${SANDBOX}`]: () =>
        detail(setUp ? { setUp: true, billedAgents: 2, subscriptionStatus: "active" } : {}),
      [`POST /api/ops/billing/clients/${SANDBOX}/setup`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        setUp = true;
        return client(SANDBOX, "Sandbox", { setUp: true });
      },
    });
    renderAt(`/ops/clients/${SANDBOX}`, api);
    const section = await screen.findByTestId("ops-client-billing");
    expect(section).toHaveTextContent("Not billed yet");
    await userEvent.type(screen.getByTestId("ops-client-billing-email"), "pay@sandbox.example.com");
    await userEvent.click(screen.getByTestId("ops-client-billing-setup"));
    await waitFor(() => expect(bodies).toEqual([{ email: "pay@sandbox.example.com" }]));
    expect(await screen.findByTestId("ops-client-billing-plan")).toHaveTextContent(
      "2 active agents · $500.00 a month",
    );
    expect(screen.getByTestId("ops-client-billing-cost")).toHaveTextContent("$43.12");
    const meter = within(screen.getByTestId("ops-client-billing-meter")).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuetext", "4,312 credits of 4,000 credits");
    expect(screen.getByTestId("ops-client-billing-meter")).toHaveTextContent(
      "312 credits over the allowance",
    );
  });

  it("lists the period's reports and the invoices with their links", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/billing/clients/${SANDBOX}`]: () => ({
        ...detail({ setUp: true, billedAgents: 2 }),
        reports: [
          {
            id: "00000000-0000-4000-8000-0000000e0001",
            day: "2026-11-03",
            agents: 2,
            allowance: 4000,
            credits: 4312,
            overage: 312,
            quantity: 12,
            costUsd: "43.1150",
            status: "failed",
            error: "Stripe could not be reached",
            sentAt: null,
          },
        ],
        invoices: [INVOICE],
      }),
    });
    renderAt(`/ops/clients/${SANDBOX}`, api);
    const reports = await screen.findByTestId("ops-client-billing-reports");
    expect(reports).toHaveTextContent("Nov 3, 2026");
    expect(reports).toHaveTextContent("Failed");
    const row = screen.getByTestId("ops-client-billing-invoices-row-in_1");
    expect(row).toHaveTextContent("$265.00");
    expect(row).toHaveTextContent("To pay");
    expect(within(row).getByRole("link", { name: "View and pay" })).toHaveAttribute(
      "href",
      INVOICE.hostedInvoiceUrl,
    );
    expect(within(row).getByRole("link", { name: "PDF" })).toHaveAttribute("href", INVOICE.pdfUrl);
  });
});
