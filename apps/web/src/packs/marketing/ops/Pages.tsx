// Pages (M44, docs/marketing-plan.md §4.7): every page read in the period, with its views, entries,
// exit rate, median time engaged (a band: the daily figures keep bands, not each view's time), how
// far half its readers got, and the visits that entered on it and reached a goal. A page opens in
// depth.
import { Link } from "react-router-dom";
import { Loaded } from "../../../ui/page";
import { EmptyState } from "../../../ui/primitives";
import { marketingCsvHref, useMarketingReport } from "./api";
import {
  bandWords,
  CsvLink,
  countWords,
  DataTable,
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

export interface PageRow {
  path: string;
  views: number;
  entries: number;
  exits: number;
  exitRate: string | null;
  goals: number;
  formSeen: number;
  medianEngaged: MedianBand | null;
  halfReadTo: number;
  smallSample: boolean;
}

export interface PagesReport extends RangedReport {
  pages: PageRow[];
}

/** "Half read to 75%": how far down half the page's readers got. */
export function halfWords(quarter: number): string {
  return quarter === 0 ? "Under a quarter" : `${quarter * 25}%`;
}

export function MarketingPagesScreen() {
  const clientId = useMarketingClientId();
  const { query } = useMarketingQuery();
  const kept = useKeptQuery();
  const state = useMarketingReport<PagesReport>(clientId, "pages", query);
  return (
    <MarketingLayout
      title="Pages"
      testId="marketing-pages"
      actions={<MarketingFilters sites={state.data?.sites} />}
    >
      <Loaded state={state}>
        {(r) =>
          !r.site ? (
            <NoSite clientId={clientId} />
          ) : (
            <div className="flex flex-col gap-4">
              <RangeLine range={r.range} />
              {r.pages.length === 0 ? (
                <EmptyState
                  testId="marketing-pages-empty"
                  title="No pages read in these days"
                  line="Pages show here the day after their first visit."
                />
              ) : (
                <DataTable testId="marketing-pages-table">
                  <thead>
                    <tr className="dt-cols">
                      <th>Page</th>
                      <th className="n">Views</th>
                      <th className="n">Entries</th>
                      <th className="n">Exit rate</th>
                      <th>Median engaged</th>
                      <th>Half read to</th>
                      <th className="n">Goals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.pages.map((p) => (
                      <tr key={p.path}>
                        <td className="max-w-[18rem] break-all">
                          <Link
                            to={withKept(MARKETING_PATHS.page(clientId, p.path), kept)}
                            className="text-link hover:underline"
                            data-testid={`marketing-pages-open-${p.path}`}
                          >
                            {p.path}
                          </Link>
                          {p.smallSample ? (
                            <span className="ml-2">
                              <SmallSample />
                            </span>
                          ) : null}
                        </td>
                        <td className="n">{countWords(p.views)}</td>
                        <td className="n">{countWords(p.entries)}</td>
                        <td className="n">{percentWords(p.exitRate)}</td>
                        <td className="whitespace-nowrap">{bandWords(p.medianEngaged)}</td>
                        <td className="whitespace-nowrap">{halfWords(p.halfReadTo)}</td>
                        <td className="n">{countWords(p.goals)}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PrivacyFooter />
                <CsvLink
                  href={marketingCsvHref(clientId, "pages", query)}
                  testId="marketing-pages-csv"
                />
              </div>
            </div>
          )
        }
      </Loaded>
    </MarketingLayout>
  );
}
