// `/agents/:id`: one agent as the client sees it (docs/ui-plan.md C2, Review 1). The header holds
// its name, its state, its go-live stage and Pause (the client admin); this month's figures sit
// under it, above the tabs, so every tab opens on them. Three tabs:
// - Overview: two columns. Its recent runs on the left, then its own view (a slot for
//   per-template or per-pack screens, ../../agents/views.ts) and upload and documents for an agent
//   that reads them; on the right what waits on you from it (action items), then "Run now" when it
//   has a form.
// - Runs (`/agents/:id/runs`): its runs, the Runs list filtered to it.
// - Agent settings (`/agents/:id/settings`; `/access` lands here): what it does and its jobs, when
//   it runs, how to reach it, what it may do in each of your tools (read-only; the client admin
//   tightens on Accounts) and who it contacts (the client admin chooses).
// Never the agent's bundle, instructions, prompts or cost (invariant 11).
import type { DayRuns, PortalAccessView, RunForm, ServiceControl } from "@countersign/core";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { type AgentViewKey, defaultReports, viewsFor } from "../../agents/views";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { CHANNEL_KIND_KEY, ChannelLines } from "../../channels/ChannelLines";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import { StatusFilter } from "../../inbox/StatusFilter";
import { packReportPath } from "../../packs/registry";
import { PortalPeopleList } from "../../people/PeoplePanel";
import { shortTime } from "../../runs/format";
import { subjectTitle } from "../../runs/subject";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { HeaderSwitcher } from "../../shell/HeaderSwitcher";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge } from "../../ui/badges";
import { cx } from "../../ui/cx";
import { hasRuns, KpiStrip, Sparkline, StatTile } from "../../ui/figures";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Loaded, Page, PageGrid, Section } from "../../ui/page";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Tabs,
  Tag,
} from "../../ui/primitives";
import {
  Skeleton,
  SkeletonBlock,
  SkeletonCard,
  SkeletonLine,
  SkeletonRows,
  SkeletonStats,
} from "../../ui/skeleton";
import { type ChipState, StatusChip } from "../../ui/status";
import { periodLabel } from "../../usage/format";
import { stageWord } from "../agentState";
import { useKnownAgent, useRememberRuns } from "../known";
import { PORTAL_PATHS } from "../paths";
import { agentChip, runChip, runOpen } from "../status";
import { accountAddress } from "./Accounts";
import { APPROVED, KIND_LABEL } from "./Home";
import { runsNote } from "./Reports";
import { TAB_WORDS as RUN_TAB_WORDS, TABS as RUN_TABS, type Tab as RunTab } from "./Runs";
import { RunTimes } from "./runsParts";
import { DropZone, Forwarding, RecentDocuments } from "./Upload";

const RUN_POLL_MS = 5_000;

export type AgentTab = "overview" | "runs" | "settings";

/**
 * The page: its header and tabs draw at once from what the frame's overview already says of the
 * agent (its name, what it does, its state), and every call that needs only the agent's id starts
 * here together (docs/audit-plan.md 1.4, 1.5). Each part waits only for its own answer.
 */
