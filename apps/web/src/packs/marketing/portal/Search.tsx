// `/reports/marketing/search` in the portal (M50, docs/plan.md §1.78): how the client's site shows
// up in Google and Bing over the last 28 days the figures cover, against the 28 before: times shown,
// clicks, click rate and average position; the top searches and pages; and the searches close to
// page one. Read only, with the day the figures run to. Searches are what people typed: shown as
// written, never as anything else.

import { useSearchParams } from "react-router-dom";
import type { PlainKey } from "../../../i18n/catalog";
import { useI18n } from "../../../i18n/i18n";
import { StatusFilter } from "../../../inbox/StatusFilter";
import { Delta, KpiStrip, StatTile } from "../../../ui/figures";
import { Loaded, Section } from "../../../ui/page";
import { Badge, Card, EmptyState, PageHeader } from "../../../ui/primitives";
import { dayLabel, periodLabel } from "../../../usage/format";
import {
  changeWords,
  PortalCsvLink,
  type PortalSite,
  percent,
  position,
  SitePicker,
  usePortalReport,
  useSiteParam,
} from "./shared";
import { NoSite } from "./Website";

interface Totals {
  impressions: number;
  clicks: number;
  ctr: string | null;
  position: number | null;
  smallSample: boolean;
}

/** The search report as the portal reads it (packs/marketing/src/search/figures.ts). */
export interface PortalSearch {
  site: PortalSite | null;
  provider: "google" | "bing" | null;
  dataRunsTo: string | null;
  period: { from: string; to: string };
  cappedToData: boolean;
  totals: Totals;
  previousTotals: Totals;
  queries: (Totals & { query: string; topPage: string | null })[];
  pages: (Totals & { path: string })[];
  closeToPageOne: {
    query: string;
    position: number;
    impressions: number;
    topPage: string | null;
    smallSample: boolean;
  }[];
}

/** What the screen shows of each list: the report gives more, for the CSV. */
const SHOWN = { queries: 15, pages: 10, near: 8 };

const PROVIDERS = [
  ["all", "marketing.search.provider.all"],
  ["google", "marketing.search.provider.google"],
  ["bing", "marketing.search.provider.bing"],
] as const satisfies readonly (readonly [string, PlainKey])[];

export function PortalSearchScreen() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [site, setSite] = useSiteParam();
  const provider = PROVIDERS.find(([p]) => p === params.get("provider"))?.[0] ?? "all";
  const query = { site, provider: provider === "all" ? "" : provider };
  const state = usePortalReport<PortalSearch>("search", query);
  // The overview's list of sites: the search report names only the chosen one.
  const sites = usePortalReport<{ sites: PortalSite[] }>("overview", { site });
  return (
    <div className="flex flex-col gap-6" data-testid="portal-marketing-search">
      <PageHeader
        title={t("marketing.search.title")}
        subtitle={t("marketing.search.subtitle")}
        actions={<PortalCsvLink report="search" query={query} />}
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter
          value={provider}
          onChange={(p) => {
            const next = new URLSearchParams(params);
            if (p === "all") next.delete("provider");
            else next.set("provider", p);
            setParams(next, { replace: true });
          }}
          area="portal-marketing-provider"
          label={t("marketing.search.provider")}
          options={PROVIDERS.map(([p, l]) => [p, t(l)])}
        />
        <SitePicker sites={sites.data?.sites} value={state.data?.site?.id} onChange={setSite} />
      </div>
      <Loaded state={state}>{(r) => (r.site ? <SearchBody r={r} /> : <NoSite />)}</Loaded>
    </div>
  );
}

