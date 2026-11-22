// R4 (docs/reporting-plan.md §3 R4, docs/plan.md §1.214): one agent's report, the same on both
// surfaces apart from what the back office adds below it (its errors and cost). Each figure that
// carries a RunFilter opens exactly its runs on the surface's runs list; one without (RunFilter
// can't say it exactly) is not a link. Loaded with the Report tab, its words with it.
import type { PortalAgentReport, RunFilter, RunsPerDay } from "@countersign/core";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/i18n";
import { RunsPerDayChart } from "../portal/screens/runsParts";
import { msWords } from "../runs/format";
import { KpiStrip, StatTile } from "../ui/figures";
import { Field, TextInput } from "../ui/forms";
import { Columns, Section } from "../ui/page";
import { Button, Card, EmptyState } from "../ui/primitives";
import { periodLabel } from "../usage/format";
import { type ReportKey, reportWord } from "./report-words";

/** The report's period as the address keeps it; none: this month. */
export interface ReportPeriod {
  from?: string;
  to?: string;
}

/** The query a period asks with. */
export function periodQuery(p: ReportPeriod): Record<string, string> {
  return { ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}) };
}

/** The report's period picker: from, to, and back to this month. */
export function ReportPeriodForm({
  period,
  onChange,
}: {
  period: ReportPeriod;
  onChange: (p: ReportPeriod) => void;
}) {
  const { locale } = useI18n();
  const w = (k: ReportKey) => reportWord(locale, k);
  const [from, setFrom] = useState(period.from ?? "");
  const [to, setTo] = useState(period.to ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onChange({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3"
      data-testid="agent-report-period"
    >
      <Field label={w("from")} className="w-auto">
        <TextInput
          type="date"
          className="w-auto"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          data-testid="agent-report-from"
        />
      </Field>
      <Field label={w("to")} className="w-auto">
        <TextInput
          type="date"
          className="w-auto"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          data-testid="agent-report-to"
        />
      </Field>
      <Button size="sm" type="submit" data-testid="agent-report-show">
        {w("show")}
      </Button>
      {period.from || period.to ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setFrom("");
            setTo("");
            onChange({});
          }}
          data-testid="agent-report-this-month"
        >
          {w("thisMonth")}
        </Button>
      ) : null}
    </form>
  );
}

/** The report's runs per day, as the runs list draws them. */
function asPerDay(report: PortalAgentReport): RunsPerDay {
  return report.perDay.map((d) => ({
    day: d.day,
    runs: d.done.count + d.waiting.count + d.failed.count + d.stopped.count + d.going.count,
    failed: d.failed.count,
    done: d.done.count,
    waiting: d.waiting.count,
    going: d.going.count,
    stopped: d.stopped.count,
  }));
}

