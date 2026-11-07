// `/agents/:id`: one agent as the client sees it (docs/ui-plan.md C2, Review 1). The header holds
// its name, its state, its go-live stage and Pause (the client admin). Three tabs:
// - Overview: the agent's own view first (a slot for per-template or per-pack screens,
//   ../../agents/views.ts; by default the client's pack reports, then this month's activity),
//   upload and documents for an agent that reads them, then what it is doing now and its latest
//   work; "Run now" beside them when it has a form.
// - Runs (`/agents/:id/runs`): its runs, the Runs list filtered to it.
// - Access (`/agents/:id/access`): what it may do in each of your tools, read-only (the client
//   admin tightens on Accounts), and who it contacts (the client admin chooses).
// Never the agent's bundle, instructions, prompts or cost (invariant 11).
import type { DayRuns, PortalAccessView, RunForm, ServiceControl } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { type AgentViewKey, defaultReports, viewsFor } from "../../agents/views";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { packReportPath } from "../../packs/registry";
import { PortalPeopleList } from "../../people/PeoplePanel";
import { shortTime } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { HeaderSwitcher } from "../../shell/HeaderSwitcher";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge } from "../../ui/badges";
import { hasRuns, KpiStrip, Sparkline, StatTile } from "../../ui/figures";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Loaded, Page, PageGrid, Section } from "../../ui/page";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Tabs,
  Tag,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { type StepItem, StepList, type StepState } from "../../ui/steps";
import { periodLabel } from "../../usage/format";
import { stageWord } from "../agentState";
import { PORTAL_PATHS } from "../paths";
import { agentChip, type RunFields, runChip, runOpen } from "../status";
import { accountAddress } from "./Accounts";
import { runsNote } from "./Reports";
import { RunTimes } from "./runsParts";
import { DropZone, Forwarding, RecentDocuments } from "./Upload";

const RUN_POLL_MS = 5_000;

export type AgentTab = "overview" | "runs" | "access";

export function AgentScreen({ tab = "overview" }: { tab?: AgentTab }) {
  const { id = "" } = useParams();
  const detail = useApi(apiRoutes.portalService, { params: { id } });
  return (
    <Page testId="portal-agent">
      <Loaded state={detail}>
        {(data) => <AgentPage id={id} tab={tab} detail={data} reload={detail.reload} />}
      </Loaded>
    </Page>
  );
}

type Detail = ResponseOf<typeof apiRoutes.portalService>;

function useIsAdmin(): boolean {
  const session = useSession();
  const client =
    session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  return client?.role === "client_admin";
}

function AgentPage({
  id,
  tab,
  detail,
  reload,
}: {
  id: string;
  tab: AgentTab;
  detail: Detail;
  reload: () => void;
}) {
  const { t } = useI18n();
  const isAdmin = useIsAdmin();
  const { service } = detail;

  // What it is doing now and its stage come from Home's route; its controls are the client admin's.
  const table = useApi(apiRoutes.portalTable);
  const controls = useApi(apiRoutes.portalServiceControls, isAdmin ? {} : null);
  const live = table.data?.services.find((s) => s.id === id) ?? null;
  const control = controls.data?.services.find((s) => s.id === id) ?? null;
  const chip = agentChip(
    {
      status: service.status,
      stage: live?.stage ?? null,
      now: live?.now ?? null,
      runsNow: live?.runsNow,
    },
    t,
  );
  const stage = stageWord(live?.stage ?? null, t);
  const name = service.name;
  const refresh = () => {
    reload();
    table.reload();
    controls.reload();
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to={PORTAL_PATHS.home} className="hover:underline">
            {t("nav.home")}
          </Link>
        }
        beside={<HeaderSwitcher />}
        leading={<AgentBadge name={name} seed={id} size="lg" />}
        title={name}
        badge={
          <span className="flex items-center gap-2">
            <StatusChip state={chip.state} testId="agent-state">
              {chip.label}
            </StatusChip>
            {stage ? <Tag>{stage}</Tag> : null}
          </span>
        }
        // DECISION: no line when the agent has no description (the role is written for us).
        subtitle={service.description ?? undefined}
        actions={
          isAdmin && control ? (
            <PauseControl control={control} name={name} onChange={refresh} />
          ) : null
        }
      />
      {control?.pause ? <PauseNotice control={control} /> : null}
      <Tabs
        items={[
          { to: PORTAL_PATHS.agent(id), label: t("agent.tab.overview"), end: true },
          { to: PORTAL_PATHS.agentRuns(id), label: t("agent.tab.runs") },
          { to: PORTAL_PATHS.agentAccess(id), label: t("agent.tab.access") },
        ]}
      />
      {tab === "runs" ? (
        <AgentRuns id={id} />
      ) : tab === "access" ? (
        <AgentAccess id={id} name={name} isAdmin={isAdmin} />
      ) : (
        <>
          <AgentFiguresStrip
            id={id}
            detail={detail}
            perDay={live?.perDay}
            waiting={live?.runsNow?.waitingOnYou ?? 0}
          />
          <PageGrid rail={<RunNow id={id} name={name} />}>
            <OwnView id={id} detail={detail} />
            {detail.readsDocuments ? <Documents isAdmin={isAdmin} /> : null}
            <RightNow
              runId={live?.now?.runId ?? null}
              going={live?.now ? runOpen(live.now) : false}
            />
            <LatestWork
              name={name}
              recent={finishedWork(
                (table.data?.recent ?? []).filter((r) => r.service.id === id),
                [...detail.recentRuns, ...(live?.now ? [{ id: live.now.runId, ...live.now }] : [])],
              )}
            />
          </PageGrid>
        </>
      )}
    </>
  );
}