function SearchBody({ r }: { r: PortalSearch }) {
  const i18n = useI18n();
  const { t, fmt, intl } = i18n;
  if (!r.dataRunsTo) {
    return (
      <EmptyState
        testId="portal-marketing-search-empty"
        title={t("marketing.search.none")}
        line={t("marketing.search.noneLine")}
      />
    );
  }
  const now = r.totals;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-muted" data-testid="portal-marketing-search-range">
        {t("marketing.search.rangeLine", {
          period: periodLabel(r.period.from, r.period.to, intl),
          day: dayLabel(r.dataRunsTo, intl),
        })}
        {r.cappedToData ? ` ${t("marketing.search.capped")}` : ""}
      </p>
      <KpiStrip testId="portal-marketing-search-kpis">
        <StatTile
          label={t("marketing.search.impressions")}
          value={fmt.number(now.impressions)}
          mark={
            <Delta
              now={now.impressions}
              before={r.previousTotals.impressions}
              words={changeWords(i18n)}
            />
          }
          note={now.smallSample ? <Badge tone="neutral">{t("marketing.smallSample")}</Badge> : null}
          testId="portal-marketing-search-impressions"
        />
        <StatTile
          label={t("marketing.search.clicks")}
          value={fmt.number(now.clicks)}
          mark={
            <Delta now={now.clicks} before={r.previousTotals.clicks} words={changeWords(i18n)} />
          }
          testId="portal-marketing-search-clicks"
        />
        <StatTile
          label={t("marketing.search.ctr")}
          value={percent(now.ctr, i18n)}
          testId="portal-marketing-search-ctr"
        />
        <StatTile
          label={t("marketing.search.position")}
          value={position(now.position, i18n)}
          note={t("marketing.search.positionNote")}
          testId="portal-marketing-search-position"
        />
      </KpiStrip>

      <Section title={t("marketing.search.queries")} testId="portal-marketing-search-queries">
        <Card>
          <div className="dt dt-ana overflow-x-auto">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>{t("marketing.col.query")}</th>
                  <th className="n">{t("marketing.col.impressions")}</th>
                  <th className="n">{t("marketing.col.clicks")}</th>
                  <th className="n">{t("marketing.col.position")}</th>
                </tr>
              </thead>
              <tbody>
                {r.queries.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-ink-muted">
                      {t("marketing.search.noQueries")}
                    </td>
                  </tr>
                ) : null}
                {r.queries.slice(0, SHOWN.queries).map((q) => (
                  <tr key={`${q.query} ${q.topPage ?? ""}`}>
                    <td className="max-w-[18rem] break-words">{q.query}</td>
                    <td className="n">{fmt.number(q.impressions)}</td>
                    <td className="n">{fmt.number(q.clicks)}</td>
                    <td className="n">{position(q.position, i18n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <p className="mt-2 text-sm text-ink-muted">{t("marketing.search.private")}</p>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t("marketing.search.pages")} testId="portal-marketing-search-pages">
          <Card>
            <div className="dt dt-ana overflow-x-auto">
              <table>
                <thead>
                  <tr className="dt-cols">
                    <th>{t("marketing.col.page")}</th>
                    <th className="n">{t("marketing.col.clicks")}</th>
                    <th className="n">{t("marketing.col.position")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.pages.slice(0, SHOWN.pages).map((p) => (
                    <tr key={p.path}>
                      <td className="max-w-[16rem] break-all">{p.path}</td>
                      <td className="n">{fmt.number(p.clicks)}</td>
                      <td className="n">{position(p.position, i18n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Section>
        <Section
          title={t("marketing.search.close")}
          meta={t("marketing.search.closeLine")}
          testId="portal-marketing-search-close"
        >
          {r.closeToPageOne.length === 0 ? (
            <EmptyState line={t("marketing.search.closeNone")} />
          ) : (
            <Card>
              <div className="dt dt-ana overflow-x-auto">
                <table>
                  <thead>
                    <tr className="dt-cols">
                      <th>{t("marketing.col.query")}</th>
                      <th className="n">{t("marketing.col.position")}</th>
                      <th className="n">{t("marketing.col.impressions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.closeToPageOne.slice(0, SHOWN.near).map((q) => (
                      <tr key={`${q.query} ${q.topPage ?? ""}`}>
                        <td className="max-w-[16rem] break-words">{q.query}</td>
                        <td className="n">{position(q.position, i18n)}</td>
                        <td className="n">{fmt.number(q.impressions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      </div>
    </div>
  );
}
