// The client page's Overview tab (`/ops/clients/:clientId`): the client at a glance, short. What
// waits on us (only when something does), each agent with its go-live stage and a link to the
// client's runs, the client's health (its supervisor and what it found), and on the rail its
// Mezonas lead (set here) and its threads with what is unread for you. Billing is in Settings.
import type { AgentStage, GoLive, OpsAgentActivity } from "@countersign/core";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { type ApiState, useApi, useApiClient } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { hasRuns, ProgressBar, Sparkline } from "../../ui/figures";
import { Select } from "../../ui/forms";
import { PageGrid, Section } from "../../ui/page";
import { Button, Card, EmptyState, ErrorNotice } from "../../ui/primitives";
import { Skeleton, SkeletonCard, SkeletonLine, SkeletonRows } from "../../ui/skeleton";
import { type ChipState, StatusChip } from "../../ui/status";
import { STAGE_LABEL } from "../agents/GoLivePanel";
import { prefetchAgent, useIntent } from "../agents/prefetch";
import { OPS_PATHS } from "../paths";
import { runsLink } from "../run/links";
import { plural, RUN_STATUS_WORDS } from "../run/words";
import type { AgentLinkState } from "../screens/AgentPage";
import { ClientHealthSection } from "../screens/ClientHealth";
import { ClientFrame, clientPagePath, type OpsClient, useClientPage } from "./ClientFrame";

const STAGES: AgentStage[] = ["bench", "trial", "signoff", "live"];

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function ClientOverviewScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <Overview clientId={clientId} />
    </ClientFrame>
  );
}

function Overview({ clientId }: { clientId: string }) {
  const client = useClientPage();
  const inbox = useApi(apiRoutes.opsInbox, {
    query: { client: clientId, status: "open", assigned: "operator" },
  });
  // Started with the client and the inbox, not after them (1.5): the rail's lead and threads.
  const threads = useApi(apiRoutes.opsThreads, { params: { id: clientId } });
  const data = client.data;
  if (!data) return client.error ? null : <OverviewSkeleton />;

  const agents = data.agents.filter((a) => !a.testCopy);
  const waiting = inbox.data?.items ?? [];

  return (
    <PageGrid rail={<Rail clientId={clientId} data={data} threads={threads} />}>
      {waiting.length > 0 ? (
        <Section
          title="Waiting on us"
          meta={`${waiting.length} open`}
          action={
            <Link to={OPS_PATHS.escalations} className="ds-btn ds-btn--link text-sm">
              Escalations
            </Link>
          }
          testId="ops-client-waiting"
        >
          <Card>
            {waiting.slice(0, 5).map((item) => (
              <ActivityRow
                key={item.id}
                time={shortDate(item.createdAt)}
                to={OPS_PATHS.escalations}
                end={<StatusChip state="waiting">Waiting on us</StatusChip>}
              >
                {item.title}
              </ActivityRow>
            ))}
          </Card>
        </Section>
      ) : null}

      <AgentStages clientId={clientId} agents={agents} activity={data.activity} />
      <ClientHealthSection clientId={clientId} onChanged={client.reload} />
    </PageGrid>
  );
}

/**
 * Each client agent on its way live (bench, trial, sign-off, live) with its work at a glance (runs
 * in 7 days and each day, its last run, what waits for approval), and the client's runs. How many
 * are live is in the header's line, not repeated here.
 */
function AgentStages({
  clientId,
  agents,
  activity,
}: {
  clientId: string;
  agents: AgentSummary[];
  activity: readonly OpsAgentActivity[] | undefined;
}) {
  return (
    <Section
      title="Agents"
      action={
        <Link
          to={clientPagePath(clientId, "runs")}
          className="ds-btn ds-btn--link text-sm"
          data-testid="ops-client-runs"
        >
          See runs
        </Link>
      }
      testId="ops-client-go-live"
    >
      {agents.length === 0 ? (
        <EmptyState
          line="No agents yet. Fork a template into this client, or build one for it."
          action={{
            label: "New agent",
            to: OPS_PATHS.newAgent(clientId),
            testId: "ops-client-empty-new-agent",
          }}
        />
      ) : (
        <Card>
          {agents.map((a) => (
            <StageRow
              key={a.id}
              clientId={clientId}
              agent={a}
              activity={activity?.find((x) => x.agentId === a.id)}
            />
          ))}
        </Card>
      )}
    </Section>
  );
}

function stageChip(g: GoLive): { state: ChipState; words: string } {
  if (g.pause) return { state: "paused", words: "Paused" };
  switch (g.stage) {
    case "live":
      return { state: "done", words: "Live" };
    case "signoff":
      return { state: "waiting", words: "Waiting on the client's sign-off" };
    case "trial":
      return { state: "running", words: "Trial" };
    default:
      return { state: "setup", words: "Bench" };
  }
}

