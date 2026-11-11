// `/`: Home (was "The Table"; docs/ui-plan.md C1, Review 1). A short greeting, the week's figures
// (the owner's v1 KPI tiles, design pass: runs done, changes, waiting on you, documents read), then
// each agent and how it stands (name, what it does, state in its colour, the tools it works in,
// its week's runs and changes, its last run in a line), and beside them what needs you: the top of
// the Inbox and the supervisor's findings. A weekly summary card when a Weekly Table was sent, the
// lead's latest message and the latest work when there is any. Each fact once: what waits on you is
// the gold tile (and the sidebar's badge), not a count on "Needs you" too; empty figures and
// sections are left out. Read from `GET /api/table` (and
// `/api/overview` for the findings, `/api/access` for each agent's tools, `/api/weekly` for the
// summary). Never a bundle, an instruction, a prompt or a cost (invariant 11).
import type { PortalAccessView, PortalFinding, TableView } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import { shortTime } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { Delta, hasRuns, KpiStrip, Sparkline, StatTile } from "../../ui/figures";
import { Field, TextArea } from "../../ui/forms";
import { Columns, Loaded, Page, PageGrid, Section } from "../../ui/page";
import {
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Tag,
} from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { longDay, partOfDay, sameDay, stageWord } from "../agentState";
import { INBOX_COUNT_POLL_MS, useRefreshInboxCount } from "../inboxCount";
import { PORTAL_PATHS } from "../paths";
import { agentChip, runChip, runOpen } from "../status";

type Service = TableView["services"][number];
type DeskItem = TableView["desk"]["top"][number];
type SentWeekly = NonNullable<ResponseOf<typeof apiRoutes.portalWeekly>["table"]>;

const KIND_LABEL: Record<string, PlainKey> = {
  external_action: "inbox.kind.external_action",
  approval: "inbox.kind.approval",
  request: "inbox.kind.request",
  review: "inbox.kind.review",
  extraction_review: "inbox.kind.extraction_review",
  change_request: "inbox.kind.change_request",
};

/** Items whose main action is an approval; the rest are answered or checked in the Inbox. */
const APPROVED = new Set(["external_action", "approval", "change_request"]);

export function HomeScreen() {
  const table = useApi(apiRoutes.portalTable);
  usePoll(table.reload, true, INBOX_COUNT_POLL_MS, table.loading);
  return (
    <Page testId="portal-home">
      <Loaded state={table}>{(data) => <Home data={data} reload={table.reload} />}</Loaded>
    </Page>
  );
}