export function AgentScreen({ tab = "overview" }: { tab?: AgentTab }) {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const isAdmin = useIsAdmin();
  const known = useKnownAgent(id);
  const detail = useApi(apiRoutes.portalService, { params: { id } });
  // What it is doing now and its stage come from Home's route; its controls are the client admin's.
  const table = useApi(apiRoutes.portalTable);
  const controls = useApi(apiRoutes.portalServiceControls, isAdmin ? {} : null);
  // Its template's KPIs head every tab; the Overview tab's own calls start with the rest.
  const overviewTab = tab === "overview";
  const view = useApi(apiRoutes.portalServiceView, { params: { id } });
  const forms = useApi(apiRoutes.portalRunForms, overviewTab ? { params: { id } } : null);

  const live = table.data?.services.find((s) => s.id === id) ?? null;
  const control = controls.data?.services.find((s) => s.id === id) ?? null;
  const service = detail.data?.service ?? null;
  const name = service?.name ?? known?.name ?? null;
  const status = service?.status ?? known?.status ?? null;
  const chip =
    status === null
      ? null
      : agentChip(
          {
            status,
            stage: live?.stage ?? known?.stage ?? null,
            now: live?.now ?? null,
            runsNow: live?.runsNow ?? known?.runsNow,
          },
          t,
        );
  const stage = stageWord(live?.stage ?? known?.stage ?? null, t);
  const description = service ? service.description : (known?.description ?? null);
  const refresh = () => {
    detail.reload();
    table.reload();
    controls.reload();
  };

  return (
    <Page testId="portal-agent">
      <PageHeader
        eyebrow={
          <Link to={PORTAL_PATHS.home} className="hover:underline">
            {t("nav.home")}
          </Link>
        }
        beside={<HeaderSwitcher />}
        leading={
          name !== null ? (
            <AgentBadge name={name} seed={id} size="lg" />
          ) : detail.error ? null : (
            <SkeletonBlock height={52} className="w-[52px] shrink-0" />
          )
        }
        title={name ?? (detail.error ? "" : <SkeletonLine width={220} size="title" />)}
        badge={
          chip ? (
            <span className="flex items-center gap-2">
              <StatusChip state={chip.state} testId="agent-state">
                {chip.label}
              </StatusChip>
              {stage ? <Tag>{stage}</Tag> : null}
            </span>
          ) : null
        }
        // DECISION: no line when the agent has no description (the role is written for us).
        subtitle={description ?? undefined}
        actions={
          isAdmin && control && name !== null ? (
            <PauseControl control={control} name={name} onChange={refresh} />
          ) : null
        }
      />
      {control?.pause ? <PauseNotice control={control} /> : null}
      {/* The owner's agent page (2026-11-11): this month's figures first, above every tab. */}
      {detail.error && !detail.data ? null : (
        <Loaded state={detail} skeleton={<SkeletonStats count={3} />}>
          {(data) => (
            <AgentFiguresStrip
              id={id}
              detail={data}
              kpis={view.data?.kpis ?? []}
              perDay={live?.perDay}
              waiting={live?.runsNow?.waitingOnYou ?? 0}
            />
          )}
        </Loaded>
      )}
      <Tabs
        items={[
          { to: PORTAL_PATHS.agent(id), label: t("agent.tab.overview"), end: true },
          { to: PORTAL_PATHS.agentRuns(id), label: t("agent.tab.runs") },
          { to: PORTAL_PATHS.agentSettings(id), label: t("agent.tab.settings") },
        ]}
      />
      {detail.error && !detail.data ? (
        // Not the client's agent, or not there: no tab has anything to show.
        <Loaded state={detail}>{() => null}</Loaded>
      ) : tab === "runs" ? (
        <AgentRuns id={id} />
      ) : tab === "settings" ? (
        <AgentSettings
          id={id}
          name={name}
          description={description}
          state={chip}
          stage={stage}
          isAdmin={isAdmin}
        />
      ) : (
        // Overview: its recent runs on the left, what waits on you from it on the right; its own
        // view and documents under the runs, Run now under the action items.
        <PageGrid
          rail={
            <>
              <ActionItems id={id} name={name} />
              <RunNow id={id} name={name ?? ""} forms={forms.data?.forms ?? []} />
            </>
          }
        >
          <RecentRuns id={id} />
          {detail.data ? (
            <>
              <OwnView id={id} detail={detail.data} />
              {detail.data.readsDocuments ? <Documents isAdmin={isAdmin} /> : null}
            </>
          ) : null}
        </PageGrid>
      )}
    </Page>
  );
}

type Detail = ResponseOf<typeof apiRoutes.portalService>;
type ViewKpi = ResponseOf<typeof apiRoutes.portalServiceView>["kpis"][number];
type FormList = ResponseOf<typeof apiRoutes.portalRunForms>["forms"];
type PortalRun = ResponseOf<typeof apiRoutes.portalRuns>["runs"][number];

function useIsAdmin(): boolean {
  const session = useSession();
  const client =
    session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  return client?.role === "client_admin";
}

// ── The agent's own view (the slot) ──────────────────────────────────────────────────────────────

/**
 * What a registered view for this agent's template or pack draws; without one, the client's pack
 * reports and then this month's activity (the generic report, with a link to the full one).
 */
function OwnView({ id, detail }: { id: string; detail: Detail }) {
  const { t } = useI18n();
  const key: AgentViewKey = { template: detail.template, packs: detail.packs };
  const views = viewsFor(key);
  if (views.length > 0) {
    return (
      <div className="flex flex-col gap-5" data-testid="agent-own-view">
        {views.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: registered views keep their order.
          <v.Component key={i} agentId={id} />
        ))}
      </div>
    );
  }
  const reports = defaultReports(key);
  // Nothing of its own to show: no empty block (its figures are above).
  if (reports.length === 0) return null;
  return (
    <div className="flex flex-col gap-5" data-testid="agent-own-view">
      {reports.map((r) => (
        <Card
          key={packReportPath(r)}
          title={t(r.titleKey)}
          meta={
            <Link to={packReportPath(r)} className="text-sm text-link hover:underline">
              {t(r.descriptionKey)}
            </Link>
          }
          testId={`agent-pack-report-${r.pack}-${r.slug}`}
        >
          <r.Component />
        </Card>
      ))}
    </div>
  );
}

