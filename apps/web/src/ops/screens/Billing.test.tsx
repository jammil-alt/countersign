// `/ops/billing`, the client page's billing section and an agent's price (docs/plan.md §1.32): the
// settings are saved as decimal strings (never floats) after the form checks them; each client's
// month so far shows with our cost; statements to review take adjustments, are sent or voided, and
// "Send all drafts" sends them; a client is set up with its email; an agent's own price needs a note.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { amountText, price } from "../../billing/parts";
import { fakeApi, OPERATOR_SESSION, Reply, SANDBOX_DETAIL } from "../../test/fixtures";
import { priceFromDraft } from "../agents/PricePanel";
import { settingsFromDraft } from "./Billing";
import { adjustmentFromDraft } from "./BillingStatement";
import { moneyTotal } from "./business";

const SANDBOX = "00000000-0000-4000-8000-00000000a001";
const DEMO = "00000000-0000-4000-8000-00000000a002";
const STATEMENT = "00000000-0000-4000-8000-0000000b5001";
const AGENT = "00000000-0000-4000-8000-0000000a9001";
const usd = (amount: string) => ({ amount, currency: "USD" });

const line = (over: Record<string, unknown>) => ({
  id: null,
  kind: "agent",
  agentId: AGENT,
  description: "Orders desk",
  amount: usd("100.0000"),
  days: 10,
  prices: [{ monthlyPrice: usd("300.0000"), days: 10 }],
  ...over,
});

const MONTH = {
  period: { start: "2026-11-01", end: "2026-11-30", through: "2026-11-04" },
  daysInMonth: 30,
  lines: [
    line({}),
    line({
      agentId: "x",
      description: "Account check",
      amount: usd("0.0000"),
      prices: [{ monthlyPrice: usd("0.0000"), days: 4 }],
      days: 4,
    }),
    line({
      kind: "usage",
      agentId: null,
      description: "Extra usage",
      amount: usd("6.2400"),
      days: null,
      prices: [],
    }),
  ],
  creditsUsed: 4312,
  creditsIncluded: 4000,
  extraCredits: 312,
  creditPrice: usd("0.0200"),
  total: usd("106.2400"),
};

function client(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    setUp: false,
    customerId: null,
    email: null,
    activeAgents: 2,
    monthSoFar: MONTH,
    costUsd: "43.1150",
    latestStatement: null,
    ...over,
  };
}

function statement(over: Record<string, unknown> = {}) {
  return {
    id: STATEMENT,
    period: { start: "2026-10-01", end: "2026-10-31" },
    status: "draft",
    total: usd("106.2400"),
    creditsUsed: 4312,
    creditsIncluded: 4000,
    extraCredits: 312,
    creditPrice: usd("0.0200"),
    lines: MONTH.lines.map((l, i) => ({ ...l, id: `00000000-0000-4000-8000-0000000c000${i}` })),
    invoiceNumber: null,
    hostedInvoiceUrl: null,
    pdfUrl: null,
    dueAt: null,
    sentAt: null,
    paidAt: null,
    clientId: DEMO,
    clientName: "Demo client",
    editable: true,
    sendStarted: false,
    sendError: null,
    stripeInvoiceId: null,
    voidedAt: null,
    createdAt: "2026-11-01T00:07:00.000Z",
    ...over,
  };
}

