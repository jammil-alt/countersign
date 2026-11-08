// Journeys (M44, docs/marketing-plan.md §4.7): how visits move through the site. The most common
// paths, the one that reaches a goal most often, where visits that didn't reach one left, the page
// visits that did ended on, and the goal funnel by entry page: landed, saw a form, reached a goal.
import { Link } from "react-router-dom";
import { Loaded, Section } from "../../../ui/page";
import { Card, EmptyState } from "../../../ui/primitives";
import { marketingCsvHref, useMarketingReport } from "./api";
import {
  CsvLink,
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
import { MARKETING_PATHS } from "./paths";

interface JourneyPath {
  pages: string[];
  longer: boolean;
  visits: number;
  goals: number;
  goalRate: string | null;
  smallSample: boolean;
}

export interface JourneysReport extends RangedReport {
  visits: number;
  smallSample: boolean;
  paths: JourneyPath[];
  other: { paths: number; visits: number };
  best: JourneyPath | null;
  leaves: { path: string; visits: number; left: number; leftRate: string | null }[];
  lastPage: { path: string; visits: number }[];
  funnel: {
    entry: string;
    landed: number;
    sawForm: number;
    goals: number;
    goalRate: string | null;
    smallSample: boolean;
  }[];
}

/** "/ → /how-it-works → … → /guides/x". */
export function pathWords(p: Pick<JourneyPath, "pages" | "longer">): string {
  if (!p.longer) return p.pages.join(" → ");
  const last = p.pages[p.pages.length - 1];
  return `${p.pages.slice(0, -1).join(" → ")} → … → ${last}`;
}

export function MarketingJourneysScreen() {
  const clientId = useMarketingClientId();
  const { query } = useMarketingQuery();
  const state = useMarketingReport<JourneysReport>(clientId, "journeys", query);
  return (
    <MarketingLayout
      title="Journeys"
      testId="marketing-journeys"
      actions={<MarketingFilters sites={state.data?.sites} />}
    >
      <Loaded state={state}>
        {(r) =>
          !r.site ? (
            <NoSite clientId={clientId} />
          ) : r.visits === 0 ? (
            <div className="flex flex-col gap-4">
              <RangeLine range={r.range} />
              <EmptyState
                testId="marketing-journeys-empty"
                title="No visits in these days"
                line="Journeys show here the day after the first visit."
              />
            </div>
          ) : (
            <JourneysBody clientId={clientId} r={r} query={query} />
          )
        }
      </Loaded>
    </MarketingLayout>
  );
}

function JourneysBody({
  clientId,
  r,
  query,
}: {
  clientId: string;
  r: JourneysReport;
  query: Record<string, string | undefined>;
}) {
  const kept = useKeptQuery();
  const pageLink = (path: string) => (
    <Link
      to={withKept(MARKETING_PATHS.page(clientId, path), kept)}
      className="text-link hover:underline"
    >
      {path}
    </Link>
  );
  return (
    <div className="flex flex-col gap-6">
      <RangeLine range={r.range} />
      {r.best ? (
        <Card title="Most often reaches a goal" pad testId="marketing-journeys-best">
          <p className="break-words text-ink">{pathWords(r.best)}</p>
          <p className="mt-1 text-sm text-ink-muted">
            {countWords(r.best.goals)} of {countWords(r.best.visits)} visits reached a goal (
            {percentWords(r.best.goalRate, 1)}).
            {r.best.smallSample ? " A small sample: no path had 20 visits with a goal." : ""}
          </p>
        </Card>
      ) : (
        <p className="text-sm text-ink-muted" data-testid="marketing-journeys-best-none">
          No visit reached a goal in these days.
        </p>
      )}
      <Section
        title="Most common paths"
        meta={
          r.other.paths > 0
            ? `${countWords(r.other.paths)} other paths, ${countWords(r.other.visits)} visits`
            : `${countWords(r.visits)} visits`
        }
        testId="marketing-journeys-paths"
      >
        <DataTable>
          <thead>
            <tr className="dt-cols">
              <th>Path</th>
              <th className="n">Visits</th>
              <th className="n">Goals</th>
            </tr>
          </thead>
          <tbody>
            {r.paths.map((p) => (
              <tr key={`${p.pages.join(">")}:${p.longer}`}>
                <td className="min-w-[14rem] break-words">
                  {pathWords(p)}
                  {p.smallSample ? (
                    <span className="ml-2">
                      <SmallSample />
                    </span>
                  ) : null}
                </td>
                <td className="n">{countWords(p.visits)}</td>
                <td className="n">{countWords(p.goals)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Section>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Where visits leave"
          meta="Visits without a goal"
          testId="marketing-journeys-leaves"
        >
          <DataTable>
            <thead>
              <tr className="dt-cols">
                <th>Page</th>
                <th className="n">Left here</th>
                <th className="n">Of its readers</th>
              </tr>
            </thead>
            <tbody>
              {r.leaves.map((l) => (
                <tr key={l.path}>
                  <td className="break-all">{pageLink(l.path)}</td>
                  <td className="n">{countWords(l.left)}</td>
                  <td className="n">{percentWords(l.leftRate)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Section>
        <Section title="Last page before a goal" testId="marketing-journeys-last">
          {r.lastPage.length === 0 ? (
            <p className="text-sm text-ink-muted">No visit reached a goal in these days.</p>
          ) : (
            <DataTable>
              <thead>
                <tr className="dt-cols">
                  <th>Page</th>
                  <th className="n">Visits</th>
                </tr>
              </thead>
              <tbody>
                {r.lastPage.map((l) => (
                  <tr key={l.path}>
                    <td className="break-all">{pageLink(l.path)}</td>
                    <td className="n">{countWords(l.visits)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Section>
      </div>
      <Section title="Goal funnel by entry page" testId="marketing-journeys-funnel">
        <DataTable>
          <thead>
            <tr className="dt-cols">
              <th>Entered on</th>
              <th className="n">Landed</th>
              <th className="n">Saw a form</th>
              <th className="n">Reached a goal</th>
              <th className="n">Goal rate</th>
            </tr>
          </thead>
          <tbody>
            {r.funnel.map((f) => (
              <tr key={f.entry}>
                <td className="break-all">
                  {pageLink(f.entry)}
                  {f.smallSample ? (
                    <span className="ml-2">
                      <SmallSample />
                    </span>
                  ) : null}
                </td>
                <td className="n">{countWords(f.landed)}</td>
                <td className="n">{countWords(f.sawForm)}</td>
                <td className="n">
                  <Link
                    to={withKept(MARKETING_PATHS.visits(clientId), kept, {
                      entry: f.entry,
                      goal: "yes",
                    })}
                    className="text-link hover:underline"
                  >
                    {countWords(f.goals)}
                  </Link>
                </td>
                <td className="n">{percentWords(f.goalRate, 1)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PrivacyFooter />
        <CsvLink
          href={marketingCsvHref(clientId, "journeys", query)}
          testId="marketing-journeys-csv"
        />
      </div>
    </div>
  );
}
