// `/ops/usage`: cost and usage per client, client agent and template, by month; filters travel in
// the URL and the request; sub-cent costs stay visible; nothing is computed with floats.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { cost } from "../../usage/format";
import { usageRange } from "./Usage";

const SANDBOX = "00000000-0000-4000-8000-00000000a001";
const DEMO = "00000000-0000-4000-8000-00000000a002";
const TPL = "00000000-0000-4000-8000-0000000c1001";
const AGENT = "00000000-0000-4000-8000-0000000c2001";
const COPY = "00000000-0000-4000-8000-0000000c2002";

const fig = (costUsd: string, runs = 1, extra: Record<string, number> = {}) => ({
  runs,
  steps: runs * 2,
  documents: 0,
  externalActions: 0,
  tokensIn: 1000,
  tokensOut: 200,
  costUsd,
  ...extra,
});
const series = (oct: string, nov: string, total: string, runs = 2) => ({
  total: fig(total, runs),
  byMonth: [
    { month: "2026-10", figures: fig(oct, runs / 2) },
    { month: "2026-11", figures: fig(nov, runs / 2) },
  ],
});

const REPORT = {
  from: "2026-10-01",
  to: "2026-11-03",
  months: ["2026-10", "2026-11"],
  total: fig("12.3456", 6, { documents: 4, externalActions: 3 }),
  byMonth: [
    { month: "2026-10", figures: fig("10.0000", 3) },
    { month: "2026-11", figures: fig("2.3456", 3) },
  ],
  clients: [
    { id: DEMO, name: "Demo client", ...series("10.0000", "2.3453", "12.3453") },
    { id: SANDBOX, name: "Sandbox", ...series("0.0000", "0.0003", "0.0003") },
  ],
  agents: [
    {
      id: AGENT,
      slug: "records",
      name: "Records clerk",
      client: { id: DEMO, name: "Demo client" },
      template: { id: TPL, slug: "records", name: "Records template" },
      testCopy: false,
      ...series("10.0000", "2.3453", "12.3453"),
    },
    {
      id: COPY,
      slug: "records-test",
      name: "Records clerk (test)",
      client: { id: SANDBOX, name: "Sandbox" },
      template: { id: TPL, slug: "records", name: "Records template" },
      testCopy: true,
      ...series("0.0000", "0.0003", "0.0003"),
    },
  ],
  templates: [
    {
      id: TPL,
      slug: "records",
      name: "Records template",
      clients: 2,
      agents: 2,
      ...series("10.0000", "2.3456", "12.3456"),
    },
  ],
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

describe("ops usage", () => {
  it("shows the totals, the months and cost per client by month", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/usage": ({ url }) => {
        queries.push(url.searchParams);
        return REPORT;
      },
    });
    renderAt("/ops/usage", api);
    expect(await screen.findByTestId("ops-usage-cost")).toHaveTextContent("$12.35");
    expect(screen.getByTestId("ops-usage-cost")).toHaveTextContent("$2.35 in Nov 2026");
    expect(screen.getByTestId("ops-usage-runs")).toHaveTextContent("6");
    expect(screen.getByTestId("ops-usage-documents")).toHaveTextContent("4");
    expect(screen.getByTestId("ops-usage-documents")).toHaveTextContent("3 changes");
    expect(screen.getByTestId("ops-usage-tokens")).toHaveTextContent("1,2001,000 in, 200 out");
    // Newest month first.
    const months = within(screen.getByTestId("ops-usage-months")).getAllByRole("row");
    expect(months[1]).toHaveTextContent("Nov 2026");
    const sandbox = screen.getByTestId(`ops-usage-row-${SANDBOX}`);
    // A sub-cent cost is not shown as free.
    expect(sandbox).toHaveTextContent("$0.0003");
    expect(screen.getByTestId(`ops-usage-row-${DEMO}`)).toHaveTextContent("$12.35");
    // The default range is six months, up to today.
    const { from, to } = usageRange("6m");
    expect(queries[0]?.get("from")).toBe(from);
    expect(queries[0]?.get("to")).toBe(to);
    expect(queries[0]?.has("client")).toBe(false);
  });

  it("groups by template, then shows that template's client agents", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/usage": ({ url }) => {
        queries.push(url.searchParams);
        return REPORT;
      },
    });
    renderAt("/ops/usage", api);
    await userEvent.click(await screen.findByTestId("ops-usage-view-filter-templates"));
    const row = await screen.findByTestId(`ops-usage-row-${TPL}`);
    expect(row).toHaveTextContent("2 client agents in 2 clients");
    await userEvent.click(within(row).getByTestId(`ops-usage-template-${TPL}`));
    await waitFor(() => expect(queries.at(-1)?.get("template")).toBe(TPL));
    expect(await screen.findByTestId(`ops-usage-row-${COPY}`)).toHaveTextContent("Test copy");
    expect(screen.getByTestId(`ops-usage-row-${AGENT}`)).toHaveTextContent("Demo client");
    expect(screen.getByText("Records template", { selector: "span.text-ink" })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("ops-usage-clear-template"));
    await waitFor(() => expect(queries.at(-1)?.has("template")).toBe(false));
  });

  it("filters by client and period from the URL", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/usage": ({ url }) => {
        queries.push(url.searchParams);
        return { ...REPORT, clients: REPORT.clients.slice(0, 1) };
      },
    });
    renderAt(`/ops/usage?client=${DEMO}&range=month`, api);
    await screen.findByTestId(`ops-usage-row-${DEMO}`);
    expect(queries[0]?.get("client")).toBe(DEMO);
    expect(queries[0]?.get("from")).toBe(usageRange("month").from);
    await userEvent.selectOptions(screen.getByTestId("ops-usage-client"), SANDBOX);
    await waitFor(() => expect(queries.at(-1)?.get("client")).toBe(SANDBOX));
    await userEvent.selectOptions(screen.getByTestId("ops-usage-range"), "12m");
    await waitFor(() => expect(queries.at(-1)?.get("from")).toBe(usageRange("12m").from));
  });

  it("says when there is no usage yet", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/usage": () => ({ ...REPORT, clients: [], agents: [], templates: [] }),
    });
    renderAt("/ops/usage", api);
    expect(await screen.findByText(/No usage in this period/)).toBeInTheDocument();
  });

  it("tallies tokens per client, and by agent, model and action", async () => {
    const queries: URLSearchParams[] = [];
    const tf = (calls: number, tokensIn: number, tokensOut: number, costUsd: string) => ({
      calls,
      tokensIn,
      tokensOut,
      costUsd,
    });
    const SLOAN = "00000000-0000-4000-8000-0000000c2003";
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/usage": () => REPORT,
      "GET /api/ops/usage/tokens": ({ url }) => {
        queries.push(url.searchParams);
        const demo = { id: DEMO, name: "Demo client" };
        const sloan = { id: SLOAN, slug: "supervisor", name: "Sloan", account: true };
        return {
          from: "2026-11-01",
          to: "2026-11-03",
          total: tf(6, 4080, 408, "0.0451"),
          rows: [
            {
              client: demo,
              agent: sloan,
              provider: "google",
              model: "google:gemini-3.1-pro",
              action: "question",
              ...tf(2, 3000, 300, "0.0400"),
            },
          ],
          byClient: [{ ...demo, ...tf(6, 4080, 408, "0.0451") }],
          byAgent: [
            { client: demo, agent: sloan, ...tf(2, 3000, 300, "0.0400") },
            { client: demo, agent: null, ...tf(4, 1080, 108, "0.0051") },
          ],
          byModel: [
            { provider: "google", model: "google:gemini-3.1-pro", ...tf(2, 3000, 300, "0.0400") },
            { provider: "xai", model: "xai:grok-4.7", ...tf(4, 1080, 108, "0.0051") },
          ],
          byAction: [
            { action: "question", ...tf(2, 3000, 300, "0.0400") },
            { action: "background_read", ...tf(3, 1000, 100, "0.0050") },
            { action: "background_translation", ...tf(1, 80, 8, "0.0001") },
          ],
        };
      },
    });
    renderAt(`/ops/usage?client=${DEMO}&template=${TPL}`, api);
    const byClient = await screen.findByTestId(`ops-usage-token-row-${DEMO}`);
    expect(byClient).toHaveTextContent("4,080");
    expect(byClient).toHaveTextContent("$0.05");
    expect(queries[0]?.get("client")).toBe(DEMO);
    expect(queries[0]?.get("template")).toBe(TPL);
    expect(queries[0]?.get("from")).toBe(usageRange("6m").from);

    await userEvent.click(screen.getByTestId("ops-usage-token-view-filter-agents"));
    const sloan = await screen.findByTestId(`ops-usage-token-row-${DEMO}:${SLOAN}`);
    expect(sloan).toHaveTextContent("Sloan");
    expect(sloan).toHaveTextContent("Account agent");
    expect(screen.getByTestId(`ops-usage-token-row-${DEMO}:`)).toHaveTextContent(
      "No agent (background use)",
    );

    await userEvent.click(screen.getByTestId("ops-usage-token-view-filter-models"));
    expect(await screen.findByTestId("ops-usage-token-row-xai:grok-4.7")).toHaveTextContent("xAI");

    await userEvent.click(screen.getByTestId("ops-usage-token-view-filter-actions"));
    expect(await screen.findByTestId("ops-usage-token-row-question")).toHaveTextContent(
      "Portal question",
    );
    expect(screen.getByTestId("ops-usage-token-row-background_read")).toHaveTextContent(
      "Background reading",
    );
    expect(screen.getByTestId("ops-usage-token-row-background_translation")).toHaveTextContent(
      "Background translation",
    );
  });

  it("formats cost from decimal strings", () => {
    expect(cost("0.0000")).toBe("$0.00");
    expect(cost("0.0003")).toBe("$0.0003");
    expect(cost("0.0100")).toBe("$0.01");
    expect(cost("1234.5650")).toBe("$1234.57");
    expect(usageRange("3m", new Date("2026-11-04T10:00:00Z"))).toEqual({
      from: "2026-09-01",
      to: "2026-11-04",
    });
  });

  it("knows every period, and a custom range", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    expect(usageRange("today", now)).toEqual({ from: "2026-11-04", to: "2026-11-04" });
    // 2026-11-04 is a Wednesday; weeks start on Monday.
    expect(usageRange("yesterday", now)).toEqual({ from: "2026-11-03", to: "2026-11-03" });
    expect(usageRange("week", now)).toEqual({ from: "2026-11-02", to: "2026-11-04" });
    expect(usageRange("lastweek", now)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    // On a Sunday, this week began six days before; last week is the one before that.
    const sunday = new Date("2026-11-08T12:00:00Z");
    expect(usageRange("week", sunday)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(usageRange("lastweek", sunday)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(usageRange("7d", now)).toEqual({ from: "2026-10-29", to: "2026-11-04" });
    expect(usageRange("mtd", now)).toEqual({ from: "2026-11-01", to: "2026-11-04" });
    expect(usageRange("month", now)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(usageRange("last", now)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(usageRange("12m", now)).toEqual({ from: "2025-12-01", to: "2026-11-04" });
    expect(usageRange("custom", now, { from: "2026-10-05", to: "2026-10-20" })).toEqual({
      from: "2026-10-05",
      to: "2026-10-20",
    });
    // A backwards or missing end falls back to month to date.
    expect(usageRange("custom", now, { from: "2026-10-20", to: "2026-10-05" })).toEqual({
      from: "2026-11-01",
      to: "2026-11-04",
    });
  });

  it("asks for a custom range from the URL and changes its ends", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/usage": ({ url }) => {
        queries.push(url.searchParams);
        return REPORT;
      },
    });
    renderAt("/ops/usage?range=custom&from=2026-10-05&to=2026-10-20", api);
    await screen.findByTestId("ops-usage-cost");
    expect(queries[0]?.get("from")).toBe("2026-10-05");
    expect(queries[0]?.get("to")).toBe("2026-10-20");
    const to = screen.getByTestId("ops-usage-to");
    expect(to).toHaveValue("2026-10-20");
    fireEvent.change(to, { target: { value: "2026-10-25" } });
    await waitFor(() => expect(queries.at(-1)?.get("to")).toBe("2026-10-25"));
    await userEvent.selectOptions(screen.getByTestId("ops-usage-range"), "7d");
    await waitFor(() => expect(queries.at(-1)?.get("from")).toBe(usageRange("7d").from));
  });

  it("hides rows with nothing in them until Show all, charts the cost and splits it", async () => {
    const zero = fig("0.0000", 0, { steps: 0, tokensIn: 0, tokensOut: 0 });
    const idle = {
      id: "00000000-0000-4000-8000-00000000a003",
      name: "Idle client",
      total: zero,
      byMonth: [
        { month: "2026-10", figures: zero },
        { month: "2026-11", figures: zero },
      ],
    };
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/models": () => ({
        models: [
          { id: "claude-opus-5-5", label: "Best (Opus)", inputPerMtok: "5", outputPerMtok: "25" },
        ],
      }),
      "GET /api/ops/usage": () => ({
        ...REPORT,
        byMonth: [{ month: "2026-10", figures: zero }, REPORT.byMonth[1]],
        clients: [...REPORT.clients, idle],
        byDay: [
          { day: "2026-10-01", figures: zero },
          { day: "2026-11-02", figures: fig("2.0000", 2) },
          { day: "2026-11-03", figures: fig("0.3456", 1) },
        ],
        byModel: [
          {
            provider: "anthropic",
            model: "claude-opus-5-5",
            calls: 4,
            tokensIn: 1000,
            tokensOut: 200,
            costUsd: "2.3000",
          },
        ],
        byVendor: [
          {
            id: "anthropic",
            name: "Anthropic",
            costUsd: "2.3000",
            estimated: false,
            calls: 4,
          },
          {
            id: "twilio",
            name: "Twilio (texts and WhatsApp)",
            costUsd: "0.0996",
            estimated: true,
            messages: 12,
          },
        ],
      }),
    });
    renderAt("/ops/usage", api);
    await screen.findByTestId(`ops-usage-row-${DEMO}`);
    // The idle client and the empty October are hidden, and the toggle says so.
    expect(screen.queryByTestId(`ops-usage-row-${idle.id}`)).toBeNull();
    const months = within(screen.getByTestId("ops-usage-months")).getAllByRole("row");
    expect(months).toHaveLength(2);
    expect(screen.getByTestId("ops-usage-show-all").closest("label")).toHaveTextContent(
      "Show all (2 empty rows hidden)",
    );
    await userEvent.click(screen.getByTestId("ops-usage-show-all"));
    expect(await screen.findByTestId(`ops-usage-row-${idle.id}`)).toBeInTheDocument();
    expect(within(screen.getByTestId("ops-usage-months")).getAllByRole("row")).toHaveLength(3);

    // Feedback (2026-11-16): a line by day, from the first day with usage, each day read by
    // pointer or by the arrow keys.
    expect(screen.getByText("Model cost by day")).toBeInTheDocument();
    expect(screen.getByText("From 2 Nov 2026, the first day with usage")).toBeInTheDocument();
    const plot = screen.getByTestId("ops-usage-chart-plot");
    expect(plot).toHaveAccessibleName(
      "Model cost by day, 2 Nov 2026 to 3 Nov 2026, highest $2.00 on 2 Nov 2026. Use the arrow keys to read each day.",
    );
    expect(screen.getByTestId("ops-usage-chart-path")).toBeInTheDocument();
    plot.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("ops-usage-chart-readout")).toHaveTextContent(
      "$2.00 · 2 runs · 2 Nov 2026",
    );
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("ops-usage-chart-readout")).toHaveTextContent("$0.35 · 1 run");
    // By vendor and by model, the model by its label.
    expect(screen.getByTestId("ops-usage-vendor-twilio")).toHaveTextContent(
      "Twilio (texts and WhatsApp)12 messagesabout $0.10",
    );
    expect(screen.getByTestId("ops-usage-vendor-anthropic")).toHaveTextContent("4 model calls");
    expect(await screen.findByText("Best (Opus)")).toBeInTheDocument();
    expect(screen.getByTestId("ops-usage-model-claude-opus-5-5")).toHaveTextContent("$2.30");
  });

  // QA (usage costs, 2026-11-22): the tables add up to the Model cost tile, the back office's spend
  // is a row of its own, fees are not model cost, and a model with no price says so.
  it("adds the back office as its own row, totals the table and flags calls with no price", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/models": () => ({ models: [] }),
      "GET /api/ops/usage": () => ({
        ...REPORT,
        total: fig("12.4056", 6),
        byMonth: [
          { month: "2026-10", figures: fig("10.0000", 3) },
          { month: "2026-11", figures: fig("2.4056", 3) },
        ],
        backOffice: {
          ...series("0.0000", "0.0600", "0.0600", 0),
          lines: [
            { id: "reggie", answers: 2, costUsd: "0.0100" },
            { id: "builder", answers: 1, costUsd: "0.0500" },
          ],
        },
        byModel: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
            calls: 30,
            tokensIn: 9000,
            tokensOut: 900,
            costUsd: "0.0000",
            unpricedCalls: 30,
          },
          { provider: "", model: "", calls: 0, tokensIn: 50, tokensOut: 5, costUsd: "0.0100" },
        ],
        byVendor: [
          {
            id: "provider_fees",
            name: "Twilio fees (texting registration)",
            costUsd: "35.5000",
            estimated: false,
            fees: 4,
          },
        ],
      }),
    });
    renderAt("/ops/usage", api);
    const office = await screen.findByTestId("ops-usage-row-back-office");
    expect(office).toHaveTextContent("Back office");
    expect(office).toHaveTextContent("Reggie $0.01 · The Builder $0.05, not part of any client");
    expect(office).toHaveTextContent("$0.06");
    // The clients and the back office add up to the tile.
    expect(screen.getByTestId("ops-usage-row-total")).toHaveTextContent("Total");
    expect(screen.getByTestId("ops-usage-row-total")).toHaveTextContent("$12.41");
    expect(screen.getByTestId("ops-usage-cost")).toHaveTextContent("$12.41");
    // A dated model id with no price is flagged, not a silent $0.00.
    const sonnet = screen.getByTestId("ops-usage-model-claude-sonnet-4-5-20250929");
    expect(sonnet).toHaveTextContent("30 calls had no price, so they count as $0.00");
    expect(sonnet).toHaveTextContent("No price");
    expect(screen.getByTestId("ops-usage-model-unrecorded")).toHaveTextContent(
      "Not itemised by model",
    );
    // Fees are money we paid, beside the model cost, never in it.
    expect(screen.getByTestId("ops-usage-vendor-provider_fees")).toHaveTextContent(
      "Twilio fees (texting registration)4 fees$35.50",
    );
    expect(
      screen.getByText(
        "What the work cost us. Fees and estimates are not in the model cost; unit costs are unverified.",
      ),
    ).toBeInTheDocument();
  });

  it("shows what the other vendors cost beside each row's model cost (§1.210)", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/usage": () => ({
        ...REPORT,
        total: { ...REPORT.total, servicesUsd: "0.3198" },
        clients: [
          {
            ...REPORT.clients[0],
            total: { ...REPORT.clients[0]?.total, servicesUsd: "0.3198" },
          },
          ...REPORT.clients.slice(1),
        ],
        byVendor: [
          { id: "resend", name: "Resend (email)", costUsd: "0.0018", estimated: true, emails: 2 },
          {
            id: "browser_run",
            name: "Browser Run (website logins)",
            costUsd: "0.0023",
            estimated: true,
            browserSeconds: 91,
          },
          {
            id: "twilio_verify",
            name: "Twilio Verify (sign-in codes)",
            costUsd: "0.0500",
            estimated: true,
            verifications: 1,
          },
          {
            id: "plaid",
            name: "Plaid (bank feeds)",
            costUsd: "0.3000",
            estimated: true,
            bankItemMonths: 1,
          },
        ],
      }),
    });
    renderAt("/ops/usage", api);
    const demo = await screen.findByTestId(`ops-usage-row-${DEMO}`);
    expect(demo).toHaveTextContent("$12.35$0.32");
    expect(screen.getByTestId("ops-usage-row-total")).toHaveTextContent("$0.32");
    expect(screen.getByTestId("ops-usage-vendor-resend")).toHaveTextContent("2 emails");
    expect(screen.getByTestId("ops-usage-vendor-browser_run")).toHaveTextContent(
      "2 minutes of browsing",
    );
    expect(screen.getByTestId("ops-usage-vendor-twilio_verify")).toHaveTextContent(
      "1 sign-in code",
    );
    expect(screen.getByTestId("ops-usage-vendor-plaid")).toHaveTextContent("1 bank month");
  });

  it("keeps billing a tab away", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/usage": () => REPORT,
    });
    renderAt("/ops/usage", api);
    await screen.findByTestId("ops-usage-cost");
    expect(
      within(screen.getByTestId("ops-usage")).getByRole("link", { name: "Billing" }),
    ).toHaveAttribute("href", "/ops/billing");
  });
});
