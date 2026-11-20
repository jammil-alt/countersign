// Parts of the portal's agent page (`./Agent.tsx`) that draw from its answer alone, so the back
// office can show what the client sees for an agent with the portal's own pieces (docs/plan.md
// §1.163): its state chip, this month's figures and its run rows. Each link into the portal can be
// turned off, or pointed elsewhere, for a copy shown outside the portal.
import type { DayRuns } from "@countersign/core";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import type { apiRoutes } from "../../api/routes";
import type { Translate } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { shortTime } from "../../runs/format";
import { subjectTitle } from "../../runs/subject";
import { ActivityRow } from "../../ui/activity";
import { cx } from "../../ui/cx";
import { hasRuns, KpiStrip, Sparkline, StatTile } from "../../ui/figures";
import { Section } from "../../ui/page";
import type { ChipState } from "../../ui/status";
import { StatusChip } from "../../ui/status";
import { periodLabel } from "../../usage/format";
import { stageWord } from "../agentState";
import { PORTAL_PATHS } from "../paths";
import { agentChip, runChip } from "../status";
import { runsNote } from "./Reports";
import { RunTimes } from "./runsParts";

export type AgentDetail = ResponseOf<typeof apiRoutes.portalService>;
type ViewKpi = ResponseOf<typeof apiRoutes.portalServiceView>["kpis"][number];
type PortalRun = ResponseOf<typeof apiRoutes.portalRuns>["runs"][number];

/** The agent's state chip and its go-live stage's word, from its page's answer alone. */
export function detailState(
  detail: AgentDetail,
  t: Translate,
): { chip: { state: ChipState; label: string }; stage: string | null } {
  return {
    chip: agentChip(
      {
        status: detail.service.status,
        stage: detail.stage ?? null,
        now: detail.now ?? null,
        runsNow: detail.runsNow,
      },
      t,
    ),
    stage: stageWord(detail.stage ?? null, t),
  };
}

/**
 * The agent's own figures first (the owner's v1 agent page): runs this month (with its last 14
 * days), changes to your tools, documents read and what waits on you, then its template's own
 * KPIs. Runs always show; a figure at 0 is left out. Each links to its list, unless `linked` is
 * false (the back office's copy of the page: nothing there opens the portal).
 */
export function AgentFiguresStrip({
  id,
  detail,
  kpis: allKpis,
  perDay,
  waiting,
  linked = true,
}: {
  id: string;
  detail: AgentDetail;
  kpis: readonly ViewKpi[];
  perDay: readonly DayRuns[] | undefined;
  waiting: number;
  linked?: boolean;
}) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { thisMonth } = detail;
  // The client view's KPIs: labels and values, never their definition.
  const kpis = allKpis.filter((k) => k.display !== null);
  const runs14 = (perDay ?? []).reduce((n, d) => n + d.runs, 0);
  const reportPath = `${PORTAL_PATHS.reports}?service=${id}`;
  const to = (path: string) => (linked ? path : undefined);
  return (
    <Section
      title={t("service.thisMonth")}
      meta={periodLabel(thisMonth.from, thisMonth.to, i18n.intl)}
      action={
        linked ? (
          <Link
            to={reportPath}
            className="text-sm text-link hover:underline"
            data-testid="agent-full-report"
          >
            {t("agent.fullReport")}
          </Link>
        ) : null
      }
      testId="agent-month"
    >
      <KpiStrip testId="agent-figures">
        <StatTile
          testId="portal-service-runs"
          to={to(PORTAL_PATHS.agentRuns(id))}
          label={t("reports.runs")}
          value={fmt.number(thisMonth.runs.total)}
          tone={
            thisMonth.runs.failed > 0 ? "risk" : thisMonth.runs.succeeded > 0 ? "positive" : "slate"
          }
          mark={
            hasRuns(perDay) ? (
              <Sparkline
                days={perDay}
                label={t("kpi.runsDays", { count: runs14, days: perDay.length })}
                testId="agent-runs-spark"
              />
            ) : undefined
          }
          note={
            thisMonth.runs.total === 0 ? t("service.nothingRan") : runsNote(thisMonth.runs, i18n)
          }
        />
        {thisMonth.actions > 0 ? (
          <StatTile
            testId="portal-service-actions"
            to={to(reportPath)}
            label={t("reports.changes")}
            value={fmt.number(thisMonth.actions)}
            tone="slate"
          />
        ) : null}
        {thisMonth.documentsRead > 0 ? (
          <StatTile
            testId="portal-service-documents"
            to={to(PORTAL_PATHS.upload)}
            label={t("reports.documentsRead")}
            value={fmt.number(thisMonth.documentsRead)}
            tone="slate"
          />
        ) : null}
        {waiting > 0 ? (
          <StatTile
            testId="agent-kpi-waiting"
            to={to(PORTAL_PATHS.inbox)}
            label={t("home.kpi.waiting")}
            value={fmt.number(waiting)}
            tone="signal"
            note={t("home.kpi.waitingNote")}
          />
        ) : null}
        {kpis.map((k) => (
          <StatTile
            key={k.id}
            testId={`agent-kpi-${k.id}`}
            label={k.label}
            value={k.display ?? ""}
          />
        ))}
      </KpiStrip>
    </Section>
  );
}

/**
 * Run rows: its title (what it is about), how long it took, and its state. Each opens the run's
 * page in the portal, or `href`'s address (null: not a link).
 */
export function RunRows({
  runs,
  prefix,
  href = (id) => `/runs/${id}`,
}: {
  runs: readonly PortalRun[];
  prefix: string;
  href?: (runId: string) => string | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <>
      {runs.map((r) => {
        const chip = runChip(r, t);
        const title = subjectTitle(r.subject, i18n);
        const to = href(r.id);
        return (
          <ActivityRow
            key={r.id}
            testId={`${prefix}-${r.id}`}
            {...(to ? { to } : {})}
            end={
              <StatusChip state={chip.state} testId={`${prefix}-${r.id}-state`}>
                {chip.label}
              </StatusChip>
            }
          >
            <span className="flex flex-col">
              {title ? <span className="line-clamp-2">{title}</span> : null}
              {/* DECISION: when it ran goes in this line, not a time column: times of different
                  lengths ("1:56 PM", "Nov 10, 12:36 PM") left the titles out of line. A run still
                  going says when it started; a finished one, when, then how long it took. */}
              <span className={cx("first-letter:uppercase", title && "text-sm text-ink-muted")}>
                {r.startedAt ? (
                  <>
                    {r.finishedAt ? `${shortTime(r.startedAt, undefined, i18n)} · ` : null}
                    <RunTimes run={r} />
                  </>
                ) : (
                  t("run.notStarted")
                )}
              </span>
            </span>
          </ActivityRow>
        );
      })}
    </>
  );
}
