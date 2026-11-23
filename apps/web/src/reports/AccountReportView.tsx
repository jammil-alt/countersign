// R5 (docs/reporting-plan.md §3 R5, docs/plan.md §1.235): one client's report, the same on both
// surfaces apart from what the back office adds above it (why the client needs us). Each figure
// that carries a RunFilter opens exactly its runs on the surface's runs list; the others open what
// the surface links them to (the client's Escalations, its connections, its billing), or nothing.
// Loaded with the report's screen, its words with it.
import {
  FAILED_RUN_ESCALATION_DAYS,
  type PortalAccountReport,
  type RunFilter,
} from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/i18n";
import { msWords } from "../runs/format";
import { KpiStrip, StatTile } from "../ui/figures";
import { Columns, Section } from "../ui/page";
import { Badge, Card, EmptyState } from "../ui/primitives";
import { periodLabel } from "../usage/format";
import { type AccountKey, accountWord } from "./account-words";
import { type ReportKey, reportWord } from "./report-words";

type Connection = PortalAccountReport["connections"][number];

/** Where the figures without a RunFilter lead on this surface; none: not a link. */
export interface AccountLinks {
  failedUnseen?: string;
  connection?: (c: Connection) => string;
  usage?: string;
  /** The agent's own report. */
  agent?: (id: string) => string;
}

/** "42%": a share of the allowance, rounded down so 99.6% never reads as 100%. */
export function sharePercent(share: number | null): string {
  return share === null ? "–" : `${Math.floor(share * 100)}%`;
}