const SETTINGS = {
  defaultAgentPrice: "250.0000",
  defaultIncludedCredits: 2000,
  creditPrice: "0.0200",
  autoSend: false,
  daysUntilDue: 30,
  unitCosts: [
    { measure: "cost_usd", unitCost: "1.0000", perUnits: 1 },
    { measure: "call_seconds", unitCost: "0.1000", perUnits: 60 },
  ],
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
  templates: [
    {
      id: "00000000-0000-4000-8000-0000000d0001",
      slug: "orders-desk",
      name: "Orders desk",
      price: { monthlyPrice: usd("300.0000"), includedCredits: 3000 },
      effective: { monthlyPrice: usd("300.0000"), includedCredits: 3000, source: "template" },
    },
    {
      id: "00000000-0000-4000-8000-0000000d0002",
      slug: "supervisor",
      name: "Supervisor",
      price: null,
      effective: { monthlyPrice: usd("0.0000"), includedCredits: 0, source: "platform" },
    },
  ],
  clients: [
    client(DEMO, "Demo client", {
      setUp: true,
      customerId: "cus_1",
      latestStatement: {
        id: STATEMENT,
        period: "2026-10-01",
        status: "payment_failed",
        total: usd("1.0000"),
      },
    }),
    client(SANDBOX, "Sandbox", { costUsd: "0.0003" }),
  ],
  toReview: [statement()],
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
  it("keep fractions of a cent, signs and thousands, without floats", () => {
    expect(amountText("250.0000")).toBe("250.00");
    expect(amountText("0.0150")).toBe("0.015");
    expect(amountText("1234567.5000")).toBe("1,234,567.50");
    expect(price(usd("0.0125"))).toBe("$0.0125");
    expect(price(usd("-15.0000"))).toBe("-$15.00");
    expect(price({ amount: "12.0000", currency: "EUR" })).toBe("12.00 EUR");
  });

  it("are checked before they are sent: decimal strings, whole units, whole cents", () => {
    const draft = {
      defaultAgentPrice: "$250",
      defaultIncludedCredits: "2000",
      creditPrice: "0.02",
      autoSend: true,
      daysUntilDue: "30",
      unitCosts: [{ measure: "cost_usd", unitCost: "1.25", perUnits: "1" }],
    };
    expect(settingsFromDraft(draft)).toEqual({
      settings: {
        defaultAgentPrice: "250",
        defaultIncludedCredits: 2000,
        creditPrice: "0.02",
        autoSend: true,
        daysUntilDue: 30,
        unitCosts: [{ measure: "cost_usd", unitCost: "1.25", perUnits: 1 }],
      },
    });
    expect(settingsFromDraft({ ...draft, defaultIncludedCredits: "20.5" })).toHaveProperty(
      "problem",
    );
    expect(settingsFromDraft({ ...draft, creditPrice: "0.00001" })).toHaveProperty("problem");
    expect(settingsFromDraft({ ...draft, defaultAgentPrice: "-1" })).toHaveProperty("problem");
    expect(settingsFromDraft({ ...draft, daysUntilDue: "0" })).toHaveProperty("problem");
    expect(adjustmentFromDraft(" Credit ", "-$15")).toEqual({
      description: "Credit",
      amount: "-15",
    });
    expect(adjustmentFromDraft("Credit", "0.00")).toHaveProperty("problem");
    expect(adjustmentFromDraft("Credit", "1.234")).toHaveProperty("problem");
    expect(adjustmentFromDraft("", "5")).toHaveProperty("problem");
    expect(priceFromDraft("249.50", "3000")).toEqual({
      monthlyPrice: "249.50",
      includedCredits: 3000,
    });
    expect(priceFromDraft("2.5e2", "3000")).toHaveProperty("problem");
  });
});

