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

    // A bar a day, each with its figure.
    expect(screen.getByText("Model cost by day")).toBeInTheDocument();
    expect(screen.getByTestId("ops-usage-chart-bar-2026-11-02")).toHaveAccessibleName(
      "Nov 2, 2026: $2.00, 2 runs",
    );
    // By vendor and by model, the model by its label.
    expect(screen.getByTestId("ops-usage-vendor-twilio")).toHaveTextContent(
      "Twilio (texts and WhatsApp)12 messagesabout $0.10",
    );
    expect(screen.getByTestId("ops-usage-vendor-anthropic")).toHaveTextContent("4 model calls");
    expect(await screen.findByText("Best (Opus)")).toBeInTheDocument();
    expect(screen.getByTestId("ops-usage-model-claude-opus-5-5")).toHaveTextContent("$2.30");
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
