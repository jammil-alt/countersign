// `/weekly` (C8, docs/ui-plan.md): the Weekly Table, as the lead sent it (ARCHITECTURE §11.4;
// docs/plan.md §1.37). The latest sent week, or `?week=`; the lead's note, the week's figures (each
// counted from records), decisions the client answers in the lead thread, setup still to do, what
// each agent did, and next week. Never cost. Download as PDF; earlier weeks from the list.
import type { WeeklyDecision, WeeklyTableView } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { SourceLinks } from "../../records/SourceLinks";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { StatTile } from "../../ui/figures";
import { Select, TextArea } from "../../ui/forms";
import { Columns, Loaded, Page, Section } from "../../ui/page";
import {
  Button,
  buttonClass,
  Card,
  Count,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Tag,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { PORTAL_PATHS } from "../paths";

export function PortalWeeklyScreen() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const week = params.get("week");
  const state = useApi(apiRoutes.portalWeekly, { query: week ? { week } : {} });

  return (
    <Page width="narrow" testId="portal-weekly">
      <Loaded state={state}>
        {(data) =>
          data.table ? (
            <WeeklyTable
              table={data.table}
              weeks={data.weeks}
              onWeek={(w) => setParams(w ? { week: w } : {})}
              reload={state.reload}
            />
          ) : (
            <>
              <PageHeader title={t("weekly.title")} subtitle={t("weekly.subtitle")} />
              <EmptyState>{t("weekly.none")}</EmptyState>
            </>
          )
        }
      </Loaded>
    </Page>
  );
}

function WeeklyTable({
  table,
  weeks,
  onWeek,
  reload,
}: {
  table: WeeklyTableView;
  weeks: string[];
  onWeek: (week: string | null) => void;
  reload: () => void;
}) {
  const { t, fmt } = useI18n();
  const day = (d: string) => fmt.date(`${d}T12:00:00Z`);
  const { stats } = table;
  const lead = table.noteBy?.name ?? null;
  const open = table.decisions.filter((d) => !d.reply).length + table.setup.items.length;
  const changes = stats.changes.automatic + stats.changes.signed;
  const versus =
    stats.runs.change === 0
      ? t("weekly.stat.same")
      : stats.runs.change > 0
        ? t("weekly.stat.up", { n: fmt.number(stats.runs.change) })
        : t("weekly.stat.down", { n: fmt.number(-stats.runs.change) });

  return (
    <>
      <PageHeader
        eyebrow={t("weekly.weekOf", { date: day(table.weekStart) })}
        title={t("weekly.title")}
        subtitle={[
          lead ? t("weekly.fromLead", { name: lead }) : null,
          table.sentAt ? t("weekly.sent", { time: fmt.time(table.sentAt) }) : null,
        ]
          .filter(Boolean)
          .join(" ")}
        actions={
          <>
            {weeks.length > 1 ? (
              <Select
                aria-label={t("weekly.earlier")}
                data-testid="portal-weekly-weeks"
                className="w-auto"
                value={table.weekStart}
                onChange={(e) => onWeek(e.target.value === weeks[0] ? null : e.target.value)}
              >
                {weeks.map((w) => (
                  <option key={w} value={w}>
                    {t("weekly.weekOf", { date: day(w) })}
                  </option>
                ))}
              </Select>
            ) : null}
            <a
              href={`/api/weekly/${table.weekStart}/pdf`}
              download
              className={buttonClass("secondary")}
              data-testid="portal-weekly-pdf"
            >
              {t("weekly.pdf")}
            </a>
          </>
        }
      />

      {table.note ? (
        <div className="ui-leadnote" data-testid="portal-weekly-note">
          {lead ? <PersonBadge name={lead} line={t("nav.lead")} size="sm" /> : null}
          <p className="whitespace-pre-wrap">{table.note}</p>
        </div>
      ) : null}

      <Columns count={4}>
        <StatTile
          testId="portal-weekly-runs"
          label={t("weekly.stat.runs")}
          value={fmt.number(stats.runs.done)}
          note={versus}
        />
        <StatTile
          testId="portal-weekly-changes"
          label={t("weekly.stat.changes")}
          value={fmt.number(changes)}
          note={t("weekly.stat.changesNote", {
            signed: fmt.number(stats.changes.signed),
            automatic: fmt.number(stats.changes.automatic),
          })}
        />
        <StatTile
          testId="portal-weekly-signatures"
          label={t("weekly.stat.signatures")}
          value={fmt.number(stats.signatures.given)}
        />
        <StatTile
          testId="portal-weekly-documents"
          label={t("weekly.stat.documents")}
          value={fmt.number(stats.documents.read)}
        />
      </Columns>

      {table.decisions.length > 0 || table.setup.items.length > 0 ? (
        <Card
          title={t("weekly.decisions")}
          meta={open > 0 ? <Count n={open} tone="warning" /> : null}
          testId="portal-weekly-decisions"
        >
          {table.decisions.map((d) => (
            <Decision key={d.id} weekStart={table.weekStart} decision={d} onReplied={reload} />
          ))}
          {table.setup.items.map((s) => (
            <ActivityRow
              key={`${s.agentId}:${s.connector}`}
              badge={<StatusChip state="setup">{t("weekly.setup")}</StatusChip>}
              end={
                <Link
                  to={PORTAL_PATHS.accounts}
                  className={buttonClass("secondary", undefined, "sm")}
                >
                  {t("weekly.connect")}
                </Link>
              }
              testId={`portal-weekly-setup-${s.connector}`}
            >
              <span className="font-medium">{t("weekly.connectTool", { tool: s.tool })}</span>
              <span className="block text-sm text-ink-muted">
                {t("weekly.connectWhy", { agent: s.agentName, tool: s.tool })}
              </span>
            </ActivityRow>
          ))}
        </Card>
      ) : null}

      {stats.agents.length > 0 ? (
        <Card title={t("weekly.team")} testId="portal-weekly-team">
          {stats.agents.map((a) => (
            <ActivityRow
              key={a.id}
              badge={<AgentBadge name={a.name} seed={a.id} size="sm" />}
              end={
                <Link to={PORTAL_PATHS.agent(a.id)} className="text-sm text-link hover:underline">
                  {t("weekly.details")}
                </Link>
              }
            >
              {t("weekly.agentRuns", { name: a.name, count: a.runsDone })}
              {a.kpis.length > 0 ? (
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  {a.kpis.map((k) => (
                    <Tag key={k.key}>
                      {k.label} <span className="figures">{k.value}</span>
                      {k.unit ? ` ${k.unit}` : ""}
                    </Tag>
                  ))}
                </span>
              ) : null}
            </ActivityRow>
          ))}
        </Card>
      ) : null}

      {table.nextWeek ? (
        <Section title={t("weekly.nextWeek")} testId="portal-weekly-next">
          <Card pad>
            <p className="whitespace-pre-wrap text-ink">{table.nextWeek}</p>
          </Card>
        </Section>
      ) : null}
    </>
  );
}

