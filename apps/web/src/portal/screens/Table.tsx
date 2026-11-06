// `/`: The Table (docs/ui-plan.md C1, prototype `#Main`), the portal's home. Each agent and what it
// is doing now, this week's figures, the latest step summaries, and on the right what waits on you,
// the lead's latest message and the supervisor's account check. Read from `GET /api/table` (and
// `/api/overview` for the account check, `/api/access` for each agent's tools). Never a bundle, an
// instruction, a prompt or a cost (invariant 11).
import type { PortalAccessView, PortalFinding, PortalHealth, TableView } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { runStatusLabel, shortTime } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { ProgressBar, StatTile } from "../../ui/figures";
import { Field, TextArea } from "../../ui/forms";
import { Columns, Loaded, Page, PageGrid, Section } from "../../ui/page";
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
import { agentChip, isGoing, longDay, partOfDay, sameDay, stageWord } from "../agentState";
import { INBOX_COUNT_POLL_MS, useRefreshInboxCount } from "../inboxCount";
import { PORTAL_PATHS } from "../paths";

type Service = TableView["services"][number];
type DeskItem = TableView["desk"]["top"][number];

const KIND_LABEL: Record<string, PlainKey> = {
  external_action: "inbox.kind.external_action",
  approval: "inbox.kind.approval",
  request: "inbox.kind.request",
  review: "inbox.kind.review",
  extraction_review: "inbox.kind.extraction_review",
  change_request: "inbox.kind.change_request",
};

/** Items whose main action is a signature; the rest are answered or checked on the Desk. */
const SIGNED = new Set(["external_action", "approval", "change_request"]);

export function TableScreen() {
  const table = useApi(apiRoutes.portalTable);
  usePoll(table.reload, true, INBOX_COUNT_POLL_MS, table.loading);
  return (
    <Page testId="portal-table">
      <Loaded state={table}>{(data) => <TheTable data={data} reload={table.reload} />}</Loaded>
    </Page>
  );
}