// ── Documents (agents that read them) ────────────────────────────────────────────────────────────

/** Drop documents for it, the latest that arrived, and the forwarding address. */
function Documents({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const documents = useApi(apiRoutes.portalDocuments, { query: { limit: 5 } });
  return (
    <Section
      title={t("agent.documents")}
      action={
        <Link to={PORTAL_PATHS.upload} className="text-sm text-link hover:underline">
          {t("agent.documentsAll")}
        </Link>
      }
      testId="agent-documents"
    >
      <DropZone onUploaded={documents.reload} />
      <RecentDocuments state={documents} />
      <Forwarding isAdmin={isAdmin} />
    </Section>
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────

/** Its runs, newest first: the Runs list, filtered to this agent. */
function AgentRuns({ id }: { id: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<RunTab>("all");
  const statuses = RUN_TABS[status];
  const runs = useApi(apiRoutes.portalRuns, {
    query: { agents: id, limit: 50, ...(statuses ? { statuses } : {}) },
  });
  usePoll(runs.reload, runs.data?.runs.some((r) => runOpen(r)) ?? false, RUN_POLL_MS, runs.loading);
  useRememberRuns(runs.data?.runs);
  return (
    <Card testId="portal-service-recent-runs">
      <RunStatusRow value={status} onChange={setStatus} area="agent-runs" />
      <Loaded state={runs} skeleton={<SkeletonRows rows={6} columns={3} />}>
        {(data) =>
          data.runs.length === 0 ? (
            <EmptyState
              compact
              icon="report"
              line={status === "all" ? t("service.noRuns") : t("runsPage.noMatch")}
            />
          ) : (
            <RunRows runs={data.runs} prefix="portal-service-run" />
          )
        }
      </Loaded>
    </Card>
  );
}

// ── Agent settings ───────────────────────────────────────────────────────────────────────────────

/**
 * Everything about the agent the client may see, read-only: what it does and its jobs, when it
 * runs (its triggers in words), what it can reach in your tools, and on the right how to reach it
 * (its number, email address and /name in threads); the client admin also chooses who it contacts.
 * Never its instructions, rules or bundle (invariant 11). Before the agent's name is known (a
 * direct load), the titles that name it are skeletons.
 */
function AgentSettings({
  id,
  name,
  description,
  state,
  stage,
  isAdmin,
}: {
  id: string;
  name: string | null;
  description: string | null;
  state: { state: ChipState; label: string } | null;
  stage: string | null;
  isAdmin: boolean;
}) {
  const { t } = useI18n();
  const triggers = useApi(apiRoutes.portalAgentTriggers, { params: { id } });
  // A title that names it, or its skeleton until the name is known.
  const named = (words: (name: string) => string) =>
    name !== null ? words(name) : <SkeletonLine width="half" size="heading" />;
  return (
    <PageGrid
      rail={
        <HowToReach
          id={id}
          name={name}
          title={named((n) => t("agent.reachIt", { name: n }))}
          commandName={triggers.data?.commandName ?? null}
          isAdmin={isAdmin}
        />
      }
    >
      <Card titleAbove title={named((n) => t("agent.about", { name: n }))} testId="agent-about">
        <div className="ui-card__body flex flex-col gap-4">
          <p className={description ? "text-ink" : "text-ink-muted"}>
            {description ?? (name !== null ? t("agent.aboutNone", { name }) : null)}
          </p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
            {state ? (
              <>
                <dt className="text-ink-muted">{t("agent.status")}</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <StatusChip state={state.state}>{state.label}</StatusChip>
                  {stage ? <Tag>{stage}</Tag> : null}
                </dd>
              </>
            ) : null}
            {triggers.data && jobsOf(triggers.data.triggers).length > 0 ? (
              <>
                <dt className="text-ink-muted">{t("agent.jobs")}</dt>
                <dd>
                  <ul className="flex flex-col gap-1 text-ink" data-testid="agent-jobs">
                    {jobsOf(triggers.data.triggers).map((job) => (
                      <li key={job}>{job}</li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      </Card>
      <Card
        titleAbove
        title={named((n) => t("agent.triggers", { name: n }))}
        testId="agent-triggers"
      >
        <Loaded state={triggers} skeleton={<SkeletonRows rows={2} columns={2} />}>
          {(data) =>
            data.triggers.length === 0 ? (
              <EmptyState
                compact
                icon="calendar"
                line={name !== null ? t("agent.triggersNone", { name }) : null}
              />
            ) : (
              <TriggerRows triggers={data.triggers} commandName={data.commandName} />
            )
          }
        </Loaded>
      </Card>
      <Reach id={id} name={name} />
      {isAdmin ? (
        // Headed like the cards beside it (a subheading above), not a page section.
        <section className="ui-cardgroup" data-testid="agent-contacts">
          <div className="ui-section__head">
            <h3 className="type-subheading text-ink">
              {named((n) => t("agent.contacts", { name: n }))}
            </h3>
          </div>
          <p className="text-sm text-ink-muted">{t("agent.contactsHelp")}</p>
          <PortalPeopleList agentId={id} />
        </section>
      ) : null}
    </PageGrid>
  );
}

type Trigger = ResponseOf<typeof apiRoutes.portalAgentTriggers>["triggers"][number];

/** Its jobs by name, once each, in the order its triggers list them. */
function jobsOf(triggers: readonly Trigger[]): string[] {
  return [...new Set(triggers.map((tr) => tr.job))];
}

function TriggerRows({
  triggers,
  commandName,
}: {
  triggers: readonly Trigger[];
  commandName: string | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div className="divide-y divide-line">
      {triggers.map((tr, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a job's triggers keep their order.
          key={`${tr.job}:${i}`}
          className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-6 py-4 max-sm:px-4"
          data-testid={`agent-trigger-${i}`}
        >
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-ink">{triggerWords(tr, commandName, i18n)}</span>
            <span className="text-sm text-ink-muted">
              {[tr.job, tr.skipsHolidays ? t("agent.skipsHolidays") : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <span className="text-sm text-ink-muted">
            {tr.lastStartedAt
              ? t("agent.lastStarted", { time: shortTime(tr.lastStartedAt, undefined, i18n) })
              : t("agent.neverStarted")}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The events a client's agent may start on, in the reader's words; any other reads generically. */
const EVENT_WORDS: Record<string, PlainKey> = {
  "document.received": "agent.trigger.event.documentReceived",
  "document.extracted": "agent.trigger.event.documentRead",
  "transaction.created": "agent.trigger.event.transactionCreated",
  "transaction.updated": "agent.trigger.event.transactionUpdated",
  "receivable.created": "agent.trigger.event.receivableCreated",
  "receivable.paid": "agent.trigger.event.receivablePaid",
  "bank.transaction.created": "agent.trigger.event.bankTransaction",
  "card.charge.created": "agent.trigger.event.cardCharge",
  "inbox.resolved": "agent.trigger.event.inboxResolved",
  "thread.message_posted": "agent.trigger.event.threadMessage",
  "inbound.message": "agent.trigger.event.inboundMessage",
  "message.received": "agent.trigger.event.messageReceived",
  "run.failed": "agent.trigger.event.runFailed",
  "connection.needs_attention": "agent.trigger.event.connectionAttention",
};

/** A trigger as one line: "Every day at 8:00 AM", "When a document has been read". */
export function triggerWords(
  tr: Trigger,
  commandName: string | null,
  { t, locale }: Pick<I18n, "t" | "locale">,
): string {
  switch (tr.type) {
    case "schedule":
      return scheduleWords(tr.cron, { t, locale });
    case "event":
      return t(EVENT_WORDS[tr.event ?? ""] ?? "agent.trigger.event.other");
    case "manual":
      return tr.clientCanRun ? t("agent.trigger.manualYou") : t("agent.trigger.manual");
    case "command":
      return commandName
        ? t("agent.trigger.command", { command: commandName })
        : t("agent.trigger.manual");
    case "message": {
      const words = tr.channels.map((c) =>
        c in CHANNEL_KIND_KEY
          ? t(CHANNEL_KIND_KEY[c as keyof typeof CHANNEL_KIND_KEY])
          : c === "command" && commandName
            ? `/${commandName}`
            : c === "sloan"
              ? "Sloan"
              : c,
      );
      return words.length > 0
        ? t("agent.trigger.message", {
            channels: new Intl.ListFormat(locale, { type: "disjunction" }).format(words),
          })
        : t("agent.trigger.event.inboundMessage");
    }
    case "webhook":
      return t("agent.trigger.webhook");
    case "handoff":
      return t("agent.trigger.handoff");
  }
}

/**
 * A schedule in words where it is a common one (every day, weekdays, one day a week at a time);
 * anything else as "On a schedule". The time is the client's own unless the trigger names a zone.
 */
function scheduleWords(cron: string | null, { t, locale }: Pick<I18n, "t" | "locale">): string {
  const parts = (cron ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return t("agent.trigger.schedule");
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || mon !== "*") {
    return t("agent.trigger.schedule");
  }
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 2, Number(hour), Number(min))));
  if (dow === "*") return t("agent.trigger.daily", { time });
  if (dow === "1-5") return t("agent.trigger.weekdays", { time });
  if (/^[0-6]$/.test(dow)) {
    // 2 January 2000 was a Sunday: day 0 of cron's week.
    const day = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2000, 0, 2 + Number(dow))),
    );
    return t("agent.trigger.weekly", { day, time });
  }
  return t("agent.trigger.schedule");
}

/** Its own number and email address (else your account's), and its /name in your threads. */
function HowToReach({
  id,
  name,
  title,
  commandName,
  isAdmin,
}: {
  id: string;
  name: string | null;
  title: ReactNode;
  commandName: string | null;
  isAdmin: boolean;
}) {
  const { t } = useI18n();
  const channels = useApi(apiRoutes.portalChannels);
  const lines = channels.data?.agents.find((a) => a.agentId === id)?.channels ?? [];
  return (
    <Card
      titleAbove
      title={title}
      testId="agent-contact"
      meta={
        isAdmin ? (
          <Link to={PORTAL_PATHS.channels} className="text-sm text-link hover:underline">
            {t("agent.reachChange")}
          </Link>
        ) : null
      }
    >
      <Loaded state={channels} skeleton={<SkeletonRows rows={2} columns={2} />}>
        {() => (
          <>
            {lines.length > 0 ? (
              <ChannelLines
                lines={lines}
                sourceText={(line) =>
                  line.source === "agent" ? t("channels.own") : t("channels.fromAccount")
                }
                testId="agent-contact-lines"
              />
            ) : null}
            {commandName ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-3 first:border-t-0 max-sm:px-4"
                data-testid="agent-contact-command"
              >
                <span className="w-28 shrink-0 text-sm text-ink-muted">{t("agent.thread")}</span>
                <span className="min-w-0 flex-1 font-mono text-sm text-ink">/{commandName}</span>
              </div>
            ) : null}
            {lines.length === 0 && !commandName && name !== null ? (
              <p className="ui-card__body text-sm text-ink-muted">
                {t("agent.reachItNone", { name })}
              </p>
            ) : null}
          </>
        )}
      </Loaded>
    </Card>
  );
}

// ── Pause and resume (the client admin) ──────────────────────────────────────────────────────────

function PauseControl({
  control,
  name,
  onChange,
}: {
  control: ServiceControl;
  name: string;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      setOpen(false);
      setReason("");
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (control.pause) {
    if (!control.pause.canResume) return null;
    return (
      <span className="flex flex-col items-end gap-2">
        <Button
          variant="primary"
          disabled={busy}
          data-testid="agent-resume"
          onClick={() =>
            run(() => api.call(apiRoutes.portalResumeService, { params: { id: control.id } }))
          }
        >
          {busy ? t("common.sending") : t("agent.resume")}
        </Button>
        {error ? <ErrorNotice error={error} /> : null}
      </span>
    );
  }
  if (!open) {
    return (
      <Button data-testid="agent-pause" onClick={() => setOpen(true)}>
        {t("agent.pause")}
      </Button>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    run(() =>
      api.call(apiRoutes.portalPauseService, {
        params: { id: control.id },
        body: { reason: reason.trim() },
      }),
    );
  };
  return (
    <form
      onSubmit={submit}
      className="ds-card flex w-full max-w-sm flex-col gap-3 p-5"
      data-testid="agent-pause-form"
    >
      <Field label={t("agent.pauseReason", { name })} hint={t("agent.pauseHelp")}>
        <TextArea
          rows={2}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          data-testid="agent-pause-reason"
        />
      </Field>
      {error ? <ErrorNotice error={error} /> : null}
      <span className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={busy || !reason.trim()}
          data-testid="agent-pause-confirm"
        >
          {busy ? t("common.sending") : t("agent.pauseConfirm", { name })}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
      </span>
    </form>
  );
}

function PauseNotice({ control }: { control: ServiceControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const pause = control.pause;
  if (!pause) return null;
  const who =
    pause.side === "client"
      ? t("agent.pausedByYou", { reason: pause.reason })
      : t("agent.pausedByUs", { reason: pause.reason });
  return (
    <div className="ds-card flex flex-col gap-1 p-5" data-testid="agent-paused">
      <span className="flex flex-wrap items-center gap-2">
        <StatusChip state="paused">{t("state.agent.paused")}</StatusChip>
        <span className="text-ink">{who}</span>
      </span>
      <span className="text-sm text-ink-muted">
        {[
          pause.until
            ? t("agent.pausedUntil", { time: shortTime(pause.until, undefined, i18n) })
            : null,
          pause.canResume ? null : t("agent.resumeOurs"),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </div>
  );
}

// ── Recent runs and action items (the Overview's two columns) ────────────────────────────────

const RECENT_RUNS = 8;

/** Its latest runs, newest first, each titled by what it is about; all of them on the Runs tab. */
function RecentRuns({ id }: { id: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<RunTab>("all");
  const statuses = RUN_TABS[status];
  const runs = useApi(apiRoutes.portalRuns, {
    query: { agents: id, limit: RECENT_RUNS, ...(statuses ? { statuses } : {}) },
  });
  usePoll(runs.reload, runs.data?.runs.some((r) => runOpen(r)) ?? false, RUN_POLL_MS, runs.loading);
  useRememberRuns(runs.data?.runs);
  return (
    <Card
      titleAbove
      title={t("agent.recentRuns")}
      meta={
        <Link
          to={PORTAL_PATHS.agentRuns(id)}
          className="text-sm text-link hover:underline"
          data-testid="agent-recent-all"
        >
          {t("agent.allRuns")}
        </Link>
      }
      testId="agent-recent"
    >
      <RunStatusRow value={status} onChange={setStatus} area="agent-recent" />
      <Loaded state={runs} skeleton={<SkeletonRows rows={4} columns={2} />}>
        {(data) =>
          data.runs.length === 0 ? (
            <EmptyState
              compact
              icon="report"
              line={status === "all" ? t("service.noRuns") : t("runsPage.noMatch")}
            />
          ) : (
            <RunRows runs={data.runs.slice(0, RECENT_RUNS)} prefix="agent-recent-run" />
          )
        }
      </Loaded>
    </Card>
  );
}

/** The run lists' status filter (the Runs page's tabs), in a band at the top of the card. */
function RunStatusRow({
  value,
  onChange,
  area,
}: {
  value: RunTab;
  onChange: (tab: RunTab) => void;
  area: string;
}) {
  const { t } = useI18n();
  return (
    <div className="overflow-x-auto border-b border-line px-6 py-3 max-sm:px-4">
      <StatusFilter
        value={value}
        onChange={onChange}
        area={area}
        options={(Object.keys(RUN_TABS) as RunTab[]).map((k) => [k, t(RUN_TAB_WORDS[k])])}
      />
    </div>
  );
}

/** Run rows: its title (what it is about), how long it took, and its state. */
function RunRows({ runs, prefix }: { runs: PortalRun[]; prefix: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <>
      {runs.map((r) => {
        const chip = runChip(r, t);
        const title = subjectTitle(r.subject, i18n);
        return (
          <ActivityRow
            key={r.id}
            testId={`${prefix}-${r.id}`}
            to={`/runs/${r.id}`}
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

/**
 * What waits on you from this agent: your open inbox items it asked for, oldest due first. Each
 * opens in the Inbox, where it is approved or answered.
 */
function ActionItems({ id, name }: { id: string; name: string | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  // The Inbox's own open list (one call between them); snoozed items wait in the Inbox.
  const inbox = useApi(apiRoutes.portalInbox, { query: { status: "open" } });
  const items = (inbox.data?.items ?? []).filter((i) => i.service?.id === id);
  return (
    <Card
      titleAbove
      title={t("agent.actionItems")}
      meta={
        items.length > 0 ? (
          <Link to={PORTAL_PATHS.inbox} className="text-sm text-link hover:underline">
            {t("home.openInbox")}
          </Link>
        ) : null
      }
      testId="agent-actions"
    >
      <Loaded state={inbox} skeleton={<SkeletonRows rows={2} columns={1} />}>
        {() =>
          items.length === 0 ? (
            <EmptyState
              compact
              tone="done"
              line={name ? t("agent.noActionItems", { name }) : t("inbox.emptyOpen")}
            />
          ) : (
            <div className="divide-y divide-line">
              {items.map((item) => {
                const kind = KIND_LABEL[item.kind];
                return (
                  <div
                    key={item.id}
                    className="ui-accent ui-accent--left flex flex-col gap-2 px-6 py-3"
                    data-tone="signal"
                    data-testid={`agent-action-${item.id}`}
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <Tag>{kind ? t(kind) : item.kind}</Tag>
                      {item.dueAt ? (
                        <StatusChip state="waiting">
                          {t("table.due", { time: shortTime(item.dueAt, undefined, i18n) })}
                        </StatusChip>
                      ) : null}
                    </span>
                    <p className="line-clamp-2 font-medium text-ink">{item.title}</p>
                    <Link
                      to={`${PORTAL_PATHS.inbox}?item=${encodeURIComponent(item.id)}`}
                      className={buttonClass("primary", "self-start", "sm")}
                      data-testid={`agent-action-${item.id}-open`}
                    >
                      {APPROVED.has(item.kind) ? t("table.reviewSign") : t("table.openItem")}
                    </Link>
                  </div>
                );
              })}
            </div>
          )
        }
      </Loaded>
    </Card>
  );
}

// ── This month's figures, and what it may do in your tools ───────────────────────────────────────

/**
 * The agent's own figures first (the owner's v1 agent page): runs this month (with its last 14
 * days), changes to your tools, documents read and what waits on you, then its template's own
 * KPIs. Runs always show; a figure at 0 is left out. Each links to its list.
 */
function AgentFiguresStrip({
  id,
  detail,
  kpis: allKpis,
  perDay,
  waiting,
}: {
  id: string;
  detail: Detail;
  kpis: readonly ViewKpi[];
  perDay: readonly DayRuns[] | undefined;
  waiting: number;
}) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { thisMonth } = detail;
  // The client view's KPIs: labels and values, never their definition.
  const kpis = allKpis.filter((k) => k.display !== null);
  const runs14 = (perDay ?? []).reduce((n, d) => n + d.runs, 0);
  const reportPath = `${PORTAL_PATHS.reports}?service=${id}`;
  return (
    <Section
      title={t("service.thisMonth")}
      meta={periodLabel(thisMonth.from, thisMonth.to, i18n.intl)}
      action={
        <Link
          to={reportPath}
          className="text-sm text-link hover:underline"
          data-testid="agent-full-report"
        >
          {t("agent.fullReport")}
        </Link>
      }
      testId="agent-month"
    >
      <KpiStrip testId="agent-figures">
        <StatTile
          testId="portal-service-runs"
          to={PORTAL_PATHS.agentRuns(id)}
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
            to={reportPath}
            label={t("reports.changes")}
            value={fmt.number(thisMonth.actions)}
            tone="slate"
          />
        ) : null}
        {thisMonth.documentsRead > 0 ? (
          <StatTile
            testId="portal-service-documents"
            to={PORTAL_PATHS.upload}
            label={t("reports.documentsRead")}
            value={fmt.number(thisMonth.documentsRead)}
            tone="slate"
          />
        ) : null}
        {waiting > 0 ? (
          <StatTile
            testId="agent-kpi-waiting"
            to={PORTAL_PATHS.inbox}
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

const VERBS = ["read", "create", "update", "delete"] as const;

/** What the agent may do through each connection it is bound to: the effective level per verb. */
function Reach({ id, name }: { id: string; name: string | null }) {
  const { t } = useI18n();
  const access = useApi(apiRoutes.portalAccess, {
    // The vault is never stored (docs/audit-plan.md 1.2).
    cache: "none",
  });
  if (!access.data || name === null) {
    return access.error ? (
      <ErrorNotice error={access.error} onRetry={access.reload} />
    ) : (
      <Skeleton>
        <SkeletonCard lines={4} />
      </Skeleton>
    );
  }
  const items = reachOf(id, access.data);
  return (
    <Card
      titleAbove
      title={t("agent.reach", { name })}
      testId="agent-reach"
      meta={
        access.data.canEdit && items.length > 0 ? (
          <Link to={PORTAL_PATHS.accounts} className="text-sm text-link hover:underline">
            {t("agent.reachChange")}
          </Link>
        ) : null
      }
    >
      {items.length === 0 ? (
        <p className="ui-card__body text-ink-muted">{t("agent.reachNone", { name })}</p>
      ) : (
        <div className="divide-y divide-line">
          {items.map(({ item, grant }) => (
            <div
              key={item.connectionId}
              className="flex flex-col gap-2 px-6 py-4"
              data-testid={`agent-reach-${item.connectionId}`}
            >
              <span className="font-medium text-ink">
                {item.name}
                {/* The account by its name in the tool, never its id there (a QuickBooks realm id). */}
                {(item.accountName ?? accountAddress(item.externalAccountId)) ? (
                  <span className="font-normal text-ink-muted">
                    {" "}
                    · {item.accountName ?? accountAddress(item.externalAccountId)}
                  </span>
                ) : null}
              </span>
              {grant.revoked ? (
                <Badge>{t("agent.revoked")}</Badge>
              ) : (
                <span className="flex flex-wrap gap-1.5">
                  {VERBS.map((verb) => {
                    const level = grant.effective[verb];
                    const words = t(`agent.level.${level}`, { verb: t(`agent.verb.${verb}`) });
                    return (
                      <Badge
                        key={verb}
                        tone={
                          level === "auto"
                            ? "positive"
                            : level === "approval"
                              ? "warning"
                              : "neutral"
                        }
                        testId={`agent-reach-${item.connectionId}-${verb}`}
                      >
                        {words}
                      </Badge>
                    );
                  })}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function reachOf(id: string, access: PortalAccessView) {
  return access.items.flatMap((item) => {
    const grant = item.agents.find((a) => a.agentId === id);
    return grant ? [{ item, grant }] : [];
  });
}

// ── Run now ──────────────────────────────────────────────────────────────────────────────────────

type FieldSpec = {
  key: string;
  label: string;
  kind: "text" | "number" | "boolean" | "choice";
  choices: string[];
  required: boolean;
};

/**
 * A run form's fields, when every field is plain (text, a number, yes or no, one of a list).
 * Null for a form we can't draw yet; it is left out (the Desk and the lead start those runs).
 */
export function formFields(input: Record<string, unknown>): FieldSpec[] | null {
  const props = input.properties;
  if (props === undefined) return [];
  if (typeof props !== "object" || props === null) return null;
  const required = Array.isArray(input.required) ? (input.required as unknown[]) : [];
  const out: FieldSpec[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (typeof raw !== "object" || raw === null) return null;
    const p = raw as Record<string, unknown>;
    const label = typeof p.title === "string" ? p.title : key;
    const base = { key, label, required: required.includes(key), choices: [] as string[] };
    if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string")) {
      out.push({ ...base, kind: "choice", choices: p.enum as string[] });
    } else if (p.type === "string") {
      out.push({ ...base, kind: "text" });
    } else if (p.type === "number" || p.type === "integer") {
      out.push({ ...base, kind: "number" });
    } else if (p.type === "boolean") {
      out.push({ ...base, kind: "boolean" });
    } else {
      return null;
    }
  }
  return out;
}

function RunNow({ id, name, forms }: { id: string; name: string; forms: FormList }) {
  const { t } = useI18n();
  const usable = forms.flatMap((f) => {
    const fields = formFields(f.input);
    return fields ? [{ form: f, fields }] : [];
  });
  if (usable.length === 0) return null;
  return (
    <Card titleAbove title={t("agent.runNow")} testId="agent-run-now">
      <div className="divide-y divide-line">
        {usable.map(({ form, fields }) => (
          <RunFormRow key={form.workflow} id={id} name={name} form={form} fields={fields} />
        ))}
      </div>
    </Card>
  );
}

function RunFormRow({
  id,
  name,
  form,
  fields,
}: {
  id: string;
  name: string;
  form: RunForm;
  fields: FieldSpec[];
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [values, setValues] = useState<Map<string, string | boolean>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [started, setStarted] = useState<string | null>(null);
  const set = (key: string, value: string | boolean) =>
    setValues((m) => new Map(m).set(key, value));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStarted(null);
    const input = Object.fromEntries(
      fields.flatMap((f) => {
        const v = values.get(f.key);
        if (f.kind === "boolean") return [[f.key, v === true]];
        if (v === undefined || v === "") return [];
        return [[f.key, f.kind === "number" ? Number(v) : v]];
      }),
    );
    try {
      const { runId } = await api.call(apiRoutes.portalRunNow, {
        params: { id, slug: form.workflow },
        body: { input },
      });
      setStarted(runId);
      setValues(new Map());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 px-6 py-4"
      data-testid={`agent-run-form-${form.workflow}`}
    >
      <span className="font-medium text-ink">{form.label}</span>
      {fields.map((f) =>
        f.kind === "boolean" ? (
          <label key={f.key} className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="size-4 accent-slate"
              checked={values.get(f.key) === true}
              onChange={(e) => set(f.key, e.target.checked)}
            />
            {f.label}
          </label>
        ) : (
          <Field key={f.key} label={f.label}>
            {f.kind === "choice" ? (
              <Select
                required={f.required}
                value={String(values.get(f.key) ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
              >
                <option value="" />
                {f.choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                type={f.kind === "number" ? "number" : "text"}
                required={f.required}
                value={String(values.get(f.key) ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
          </Field>
        ),
      )}
      {error ? <ErrorNotice error={error} /> : null}
      {started ? (
        <p role="status" className="text-sm text-ink">
          {t("agent.runStarted", { name })}{" "}
          <Link to={`/runs/${started}`} className="text-link hover:underline">
            {t("agent.openRun")}
          </Link>
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={busy}
        className="self-start"
        data-testid={`agent-run-${form.workflow}`}
      >
        {/* 1.8: the press shows at once; the run's link comes with the server's answer. */}
        {busy ? t("common.sending") : t("agent.run")}
      </Button>
    </form>
  );
}
