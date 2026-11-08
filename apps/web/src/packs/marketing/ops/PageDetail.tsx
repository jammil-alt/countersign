// One page in depth (M44, `pages/detail?path=…`): its figures, how far down its readers got by
// quarter, how long they stayed (bands), where they came from and went next, and the tracked
// elements they clicked, with where each sits on the page.
import { Link, useSearchParams } from "react-router-dom";
import { KpiStrip, ProgressBar, StatTile } from "../../../ui/figures";
import { Columns, Loaded, Section } from "../../../ui/page";
import { EmptyState } from "../../../ui/primitives";
import { useMarketingReport } from "./api";
import {
  bandWords,
  countWords,
  DataTable,
  MarketingFilters,
  MarketingLayout,
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
import { sourceWords } from "./Overview";
import { halfWords, type PageRow } from "./Pages";
import { MARKETING_PATHS } from "./paths";

interface Flow {
  kind: "source" | "page" | "goal" | "left";
  key: string | null;
  visits: number;
}

export interface PageReport extends RangedReport {
  path: string;
  page: PageRow | null;
  reach: { quarter: number; views: number; share: string | null }[];
  engaged: number[];
  clicks: { target: string; clicks: number; position: number }[];
  cameFrom: Flow[];
  wentNext: Flow[];
}

/** The engaged-time bands' names, in order (packs/marketing ENGAGED_BAND_UPPER_SECONDS). */
export const BAND_NAMES = [
  "Under 10 s",
  "10 to 30 s",
  "30 s to 1 min",
  "1 to 2 min",
  "2 to 4 min",
  "4 min or more",
];

function flowWords(f: Flow): string {
  if (f.kind === "goal") return "Reached a goal";
  if (f.kind === "left") return "Left the site";
  if (f.kind === "page") return f.key ?? "";
  const [group = "", name = null] = (f.key ?? "").split(/\/(.*)/);
  return `Arrived from ${sourceWords(group, name || null)}`;
}

function FlowList({ title, flows, testId }: { title: string; flows: Flow[]; testId: string }) {
  const total = flows.reduce((a, f) => a + f.visits, 0);
  return (
    <Section title={title} testId={testId}>
      {flows.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {flows.map((f) => (
            <li key={`${f.kind}:${f.key}`} className="flex flex-col gap-1">
              <span className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="min-w-0 break-all text-ink">{flowWords(f)}</span>
                <span className="figures text-ink-muted">{countWords(f.visits)}</span>
              </span>
              <ProgressBar value={f.visits} max={total} label={`${flowWords(f)}: ${f.visits}`} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function MarketingPageDetailScreen() {
  const clientId = useMarketingClientId();
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const { query } = useMarketingQuery(["path"]);
  const kept = useKeptQuery();
  const state = useMarketingReport<PageReport>(path ? clientId : null, "page", query);
  return (
    <MarketingLayout
      title={path || "Page"}
      subtitle={
        <Link
          to={withKept(MARKETING_PATHS.pages(clientId), kept)}
          className="text-link hover:underline"
        >
          All pages
        </Link>
      }
      testId="marketing-page-detail"
      actions={<MarketingFilters sites={state.data?.sites} />}
    >
      {!path ? (
        <EmptyState line="Choose a page from the list of pages." />
      ) : (
        <Loaded state={state}>
          {(r) =>
            !r.site ? (
              <NoSite clientId={clientId} />
            ) : !r.page ? (
              <div className="flex flex-col gap-4">
                <RangeLine range={r.range} />
                <EmptyState
                  testId="marketing-page-detail-empty"
                  title="Nobody read this page in these days"
                  line="Try a longer period."
                />
              </div>
            ) : (
              <PageBody clientId={clientId} r={r} page={r.page} kept={kept} />
            )
          }
        </Loaded>
      )}
    </MarketingLayout>
  );
}

function PageBody({
  clientId,
  r,
  page,
  kept,
}: {
  clientId: string;
  r: PageReport;
  page: PageRow;
  kept: string;
}) {
  const engagedTotal = r.engaged.reduce((a, n) => a + n, 0);
  return (
    <div className="flex flex-col gap-6">
      <RangeLine range={r.range} />
      <KpiStrip testId="marketing-page-detail-kpis">
        <StatTile
          label="Views"
          value={countWords(page.views)}
          note={page.smallSample ? <SmallSample /> : `${countWords(page.entries)} entered here`}
        />
        <StatTile
          label="Exit rate"
          value={percentWords(page.exitRate)}
          note={`${countWords(page.exits)} left from here`}
        />
        <StatTile
          label="Median engaged"
          value={bandWords(page.medianEngaged)}
          note={`Half read to ${halfWords(page.halfReadTo)}`}
        />
        <StatTile
          label="Goals"
          value={countWords(page.goals)}
          note="Visits that entered here and reached one"
          to={withKept(MARKETING_PATHS.visits(clientId), kept, { entry: r.path, goal: "yes" })}
        />
      </KpiStrip>
      <Columns count={2}>
        <Section title="How far down" testId="marketing-page-detail-reach">
          <ul className="flex flex-col gap-3">
            {r.reach.map((q) => (
              <li key={q.quarter} className="flex flex-col gap-1">
                <span className="flex justify-between gap-2 text-sm">
                  <span className="text-ink">{q.quarter * 25}% of the page</span>
                  <span className="figures text-ink-muted">
                    {percentWords(q.share)} · {countWords(q.views)}
                  </span>
                </span>
                <ProgressBar
                  value={q.views}
                  max={page.views}
                  label={`${q.quarter * 25}% of the page: ${q.views} views`}
                />
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Time engaged" testId="marketing-page-detail-engaged">
          <ul className="flex flex-col gap-3">
            {r.engaged.map((n, i) => (
              <li key={BAND_NAMES[i]} className="flex flex-col gap-1">
                <span className="flex justify-between gap-2 text-sm">
                  <span className="text-ink">{BAND_NAMES[i]}</span>
                  <span className="figures text-ink-muted">{countWords(n)}</span>
                </span>
                <ProgressBar value={n} max={engagedTotal} label={`${BAND_NAMES[i]}: ${n} views`} />
              </li>
            ))}
          </ul>
        </Section>
        <FlowList title="Came from" flows={r.cameFrom} testId="marketing-page-detail-from" />
        <FlowList title="Went next" flows={r.wentNext} testId="marketing-page-detail-next" />
      </Columns>
      <Section title="Tracked clicks" testId="marketing-page-detail-clicks">
        {r.clicks.length === 0 ? (
          <p className="text-sm text-ink-muted">No tracked element on this page was clicked.</p>
        ) : (
          <DataTable>
            <thead>
              <tr className="dt-cols">
                <th>Element</th>
                <th className="n">Clicks</th>
                <th className="n">Down the page</th>
              </tr>
            </thead>
            <tbody>
              {r.clicks.map((c) => (
                <tr key={c.target}>
                  <td className="break-all">
                    {c.target}
                    {r.site?.goals.includes(c.target) ? (
                      <span className="ml-2 text-sm text-ink-muted">Goal</span>
                    ) : null}
                  </td>
                  <td className="n">{countWords(c.clicks)}</td>
                  <td className="n">{c.position}%</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PrivacyFooter />
        <Link
          to={withKept(MARKETING_PATHS.visits(clientId), kept, { path: r.path })}
          className="ds-btn ds-btn--link text-sm"
          data-testid="marketing-page-detail-visits"
        >
          Visits that read this page
        </Link>
      </div>
    </div>
  );
}