/** A decision for the client, answered once in the lead thread. */
function Decision({
  weekStart,
  decision: d,
  onReplied,
}: {
  weekStart: string;
  decision: WeeklyDecision;
  onReplied: () => void;
}) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalWeeklyReply, {
        params: { weekStart, decisionId: d.id },
        body: { text: text.trim() },
      });
      setOpen(false);
      setText("");
      onReplied();
    } catch (err) {
      // Answered already (by someone else, or in another tab): show the answer.
      if (err instanceof ApiError && err.status === 409) onReplied();
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="ui-card__body flex flex-col gap-2 border-b border-line last:border-b-0"
      data-testid={`portal-weekly-decision-${d.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{d.title}</p>
          {d.body ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-muted">{d.body}</p>
          ) : null}
        </div>
        {d.reply ? (
          <StatusChip state="person">
            {t("weekly.replied", { name: d.reply.by, time: fmt.time(d.reply.at) })}
          </StatusChip>
        ) : open ? null : (
          <Button size="sm" onClick={() => setOpen(true)} data-testid="portal-weekly-reply">
            {t("weekly.reply")}
          </Button>
        )}
      </div>
      {d.options.length > 0 ? (
        <ol className="list-inside list-[upper-alpha] text-sm text-ink">
          {d.options.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ol>
      ) : null}
      <SourceLinks ids={d.sources} href={(id) => `/records/${id}`} />
      {open && !d.reply ? (
        <form onSubmit={(e) => void send(e)} className="mt-2 flex flex-col gap-2">
          <TextArea
            aria-label={t("weekly.reply")}
            data-testid="portal-weekly-reply-text"
            rows={3}
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("weekly.replyPlaceholder")}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || !text.trim()}
              data-testid="portal-weekly-reply-send"
            >
              {busy ? t("common.sending") : t("common.send")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
          </div>
          {error ? <ErrorNotice error={error} /> : null}
        </form>
      ) : null}
    </div>
  );
}
