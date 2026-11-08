// `/reports/marketing/overview` in the portal (M50, docs/plan.md §1.78): the client's own website
// over the last 7, 28 or 90 finished days against the days before: visits, goals, visits that left
// at once, the median time engaged, the days, the top pages and where visits came from. Read only;
// small samples and days not counted yet are marked, as in the back office (M44).
import { useSearchParams } from "react-router-dom";
import type { PlainKey } from "../../../i18n/catalog";
import { useI18n } from "../../../i18n/i18n";
import { StatusFilter } from "../../../inbox/StatusFilter";
import { Delta, KpiStrip, Sparkbars, StatTile } from "../../../ui/figures";
import { Loaded, Section } from "../../../ui/page";
import { Badge, Card, EmptyState, PageHeader } from "../../../ui/primitives";
import { periodLabel } from "../../../usage/format";
import {
  bandWords,
  changeWords,
  PortalCsvLink,
  type PortalSite,
  PrivacyLine,
  percent,
  SitePicker,
  sourceWords,
  usePortalReport,
  useSiteParam,
} from "./shared";

interface Totals {
  visits: number;
  views: number;
  goals: number;
  bounces: number;
  goalRate: string | null;
  bounceRate: string | null;
  medianEngaged: { fromSeconds: number; toSeconds: number | null } | null;
  smallSample: boolean;
}

/** The overview report as the portal reads it (packs/marketing/src/reports.ts). */
export interface PortalOverview {
  site: PortalSite | null;
  sites: PortalSite[];
  range: { from: string; to: string; days: number; includesToday: boolean };
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

const PERIODS = [
  ["7", "marketing.period.7"],
  ["28", "marketing.period.28"],
  ["90", "marketing.period.90"],
] as const satisfies readonly (readonly [string, PlainKey])[];

export function PortalWebsiteScreen() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [site, setSite] = useSiteParam();
  const period = PERIODS.find(([p]) => p === params.get("period"))?.[0] ?? "28";
  const query = { site, period };
  const state = usePortalReport<PortalOverview>("overview", query);
  return (
    <div className="flex flex-col gap-6" data-testid="portal-marketing-website">
      <PageHeader
        title={t("marketing.website.title")}
        subtitle={t("marketing.website.subtitle")}
        actions={<PortalCsvLink report="overview" query={query} />}
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter
          value={period}
          onChange={(p) => {
            const next = new URLSearchParams(params);
            if (p === "28") next.delete("period");
            else next.set("period", p);
            setParams(next, { replace: true });
          }}
          area="portal-marketing-period"
          label={t("marketing.period")}
          options={PERIODS.map(([p, l]) => [p, t(l)])}
        />
        <SitePicker sites={state.data?.sites} value={state.data?.site?.id} onChange={setSite} />
      </div>
      <Loaded state={state}>{(r) => (r.site ? <WebsiteBody r={r} /> : <NoSite />)}</Loaded>
      <PrivacyLine />
    </div>
  );
}

export function NoSite() {
  const { t } = useI18n();
  return (
    <EmptyState
      testId="portal-marketing-no-site"
      title={t("marketing.noSite")}
      line={t("marketing.noSiteLine")}
    />
  );
}

function WebsiteBody({ r }: { r: PortalOverview }) {
  const i18n = useI18n();
  const { t, fmt, intl } = i18n;
  const now = r.totals;
  const notCounted = r.daily.filter((d) => !d.built).length;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-muted" data-testid="portal-marketing-range">
        {t("marketing.rangeLine", {
          count: r.range.days,
          period: periodLabel(r.range.from, r.range.to, intl),
        })}
        {notCounted > 0 ? ` ${t("marketing.notCounted", { count: notCounted })}` : ""}
      </p>
      <KpiStrip testId="portal-marketing-kpis">
        <StatTile
          label={t("marketing.website.visits")}
          value={fmt.number(now.visits)}
          mark={
            <Delta now={now.visits} before={r.previousTotals.visits} words={changeWords(i18n)} />
          }
          note={
            now.smallSample ? (
              <Badge tone="neutral">{t("marketing.smallSample")}</Badge>
            ) : (
              t("marketing.website.pagesRead", { count: now.views })
            )
          }
          testId="portal-marketing-visits"
        />
        <StatTile
          label={t("marketing.website.goals")}
          value={fmt.number(now.goals)}
          note={t("marketing.website.goalShare", { rate: percent(now.goalRate, i18n) })}
          testId="portal-marketing-goals"
        />
        <StatTile
          label={t("marketing.website.bounce")}
          value={percent(now.bounceRate, i18n)}
          note={t("marketing.website.bounceNote", { count: now.bounces })}
          testId="portal-marketing-bounces"
        />
        <StatTile
          label={t("marketing.website.engaged")}
          value={bandWords(now.medianEngaged, i18n)}
          note={t("marketing.website.perVisit")}
          testId="portal-marketing-engaged"
        />
      </KpiStrip>

      <Section title={t("marketing.website.byDay")} testId="portal-marketing-days">
        {r.daily.some((d) => d.visits > 0) ? (
          <Sparkbars
            values={r.daily.map((d) => ({ value: d.visits }))}
            label={t("marketing.website.byDayLabel", {
              period: periodLabel(r.range.from, r.range.to, intl),
            })}
          />
        ) : (
          <EmptyState
            testId="portal-marketing-no-visits"
            title={t("marketing.website.noVisits")}
            line={t("marketing.website.noVisitsLine")}
          />
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t("marketing.website.pages")} testId="portal-marketing-pages">
          <Card>
            <div className="dt dt-ana overflow-x-auto">
              <table>
                <thead>
                  <tr className="dt-cols">
                    <th>{t("marketing.col.page")}</th>
                    <th className="n">{t("marketing.col.views")}</th>
                    <th className="n">{t("marketing.col.goals")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.pages.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-ink-muted">
                        {t("marketing.website.noPages")}
                      </td>
                    </tr>
                  ) : null}
                  {r.pages.map((p) => (
                    <tr key={p.path}>
                      <td className="max-w-[16rem] break-all">{p.path}</td>
                      <td className="n">{fmt.number(p.views)}</td>
                      <td className="n">{fmt.number(p.goals)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Section>
        <Section title={t("marketing.website.sources")} testId="portal-marketing-sources">
          <Card>
            <div className="dt dt-ana overflow-x-auto">
              <table>
                <thead>
                  <tr className="dt-cols">
                    <th>{t("marketing.col.source")}</th>
                    <th className="n">{t("marketing.col.visits")}</th>
                    <th className="n">{t("marketing.col.goals")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.sources.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-ink-muted">
                        {t("marketing.website.noSources")}
                      </td>
                    </tr>
                  ) : null}
                  {r.sources.map((s) => (
                    <tr key={s.source}>
                      <td className="break-all">{sourceWords(s.group, s.name, i18n)}</td>
                      <td className="n">{fmt.number(s.visits)}</td>
                      <td className="n">{fmt.number(s.goals)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Section>
      </div>
      {r.filtered > 0 ? (
        <p className="text-sm text-ink-muted" data-testid="portal-marketing-filtered">
          {t("marketing.website.filtered", { count: r.filtered })}
        </p>
      ) : null}
    </div>
  );
}
