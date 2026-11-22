// R5 (docs/reporting-plan.md §3 R5, docs/plan.md §1.235): `/ops/accounts`, every client the
// operator serves side by side for a period, each in its own days. Sortable by any column; "Needs
// us" first by default (something waiting past a day, a failed run nobody has looked at, a broken
// connection, an allowance over 80% used). Each figure opens what is behind it. Its own chunk.
import { accountReportRoutes, type OpsAccountRow, type RunFilter } from "@countersign/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { sharePercent } from "../../reports/AccountReportView";
import { periodQuery, ReportPeriodForm } from "../../reports/AgentReportView";
import { msWords } from "../../runs/format";
import { Loaded, Page } from "../../ui/page";
import { Badge, Card, EmptyState, PageHeader } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { accountLinks, NEEDS_US_WORDS } from "../client/ClientReport";
import { OPS_PATHS } from "../paths";
import { runsLink } from "../run/links";

const n = (v: number) => v.toLocaleString("en-US");

type Col =
  | "needs"
  | "client"
  | "runs"
  | "change"
  | "failed"
  | "waiting"
  | "oldest"
  | "unseen"
  | "connections"
  | "usage";

/** Each column's sort value: numbers, or the client's name. */
const VALUE: Record<Col, (r: OpsAccountRow) => number | string> = {
  needs: (r) => r.needsUs.length,
  client: (r) => r.client.name.toLowerCase(),
  runs: (r) => r.runs.count,
  change: (r) => r.headline.runs - r.previous.runs,
  failed: (r) => r.failed.count,
  waiting: (r) => r.waiting.runs.count,
  // The oldest wait first when descending: older is larger.
  oldest: (r) => (r.waiting.oldestSince ? -Date.parse(r.waiting.oldestSince) : -Infinity),
  unseen: (r) => r.failedUnseen.count,
  connections: (r) => r.connections.length,
  usage: (r) => r.usage?.share ?? -1,
};

/** Rows by a column; ties by "Needs us", then name, so the order is stable. */
export function sortAccounts(rows: readonly OpsAccountRow[], col: Col, dir: 1 | -1) {
  const cmp = (a: number | string, b: number | string) =>
    typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
  return [...rows].sort(
    (a, b) =>
      cmp(VALUE[col](a), VALUE[col](b)) * dir ||
      b.needsUs.length - a.needsUs.length ||
      a.client.name.localeCompare(b.client.name),
  );
}

function Cell({ count, filter }: { count: number; filter: RunFilter | null }) {
  return count > 0 && filter ? (
    <Link to={runsLink(filter)} className="hover:underline">
      {n(count)}
    </Link>
  ) : (
    <>{n(count)}</>
  );
}

function AccountsTable({ rows }: { rows: OpsAccountRow[] }) {
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "needs", dir: -1 });
  const sorted = sortAccounts(rows, sort.col, sort.dir);
  const th = (col: Col, label: string, numeric = true) => (
    <th
      className={numeric ? "n" : undefined}
      aria-sort={sort.col === col ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        className="dt-sort"
        data-testid={`ops-accounts-sort-${col}`}
        // Numbers start with the largest, names from A.
        onClick={() =>
          setSort((s) => ({
            col,
            dir: s.col === col ? (s.dir === 1 ? -1 : 1) : col === "client" ? 1 : -1,
          }))
        }
      >
        {label}
      </button>
    </th>
  );
  return (
    <Card>
      <div className="dt dt-ana overflow-x-auto">
        <table data-testid="ops-accounts-table">
          <thead>
            <tr className="dt-cols">
              {th("client", "Client", false)}
              {th("needs", "Needs us", false)}
              {th("runs", "Runs")}
              {th("change", "Against before")}
              {th("failed", "Failed")}
              {th("waiting", "Waiting now")}
              {th("oldest", "Oldest wait")}
              {th("unseen", "Failed, not looked at")}
              {th("connections", "Connections")}
              {th("usage", "Allowance used")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const links = accountLinks(r.client.id);
              const change = r.headline.runs - r.previous.runs;
              return (
                <tr key={r.client.id} data-testid={`ops-accounts-row-${r.client.id}`}>
                  <td>
                    <Link to={OPS_PATHS.clientReport(r.client.id)} className="hover:underline">
                      {r.client.name}
                    </Link>
                    <span className="ml-2 text-sm text-ink-muted">
                      {r.agents === 1 ? "1 agent" : `${n(r.agents)} agents`}
                    </span>
                  </td>
                  <td>
                    {r.needsUs.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {r.needsUs.map((x) => (
                          <Badge key={x} tone="warning">
                            {NEEDS_US_WORDS[x]}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="text-ink-muted">–</span>
                    )}
                  </td>
                  <td className="n figures">
                    <Cell count={r.runs.count} filter={r.runs.filter} />
                  </td>
                  <td className="n figures" title={`${n(r.previous.runs)} the period before`}>
                    {change > 0 ? `+${n(change)}` : n(change)}
                  </td>
                  <td className="n figures">
                    <Cell count={r.failed.count} filter={r.failed.filter} />
                  </td>
                  <td className="n figures">
                    <Cell count={r.waiting.runs.count} filter={r.waiting.runs.filter} />
                  </td>
                  <td className="n figures">
                    {r.waiting.oldestSince
                      ? msWords(Math.max(0, Date.now() - Date.parse(r.waiting.oldestSince)))
                      : "–"}
                  </td>
                  <td className="n figures">
                    {r.failedUnseen.count > 0 ? (
                      <Link to={links.failedUnseen} className="hover:underline">
                        {n(r.failedUnseen.count)}
                      </Link>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="n figures">
                    {r.connections.length > 0 ? (
                      <Link to={links.connection()} className="hover:underline">
                        {n(r.connections.length)}
                      </Link>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="n figures">
                    {r.usage ? (
                      <Link to={links.usage} className="hover:underline">
                        {sharePercent(r.usage.share)}
                      </Link>
                    ) : (
                      "–"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function AccountsScreen() {
  const [params, setParams] = useSearchParams();
  const from = params.get("from");
  const to = params.get("to");
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const accounts = useApi(accountReportRoutes.opsAccounts, { query: periodQuery(period) });
  const needs = accounts.data?.accounts.filter((a) => a.needsUs.length > 0).length ?? 0;
  return (
    <Page testId="ops-accounts">
      <PageHeader
        title="Accounts"
        subtitle={
          accounts.data
            ? needs === 0
              ? "No client needs us."
              : `${n(needs)} ${needs === 1 ? "client needs" : "clients need"} us.`
            : "Every client you serve, side by side."
        }
      />
      <ReportPeriodForm period={period} onChange={(p) => setParams(periodQuery(p))} />
      <Loaded state={accounts} skeleton={<SkeletonRows rows={6} columns={6} />}>
        {(data) =>
          data.accounts.length === 0 ? (
            <EmptyState>You serve no clients yet.</EmptyState>
          ) : (
            <AccountsTable rows={data.accounts} />
          )
        }
      </Loaded>
    </Page>
  );
}