describe("ops billing", () => {
  it("shows each client's month so far with our cost, template prices, and saves the settings", async () => {
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
    // The first test here loads the back office's lazy chunk, which can take over a second on a busy machine.
    const demo = await screen.findByTestId(`ops-billing-row-${DEMO}`, {}, { timeout: 10_000 });
    expect(demo).toHaveTextContent("$106.24");
    expect(demo).toHaveTextContent("4,312");
    expect(demo).toHaveTextContent("4,000");
    expect(demo).toHaveTextContent("312");
    expect(demo).toHaveTextContent("$43.12");
    expect(demo).toHaveTextContent("Payment failed");
    const sandbox = screen.getByTestId(`ops-billing-row-${SANDBOX}`);
    expect(sandbox).toHaveTextContent("$0.0003");
    expect(within(sandbox).getByRole("link", { name: "Set up on its page" })).toHaveAttribute(
      "href",
      `/ops/clients/${SANDBOX}`,
    );
    expect(screen.getByTestId("ops-billing-stripe-status")).toHaveTextContent(/webhook secret/);
    expect(screen.getByTestId("ops-billing-template-orders-desk")).toHaveTextContent("$300.00");
    expect(screen.getByTestId("ops-billing-template-supervisor")).toHaveTextContent(
      "Platform agent, free",
    );
    expect(screen.getByTestId("ops-billing-cost-call_seconds")).toHaveTextContent(
      "Counts once usage has it",
    );

    const credits = screen.getByTestId("ops-billing-allowance");
    await userEvent.clear(credits);
    await userEvent.type(credits, "2500");
    const creditPrice = screen.getByTestId("ops-billing-credit-price");
    await userEvent.clear(creditPrice);
    await userEvent.type(creditPrice, "0.025");
    await userEvent.click(screen.getByTestId("ops-billing-auto-send"));
    await userEvent.click(screen.getByRole("button", { name: "Price this measure" }));
    const added = await screen.findByTestId("ops-billing-cost-runs");
    const costInput = within(added).getByLabelText("Cost of runs");
    await userEvent.clear(costInput);
    await userEvent.type(costInput, "0.0010");
    await userEvent.click(screen.getByTestId("ops-billing-save"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      defaultAgentPrice: "250.0000",
      defaultIncludedCredits: 2500,
      creditPrice: "0.025",
      autoSend: true,
      daysUntilDue: 30,
      unitCosts: [
        { measure: "cost_usd", unitCost: "1.0000", perUnits: 1 },
        { measure: "call_seconds", unitCost: "0.1000", perUnits: 60 },
        { measure: "runs", unitCost: "0.0010", perUnits: 1 },
      ],
    });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("adds up the month across clients in decimals and moves to Usage by its tab", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/billing": () => BILLING,
    });
    renderAt("/ops/billing", api);
    const total = await screen.findByTestId("ops-billing-month-total", {}, { timeout: 5000 });
    // 106.24 + 106.24, and 43.1150 + 0.0003 of our cost: no float drift.
    expect(total).toHaveTextContent("$212.48");
    expect(total).toHaveTextContent("across 2 clients");
    expect(screen.getByTestId("ops-billing-our-cost")).toHaveTextContent("$43.12");
    expect(screen.getByTestId("ops-billing-to-review")).toHaveTextContent("Drafts waiting on you");
    expect(screen.getByTestId("ops-billing-failed")).toHaveTextContent("1 of 2 clients set up");
    await userEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(await screen.findByTestId("ops-usage")).toBeInTheDocument();
  });

  it("adds money per currency, never as floats", () => {
    expect(moneyTotal([])).toBe("$0.00");
    expect(moneyTotal([usd("0.1000"), usd("0.2000")])).toBe("$0.30");
    expect(moneyTotal([usd("1.0000"), { amount: "2.5000", currency: "EUR" }])).toBe(
      "$1.00 + 2.50 EUR",
    );
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

  it("reviews a draft: its lines, an adjustment, and sending it", async () => {
    const bodies: unknown[] = [];
    let current = statement();
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/billing": () => ({ ...BILLING, toReview: [current] }),
      [`POST /api/ops/billing/statements/${STATEMENT}/adjustments`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        current = statement({
          total: usd("91.2400"),
          lines: [
            ...statement().lines,
            line({
              id: "00000000-0000-4000-8000-0000000c0009",
              kind: "adjustment",
              agentId: null,
              description: "Credit for a slow week",
              amount: usd("-15.0000"),
              days: null,
              prices: [],
            }),
          ],
        });
        return current;
      },
      [`POST /api/ops/billing/statements/${STATEMENT}/send`]: () => {
        current = statement({
          status: "sent",
          editable: false,
          sendStarted: true,
          invoiceNumber: "MZ-0001",
          sentAt: "2026-11-05T10:00:00.000Z",
          hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/in_1",
          pdfUrl: "https://pay.stripe.com/invoice/acct/in_1/pdf",
        });
        return current;
      },
    });
    renderAt("/ops/billing", api);
    const card = await screen.findByTestId(`ops-statement-${STATEMENT}`, {}, { timeout: 5000 });
    expect(card).toHaveTextContent("Demo client · October 2026");
    const lines = within(card).getByTestId(`ops-statement-${STATEMENT}-lines`);
    expect(lines).toHaveTextContent("$300.00 a month · 10 of 31 days");
    expect(lines).toHaveTextContent("Included");
    expect(lines).toHaveTextContent("312 credits past the 4,000 included (4,312 used), $0.02 each");
    expect(within(lines).getByTestId(`ops-statement-${STATEMENT}-lines-total`)).toHaveTextContent(
      "$106.24",
    );
    await userEvent.type(
      within(card).getByTestId(`ops-statement-${STATEMENT}-adjust-description`),
      "Credit for a slow week",
    );
    await userEvent.type(
      within(card).getByTestId(`ops-statement-${STATEMENT}-adjust-amount`),
      "-15",
    );
    await userEvent.click(within(card).getByTestId(`ops-statement-${STATEMENT}-adjust`));
    await waitFor(() =>
      expect(screen.getByTestId(`ops-statement-${STATEMENT}-total`)).toHaveTextContent("$91.24"),
    );
    expect(bodies).toEqual([{ description: "Credit for a slow week", amount: "-15" }]);
    expect(screen.getByText("-$15.00")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId(`ops-statement-${STATEMENT}-send`));
    await waitFor(() =>
      expect(screen.getByTestId(`ops-statement-${STATEMENT}`)).toHaveTextContent("To pay"),
    );
    expect(screen.getByTestId(`ops-statement-${STATEMENT}`)).toHaveTextContent("Invoice MZ-0001");
    expect(screen.queryByTestId(`ops-statement-${STATEMENT}-send`)).toBeNull();
  });

  it("says why a send stopped, and sends every draft at once", async () => {
    const stopped = statement({
      editable: false,
      sendStarted: true,
      sendError: "Stripe: the fake was told to fail",
      stripeInvoiceId: "in_1",
    });
    let sent = false;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/billing": () => ({ ...BILLING, toReview: sent ? [] : [stopped] }),
      "POST /api/ops/billing/statements/send-drafts": () => {
        sent = true;
        return {
          results: [{ statementId: STATEMENT, clientId: DEMO, status: "sent", error: null }],
        };
      },
    });
    renderAt("/ops/billing", api);
    expect(
      await screen.findByTestId(`ops-statement-${STATEMENT}-error`, {}, { timeout: 5000 }),
    ).toHaveTextContent("the fake was told to fail");
    expect(screen.getByTestId(`ops-statement-${STATEMENT}-send`)).toHaveTextContent("Send again");
    // Stripe has it: no adjustments, no void.
    expect(screen.queryByTestId(`ops-statement-${STATEMENT}-adjust`)).toBeNull();
    expect(screen.queryByTestId(`ops-statement-${STATEMENT}-void`)).toBeNull();
    await userEvent.click(screen.getByTestId("ops-billing-send-all"));
    expect(await screen.findByTestId("ops-billing-send-all-result")).toHaveTextContent(
      "1 statement sent.",
    );
    expect(await screen.findByText(/Nothing to review/)).toBeInTheDocument();
  });

  it("shows Stripe's refusal of a void", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/billing": () => BILLING,
      [`POST /api/ops/billing/statements/${STATEMENT}/void`]: () =>
        new Reply(409, {
          error: {
            code: "not_editable",
            message: "only a draft that hasn't gone to Stripe can change",
          },
        }),
    });
    renderAt("/ops/billing", api);
    await userEvent.click(
      await screen.findByTestId(`ops-statement-${STATEMENT}-void`, {}, { timeout: 5000 }),
    );
    expect(await screen.findByText(/only a draft that hasn't gone to Stripe/)).toBeInTheDocument();
  });
});