// ── The agent's own view (the slot) ──────────────────────────────────────────────────────────────

/**
 * What a registered view for this agent's template or pack draws; without one, the client's pack
 * reports and then this month's activity (the generic report, with a link to the full one).
 */
function OwnView({ id, detail }: { id: string; detail: Detail }) {
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
          title={r.title}
          meta={
            <Link to={packReportPath(r)} className="text-sm text-link hover:underline">
              {r.description}
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
  const i18n = useI18n();
  const { t } = i18n;
  const runs = useApi(apiRoutes.portalRuns, { query: { agents: id, limit: 50 } });
  usePoll(runs.reload, runs.data?.runs.some((r) => runOpen(r)) ?? false, RUN_POLL_MS, runs.loading);
  return (
    <Loaded state={runs}>
      {(data) =>
        data.runs.length === 0 ? (
          <EmptyState>{t("service.noRuns")}</EmptyState>
        ) : (
          <Card testId="portal-service-recent-runs">
            {data.runs.map((r) => (
              <ActivityRow
                key={r.id}
                testId={`portal-service-run-${r.id}`}
                time={r.startedAt ? shortTime(r.startedAt, undefined, i18n) : ""}
                to={`/runs/${r.id}`}
                end={
                  <StatusChip
                    state={runChip(r, t).state}
                    testId={`portal-service-run-${r.id}-state`}
                  >
                    {runChip(r, t).label}
                  </StatusChip>
                }
              >
                {r.startedAt ? <RunTimes run={r} /> : t("run.notStarted")}
              </ActivityRow>
            ))}
          </Card>
        )
      }
    </Loaded>
  );
}

// ── Access ───────────────────────────────────────────────────────────────────────────────────────

/** What it may do in your tools (read-only here), and who it contacts (the client admin's). */
function AgentAccess({ id, name, isAdmin }: { id: string; name: string; isAdmin: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-8">
      <Reach id={id} name={name} />
      {isAdmin ? (
        <Section title={t("agent.contacts", { name })} testId="agent-contacts">
          <p className="text-sm text-ink-muted">{t("agent.contactsHelp")}</p>
          <PortalPeopleList agentId={id} />
        </Section>
      ) : null}
    </div>
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
          {t("agent.resume")}
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
          {t("agent.pauseConfirm", { name })}
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

// ── Right now: the run going (or the last one), step by step ─────────────────────────────────────

function stepState(status: string): StepState {
  switch (status) {
    case "succeeded":
      return "done";
    case "running":
      return "current";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return "todo";
  }
}

function RightNow({ runId, going }: { runId: string | null; going: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const run = useApi(apiRoutes.portalRun, runId ? { params: { id: runId } } : null);
  usePoll(run.reload, going && runId !== null, RUN_POLL_MS, run.loading);
  // Nothing ran yet: the section is left out (empty sections hide).
  if (!runId) return null;
  const data = run.data;
  const steps: StepItem[] = (data?.steps ?? []).map((s) => ({
    key: s.id,
    title: s.label,
    detail: [s.summary, ...(s.oversight ?? [])].filter(Boolean).join(" · ") || undefined,
    state: stepState(s.status),
    time: s.startedAt ? shortTime(s.startedAt, undefined, i18n) : "",
  }));
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <Card
      testId="agent-now"
      title={
        <span className="flex flex-col">
          <span>{data && runOpen(data.run) ? t("agent.rightNow") : t("table.lastRun")}</span>
          {data?.run.startedAt ? (
            <span className="text-sm font-normal text-ink-muted">
              {t("table.started", { time: shortTime(data.run.startedAt, undefined, i18n) })}
            </span>
          ) : null}
        </span>
      }
      meta={
        data ? (
          <StatusChip state={runChip(data.run, t).state} testId="agent-now-state">
            {runChip(data.run, t).label}
            {runOpen(data.run) && steps.length > 0
              ? ` · ${t("table.stepOf", { index: Math.min(done + 1, steps.length), total: steps.length })}`
              : ""}
          </StatusChip>
        ) : null
      }
      footer={
        <Link to={`/runs/${runId}`} className="text-sm text-link hover:underline">
          {t("agent.openRun")}
        </Link>
      }
    >
      <div className="ui-card__body">
        {run.error ? <ErrorNotice error={run.error} onRetry={run.reload} /> : null}
        {data && steps.length === 0 ? (
          <p className="text-ink-muted">{runChip(data.run, t).label}</p>
        ) : null}
        {steps.length > 0 ? <StepList steps={steps} testId="agent-now-steps" /> : null}
      </div>
    </Card>
  );
}

// ── Its latest work ──────────────────────────────────────────────────────────────────────────────

function LatestWork({ name, recent }: { name: string; recent: Recent[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  if (recent.length === 0) return null;
  return (
    <Card title={t("agent.latest", { name })} testId="agent-latest">
      {recent.map((r) => (
        <ActivityRow
          key={`${r.runId}:${r.label}:${r.at ?? ""}`}
          time={r.at ? shortTime(r.at, undefined, i18n) : ""}
          to={`/runs/${r.runId}`}
        >
          {r.summary ?? r.label}
        </ActivityRow>
      ))}
    </Card>
  );
}

type Recent = { runId: string; label: string; summary: string | null; at: string | null };

/**
 * An agent's latest work: steps of its finished runs only (the run going now is in "Right now"
 * above), newest first by the time each shows.
 */
export function finishedWork(recent: Recent[], runs: (RunFields & { id: string })[]): Recent[] {
  const open = new Set(runs.filter((r) => runOpen(r)).map((r) => r.id));
  const time = (r: Recent) => (r.at ? new Date(r.at).getTime() : 0);
  return recent.filter((r) => !open.has(r.runId)).sort((a, b) => time(b) - time(a));
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
  perDay,
  waiting,
}: {
  id: string;
  detail: Detail;
  perDay: readonly DayRuns[] | undefined;
  waiting: number;
}) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const view = useApi(apiRoutes.portalServiceView, { params: { id } });
  const { thisMonth } = detail;
  // The client view's KPIs: labels and values, never their definition.
  const kpis = (view.data?.kpis ?? []).filter((k) => k.display !== null);
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
function Reach({ id, name }: { id: string; name: string }) {
  const { t } = useI18n();
  const access = useApi(apiRoutes.portalAccess);
  if (!access.data) return null;
  const items = reachOf(id, access.data);
  return (
    <Card
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

function RunNow({ id, name }: { id: string; name: string }) {
  const { t } = useI18n();
  const forms = useApi(apiRoutes.portalRunForms, { params: { id } });
  const usable = (forms.data?.forms ?? []).flatMap((f) => {
    const fields = formFields(f.input);
    return fields ? [{ form: f, fields }] : [];
  });
  if (usable.length === 0) return null;
  return (
    <Card title={t("agent.runNow")} testId="agent-run-now">
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
        {t("agent.run")}
      </Button>
    </form>
  );
}
