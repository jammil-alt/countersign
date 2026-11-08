// Weekly report (M47, docs/plan.md §1.77): the Site reporter's reports on one site, newest first,
// each with its week, its summary, whether someone has read it and where its three suggested
// actions stand. A report is written by the client's Site reporter agent each Monday morning (a
// fork of the `site-report` template); every number in it was checked against the figures before
// it was kept. One report in full is ./Report.tsx.
import { Link } from "react-router-dom";
import { Select } from "../../../ui/forms";
import { Card, EmptyState, ErrorNotice, Loading } from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import { marketingCsvHref, useMarketingReport } from "./api";
import {
  CsvLink,
  dayWords,
  MarketingLayout,
  type MarketingSite,
  useMarketingClientId,
  useMarketingQuery,
} from "./layout";
import { MARKETING_PATHS } from "./paths";

export interface ReportListRow {
  id: string;
  siteId: string;
  periodFrom: string;
  periodTo: string;
  createdAt: string;
  read: boolean;
  summary: string;
  actions: { open: number; done: number; notNow: number };
}

export interface ReportsReport {
  site: MarketingSite | null;
  sites: MarketingSite[];
  reports: ReportListRow[];
}

/** "Nov 1 to Nov 7". */
export const weekWords = (from: string, to: string) => `${dayWords(from)} to ${dayWords(to, true)}`;

/** Where a report's actions stand, in words. */
export function actionsWords(a: ReportListRow["actions"]): string {
  const parts = [
    a.open > 0 ? `${a.open} open` : null,
    a.done > 0 ? `${a.done} done` : null,
    a.notNow > 0 ? `${a.notNow} not now` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No actions";
}

export function MarketingReportsScreen() {
  const clientId = useMarketingClientId();
  const { query, set } = useMarketingQuery();
  const site = typeof query.site === "string" ? query.site : undefined;
  const state = useMarketingReport<ReportsReport>(clientId, "reports", { site });
  const data = state.data;
  return (
    <MarketingLayout
      title="Weekly report"
      subtitle="Each Monday: what changed on the site and in search, why it probably changed, and three things worth doing."
      testId="marketing-reports"
      actions={
        data?.site ? (
          <CsvLink
            href={marketingCsvHref(clientId, "reports", { site: data.site.id })}
            testId="marketing-reports-csv-download"
          />
        ) : null
      }
    >
      {state.loading && !data ? <Loading /> : null}
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {data && data.sites.length > 1 ? (
        <div className="max-w-xs">
          <Select
            aria-label="Site"
            value={data.site?.id ?? ""}
            onChange={(e) => set({ site: e.target.value })}
            data-testid="marketing-reports-site-select"
          >
            {data.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.domain}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {data && !data.site ? (
        <EmptyState
          testId="marketing-reports-no-site"
          title="No site yet"
          line="Add the client's website on the Sites page first."
          action={{ label: "Go to Sites", to: MARKETING_PATHS.sites(clientId) }}
        />
      ) : null}
      {data?.site && data.reports.length === 0 ? (
        <EmptyState
          testId="marketing-reports-empty"
          title="No report yet"
          line="The Site reporter writes one each Monday morning. Fork the Site reporter template into this client and switch it on; its first report comes the Monday after."
        />
      ) : null}
      {data?.site && data.reports.length > 0 ? (
        <ul className="flex flex-col gap-3" data-testid="marketing-reports-list">
          {data.reports.map((r) => (
            <li key={r.id}>
              <Card testId="marketing-reports-row" pad>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      to={MARKETING_PATHS.report(clientId, r.id)}
                      className="font-medium text-ink hover:underline"
                      data-testid="marketing-reports-row-open"
                    >
                      Week of {weekWords(r.periodFrom, r.periodTo)}
                    </Link>
                    {r.read ? (
                      <StatusChip state="done">Read</StatusChip>
                    ) : (
                      <StatusChip state="waiting">Not read yet</StatusChip>
                    )}
                  </div>
                  <p className="text-ink">{r.summary}</p>
                  <p className="text-sm text-ink-muted">Actions: {actionsWords(r.actions)}</p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </MarketingLayout>
  );
}