export function AccountReportView({
  report,
  runsLink,
  csvHref,
  links = {},
  above,
  surface = "portal",
}: {
  /** The portal's report, or the back office's (which holds it). */
  report: PortalAccountReport;
  /**
   * Whose open items "waiting now" counts: the portal's are the client's own, the back office's
   * every open item, ours included (QA CL1: 22, 24 and 26 for one client with no word for which).
   */
  surface?: "portal" | "ops";
  runsLink: (filter: RunFilter) => string;
  csvHref: string;
  links?: AccountLinks;
  /** What the back office adds first: why the client needs us. */
  above?: ReactNode;
}) {
  const i18n = useI18n();
  const { fmt, locale } = i18n;
  const r = (k: ReportKey, p?: Record<string, string | number>) => reportWord(locale, k, p);
  const w = (k: AccountKey, p?: Record<string, string | number>) => accountWord(locale, k, p);
  const to = (f: RunFilter | null | undefined) => (f ? runsLink(f) : undefined);
  const time = (v: number | null) => (v === null ? "–" : msWords(v, i18n));
  const before = (value: string) => r("before", { value });
  const age = (since: string | null) =>
    since ? msWords(Math.max(0, Date.now() - Date.parse(since)), i18n) : "–";
  const h = report.headline;
  const p = report.previous;
  const waiting = report.waiting;

  return (
    <div className="flex flex-col gap-6" data-testid="account-report">
      {above}
      <Section
        title={w("title")}
        meta={periodLabel(report.from, report.to, i18n.intl)}
        action={
          <a
            href={csvHref}
            download
            className="text-sm text-link hover:underline"
            data-testid="account-report-csv"
          >
            {r("csv")}
          </a>
        }
      >
        <KpiStrip testId="account-report-runs">
          <StatTile
            testId="account-report-runs-all"
            label={r("runs")}
            value={fmt.number(report.runs.count)}
            to={to(report.runs.filter)}
            note={before(fmt.number(p.runs))}
          />
          <StatTile
            testId="account-report-runs-done"
            label={r("done")}
            value={fmt.number(report.done.count)}
            tone={report.done.count > 0 ? "positive" : undefined}
            to={to(report.done.filter)}
            note={before(fmt.number(p.done))}
          />
          <StatTile
            testId="account-report-runs-failed"
            label={r("failed")}
            value={fmt.number(report.failed.count)}
            tone={report.failed.count > 0 ? "risk" : undefined}
            to={to(report.failed.filter)}
            note={before(fmt.number(p.failed))}
          />
          <StatTile
            testId="account-report-finish"
            label={r("finish")}
            value={time(h.finishMedianMs)}
            note={before(time(p.finishMedianMs))}
          />
        </KpiStrip>
      </Section>

      <Columns count={3}>
        <StatTile
          testId="account-report-waiting"
          label={w("waitingNow")}
          value={fmt.number(waiting.runs.count)}
          tone={waiting.runs.count > 0 || waiting.items > 0 ? "signal" : undefined}
          to={to(waiting.runs.filter)}
          note={
            waiting.items > 0
              ? w(surface === "ops" ? "waitingNoteOps" : "waitingNote", {
                  items: fmt.number(waiting.items),
                  age: age(waiting.oldestSince),
                })
              : w("nothingWaiting")
          }
          {...(waiting.overdue > 0 ? { noteTone: "signal" as const } : {})}
        />
        <StatTile
          testId="account-report-failed-unseen"
          label={w("failedUnseen")}
          value={fmt.number(report.failedUnseen.count)}
          tone={report.failedUnseen.count > 0 ? "risk" : undefined}
          to={to(report.failedUnseen.filter) ?? links.failedUnseen}
          note={w("failedUnseenNote", { days: FAILED_RUN_ESCALATION_DAYS })}
        />
        {report.usage ? (
          <StatTile
            testId="account-report-usage"
            label={w("usage")}
            value={sharePercent(report.usage.share)}
            to={links.usage}
            note={w("usageNote", {
              used: fmt.number(report.usage.used),
              included: fmt.number(report.usage.included),
            })}
          />
        ) : null}
      </Columns>

      <Card title={w("connections")} titleAbove testId="account-report-connections">
        {report.connections.length === 0 ? (
          <p className="ui-card__body text-sm text-ink-muted">{w("connectionsNone")}</p>
        ) : (
          <ul className="ui-card__body flex flex-col gap-2 text-sm">
            {report.connections.map((c) => {
              const href = links.connection?.(c);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3">
                  {href ? (
                    <Link to={href} className="hover:underline">
                      {c.name}
                    </Link>
                  ) : (
                    <span>{c.name}</span>
                  )}
                  <span className="flex items-center gap-2 text-ink-muted">
                    <Badge tone="risk">{w(`attention.${c.attention}`)}</Badge>
                    {w("since", { date: fmt.day(c.since) })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {report.agents.length > 0 ? (
        <Card title={w("agents")} titleAbove testId="account-report-agents">
          <div className="dt dt-ana overflow-x-auto">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>{w("agent")}</th>
                  <th className="n">{r("runs")}</th>
                  <th className="n">{r("done")}</th>
                  <th className="n">{r("failed")}</th>
                  <th className="n">{w("waitingNow")}</th>
                  <th className="n">{r("finish")}</th>
                  <th className="n">{r("approvals")}</th>
                  <th className="n">{r("count")}</th>
                </tr>
              </thead>
              <tbody>
                {report.agents.map((a) => {
                  const cell = (n: number, f: RunFilter | null) => {
                    const link = n > 0 ? to(f) : undefined;
                    return link ? (
                      <Link to={link} className="hover:underline">
                        {fmt.number(n)}
                      </Link>
                    ) : (
                      fmt.number(n)
                    );
                  };
                  const page = links.agent?.(a.service.id);
                  return (
                    <tr key={a.service.id} data-testid={`account-report-agent-${a.service.id}`}>
                      <td>
                        {page ? (
                          <Link to={page} className="hover:underline">
                            {a.service.name}
                          </Link>
                        ) : (
                          a.service.name
                        )}
                      </td>
                      <td className="n figures" title={before(fmt.number(a.previous.runs))}>
                        {cell(a.runs.count, a.runs.filter)}
                      </td>
                      <td className="n figures">{cell(a.done.count, a.done.filter)}</td>
                      <td className="n figures">{cell(a.failed.count, a.failed.filter)}</td>
                      <td className="n figures">{cell(a.waiting.count, a.waiting.filter)}</td>
                      <td className="n figures">{time(a.headline.finishMedianMs)}</td>
                      <td className="n figures">{fmt.number(a.headline.approvals)}</td>
                      <td className="n figures">{fmt.number(a.headline.changes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {report.runs.count === 0 && report.agents.length === 0 ? (
        <EmptyState>{r("none")}</EmptyState>
      ) : null}
    </div>
  );
}
