// Overview (M44, docs/marketing-plan.md §4.7): one site's visits, goals, bounces and engaged time
// for the period against the one before, its days, and its top pages and sources, each a link
// into the screen that opens it. Small samples and days not yet counted are marked.
import { Link } from "react-router-dom";
import { Delta, KpiStrip, Sparkbars, StatTile } from "../../../ui/figures";
import { Loaded, Section } from "../../../ui/page";
import { EmptyState } from "../../../ui/primitives";
import { marketingCsvHref, useMarketingReport } from "./api";
import {
  bandWords,
  CsvLink,
  countWords,
  DataTable,
  dayWords,
  MarketingFilters,
  MarketingLayout,
  type MedianBand,
  NoSite,
  PrivacyFooter,
  percentWords,
  type RangedReport,
  RangeLine,
  SmallSample,
  useKeptQuery,
  useMarketingClientId,
  useMarketingQuery,
  withKept,
} from "./layout";
import { MARKETING_PATHS } from "./paths";

export interface Totals {
  visits: number;
  views: number;
  goals: number;
  bounces: number;
  goalRate: string | null;
  bounceRate: string | null;
  medianEngaged: MedianBand | null;
  smallSample: boolean;
}

export interface OverviewReport extends RangedReport {
  totals: Totals;
  previousTotals: Totals;
  daily: { day: string; visits: number; goals: number; built: boolean }[];
  pages: { path: string; views: number; entries: number; goals: number; smallSample: boolean }[];
  sources: {
    source: string;
    group: string;
    name: string | null;
    visits: number;
    goals: number;
    smallSample: boolean;
  }[];
  filtered: number;
}

/** "google (search)", "direct": a source's key in words. */
export function sourceWords(group: string, name: string | null): string {
  return name ? `${name} (${group})` : group;
}

const changeWords = (direction: "up" | "down" | "same", by: number) =>
  direction === "same"
    ? "Same as the days before"
    : `${direction === "up" ? "Up" : "Down"} ${countWords(by)} on the days before`;

export function MarketingOverviewScreen() {
  const clientId = useMarketingClientId();
  const { query } = useMarketingQuery();
  const state = useMarketingReport<OverviewReport>(clientId, "overview", query);
  return (
    <MarketingLayout
      title="Overview"
      testId="marketing-overview"
      actions={<MarketingFilters sites={state.data?.sites} />}
    >
      <Loaded state={state}>
        {(r) =>
          r.site ? <OverviewBody clientId={clientId} r={r} /> : <NoSite clientId={clientId} />
        }
      </Loaded>
    </MarketingLayout>
  );
}

function OverviewBody({ clientId, r }: { clientId: string; r: OverviewReport }) {
  const kept = useKeptQuery();
  const { query } = useMarketingQuery();
  const t = r.totals;
  return (
    <div className="flex flex-col gap-6">
      <RangeLine range={r.range} />
      <KpiStrip testId="marketing-overview-kpis">
        <StatTile
          label="Visits"
          value={countWords(t.visits)}
          mark={<Delta now={t.visits} before={r.previousTotals.visits} words={changeWords} />}
          note={t.smallSample ? <SmallSample /> : `${countWords(t.views)} pages read`}
          to={withKept(MARKETING_PATHS.visits(clientId), kept)}
          testId="marketing-overview-visits"
        />
        <StatTile
          label="Reached a goal"
          value={countWords(t.goals)}
          note={`${percentWords(t.goalRate, 1)} of visits`}
          to={withKept(MARKETING_PATHS.visits(clientId), kept, { goal: "yes" })}
          testId="marketing-overview-goals"
        />
        <StatTile
          label="Left at once"
          value={percentWords(t.bounceRate)}
          note={`${countWords(t.bounces)} visits read one page and left`}
          testId="marketing-overview-bounces"
        />
        <StatTile
          label="Median time engaged"
          value={bandWords(t.medianEngaged)}
          note="Per visit"
          testId="marketing-overview-engaged"
        />
      </KpiStrip>

      <Section
        title="Visits by day"
        meta={`${countWords(r.previousTotals.visits)} in the ${r.range.days} days before`}
        testId="marketing-overview-days"
      >
        {r.daily.some((d) => d.visits > 0) ? (
          <div className="flex flex-col gap-2">
            <Sparkbars
              values={r.daily.map((d) => ({ value: d.visits }))}
              label={`Visits per day, ${dayWords(r.range.from)} to ${dayWords(r.range.to)}`}
            />
            <p className="text-sm text-ink-muted">
              Busiest: {(() => {
                const top = [...r.daily].sort((a, b) => b.visits - a.visits)[0];
                return top ? `${dayWords(top.day)}, ${countWords(top.visits)} visits` : "–";
              })()}
              {r.daily.some((d) => !d.built)
                ? `. ${r.daily.filter((d) => !d.built).length} days not counted yet.`
                : "."}
            </p>
          </div>
        ) : (
          <EmptyState
            testId="marketing-overview-empty"
            title="No visits in these days"
            line="Once the snippet is on the site's pages, visits show here the day after."
            action={{ label: "See the snippet", to: MARKETING_PATHS.sites(clientId) }}
          />
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Top pages"
          action={
            <Link
              to={withKept(MARKETING_PATHS.pages(clientId), kept)}
              className="ds-btn ds-btn--link text-sm"
            >
              All pages
            </Link>
          }
          testId="marketing-overview-pages"
        >
          <DataTable>
            <thead>
              <tr className="dt-cols">
                <th>Page</th>
                <th className="n">Views</th>
                <th className="n">Entries</th>
                <th className="n">Goals</th>
              </tr>
            </thead>
            <tbody>
              {r.pages.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-ink-muted">
                    No pages read yet.
                  </td>
                </tr>
              ) : null}
              {r.pages.map((p) => (
                <tr key={p.path}>
                  <td className="max-w-[16rem] break-all">
                    <Link
                      to={withKept(MARKETING_PATHS.page(clientId, p.path), kept)}
                      className="text-link hover:underline"
                    >
                      {p.path}
                    </Link>
                  </td>
                  <td className="n">{countWords(p.views)}</td>
                  <td className="n">{countWords(p.entries)}</td>
                  <td className="n">{countWords(p.goals)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Section>
        <Section
          title="Top sources"
          action={
            <Link
              to={withKept(MARKETING_PATHS.sources(clientId), kept)}
              className="ds-btn ds-btn--link text-sm"
            >
              All sources
            </Link>
          }
          testId="marketing-overview-sources"
        >
          <DataTable>
            <thead>
              <tr className="dt-cols">
                <th>Source</th>
                <th className="n">Visits</th>
                <th className="n">Goals</th>
              </tr>
            </thead>
            <tbody>
              {r.sources.length === 0 ? (
                <tr>
                  <td colSpan={3} className="text-ink-muted">
                    No sources yet.
                  </td>
                </tr>
              ) : null}
              {r.sources.map((s) => (
                <tr key={s.source}>
                  <td>
                    <Link
                      to={withKept(MARKETING_PATHS.visits(clientId), kept, { source: s.source })}
                      className="text-link hover:underline"
                    >
                      {sourceWords(s.group, s.name)}
                    </Link>
                    {s.smallSample ? (
                      <span className="ml-2">
                        <SmallSample />
                      </span>
                    ) : null}
                  </td>
                  <td className="n">{countWords(s.visits)}</td>
                  <td className="n">{countWords(s.goals)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Section>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PrivacyFooter filtered={r.filtered} />
        <CsvLink
          href={marketingCsvHref(clientId, "overview", query)}
          testId="marketing-overview-csv"
        />
      </div>
    </div>
  );
}