function Home({ data, reload }: { data: TableView; reload: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const session = useSession();
  const overview = useApi(apiRoutes.portalOverview);
  // Each agent's tools are the connections it is granted; the cards go without them if this fails.
  const access = useApi(apiRoutes.portalAccess, {
    // The vault is never stored (docs/audit-plan.md 1.2).
    cache: "none",
  });
  const weekly = useApi(apiRoutes.portalWeekly, { query: {} });
  const now = new Date();
  const tz = data.client.timezone;
  const first = session.user.name?.trim().split(/\s+/)[0];
  const part = partOfDay(now, tz);
  const greeting = first ? t(`table.greeting.${part}`, { name: first }) : t(`table.hello.${part}`);
  const findings = overview.data?.health?.findings ?? [];
  const sent = weekly.data?.table ?? null;

  return (
    <>
      <PageHeader
        eyebrow={longDay(now, i18n.intl, tz)}
        title={greeting}
        // The week's figures are the strip below: no line repeats them here.
        actions={
          <Link
            to={PORTAL_PATHS.upload}
            className={buttonClass("secondary")}
            data-testid="home-add-documents"
          >
            {t("home.addDocuments")}
          </Link>
        }
      />
      {data.services.length > 0 ? <HomeFigures data={data} /> : null}
      <PageGrid
        rail={
          <>
            {data.desk.open > 0 || findings.length > 0 ? (
              <NeedsYou desk={data.desk} findings={findings} tz={tz} onChange={reload} />
            ) : null}
            {data.recent.length > 0 ? <Latest recent={data.recent} /> : null}
          </>
        }
      >
        <Agents services={data.services} access={access.data} />
        {data.lead?.message ? <LeadNote lead={data.lead} /> : null}
        {sent ? <WeeklyCard table={sent} /> : null}
      </PageGrid>
    </>
  );
}

// ── This week's figures ──────────────────────────────────────────────────────────────────────────

/**
 * The KPI strip (the owner's v1 home): runs done this week with its last 14 days, changes made to
 * your tools, what waits on you (signal) and documents read, each a link to its list. A figure
 * with nothing this week or last is left out (runs always show). Each number appears once on the
 * page: "Needs you" carries no count of its own, and no line under the title repeats them.
 */
function HomeFigures({ data }: { data: TableView }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const f = data.figures;
  const done = f.runs?.succeeded ?? f.runsDone;
  const changes = f.changes.automatic + f.changes.signed;
  const last = f.lastWeek;
  const days = f.perDay;
  const runs14 = (days ?? []).reduce((n, d) => n + d.runs, 0);
  const delta = (direction: "up" | "down" | "same", by: number) =>
    direction === "same"
      ? t("home.kpi.same")
      : t(direction === "up" ? "home.kpi.up" : "home.kpi.down", { count: by });
  const documents = f.documentsRead;
  return (
    <KpiStrip testId="home-figures">
      <StatTile
        testId="home-kpi-runs"
        to={PORTAL_PATHS.runs}
        label={t("home.kpi.runsDone")}
        value={fmt.number(done)}
        tone={done > 0 ? "positive" : undefined}
        mark={
          hasRuns(days) ? (
            <Sparkline
              days={days}
              label={t("kpi.runsDays", { count: runs14, days: days.length })}
              testId="home-kpi-runs-spark"
            />
          ) : undefined
        }
        note={hasRuns(days) ? t("kpi.runsDays", { count: runs14, days: days.length }) : undefined}
      />
      {changes > 0 || (last?.changes ?? 0) > 0 ? (
        <StatTile
          testId="home-kpi-changes"
          to={PORTAL_PATHS.reports}
          label={t("home.kpi.changes")}
          tone="slate"
          value={fmt.number(changes)}
          mark={last ? <Delta now={changes} before={last.changes} words={delta} /> : undefined}
          note={
            changes > 0
              ? t("home.kpi.changesNote", {
                  automatic: fmt.number(f.changes.automatic),
                  approved: fmt.number(f.changes.signed),
                })
              : undefined
          }
        />
      ) : null}
      {data.desk.open > 0 ? (
        <StatTile
          testId="home-kpi-waiting"
          to={PORTAL_PATHS.inbox}
          label={t("home.kpi.waiting")}
          value={fmt.number(data.desk.open)}
          tone="signal"
          note={t("home.kpi.waitingNote")}
        />
      ) : null}
      {documents !== undefined && (documents > 0 || (last?.documentsRead ?? 0) > 0) ? (
        <StatTile
          testId="home-kpi-documents"
          to={PORTAL_PATHS.upload}
          label={t("home.kpi.documents")}
          tone="slate"
          value={fmt.number(documents)}
          mark={
            last ? <Delta now={documents} before={last.documentsRead} words={delta} /> : undefined
          }
        />
      ) : null}
    </KpiStrip>
  );
}

// ── Your agents ──────────────────────────────────────────────────────────────────────────────────

function Agents({
  services,
  access,
}: {
  services: Service[];
  access: PortalAccessView | undefined;
}) {
  const { t } = useI18n();
  return (
    <Section title={t("home.agents")} testId="home-agents">
      {services.length === 0 ? (
        <EmptyState>{t("overview.noServices")}</EmptyState>
      ) : (
        <Columns count={2}>
          {services.map((s) => (
            <AgentCard key={s.id} service={s} tools={toolsOf(s.id, access)} />
          ))}
        </Columns>
      )}
    </Section>
  );
}

/** The connections an agent is granted (not revoked), by name. */
function toolsOf(agentId: string, access: PortalAccessView | undefined): string[] {
  if (!access) return [];
  return access.items
    .filter((item) => item.agents.some((a) => a.agentId === agentId && !a.revoked))
    .map((item) => item.name);
}

/**
 * One agent as the owner's v1 home draws it: its name and what it does, its state (and its go-live
 * stage before it is live), the tools it works in, and its last run in one line.
 */
function AgentCard({ service: s, tools }: { service: Service; tools: string[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const chip = agentChip(s, t);
  const stage = stageWord(s.stage, t);
  const tone = agentAccent(s, chip.state);
  return (
    <Link
      to={PORTAL_PATHS.agent(s.id)}
      data-testid={`portal-service-${s.id}`}
      data-tone={tone}
      className={`ds-card flex min-w-0 flex-col gap-4 p-6 text-ink no-underline hover:border-line-strong ${
        tone ? "ui-accent" : ""
      } ${chip.state === "setup" ? "border-dashed" : ""}`}
    >
      <span className="flex items-start gap-3">
        <AgentBadge name={s.name} seed={s.id} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="type-subheading">{s.name}</span>
          {s.description ? (
            <span className="line-clamp-2 text-sm text-ink-muted">{s.description}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusChip state={chip.state} testId={`table-agent-state-${s.id}`}>
            {chip.label}
          </StatusChip>
          {stage ? <Tag>{stage}</Tag> : null}
        </span>
      </span>
      {tools.length > 0 ? (
        <span className="flex flex-wrap gap-1.5" data-testid={`home-agent-tools-${s.id}`}>
          {tools.map((name) => (
            <Tag key={name}>{name}</Tag>
          ))}
        </span>
      ) : null}
      <AgentFigures service={s} />
      <span
        className="border-t border-line pt-3.5 text-sm text-ink-muted"
        data-testid={`table-agent-now-${s.id}`}
      >
        {lastRunLine(s, i18n)}
      </span>
    </Link>
  );
}

/**
 * A card's state colour, beside its chip (brand book): waiting on you in signal, a last run that
 * failed in risk, working or ready and live in positive ("working fine"). Setting up and paused
 * have none: the chip says it.
 */
export function agentAccent(
  s: Pick<Service, "now">,
  state: ChipState,
): "signal" | "risk" | "positive" | undefined {
  if (state === "waiting") return "signal";
  if (state === "setup" || state === "paused") return undefined;
  if (s.now && !runOpen(s.now) && s.now.status === "failed") return "risk";
  return "positive";
}

/**
 * The agent's own figures this week: runs (with its last 14 days) and changes to your tools. Left
 * out until it has run at all in those days or changed something.
 */
function AgentFigures({ service: s }: { service: Service }) {
  const { t, fmt } = useI18n();
  const runs = s.runs?.total ?? s.runsDone;
  const changes = s.changes ?? 0;
  const days = s.perDay;
  if (!hasRuns(days) && runs === 0 && changes === 0) return null;
  const runs14 = (days ?? []).reduce((n, d) => n + d.runs, 0);
  return (
    <span className="ui-figs" data-testid={`home-agent-figures-${s.id}`}>
      <span className="ui-fig">
        <span className="ui-fig__value">{fmt.number(runs)}</span>
        <span className="ui-fig__label">{t("home.card.runsWeek", { count: runs })}</span>
      </span>
      {changes > 0 ? (
        <span className="ui-fig">
          <span className="ui-fig__value">{fmt.number(changes)}</span>
          <span className="ui-fig__label">{t("home.card.changes", { count: changes })}</span>
        </span>
      ) : null}
      {hasRuns(days) ? (
        <span className="ui-figs__spark">
          <Sparkline
            days={days}
            label={t("kpi.runsDays", { count: runs14, days: days.length })}
            testId={`home-agent-spark-${s.id}`}
          />
        </span>
      ) : null}
    </span>
  );
}

/**
 * The card's one line: what it is doing now ("Now: Match items · Step 3 of 6"), since when it
 * waits on you, or its last run ("Last run 7:04 · Done"), with this week's KPIs after it.
 */
export function lastRunLine(s: Service, i18n: I18n): string {
  const { t } = i18n;
  const kpis = s.kpis.slice(0, 2).map((k) => `${k.label}: ${k.value}`);
  const at = (iso: string | null) => (iso ? shortTime(iso, undefined, i18n) : "");
  const now = s.now;
  if (!now) return [t("table.noRunsYet"), ...kpis].join(" · ");
  if (runOpen(now) && now.waitingOnYou) {
    return [t("home.card.waitingSince", { time: at(now.since) }), ...kpis].join(" · ");
  }
  if (runOpen(now)) {
    const step = now.step;
    return [
      step ? t("home.card.now", { step: step.label }) : runChip(now, t).label,
      step ? t("table.stepOf", { index: step.index, total: step.total }) : null,
      ...kpis,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    now.since ? t("home.card.lastRun", { time: at(now.since) }) : t("table.lastRun"),
    runChip(now, t).label,
    ...kpis,
  ].join(" · ");
}

// ── The weekly summary ───────────────────────────────────────────────────────────────────────────

function WeeklyCard({ table }: { table: SentWeekly }) {
  const i18n = useI18n();
  const { t } = i18n;
  const lead = table.noteBy?.name;
  return (
    <Card
      testId="home-weekly"
      title={t("home.weekly.title")}
      meta={t("weekly.weekOf", { date: i18n.fmt.date(`${table.weekStart}T12:00:00Z`) })}
      footer={
        <Link
          to={PORTAL_PATHS.weekly}
          className="text-sm text-link hover:underline"
          data-testid="home-weekly-open"
        >
          {t("home.weekly.open")}
        </Link>
      }
      pad
    >
      {table.note ? (
        <>
          <p className="line-clamp-3 whitespace-pre-line text-ink">{table.note}</p>
          {lead ? (
            <p className="mt-2 text-sm text-ink-muted">{t("weekly.fromLead", { name: lead })}</p>
          ) : null}
        </>
      ) : (
        <p className="text-ink-muted">{t("home.weekly.ready")}</p>
      )}
    </Card>
  );
}

// ── Latest from your agents ──────────────────────────────────────────────────────────────────────

function Latest({ recent }: { recent: TableView["recent"] }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <Card
      titleAbove
      testId="table-latest"
      title={t("table.latest")}
      meta={
        <Link to={PORTAL_PATHS.runs} className="text-sm text-link hover:underline">
          {t("table.seeAllRuns")}
        </Link>
      }
    >
      {recent.slice(0, 5).map((r) => (
        <ActivityRow
          key={`${r.runId}:${r.label}:${r.at ?? ""}`}
          testId={`table-latest-${r.runId}`}
          time={r.at ? shortTime(r.at, undefined, i18n) : ""}
          badge={<AgentBadge name={r.service.name} seed={r.service.id} size="sm" />}
          to={`/runs/${r.runId}`}
        >
          <span className="font-medium">{r.service.name}</span> {r.summary ?? r.label}
        </ActivityRow>
      ))}
    </Card>
  );
}

// ── Needs you: the top of the Inbox and the supervisor's findings ────────────────────────────────

/** "Not now" from Home: back tomorrow at 8:00 on the reader's clock. */
export function tomorrowMorning(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

/** The most rows "Needs you" shows on Home; the Inbox has the rest. */
export const NEEDS_YOU_ROWS = 3;

function NeedsYou({
  desk,
  findings,
  tz,
  onChange,
}: {
  desk: TableView["desk"];
  findings: PortalFinding[];
  tz: string;
  onChange: () => void;
}) {
  const { t } = useI18n();
  // DECISION (owner, design pass 2): Home shows at most three short rows, the Inbox's top first,
  // then the supervisor's findings in what room is left; the rest is one link to the Inbox.
  const rows = desk.top.slice(0, NEEDS_YOU_ROWS);
  const shownFindings = findings.slice(0, NEEDS_YOU_ROWS - rows.length);
  const more = Math.max(0, desk.open - rows.length);
  return (
    <Card
      titleAbove
      testId="table-desk"
      title={t("home.needsYou")}
      footer={
        <Link
          to={PORTAL_PATHS.inbox}
          className="text-sm text-link hover:underline"
          data-testid="home-open-inbox"
        >
          {more > 0 ? t("home.moreInInbox", { count: more }) : t("home.openInbox")}
        </Link>
      }
    >
      <div className="divide-y divide-line">
        {rows.map((item) => (
          <DeskRow key={item.id} item={item} tz={tz} onChange={onChange} />
        ))}
        {shownFindings.map((f) => (
          <FindingRow key={f.id} finding={f} />
        ))}
      </div>
    </Card>
  );
}

function DeskRow({ item, tz, onChange }: { item: DeskItem; tz: string; onChange: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const refreshCount = useRefreshInboxCount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const kind = KIND_LABEL[item.kind];
  const due = item.dueAt ? new Date(item.dueAt) : null;

  // DECISION: Home never approves or answers. Its main action opens the item in the Inbox, where
  // the change shows with its before and after; "Not now" snoozes it to tomorrow 8:00, and the
  // Inbox offers the other times.
  const notNow = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalSnoozeInbox, {
        params: { id: item.id },
        body: { until: tomorrowMorning() },
      });
      refreshCount();
      onChange();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <div
      className="ui-accent ui-accent--left flex flex-col gap-2 px-6 py-3"
      data-tone="signal"
      data-testid={`table-desk-item-${item.id}`}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <Tag>{kind ? t(kind) : item.kind}</Tag>
        {due ? (
          <StatusChip state="waiting">
            {sameDay(due, new Date(), tz)
              ? t("table.dueToday")
              : t("table.due", { time: shortTime(item.dueAt, undefined, i18n) })}
          </StatusChip>
        ) : null}
      </span>
      <p className="line-clamp-2 font-medium text-ink">{item.title}</p>
      {error ? <ErrorNotice error={error} /> : null}
      <span className="flex flex-wrap gap-2">
        <Link
          to={`${PORTAL_PATHS.inbox}?item=${encodeURIComponent(item.id)}`}
          className={buttonClass("primary", undefined, "sm")}
          data-testid={`table-desk-open-${item.id}`}
        >
          {APPROVED.has(item.kind) ? t("table.reviewSign") : t("table.openItem")}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={notNow}
          data-testid={`table-desk-later-${item.id}`}
        >
          {t("table.notNow")}
        </Button>
      </span>
    </div>
  );
}

// ── The lead's note ──────────────────────────────────────────────────────────────────────────────

function LeadNote({ lead }: { lead: NonNullable<TableView["lead"]> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const name = lead.name ?? t("nav.lead");
  const first = name.split(/\s+/)[0] ?? name;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<unknown>(null);
  if (!lead.message) return null;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setState("sending");
    setError(null);
    try {
      // The lead thread is opened on first ask; the reply goes into it.
      const { threads } = await api.call(apiRoutes.portalThreads, {
        query: { subject: "lead" },
      });
      const thread = threads.find((th) => th.subject === "lead");
      if (!thread) throw new Error("no lead thread");
      await api.call(apiRoutes.portalPostMessage, {
        params: { id: thread.id },
        body: { text: text.trim() },
      });
      setText("");
      setOpen(false);
      setState("sent");
    } catch (err) {
      setError(err);
      setState("idle");
    }
  };

  return (
    <div
      data-testid="table-lead"
      className="ds-card flex flex-col gap-3 border-copper-tint bg-copper-tint p-6"
    >
      <PersonBadge
        name={name}
        line={`${t("nav.lead")} · ${shortTime(lead.message.at, undefined, i18n)}`}
        size="sm"
      />
      <p className="text-ink whitespace-pre-line">{lead.message.text}</p>
      {state === "sent" ? (
        <p className="text-sm text-ink-muted" role="status">
          {t("table.lead.sent", { name: first })}
        </p>
      ) : null}
      {open ? (
        <form onSubmit={send} className="flex flex-col gap-2">
          <Field label={t("table.lead.yourReply")}>
            <TextArea
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="table-lead-text"
            />
          </Field>
          {error ? <ErrorNotice error={error} /> : null}
          <span className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={state === "sending" || !text.trim()}
              data-testid="table-lead-send"
            >
              {state === "sending" ? t("common.sending") : t("common.send")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
          </span>
        </form>
      ) : (
        <button
          type="button"
          className="self-start text-sm text-copper-ink hover:underline"
          onClick={() => {
            setOpen(true);
            setState("idle");
          }}
          data-testid="table-lead-reply"
        >
          {t("table.lead.reply", { name: first })}
        </button>
      )}
    </div>
  );
}

/** A finding of the supervisor's account check: its title and plain steps, in their language. */
function FindingRow({ finding: f }: { finding: PortalFinding }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div
      className="ui-accent ui-accent--left flex flex-col gap-2 px-6 py-3"
      data-tone="signal"
      data-testid={`portal-finding-${f.id}`}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <Tag>{t("overview.findings")}</Tag>
        {f.remindedAt ? (
          <StatusChip state="waiting">{t("overview.findingReminder")}</StatusChip>
        ) : (
          <span className="text-sm text-ink-muted">{shortTime(f.createdAt, undefined, i18n)}</span>
        )}
      </span>
      <p className="line-clamp-2 font-medium text-ink">{f.title}</p>
      {/* What to do, step by step, is on the item in the Inbox: Home stays a short list. */}
      <Link
        to={PORTAL_PATHS.inbox}
        className="self-start text-sm text-link hover:underline"
        data-testid={`portal-finding-open-${f.id}`}
      >
        {t("table.openItem")}
      </Link>
    </div>
  );
}