export function AgentReportView({
  report,
  runsLink,
  csvHref,
  extra,
}: {
  /** The portal's report, or the back office's (which holds it). */
  report: PortalAgentReport;
  /** The surface's runs list on exactly these runs. */
  runsLink: (filter: RunFilter) => string;
  csvHref: string;
  /** What the back office adds: its errors and cost. */
  extra?: ReactNode;
}) {
  const i18n = useI18n();
  const { fmt, locale } = i18n;
  const w = (k: ReportKey, p?: Record<string, string | number>) => reportWord(locale, k, p);
  const to = (f: RunFilter | null | undefined) => (f ? runsLink(f) : undefined);
  const time = (v: number | null) => (v === null ? "–" : msWords(v, i18n));
  const h = report.headline;
  const p = report.previous;
  const before = (value: string) => w("before", { value });
  const approvals = report.approvals;
  const empty = report.runs.count === 0;

  return (
    <div className="flex flex-col gap-6" data-testid="agent-report">
      <Section
        title={w("title")}
        meta={periodLabel(report.from, report.to, i18n.intl)}
        action={
          <a
            href={csvHref}
            download
            className="text-sm text-link hover:underline"
            data-testid="agent-report-csv"
          >
            {w("csv")}
          </a>
        }
      >
        <KpiStrip testId="agent-report-runs">
          <StatTile
            testId="agent-report-runs-all"
            label={w("runs")}
            value={fmt.number(report.runs.count)}
            to={to(report.runs.filter)}
            note={before(fmt.number(p.runs))}
          />
          <StatTile
            testId="agent-report-runs-done"
            label={w("done")}
            value={fmt.number(report.outcomes.done.count)}
            tone={report.outcomes.done.count > 0 ? "positive" : undefined}
            to={to(report.outcomes.done.filter)}
            note={before(fmt.number(p.done))}
          />
          <StatTile
            testId="agent-report-runs-failed"
            label={w("failed")}
            value={fmt.number(report.outcomes.failed.count)}
            tone={report.outcomes.failed.count > 0 ? "risk" : undefined}
            to={to(report.outcomes.failed.filter)}
            note={before(fmt.number(p.failed))}
          />
          <StatTile
            testId="agent-report-finish"
            label={w("finish")}
            value={time(h.finishMedianMs)}
            to={to(report.timeToFinish.runs.filter)}
            note={
              report.timeToFinish.runs.count > 0
                ? w("finishNote", {
                    count: fmt.number(report.timeToFinish.runs.count),
                    p90: time(report.timeToFinish.p90Ms),
                  })
                : before(time(p.finishMedianMs))
            }
          />
        </KpiStrip>
        {empty ? null : <RunsPerDayChart days={asPerDay(report)} testId="agent-report-days" />}
      </Section>

      <Columns count={3}>
        <StatTile
          testId="agent-report-waiting"
          label={w("waiting")}
          value={time(report.waitingOnPeople.medianMs)}
          tone={report.waitingOnPeople.open > 0 ? "signal" : undefined}
          note={w("waitingNote", { open: fmt.number(report.waitingOnPeople.open) })}
        />
        <StatTile
          testId="agent-report-approvals"
          label={w("approvals")}
          value={fmt.number(approvals.signed + approvals.edited + approvals.turnedDown)}
          note={before(fmt.number(p.approvals))}
        />
        <StatTile
          testId="agent-report-changes"
          label={w("changes")}
          value={fmt.number(report.changes.total.count)}
          to={to(report.changes.total.filter)}
          note={
            report.changes.amounts.length > 0
              ? report.changes.amounts.map((a) => fmt.money(a.total, a.currency)).join(", ")
              : before(fmt.number(p.changes))
          }
        />
      </Columns>

      {approvals.byPerson.length > 0 ? (
        <Card title={w("approvals")} titleAbove testId="agent-report-approvers">
          <div className="dt dt-ana overflow-x-auto">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>{w("person")}</th>
                  <th className="n">{w("signed")}</th>
                  <th className="n">{w("edited")}</th>
                  <th className="n">{w("turnedDown")}</th>
                </tr>
              </thead>
              <tbody>
                {approvals.byPerson.map((r) => {
                  const name = r.person?.name ?? (r.steppedIn ? w("us") : "–");
                  const link = to(r.filter);
                  return (
                    <tr key={r.person?.id ?? (r.steppedIn ? "us" : "unknown")}>
                      <td>
                        {link ? (
                          <Link to={link} className="hover:underline">
                            {name}
                          </Link>
                        ) : (
                          name
                        )}
                      </td>
                      <td className="n figures">{fmt.number(r.signed)}</td>
                      <td className="n figures">{fmt.number(r.edited)}</td>
                      <td className="n figures">{fmt.number(r.turnedDown)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {report.changes.byConnector.length > 0 ? (
        <Card title={w("changes")} titleAbove testId="agent-report-tools">
          <div className="dt dt-ana overflow-x-auto">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>{w("tool")}</th>
                  <th className="n">{w("count")}</th>
                  <th className="n">{w("amount")}</th>
                </tr>
              </thead>
              <tbody>
                {report.changes.byConnector.map((c) => (
                  <tr key={c.connector}>
                    <td>
                      {c.filter ? (
                        <Link to={runsLink(c.filter)} className="hover:underline">
                          {c.name}
                        </Link>
                      ) : (
                        c.name
                      )}
                      <span className="ml-2 text-sm text-ink-muted">
                        {c.entities.map((e) => `${e.entity} ${fmt.number(e.count)}`).join(", ")}
                      </span>
                    </td>
                    <td className="n figures">{fmt.number(c.count)}</td>
                    <td className="n figures">
                      {c.amounts.map((a) => fmt.money(a.total, a.currency)).join(", ") || "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {report.handled.length > 0 ? (
        <Section title={w("handled")} testId="agent-report-handled">
          <Columns count={3}>
            {report.handled.map((k) => {
              const link = to(k.filter);
              const title = w(`kind.${k.kind}` as ReportKey);
              return (
                <Card
                  key={k.kind}
                  title={link ? <Link to={link}>{title}</Link> : title}
                  meta={w("records", { count: fmt.number(k.records), runs: fmt.number(k.runs) })}
                >
                  <ul className="ui-card__body flex flex-col gap-1 text-sm">
                    {k.top.map((r) => {
                      const words = [r.label, r.number].filter(Boolean).join(" ") || "–";
                      const open = to(r.filter);
                      return (
                        <li key={r.id ?? words} className="flex justify-between gap-3">
                          {open ? (
                            <Link to={open} className="truncate hover:underline">
                              {words}
                            </Link>
                          ) : (
                            <span className="truncate">{words}</span>
                          )}
                          <span className="figures text-ink-muted">{fmt.number(r.runs)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              );
            })}
          </Columns>
        </Section>
      ) : null}

      {report.kpis.some((k) => k.display !== null) ? (
        <Section title={w("kpis")} testId="agent-report-kpis">
          <KpiStrip>
            {report.kpis
              .filter((k) => k.display !== null)
              .map((k) => (
                <StatTile key={k.id} label={k.label} value={k.display ?? ""} />
              ))}
          </KpiStrip>
        </Section>
      ) : null}

      {empty ? <EmptyState>{w("none")}</EmptyState> : null}
      {extra}
    </div>
  );
}
