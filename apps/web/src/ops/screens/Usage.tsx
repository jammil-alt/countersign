// `/ops/usage` (ARCHITECTURE §13, §15): usage and model cost per client, client agent and template,
// by month, for the clients this operator serves. Cost is operator-only; the portal never sees it.
// The filters live in the URL (`?client=`, `?template=`, `?view=`, `?range=`) so a client page or a
// template can link straight to its usage.
import type { UsageFigures, UsageReport } from "@countersign/core";
import { Link, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { useSession } from "../../session/session";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import {
  cost,
  count,
  isoDay,
  monthLabel,
  monthStart,
  periodLabel,
  plural,
} from "../../usage/format";
import { Stat, StatRow } from "../../usage/Stat";
import { Select } from "../agents/ui";

const RANGES = [
  ["month", "This month", 0],
  ["3m", "Last 3 months", 2],
  ["6m", "Last 6 months", 5],
  ["12m", "Last 12 months", 11],
] as const;
type RangeKey = (typeof RANGES)[number][0];

const VIEWS = [
  ["clients", "Clients"],
  ["agents", "Client agents"],
  ["templates", "Templates"],
] as const;
type View = (typeof VIEWS)[number][0];

/** The range's days in UTC, as the rollup counts them. */
// DECISION: the screen's ranges are whole months back from today, in UTC like usage_daily; the
// default, six months, is the API's default too.
export function usageRange(key: RangeKey, today: Date = new Date()): { from: string; to: string } {
  const to = isoDay(today);
  const back = RANGES.find(([k]) => k === key)?.[2] ?? 5;
  return { from: monthStart(to, back), to };
}

const tokens = (f: UsageFigures) => count(f.tokensIn + f.tokensOut);

interface Row {
  key: string;
  name: React.ReactNode;
  sub?: React.ReactNode;
  total: UsageFigures;
  byMonth: UsageReport["byMonth"];
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
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const { from, to } = usageRange(range);
  const { data, error, loading, reload } = useApi(apiRoutes.opsUsage, {
    query: { from, to, ...(client ? { client } : {}), ...(template ? { template } : {}) },
  });
  const clients = session.tenants.filter((t) => t.role === "operator");
  const templateName =
    data?.templates.find((t) => t.id === template)?.name ??
    data?.agents.find((a) => a.template?.id === template)?.template?.name;
  const thisMonth = data?.byMonth.at(-1);
  const rows = data ? rowsFor(view, data, (id) => set({ template: id, view: "agents" })) : [];

  return (
    <div>
      <PageHeader
        title="Usage and cost"
        subtitle="What your clients' agents did and what their model calls cost, by month. Only you see cost."
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusFilter
          value={view}
          onChange={(v) => set({ view: v === "clients" ? "" : v })}
          area="ops-usage-view"
          label="Group by"
          options={VIEWS.map(([v, l]) => [v, l])}
        />
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Select is the label's control. */}
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          Period
          <Select
            data-testid="ops-usage-range"
            value={range}
            onChange={(e) => set({ range: e.target.value === "6m" ? "" : e.target.value })}
            className="h-8 w-40 text-sm"
          >
            {RANGES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </label>
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
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <>
          <StatRow>
            <Stat
              testId="ops-usage-cost"
              label="Model cost"
              value={cost(data.total.costUsd)}
              note={`${periodLabel(data.from, data.to)}${
                thisMonth
                  ? ` · ${cost(thisMonth.figures.costUsd)} in ${monthLabel(thisMonth.month)}`
                  : ""
              }`}
            />
            <Stat
              testId="ops-usage-runs"
              label="Runs"
              value={count(data.total.runs)}
              note={`${count(data.total.steps)} steps, test runs included`}
            />
            <Stat
              testId="ops-usage-documents"
              label="Documents read"
              value={count(data.total.documents)}
              note={`${plural(data.total.externalActions, "change")} made to clients' tools`}
            />
            <Stat
              testId="ops-usage-tokens"
              label="Tokens"
              value={tokens(data.total)}
              note={`${count(data.total.tokensIn)} in, ${count(data.total.tokensOut)} out`}
            />
          </StatRow>

          <section className="mb-8">
            <SectionLabel>By month</SectionLabel>
            <div className="dt dt-ana overflow-x-auto">
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
                  {[...data.byMonth].reverse().map((m) => (
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
            </div>
          </section>

          <section>
            <SectionLabel>{VIEWS.find(([v]) => v === view)?.[1]}: cost by month</SectionLabel>
            {rows.length === 0 ? (
              <EmptyState>
                No usage in this period. Runs and their cost show here once agents run.
              </EmptyState>
            ) : (
              <div className="dt dt-ana overflow-x-auto">
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
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