/** "Day 3 of 14 · 12 of 20 runs", "Asked Nov 4", "Paused by the client: …". */
export function stageNote(g: GoLive): string | null {
  if (g.pause) {
    const who = g.pause.side === "client" ? "the client" : "us";
    return `Paused by ${who}: ${g.pause.reason}`;
  }
  if (g.stage === "trial" && g.trial) {
    return `Day ${g.trial.days} of ${g.trial.minDays} · ${g.trial.runs} of ${g.trial.minRuns} live runs${g.trial.ready ? " · ready for sign-off" : ""}`;
  }
  if (g.stage === "signoff" && g.signoff) return `Asked ${shortDate(g.signoff.askedAt)}`;
  if ((g.stage ?? "bench") === "bench") {
    // Fix 2 of the design pass: `writes` is read from the latest version while none is live, and
    // a draft says so rather than "goes straight to live".
    if (g.liveVersion === false) {
      return g.writes ? "No live version yet · test runs only" : "No live version yet";
    }
    return g.writes ? "Test runs only" : "Writes nothing: goes straight to live";
  }
  return null;
}

/** A row's state colour beside its chip: waiting (signal), last run failed (risk), live (positive). */
export function stageTone(
  g: GoLive | undefined,
  a: OpsAgentActivity | undefined,
): "signal" | "risk" | "positive" | undefined {
  if (a && a.waitingRuns > 0) return "signal";
  if (g?.signoff && g.stage === "signoff") return "signal";
  if (a?.lastRun?.status === "failed") return "risk";
  if (g?.stage === "live" && !g.pause) return "positive";
  return undefined;
}