describe("the client page's billing", () => {
  const detail = (over: Record<string, unknown>) => ({
    stripeConfigured: true,
    client: client(SANDBOX, "Sandbox", over),
    agents: [
      {
        agentId: AGENT,
        slug: "orders",
        name: "Orders desk",
        runStatus: "active",
        price: { monthlyPrice: usd("280.0000"), includedCredits: 3000, source: "override" },
        override: {
          monthlyPrice: usd("280.0000"),
          includedCredits: 3000,
          note: "First-year discount",
          setBy: "Operator",
          setAt: "2026-11-01T00:00:00.000Z",
        },
        template: { id: "00000000-0000-4000-8000-0000000d0001", name: "Orders desk" },
      },
    ],
    statements: [],
    events: [],
  });

  it("sets up a client with its billing email, then shows prices and the month so far", async () => {
    const bodies: unknown[] = [];
    let setUp = false;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/billing/clients/${SANDBOX}`]: () =>
        detail(setUp ? { setUp: true, email: "pay@sandbox.example.com" } : {}),
      [`POST /api/ops/billing/clients/${SANDBOX}/setup`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        setUp = true;
        return client(SANDBOX, "Sandbox", { setUp: true });
      },
    });
    renderAt(`/ops/clients/${SANDBOX}`, api);
    const section = await screen.findByTestId("ops-client-billing");
    expect(section).toHaveTextContent("Not billed yet");
    const agentRow = screen.getByTestId(`ops-client-billing-agent-${AGENT}`);
    expect(agentRow).toHaveTextContent("$280.00");
    expect(agentRow).toHaveTextContent("Own price · First-year discount");
    expect(within(agentRow).getByRole("link", { name: "Change" })).toHaveAttribute(
      "href",
      `/ops/clients/${SANDBOX}/agents/orders/settings`,
    );
    await userEvent.type(screen.getByTestId("ops-client-billing-email"), "pay@sandbox.example.com");
    await userEvent.click(screen.getByTestId("ops-client-billing-setup"));
    await waitFor(() => expect(bodies).toEqual([{ email: "pay@sandbox.example.com" }]));
    expect(await screen.findByTestId("ops-client-billing-setup-done")).toHaveTextContent(
      "invoices go to pay@sandbox.example.com",
    );
    expect(screen.getByTestId("ops-client-billing-cost")).toHaveTextContent("$43.12");
    const meter = within(screen.getByTestId("ops-client-billing-meter")).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuetext", "4,312 credits of 4,000 credits");
    expect(screen.getByTestId("ops-client-billing-month")).toHaveTextContent("Total so far");
  });

  it("lists the statements with Stripe's links", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/billing/clients/${SANDBOX}`]: () => ({
        ...detail({ setUp: true }),
        statements: [
          statement({
            status: "paid",
            editable: false,
            sendStarted: true,
            invoiceNumber: "MZ-0001",
            paidAt: "2026-11-10T00:00:00.000Z",
            hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/in_1",
            pdfUrl: "https://pay.stripe.com/invoice/acct/in_1/pdf",
          }),
        ],
      }),
    });
    renderAt(`/ops/clients/${SANDBOX}`, api);
    const card = await screen.findByTestId(`ops-statement-${STATEMENT}`);
    expect(card).toHaveTextContent("Paid");
    expect(card).toHaveTextContent("paid Nov 10, 2026");
    expect(within(card).getByRole("link", { name: "Stripe's page" })).toHaveAttribute(
      "href",
      "https://invoice.stripe.com/i/acct/in_1",
    );
    expect(within(card).getByRole("link", { name: "PDF" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Send/ })).toBeNull();
  });
});