function TheTable({ data, reload }: { data: TableView; reload: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const session = useSession();
  const overview = useApi(apiRoutes.portalOverview);
  // Each agent's tools are the connections it is granted; the cards go without them if this fails.
  const access = useApi(apiRoutes.portalAccess);
  const now = new Date();
  const tz = data.client.timezone;
  const first = session.user.name?.trim().split(/\s+/)[0];
  const part = partOfDay(now, tz);
  const greeting = first ? t(`table.greeting.${part}`, { name: first }) : t(`table.hello.${part}`);
  const waiting = data.desk.open;

  return (
    <>
      <PageHeader
        eyebrow={longDay(now, i18n.intl, tz)}
        title={greeting}
        subtitle={
          <span data-testid="table-week-line">
            {t("table.weekLine", { count: data.figures.runsDone })}{" "}
            {waiting === 0 ? t("table.waitNone") : t("table.waitLine", { count: waiting })}
          </span>
        }
        actions={<WeeklyAndSloan />}
      />
      <PageGrid
        rail={
          <>
            <WaitingOnYou desk={data.desk} tz={tz} onChange={reload} />
            {data.lead?.message ? <LeadNote lead={data.lead} /> : null}
            {overview.data?.health?.summary ? (
              <HealthCard summary={overview.data.health.summary} />
            ) : null}
          </>
        }
      >
        {overview.data?.health && overview.data.health.findings.length > 0 ? (
          <Findings findings={overview.data.health.findings} />
        ) : null}
        <WorkingNow services={data.services} access={access.data} />
        <Section title={t("table.thisWeek")} testId="table-this-week">
          <Columns count={3}>
            <StatTile
              testId="table-stat-runs"
              label={t("table.stat.runs")}
              value={i18n.fmt.number(data.figures.runsDone)}
            />
            <StatTile
              testId="table-stat-changes"
              label={t("table.stat.changes")}
              value={i18n.fmt.number(data.figures.changes.automatic + data.figures.changes.signed)}
              note={t("table.stat.changesNote", {
                automatic: data.figures.changes.automatic,
                signed: data.figures.changes.signed,
              })}
            />
            <StatTile
              testId="table-stat-waiting"
              label={t("common.waitingOnYou")}
              value={i18n.fmt.number(waiting)}
              note={waiting > 0 ? t("table.stat.onYourDesk") : t("table.waitNone")}
              {...(waiting > 0 ? { noteTone: "signal" as const } : {})}
            />
          </Columns>
        </Section>
        <Latest recent={data.recent} />
      </PageGrid>
    </>
  );
}

/**
 * "Open the Weekly Table" and "Ask Sloan": the Table's header actions, and an agent page's, where
 * pausing is the main action and Sloan's link is `quiet` (secondary).
 */
export function WeeklyAndSloan({ quiet = false }: { quiet?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <Link to={PORTAL_PATHS.weekly} className={buttonClass("secondary")} data-testid="open-weekly">
        {t("table.openWeekly")}
      </Link>
      <Link
        to={PORTAL_PATHS.sloan}
        className={buttonClass(quiet ? "secondary" : "primary")}
        data-testid="ask-sloan"
      >
        {t("table.askSloan")}
      </Link>
    </>
  );
}

// ── Working now ──────────────────────────────────────────────────────────────────────────────────

function WorkingNow({
  services,
  access,
}: {
  services: Service[];
  access: PortalAccessView | undefined;
}) {
  const { t } = useI18n();
  const chips = services.map((s) => agentChip(s, t).state);
  const count = (state: string) => chips.filter((c) => c === state).length;
  const meta = [
    count("running") > 0 ? t("table.meta.running", { count: count("running") }) : null,
    count("waiting") > 0 ? t("table.meta.waiting", { count: count("waiting") }) : null,
    count("setup") > 0 ? t("table.meta.setup", { count: count("setup") }) : null,
    count("paused") > 0 ? t("table.meta.paused", { count: count("paused") }) : null,
  ].filter(Boolean);
  return (
    <Section
      title={t("table.workingNow")}
      meta={meta.join(" · ") || undefined}
      testId="table-working"
    >
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

function AgentCard({ service: s, tools }: { service: Service; tools: string[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const chip = agentChip(s, t);
  const stage = stageWord(s.stage, t);
  const going = isGoing(s.now);
  const step = going ? s.now?.step : null;
  const today =
    s.kpis.length > 0
      ? s.kpis
          .slice(0, 2)
          .map((k) => `${k.label}: ${k.value}`)
          .join(" · ")
      : t("table.runsThisWeek", { count: s.runsDone });
  return (
    <Link
      to={PORTAL_PATHS.agent(s.id)}
      data-testid={`portal-service-${s.id}`}
      className={`ds-card flex min-w-0 flex-col gap-4 p-6 text-ink no-underline hover:border-line-strong ${
        chip.state === "setup" ? "border-dashed" : ""
      }`}
    >
      <span className="flex items-start gap-3">
        <AgentBadge name={s.name} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="type-subheading">{s.name}</span>
          {s.description ? (
            <span className="truncate text-sm text-ink-muted">{s.description}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusChip state={chip.state} testId={`table-agent-state-${s.id}`}>
            {chip.label}
          </StatusChip>
          {stage ? <Tag>{stage}</Tag> : null}
        </span>
      </span>
      <span className="flex flex-col gap-1.5">
        <span className="eyebrow text-ink-muted">
          {going ? t("table.now") : t("table.lastRun")}
        </span>
        <span data-testid={`table-agent-now-${s.id}`}>
          {!s.now ? t("table.noRunsYet") : step ? step.label : runStatusLabel(s.now.status, i18n)}
        </span>
      </span>
      {going ? (
        <span className="flex flex-col gap-1.5">
          <ProgressBar
            value={step?.index ?? 0}
            max={step?.total ?? 1}
            tone={s.now?.waitingOnYou ? "waiting" : "accent"}
            label={
              step ? t("table.stepOf", { index: step.index, total: step.total }) : t("table.now")
            }
          />
          <span className="text-sm text-ink-muted">
            {[
              step ? t("table.stepOf", { index: step.index, total: step.total }) : null,
              s.now?.since
                ? s.now.waitingOnYou
                  ? t("table.waitingSince", { time: shortTime(s.now.since, undefined, i18n) })
                  : t("table.started", { time: shortTime(s.now.since, undefined, i18n) })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      ) : s.now?.since ? (
        <span className="text-sm text-ink-muted">
          {t("table.finished", { time: shortTime(s.now.since, undefined, i18n) })}
        </span>
      ) : null}
      <span className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3.5">
        <span className="text-sm">{today}</span>
        {tools.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {tools.map((name) => (
              <Tag key={name}>{name}</Tag>
            ))}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

// ── Latest from your agents ──────────────────────────────────────────────────────────────────────

function Latest({ recent }: { recent: TableView["recent"] }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <Card
      testId="table-latest"
      title={t("table.latest")}
      meta={
        <Link to={PORTAL_PATHS.runs} className="text-sm text-link hover:underline">
          {t("table.seeAllRuns")}
        </Link>
      }
    >
      {recent.length === 0 ? (
        <p className="ui-card__body text-ink-muted">{t("table.noLatest")}</p>
      ) : (
        recent.map((r) => (
          <ActivityRow
            key={`${r.runId}:${r.label}:${r.at ?? ""}`}
            testId={`table-latest-${r.runId}`}
            time={r.at ? shortTime(r.at, undefined, i18n) : ""}
            badge={<AgentBadge name={r.service.name} size="sm" />}
            to={`/runs/${r.runId}`}
          >
            <span className="font-medium">{r.service.name}</span> {r.summary ?? r.label}
          </ActivityRow>
        ))
      )}
    </Card>
  );
}

// ── Waiting on you (the top of the Desk) ─────────────────────────────────────────────────────────

/** "Not now" from the Table: back tomorrow at 8:00 on the reader's clock. */
export function tomorrowMorning(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

function WaitingOnYou({
  desk,
  tz,
  onChange,
}: {
  desk: TableView["desk"];
  tz: string;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const more = desk.open - desk.top.length;
  return (
    <Card
      testId="table-desk"
      title={t("common.waitingOnYou")}
      meta={<Count n={desk.open} tone="warning" />}
      footer={
        <Link to={PORTAL_PATHS.desk} className="text-sm text-link hover:underline">
          {more > 0 ? t("table.moreOnDesk", { count: more }) : t("table.openDesk")}
        </Link>
      }
    >
      {desk.top.length === 0 ? (
        <p className="ui-card__body text-ink-muted">{t("table.waitNone")}</p>
      ) : (
        <div className="divide-y divide-line">
          {desk.top.map((item) => (
            <DeskRow key={item.id} item={item} tz={tz} onChange={onChange} />
          ))}
        </div>
      )}
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

  // DECISION: the Table never signs or answers. Its main action opens the item on the Desk, where
  // the change shows with its before and after; "Not now" snoozes it to tomorrow 8:00, and the
  // Desk offers the other times.
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
    <div className="flex flex-col gap-3 px-6 py-4" data-testid={`table-desk-item-${item.id}`}>
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
      <p className="font-medium text-ink">{item.title}</p>
      {error ? <ErrorNotice error={error} /> : null}
      <span className="flex flex-wrap gap-2">
        <Link
          to={PORTAL_PATHS.desk}
          className={buttonClass("primary", undefined, "sm")}
          data-testid={`table-desk-open-${item.id}`}
        >
          {SIGNED.has(item.kind) ? t("table.reviewSign") : t("table.openItem")}
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

// ── The supervisor's account check (docs/plan.md §1.28) ──────────────────────────────────────────

/** The open findings that need the client: each one's title and plain steps, in their language. */
function Findings({ findings }: { findings: PortalFinding[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <Section
      title={t("overview.findings")}
      action={
        <Link to={PORTAL_PATHS.desk} className="text-sm text-link hover:underline">
          {t("table.openDesk")}
        </Link>
      }
      testId="portal-findings"
    >
      <div className="flex flex-col gap-3">
        {findings.map((f) => (
          <Card key={f.id} testId={`portal-finding-${f.id}`} pad>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="font-medium text-ink">{f.title}</h3>
                <span className="flex items-center gap-2">
                  {f.remindedAt ? (
                    <StatusChip state="waiting">{t("overview.findingReminder")}</StatusChip>
                  ) : null}
                  <span className="text-sm text-ink-muted">
                    {shortTime(f.remindedAt ?? f.createdAt, undefined, i18n)}
                  </span>
                </span>
              </div>
              {f.steps.length > 0 ? (
                <ol className="flex list-decimal flex-col gap-1 pl-5 text-ink">
                  {f.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              ) : null}
              <p className="text-sm text-ink-muted">{t("overview.findingMarkDone")}</p>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
}

/** The supervisor's latest daily check: good, or what needs a look, with its counts. */
function HealthCard({ summary }: { summary: NonNullable<PortalHealth["summary"]> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const good = summary.state === "good";
  return (
    <Card
      testId="portal-health"
      title={t("overview.health")}
      meta={
        <StatusChip state={good ? "done" : "waiting"} testId="portal-health-state">
          {good ? t("overview.healthGood") : t("overview.healthAttention")}
        </StatusChip>
      }
      pad
    >
      <ul className="flex flex-col gap-1.5 text-sm text-ink">
        <li>
          {t("overview.healthRuns", { count: summary.runs.total })}
          {summary.runs.failed > 0
            ? ` · ${t("overview.healthFailed", { count: summary.runs.failed })}`
            : ""}
        </li>
        {summary.connections.needsAttention > 0 ? (
          <li>{t("overview.healthConnections", { count: summary.connections.needsAttention })}</li>
        ) : null}
        {summary.waiting.count > 0 ? (
          <li>{t("overview.healthWaiting", { count: summary.waiting.count })}</li>
        ) : null}
        <li className="text-ink-muted">
          {t("overview.healthChecked", { time: shortTime(summary.checkedAt, undefined, i18n) })}
        </li>
      </ul>
    </Card>
  );
}
