// `/ops/usage` (ARCHITECTURE §13, §15): usage and model cost per client, client agent and template,
// by month, for the clients this operator serves. Cost is operator-only; the portal never sees it.
// The filters live in the URL (`?client=`, `?template=`, `?view=`, `?range=`, `?from=&to=` for a
// custom range, `?all=1` to show empty rows) so a client page or a template can link straight to
// its usage. Drafted in the prototype's back-office style (no prototype screen; docs/ui-plan.md):
// the period's figures as stat tiles, the cost as a line by day (from the first day with usage),
// the chosen grouping (rows with nothing in them hidden until "Show all"), the split by vendor and
// model, the tokens by client, agent, model and action (`?tokens=`, docs/plan.md §1.115), then the
// months.
import {
  BACK_OFFICE_SPEND_LABELS,
  dec,
  MODEL_PROVIDER_NAMES,
  type ModelProvider,
  providerModelName,
  UNRECORDED_MODEL,
  type UsageFigures,
  type UsageModelRow,
  type UsageReport,
  type UsageVendorRow,
} from "@countersign/core";
import { Link, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { useSession } from "../../session/session";
import { StatTile } from "../../ui/figures";
import { TextInput } from "../../ui/forms";
import { Columns, Loaded, Page, Section } from "../../ui/page";
import { Badge, Button, Card, EmptyState, PageHeader } from "../../ui/primitives";
import {
  cost,
  count,
  dayLabel,
  isoDay,
  monthEnd,
  monthLabel,
  monthStart,
  periodLabel,
  plural,
} from "../../usage/format";
import { type ChartPoint, fromFirstUsage, LineChart } from "../../usage/LineChart";
import { Select } from "../agents/ui";
import { BusinessTabs, TableCard } from "./business";
import { TOKEN_VIEWS, type TokenView, UsageTokens } from "./UsageTokens";

// UI cleanup: the periods people ask for, as well as whole months, and a custom range.
const RANGES = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["week", "This week"],
  ["lastweek", "Last week"],
  ["mtd", "Month to date"],
  ["month", "This month"],
  ["last", "Last month"],
  ["3m", "Last 3 months"],
  ["6m", "Last 6 months"],
  ["12m", "Last 12 months"],
  ["custom", "Custom range"],
] as const;
type RangeKey = (typeof RANGES)[number][0];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` `n` days after `day` (before, for negative `n`). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

const VIEWS = [
  ["clients", "Clients"],
  ["agents", "Client agents"],
  ["templates", "Templates"],
] as const;
type View = (typeof VIEWS)[number][0];

/** The Monday of `day`'s week (weeks run Monday to Sunday). */
function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** The range's days in UTC, as the rollup counts them. */
// DECISION: periods are UTC days like usage_daily; "This month" is the whole calendar month (its
// days to come show empty), "Month to date" stops today; "Last N months" are whole months back to
// today. Weeks run Monday to Sunday (ISO 8601): "This week" is Monday to today, "Last week" the
// whole week before (feedback, 2026-11-06). The default, six months, is the API's default too. A custom range with a missing or
// backwards end falls back to month to date.
export function usageRange(
  key: RangeKey,
  today: Date = new Date(),
  custom: { from?: string | null; to?: string | null } = {},
): { from: string; to: string } {
  const day = isoDay(today);
  switch (key) {
    case "today":
      return { from: day, to: day };
    case "yesterday": {
      const y = addDays(day, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: addDays(day, -6), to: day };
    case "30d":
      return { from: addDays(day, -29), to: day };
    case "week":
      return { from: weekStart(day), to: day };
    case "lastweek": {
      const from = addDays(weekStart(day), -7);
      return { from, to: addDays(from, 6) };
    }
    case "mtd":
      return { from: monthStart(day), to: day };
    case "month":
      return { from: monthStart(day), to: monthEnd(day) };
    case "last": {
      const from = monthStart(day, 1);
      return { from, to: monthEnd(from) };
    }
    case "3m":
      return { from: monthStart(day, 2), to: day };
    case "12m":
      return { from: monthStart(day, 11), to: day };
    case "custom": {
      const { from, to } = custom;
      if (from && to && DAY_RE.test(from) && DAY_RE.test(to) && from <= to) return { from, to };
      return { from: monthStart(day), to: day };
    }
    default:
      return { from: monthStart(day, 5), to: day };
  }
}

/** Nothing happened and nothing was spent: a row the table hides until "Show all". */
export function isEmptyFigures(f: UsageFigures): boolean {
  return (
    f.runs === 0 &&
    f.steps === 0 &&
    f.documents === 0 &&
    f.externalActions === 0 &&
    f.tokensIn === 0 &&
    f.tokensOut === 0 &&
    dec(f.costUsd).isZero() &&
    dec(f.servicesUsd ?? "0").isZero()
  );
}

const tokens = (f: UsageFigures) => count(f.tokensIn + f.tokensOut);

interface Row {
  key: string;
  name: React.ReactNode;
  sub?: React.ReactNode;
  total: UsageFigures;
  byMonth: UsageReport["byMonth"];
}

/**
 * QA (usage costs, 2026-11-22): the spend in the total that is no client agent's, as rows of their
 * own so the table adds up to the Model cost tile: the back office's (Reggie, the Builder, builds)
 * on Clients and Client agents, and the clients' own reading and translation on Client agents
 * (on Clients it is already in each client's row). Templates are a part of the whole: no rows.
 */
function otherRows(view: View, data: UsageReport): Row[] {
  if (view === "templates") return [];
  const out: Row[] = [];
  const bg = data.background;
  if (view === "agents" && bg && !isEmptyFigures(bg.total)) {
    out.push({
      key: "background",
      name: <span className="font-medium text-ink">No agent</span>,
      sub: (
        <span className="text-sm text-ink-muted">
          The clients' own reading and translation, no agent asked for
        </span>
      ),
      total: bg.total,
      byMonth: bg.byMonth,
    });
  }
  const office = data.backOffice;
  if (
    office &&
    !(dec(office.total.costUsd).isZero() && dec(office.total.servicesUsd ?? "0").isZero())
  ) {
    out.push({
      key: "back-office",
      name: <span className="font-medium text-ink">Back office</span>,
      sub: (
        <span className="text-sm text-ink-muted">
          {office.lines
            .map((l) => `${BACK_OFFICE_SPEND_LABELS[l.id]} ${cost(l.costUsd)}`)
            .join(" · ")}
          , not part of any client
        </span>
      ),
      total: office.total,
      byMonth: office.byMonth,
    });
  }
  return out;
}

function rowsFor(view: View, data: UsageReport, onTemplate: (id: string) => void): Row[] {
  if (view === "clients") {
    return data.clients.map((c) => ({
      key: c.id,
      name: (
        <Link to={`/ops/clients/${c.id}`} className="font-medium text-ink hover:underline">
          {c.name}
        </Link>
      ),
      total: c.total,
      byMonth: c.byMonth,
    }));
  }
  if (view === "agents") {
    return data.agents.map((a) => ({
      key: a.id,
      name: (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to={`/ops/clients/${a.client.id}/agents/${a.slug}`}
            className="font-medium text-ink hover:underline"
          >
            {a.name}
          </Link>
          {a.testCopy ? <Badge>Test copy</Badge> : null}
        </span>
      ),
      sub: (
        <span className="text-sm text-ink-muted">
          {a.client.name}
          {" · "}
          {a.template ? (
            <button
              type="button"
              className="hover:text-ink hover:underline"
              onClick={() => onTemplate(a.template?.id ?? "")}
            >
              {a.template.name}
            </button>
          ) : (
            "Built for this client"
          )}
        </span>
      ),
      total: a.total,
      byMonth: a.byMonth,
    }));
  }
  return data.templates.map((t) => ({
    key: t.id,
    name: (
      <button
        type="button"
        data-testid={`ops-usage-template-${t.id}`}
        className="font-medium text-ink hover:underline"
        onClick={() => onTemplate(t.id)}
      >
        {t.name}
      </button>
    ),
    sub: (
      <span className="text-sm text-ink-muted">
        {t.agents === 1 ? "1 client agent" : `${t.agents} client agents`} in{" "}
        {t.clients === 1 ? "1 client" : `${t.clients} clients`}
      </span>
    ),
    total: t.total,
    byMonth: t.byMonth,
  }));
}

export function OpsUsageScreen() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find(([v]) => v === params.get("view"))?.[0] ?? "clients") as View;
  const range = (RANGES.find(([k]) => k === params.get("range"))?.[0] ?? "6m") as RangeKey;
  const client = params.get("client") ?? "";
  const template = params.get("template") ?? "";
  const showAll = params.get("all") === "1";
  const tokenView = (TOKEN_VIEWS.find(([v]) => v === params.get("tokens"))?.[0] ??
    "clients") as TokenView;
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const { from, to } = usageRange(range, new Date(), {
    from: params.get("from"),
    to: params.get("to"),
  });
  const usage = useApi(apiRoutes.opsUsage, {
    query: { from, to, ...(client ? { client } : {}), ...(template ? { template } : {}) },
  });
  const { data } = usage;
  const clients = session.tenants.filter((t) => t.role === "operator");
  const templateName =
    data?.templates.find((t) => t.id === template)?.name ??
    data?.agents.find((a) => a.template?.id === template)?.template?.name;

  return (
    <Page testId="ops-usage">
      <div>
        <PageHeader
          title="Usage and billing"
          subtitle="What your clients' agents did and what their model calls cost, by month. Only you see cost."
        />
        <BusinessTabs />
      </div>
      {/* The period first (dataviz: date range first), then the client, then the grouping. */}
      <div className="flex flex-wrap items-center gap-3" data-testid="ops-usage-filters">
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Select is the label's control. */}
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          Period
          <Select
            data-testid="ops-usage-range"
            // Feedback (2026-11-16): the box read "Today" over six months' figures; a browser
            // restoring a select's last value on reload can do that, so it doesn't.
            autoComplete="off"
            value={range}
            onChange={(e) => {
              const next = e.target.value;
              // A custom range starts from the period shown, to adjust.
              set(
                next === "custom"
                  ? { range: next, from, to }
                  : { range: next === "6m" ? "" : next, from: "", to: "" },
              );
            }}
            className="h-8 w-44 text-sm"
          >
            {RANGES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        {range === "custom" ? (
          <span className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: the input is the label's control. */}
            <label className="flex items-center gap-2">
              From
              <TextInput
                type="date"
                data-testid="ops-usage-from"
                value={from}
                max={to}
                onChange={(e) => e.target.value && set({ from: e.target.value })}
                className="h-8 w-40 text-sm"
              />
            </label>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: the input is the label's control. */}
            <label className="flex items-center gap-2">
              to
              <TextInput
                type="date"
                data-testid="ops-usage-to"
                value={to}
                min={from}
                onChange={(e) => e.target.value && set({ to: e.target.value })}
                className="h-8 w-40 text-sm"
              />
            </label>
          </span>
        ) : null}
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Select is the label's control. */}
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          Client
          <Select
            data-testid="ops-usage-client"
            value={client}
            onChange={(e) => set({ client: e.target.value })}
            className="h-8 w-44 text-sm"
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <StatusFilter
          value={view}
          onChange={(v) => set({ view: v === "clients" ? "" : v })}
          area="ops-usage-view"
          label="Group by"
          options={VIEWS.map(([v, l]) => [v, l])}
        />
        {template ? (
          <span className="flex items-center gap-2 text-sm text-ink-muted">
            Template: <span className="text-ink">{templateName ?? "this template"}</span>
            <Button
              size="sm"
              variant="ghost"
              data-testid="ops-usage-clear-template"
              onClick={() => set({ template: "" })}
            >
              Show all
            </Button>
          </span>
        ) : null}
      </div>
      <Loaded state={usage}>
        {(data) => (
          <UsageReportView
            data={data}
            view={view}
            showAll={showAll}
            onShowAll={(on) => set({ all: on ? "1" : "" })}
            onTemplate={(id) => set({ template: id, view: "agents" })}
            tokenSection={
              <UsageTokens
                from={from}
                to={to}
                client={client}
                template={template}
                view={tokenView}
                onView={(v) => set({ tokens: v === "clients" ? "" : v })}
              />
            }
          />
        )}
      </Loaded>
    </Page>
  );
}

/** "From Nov 2, the first day with usage", when the line starts after the period does. */
function chartSpan(data: UsageReport): string | undefined {
  const first = data.byDay?.find((d) => !isEmptyFigures(d.figures));
  return first && first.day !== data.from
    ? `From ${dayLabel(first.day)}, the first day with usage`
    : undefined;
}

/** The chart's points: by day (every preset, up to a year), else by month. */
function chartPoints(data: UsageReport): ChartPoint[] {
  if (data.byDay) {
    return data.byDay.map((d) => ({
      key: d.day,
      label: dayLabel(d.day).replace(/, \d{4}$/, ""),
      long: dayLabel(d.day),
      costUsd: d.figures.costUsd,
      runs: d.figures.runs,
    }));
  }
  return data.byMonth.map((m) => ({
    key: m.month,
    label: monthLabel(m.month),
    long: monthLabel(m.month),
    costUsd: m.figures.costUsd,
    runs: m.figures.runs,
  }));
}

function UsageReportView({
  data,
  view,
  showAll,
  onShowAll,
  onTemplate,
  tokenSection,
}: {
  data: UsageReport;
  view: View;
  /** Rows and months with nothing in them show too. */
  showAll: boolean;
  onShowAll: (on: boolean) => void;
  onTemplate: (id: string) => void;
  /** The tokens section, with its own request (./UsageTokens.tsx). */
  tokenSection: React.ReactNode;
}) {
  const thisMonth = data.byMonth.at(-1);
  const allRows = rowsFor(view, data, onTemplate);
  const rows = showAll ? allRows : allRows.filter((r) => !isEmptyFigures(r.total));
  const others = otherRows(view, data);
  // Clients and client agents, with the rows of spend that is no client agent's, add up to the
  // total; templates are a part of it.
  const sums = view !== "templates";
  const months = [...data.byMonth].reverse();
  const shownMonths = showAll ? months : months.filter((m) => !isEmptyFigures(m.figures));
  const hidden = allRows.length - rows.length + (months.length - shownMonths.length);
  const viewName = VIEWS.find(([v]) => v === view)?.[1];
  const toggle =
    hidden > 0 || showAll ? (
      <label className="flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          className="size-4 accent-slate"
          data-testid="ops-usage-show-all"
          checked={showAll}
          onChange={(e) => onShowAll(e.target.checked)}
        />
        Show all{showAll ? "" : ` (${plural(hidden, "empty row")} hidden)`}
      </label>
    ) : null;
  // Nothing at all in the period: one line, not a page of zeros.
  if (isEmptyFigures(data.total) && !data.byVendor?.length) {
    return (
      <EmptyState>
        No usage in {periodLabel(data.from, data.to)}. Runs and their cost show here once agents
        run.
      </EmptyState>
    );
  }
  return (
    <>
      <Columns count={4}>
        <StatTile
          testId="ops-usage-cost"
          label="Model cost"
          value={cost(data.total.costUsd)}
          note={`${periodLabel(data.from, data.to)}${
            thisMonth
              ? ` · ${cost(thisMonth.figures.costUsd)} in ${monthLabel(thisMonth.month)}`
              : ""
          }`}
        />
        <StatTile
          testId="ops-usage-runs"
          label="Runs"
          value={count(data.total.runs)}
          note={`${count(data.total.steps)} steps, test runs included`}
        />
        <StatTile
          testId="ops-usage-documents"
          label="Documents read"
          value={count(data.total.documents)}
          note={`${plural(data.total.externalActions, "change")} made to clients' tools`}
        />
        <StatTile
          testId="ops-usage-tokens"
          label="Tokens"
          value={tokens(data.total)}
          note={`${count(data.total.tokensIn)} in, ${count(data.total.tokensOut)} out`}
        />
      </Columns>

      {isEmptyFigures(data.total) && !data.byVendor?.length ? null : (
        <Section
          title={data.byDay ? "Model cost by day" : "Model cost by month"}
          meta={data.byDay ? chartSpan(data) : undefined}
        >
          <Card pad>
            <LineChart points={fromFirstUsage(chartPoints(data))} testId="ops-usage-chart" />
          </Card>
        </Section>
      )}

      <Section action={toggle}>
        {allRows.length === 0 && others.length === 0 ? (
          <EmptyState>
            No usage in this period. Runs and their cost show here once agents run.
          </EmptyState>
        ) : rows.length === 0 && others.length === 0 ? (
          <EmptyState>Nothing was used in this period. Show all to list every row.</EmptyState>
        ) : (
          <TableCard
            title={`${viewName}: cost by month`}
            meta={plural(
              rows.length,
              view === "clients" ? "client" : view === "agents" ? "agent" : "template",
            )}
          >
            <table data-testid={`ops-usage-${view}`}>
              <thead>
                <tr className="dt-cols">
                  <th>
                    {view === "clients" ? "Client" : view === "agents" ? "Agent" : "Template"}
                  </th>
                  {data.months.map((m) => (
                    <th key={m} className="n">
                      {monthLabel(m)}
                    </th>
                  ))}
                  <th className="n">Runs</th>
                  <th className="n">Total</th>
                  <th
                    className="n"
                    title="Texts, calls, email, browser time, sign-in codes and bank feeds, at our unit costs: an estimate, not in the total"
                  >
                    Services
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...rows, ...others].map((r) => (
                  <tr key={r.key} data-testid={`ops-usage-row-${r.key}`}>
                    <td>
                      <span className="flex flex-col py-1">
                        {r.name}
                        {r.sub}
                      </span>
                    </td>
                    {r.byMonth.map((m) => (
                      <td key={m.month} className="n">
                        {cost(m.figures.costUsd)}
                      </td>
                    ))}
                    <td className="n">{count(r.total.runs)}</td>
                    <td className="n text-ink">{cost(r.total.costUsd)}</td>
                    <td className="n">{cost(r.total.servicesUsd ?? "0")}</td>
                  </tr>
                ))}
              </tbody>
              {sums ? (
                <tfoot>
                  <tr data-testid="ops-usage-row-total" className="border-t border-line">
                    <td className="font-medium text-ink">Total</td>
                    {data.byMonth.map((m) => (
                      <td key={m.month} className="n font-medium text-ink">
                        {cost(m.figures.costUsd)}
                      </td>
                    ))}
                    <td className="n font-medium text-ink">{count(data.total.runs)}</td>
                    <td className="n font-medium text-ink">{cost(data.total.costUsd)}</td>
                    <td className="n font-medium text-ink">
                      {cost(data.total.servicesUsd ?? "0")}
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </TableCard>
        )}
      </Section>

      <UsageSplits data={data} />

      {tokenSection}

      {shownMonths.length > 0 ? (
        <Section>
          <TableCard title="By month" meta={periodLabel(data.from, data.to)}>
            <table data-testid="ops-usage-months">
              <thead>
                <tr className="dt-cols">
                  <th>Month</th>
                  {["Runs", "Steps", "Documents", "Changes", "Tokens", "Cost"].map((h) => (
                    <th key={h} className="n">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownMonths.map((m) => (
                  <tr key={m.month}>
                    <td className="text-ink">{monthLabel(m.month)}</td>
                    <td className="n">{count(m.figures.runs)}</td>
                    <td className="n">{count(m.figures.steps)}</td>
                    <td className="n">{count(m.figures.documents)}</td>
                    <td className="n">{count(m.figures.externalActions)}</td>
                    <td className="n">{tokens(m.figures)}</td>
                    <td className="n">{cost(m.figures.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        </Section>
      ) : null}
    </>
  );
}

/** What a vendor's usage was, in a few words: "3 model calls", "12 messages", "2 minutes". */
function vendorUsage(v: UsageVendorRow): string {
  if (v.fees !== undefined) return plural(v.fees, "fee");
  if (v.messages !== undefined) return plural(v.messages, "message");
  if (v.emails !== undefined) return plural(v.emails, "email");
  if (v.verifications !== undefined) return plural(v.verifications, "sign-in code");
  if (v.bankItemMonths !== undefined) return plural(v.bankItemMonths, "bank month");
  if (v.browserSeconds !== undefined) {
    return `${plural(Math.ceil(v.browserSeconds / 60), "minute")} of browsing`;
  }
  if (v.callSeconds !== undefined) {
    const minutes = Math.ceil(v.callSeconds / 60);
    return `${plural(minutes, "minute")} of calls`;
  }
  if (v.id === "unrecorded") return "Steps with no call record";
  return plural(v.calls ?? 0, "model call");
}

/** A model row's name: its label, or what the row is when no record names a model. */
function ModelName({ row, label }: { row: UsageModelRow; label: string | undefined }) {
  if (row.model === UNRECORDED_MODEL) {
    return (
      <span className="flex flex-col py-1">
        <span className="text-ink">Not itemised by model</span>
        <span className="text-sm text-ink-muted">
          Steps with no call record, and answers that name no model
        </span>
      </span>
    );
  }
  const unpriced = row.unpricedCalls ?? 0;
  const failed = row.failedCalls ?? 0;
  return (
    <span className="flex flex-col py-1">
      <span className="text-ink">{label ?? providerModelName(row.model)}</span>
      <span className="text-sm text-ink-muted">
        {MODEL_PROVIDER_NAMES[row.provider as ModelProvider] ?? row.provider}
        {unpriced > 0
          ? ` · ${plural(unpriced, "call")} had no price, so ${unpriced === 1 ? "it counts" : "they count"} as $0.00`
          : ""}
        {/* S4.8 (QA W7): failed calls, counted apart from Calls. */}
        {failed > 0 ? ` · ${plural(failed, "failed call")}, not counted in Calls` : ""}
      </span>
    </span>
  );
}

/**
 * UI cleanup: the period's cost by model and by vendor. Models read by their label where the
 * models list has one; Twilio's and ElevenLabs' cost is our unit cost times the usage ("about").
 */
function UsageSplits({ data }: { data: UsageReport }) {
  const models = useApi(apiRoutes.opsModels, data.byModel?.length ? {} : null);
  const byModel = data.byModel ?? [];
  const byVendor = data.byVendor ?? [];
  if (byModel.length === 0 && byVendor.length === 0) return null;
  const label = (id: string) => models.data?.models.find((m) => m.id === id)?.label;
  return (
    <Columns count={2}>
      {byVendor.length > 0 ? (
        <TableCard
          title="By vendor"
          meta={
            byVendor.some((v) => v.estimated || v.id === "provider_fees")
              ? "What the work cost us. Fees and estimates are not in the model cost; unit costs are unverified."
              : "What the work cost us"
          }
          testId="ops-usage-vendors"
        >
          <table data-testid="ops-usage-by-vendor">
            <thead>
              <tr className="dt-cols">
                <th>Vendor</th>
                <th className="n">Usage</th>
                <th className="n">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byVendor.map((v) => (
                <tr key={v.id} data-testid={`ops-usage-vendor-${v.id}`}>
                  <td className="text-ink">{v.name}</td>
                  <td className="n">{vendorUsage(v)}</td>
                  <td className="n">
                    {v.costUsd === null ? (
                      <span title="No unit cost is set for this in Billing">Not priced</span>
                    ) : v.estimated ? (
                      <span title="Our unit cost times the usage">about {cost(v.costUsd)}</span>
                    ) : (
                      cost(v.costUsd)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}
      {byModel.length > 0 ? (
        <TableCard
          title="By model"
          meta={plural(byModel.length, "model")}
          testId="ops-usage-models"
        >
          <table data-testid="ops-usage-by-model">
            <thead>
              <tr className="dt-cols">
                <th>Model</th>
                <th className="n">Calls</th>
                <th className="n">Tokens</th>
                <th className="n">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((m) => (
                <tr
                  key={`${m.provider}:${m.model}`}
                  data-testid={`ops-usage-model-${m.model || "unrecorded"}`}
                >
                  <td>
                    <ModelName row={m} label={label(m.model)} />
                  </td>
                  <td className="n">{m.model === UNRECORDED_MODEL ? "" : count(m.calls)}</td>
                  <td className="n">{count(m.tokensIn + m.tokensOut)}</td>
                  <td className="n text-ink">
                    {(m.unpricedCalls ?? 0) > 0 ? (
                      <span className="inline-flex items-center gap-2">
                        <Badge tone="warning" testId={`ops-usage-model-${m.model}-unpriced`}>
                          No price
                        </Badge>
                        {cost(m.costUsd)}
                      </span>
                    ) : (
                      cost(m.costUsd)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}
    </Columns>
  );
}