describe("an agent's price", () => {
  const PRICE = {
    agentId: AGENT,
    kind: "client",
    price: { monthlyPrice: usd("300.0000"), includedCredits: 3000, source: "template" },
    own: null,
    template: {
      id: "00000000-0000-4000-8000-0000000d0001",
      name: "Orders desk",
      price: { monthlyPrice: usd("300.0000"), includedCredits: 3000 },
    },
    defaults: { monthlyPrice: usd("250.0000"), includedCredits: 2000 },
    history: [],
  };

  it("needs a note for a client agent's own price, and sends decimal strings", async () => {
    const { PricePanel } = await import("../agents/PricePanel");
    const bodies: unknown[] = [];
    const api = fakeApi({
      [`GET /api/ops/billing/agents/${AGENT}/price`]: () => PRICE,
      [`PUT /api/ops/billing/agents/${AGENT}/price`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          ...PRICE,
          price: { monthlyPrice: usd("249.5000"), includedCredits: 3000, source: "override" },
          own: {
            monthlyPrice: usd("249.5000"),
            includedCredits: 3000,
            note: "First-year discount",
            setBy: "Operator",
            setAt: "2026-11-05T00:00:00.000Z",
          },
        };
      },
    });
    render(
      <MemoryRouter>
        <AppProviders client={api.client}>
          <PricePanel agent={{ id: AGENT, kind: "client" } as never} />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("agent-price-current")).toHaveTextContent(
      "$300.00 a month, 3,000 credits included · Template's price",
    );
    await userEvent.click(screen.getByTestId("agent-price-edit"));
    const monthly = screen.getByTestId("agent-price-monthly");
    await userEvent.clear(monthly);
    await userEvent.type(monthly, "249.50");
    await userEvent.click(screen.getByTestId("agent-price-save"));
    expect(await screen.findByText(/Say why this agent's price differs/)).toBeInTheDocument();
    expect(bodies).toEqual([]);
    await userEvent.type(screen.getByTestId("agent-price-note"), "First-year discount");
    await userEvent.click(screen.getByTestId("agent-price-save"));
    await waitFor(() =>
      expect(bodies).toEqual([
        { price: { monthlyPrice: "249.50", includedCredits: 3000 }, note: "First-year discount" },
      ]),
    );
  });
});