/** "12 live runs in 7 days · Last run 2:04 PM, done". */
export function activityLine(a: OpsAgentActivity): string {
  const last = a.lastRun;
  if (!last) return "No runs yet";
  // A waiting run's state is the chip beside this line, not repeated in it.
  const state = last.waiting
    ? ""
    : `, ${(RUN_STATUS_WORDS[last.status] ?? last.status).toLowerCase()}`;
  return [
    a.runs7d > 0 ? `${plural(a.runs7d, "live run", "live runs")} in 7 days` : null,
    `Last run ${shortTime(last.at)}${state}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function StageRow({
  clientId,
  agent,
  activity,
}: {
  clientId: string;
  agent: AgentSummary;
  activity: OpsAgentActivity | undefined;
}) {
  const state = useApi(apiRoutes.opsAgentGoLive, { params: { id: agent.id } });
  const intent = useIntent();
  const g = state.data?.goLive;
  const stage = g?.stage ?? "bench";
  const step = STAGES.indexOf(stage) + 1;
  const chip = g ? stageChip(g) : null;
  const note = g ? stageNote(g) : null;
  const tone = stageTone(g, activity);
  const days = activity?.perDay;
  const days14 = (days ?? []).reduce((n, d) => n + d.runs, 0);
  return (
    <div
      className={`ui-activity ${tone ? "ui-accent ui-accent--left" : ""}`}
      data-tone={tone}
      data-testid={`ops-client-stage-${agent.slug}`}
    >
      <span className="ui-activity__badge">
        <AgentBadge name={agent.serviceName ?? agent.name} seed={agent.id} size="sm" />
      </span>
      <span className="ui-activity__text flex min-w-0 flex-col gap-1.5">
        <Link
          to={`${OPS_PATHS.client(clientId)}/agents/${agent.slug}`}
          state={{ agentId: agent.id } satisfies AgentLinkState}
          className="font-medium text-ink hover:underline"
          {...intent(agent.id, (p) => prefetchAgent(p, agent.id))}
        >
          {agent.serviceName ?? agent.name}
        </Link>
        {g ? (
          <>
            <ProgressBar
              value={step}
              max={STAGES.length}
              label={`Stage ${step} of ${STAGES.length}: ${STAGE_LABEL[stage]}`}
              tone={stage === "signoff" ? "waiting" : "accent"}
            />
            {note ? (
              <span className="text-sm text-ink-muted" data-testid="ops-client-stage-note">
                {note}
              </span>
            ) : null}
          </>
        ) : state.error ? (
          <span className="text-sm text-ink-muted">The stage could not be loaded.</span>
        ) : null}
        {activity ? (
          <span
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted"
            data-testid={`ops-client-activity-${agent.slug}`}
          >
            <span>{activityLine(activity)}</span>
            {activity.waitingRuns > 0 ? (
              <Link
                to={runsLink({ statuses: ["waiting"], mode: "live", agents: [agent.id] })}
                className="no-underline"
              >
                <StatusChip state="waiting">
                  {plural(activity.waitingRuns, "run", "runs")} waiting for approval
                </StatusChip>
              </Link>
            ) : null}
          </span>
        ) : null}
      </span>
      <span className="ui-activity__end flex-col items-end gap-2">
        {chip ? <StatusChip state={chip.state}>{chip.words}</StatusChip> : null}
        {hasRuns(days) ? (
          <Sparkline
            days={days}
            label={`Runs each day, last ${days.length} days: ${days14} in all`}
            testId={`ops-client-spark-${agent.slug}`}
          />
        ) : null}
      </span>
    </div>
  );
}

type Threads = ApiState<ResponseOf<typeof apiRoutes.opsThreads>>;

/** The Overview's shape while the client loads: the agents' rows, and the rail's two cards. */
function OverviewSkeleton() {
  return (
    <Skeleton testId="ops-client-overview-skeleton">
      <PageGrid
        rail={
          <>
            <SkeletonCard lines={2} />
            <SkeletonCard lines={3} />
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <SkeletonLine size="heading" width="short" />
          <SkeletonRows rows={3} columns={2} />
        </div>
      </PageGrid>
    </Skeleton>
  );
}

function Rail({
  clientId,
  data,
  threads,
}: {
  clientId: string;
  data: OpsClient;
  threads: Threads;
}) {
  return (
    <>
      <LeadCard clientId={clientId} data={data} threads={threads} />
      <ThreadsCard threads={threads} />
    </>
  );
}

/** The client's Mezonas lead (copper: a person of ours), and choosing another. */
function LeadCard({
  clientId,
  data,
  threads,
}: {
  clientId: string;
  data: OpsClient;
  threads: Threads;
}) {
  const api = useApiClient();
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const operators = data.members.filter((m) => m.role === "operator");
  const lead = threads.data?.lead ?? null;
  const picked = choice ?? lead?.userId ?? "";

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await api.call(apiRoutes.opsSetLead, {
        params: { id: clientId },
        body: { userId: picked === "" ? null : picked, reason: "" },
      });
      setChoice(null);
      threads.reload();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Mezonas lead" pad testId="ops-client-lead">
      {threads.error ? <ErrorNotice error={threads.error} onRetry={threads.reload} /> : null}
      {threads.data ? (
        <div className="flex flex-col gap-4">
          {lead ? (
            <PersonBadge name={lead.name ?? lead.email} line={lead.email} />
          ) : (
            <p className="text-ink-muted">No lead yet. The client sees their lead in the portal.</p>
          )}
          {operators.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Lead"
                data-testid="ops-client-lead-choice"
                className="min-w-0 flex-1"
                value={picked}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">No lead</option>
                {operators.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name ?? m.email}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                disabled={busy || picked === (lead?.userId ?? "")}
                onClick={() => void save()}
                data-testid="ops-client-lead-save"
              >
                Set lead
              </Button>
            </div>
          ) : null}
          {problem ? <ErrorNotice error={problem} /> : null}
        </div>
      ) : threads.error ? null : (
        <Skeleton>
          <SkeletonLine width="half" />
          <SkeletonLine width="long" size="small" />
        </Skeleton>
      )}
    </Card>
  );
}

/** The client's threads (with its lead and its agents), newest first, with what you haven't read. */
function ThreadsCard({ threads }: { threads: Threads }) {
  const list = [...(threads.data?.threads ?? [])].sort((a, b) =>
    (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt),
  );
  const unread = list.reduce((n, t) => n + t.unread, 0);
  return (
    <Card
      titleAbove
      title="Threads"
      meta={unread > 0 ? `${unread} unread` : undefined}
      testId="ops-client-threads"
    >
      {threads.error ? (
        <div className="ui-card__body">
          <ErrorNotice error={threads.error} onRetry={threads.reload} />
        </div>
      ) : null}
      {threads.data && list.length === 0 ? (
        <p className="ui-card__body text-ink-muted">No threads yet.</p>
      ) : null}
      {list.slice(0, 8).map((t) => (
        <ActivityRow
          key={t.id}
          time={shortDate(t.lastMessageAt ?? t.createdAt)}
          end={
            t.unread > 0 ? <StatusChip state="waiting">{`${t.unread} unread`}</StatusChip> : null
          }
        >
          <span className="block truncate">{t.title}</span>
          {t.agent ? <span className="block text-sm text-ink-muted">{t.agent.name}</span> : null}
        </ActivityRow>
      ))}
    </Card>
  );
}
