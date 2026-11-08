// `/reports/marketing/weekly-report` in the portal (M50, docs/plan.md §1.78): the newest weekly
// report on the client's website and search, and the ones before it; `…/weekly-report/:id` opens
// one. Read only: what changed, why it probably did, what we can't know, and the three suggested
// actions with where each stands (the client's Mezonas lead marks them with the client). The
// report's text is the agent's words about the client's own figures, shown as written.
import { Link, useParams } from "react-router-dom";
import type { PlainKey } from "../../../i18n/catalog";
import { useI18n } from "../../../i18n/i18n";
import { Loaded, Section } from "../../../ui/page";
import { Badge, Card, EmptyState, PageHeader } from "../../../ui/primitives";
import { periodLabel } from "../../../usage/format";
import {
  PortalCsvLink,
  type PortalSite,
  SitePicker,
  usePortalItem,
  usePortalReport,
  useSiteParam,
} from "./shared";
import { NoSite } from "./Website";

export const WEEKLY = "weekly-report";
const BASE = `/reports/marketing/${WEEKLY}`;

export interface WeeklyListItem {
  id: string;
  periodFrom: string;
  periodTo: string;
  createdAt: string;
  read: boolean;
}

export interface WeeklyView extends WeeklyListItem {
  summary: string;
  changes: { text: string }[];
  causes: { text: string }[];
  unknown: string;
  actions: { idx: number; text: string; decision: "open" | "done" | "not_now" }[];
  sourceCount: number;
}

export interface PortalWeekly {
  site: PortalSite | null;
  sites: PortalSite[];
  reports: WeeklyListItem[];
  latest: WeeklyView | null;
}

const DECISION: Record<WeeklyView["actions"][number]["decision"], PlainKey> = {
  open: "marketing.weekly.action.open",
  done: "marketing.weekly.action.done",
  not_now: "marketing.weekly.action.not_now",
};

export function PortalWeeklyReportScreen() {
  const { t } = useI18n();
  const { id } = useParams();
  const [site, setSite] = useSiteParam();
  const query = { site };
  const list = usePortalReport<PortalWeekly>(WEEKLY, query);
  const one = usePortalItem<WeeklyView>(WEEKLY, id ?? null);
  return (
    <div className="flex flex-col gap-6" data-testid="portal-marketing-weekly">
      <PageHeader
        title={t("marketing.weekly.title")}
        subtitle={t("marketing.weekly.subtitle")}
        actions={<PortalCsvLink report={WEEKLY} query={query} />}
      />
      <SitePicker sites={list.data?.sites} value={list.data?.site?.id} onChange={setSite} />
      <Loaded state={list}>
        {(r) => {
          if (!r.site) return <NoSite />;
          if (id) {
            return (
              <Loaded state={one}>
                {(w) => <WeeklyBody w={w} reports={r.reports} current={w.id} />}
              </Loaded>
            );
          }
          if (!r.latest) {
            return (
              <EmptyState
                testId="portal-marketing-weekly-none"
                title={t("marketing.weekly.none")}
                line={t("marketing.weekly.noneLine")}
              />
            );
          }
          return <WeeklyBody w={r.latest} reports={r.reports} current={r.latest.id} />;
        }}
      </Loaded>
    </div>
  );
}

function Lines({ items, testId }: { items: { text: string }[]; testId: string }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-ink" data-testid={testId}>
      {items.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the report's lines keep their order.
        <li key={i}>{c.text}</li>
      ))}
    </ul>
  );
}

function WeeklyBody({
  w,
  reports,
  current,
}: {
  w: WeeklyView;
  reports: WeeklyListItem[];
  current: string;
}) {
  const { t, intl } = useI18n();
  const newest = reports[0]?.id;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex flex-col gap-6" data-testid="portal-marketing-weekly-report">
        <Card pad>
          <p className="eyebrow">
            {t("marketing.weekly.week", { period: periodLabel(w.periodFrom, w.periodTo, intl) })}
          </p>
          {w.summary ? (
            <p className="mt-2 text-ink" data-testid="portal-marketing-weekly-summary">
              {w.summary}
            </p>
          ) : null}
          <p className="mt-3 text-sm text-ink-muted">
            {t("marketing.weekly.sources", { count: w.sourceCount })}
          </p>
        </Card>
        {w.changes.length > 0 ? (
          <Section title={t("marketing.weekly.changes")}>
            <Lines items={w.changes} testId="portal-marketing-weekly-changes" />
          </Section>
        ) : null}
        {w.causes.length > 0 ? (
          <Section title={t("marketing.weekly.causes")}>
            <Lines items={w.causes} testId="portal-marketing-weekly-causes" />
          </Section>
        ) : null}
        {w.unknown ? (
          <Section title={t("marketing.weekly.unknown")}>
            <p className="text-ink">{w.unknown}</p>
          </Section>
        ) : null}
        <Section
          title={t("marketing.weekly.actions")}
          meta={t("marketing.weekly.actionsLine")}
          testId="portal-marketing-weekly-actions"
        >
          {w.actions.length === 0 ? (
            <EmptyState line={t("marketing.weekly.noActions")} />
          ) : (
            <ol className="flex flex-col gap-2">
              {w.actions.map((a) => (
                <li key={a.idx}>
                  <Card pad>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <span className="text-ink">{a.text}</span>
                      <Badge
                        tone={a.decision === "done" ? "positive" : "neutral"}
                        testId={`portal-marketing-weekly-action-${a.idx}`}
                      >
                        {t(DECISION[a.decision])}
                      </Badge>
                    </div>
                  </Card>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
      <Section title={t("marketing.weekly.past")} testId="portal-marketing-weekly-list">
        <ul className="flex flex-col divide-y divide-line">
          {reports.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              {r.id === current ? (
                <span className="font-medium text-ink">
                  {periodLabel(r.periodFrom, r.periodTo, intl)}
                </span>
              ) : (
                <Link
                  to={r.id === newest ? BASE : `${BASE}/${r.id}`}
                  className="text-ink hover:underline"
                  data-testid={`portal-marketing-weekly-open-${r.id}`}
                >
                  {periodLabel(r.periodFrom, r.periodTo, intl)}
                </Link>
              )}
              {r.read ? null : <Badge tone="neutral">{t("marketing.weekly.new")}</Badge>}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
