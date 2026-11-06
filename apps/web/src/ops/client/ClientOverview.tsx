// The client page's Overview tab (`/ops/clients/:clientId`): the client at a glance in the
// prototype's back-office style. Figures first (agents live, waiting on us, connections, open
// findings), then each agent's go-live stage, the client's health with its supervisor and its
// billing, and on the rail its Mezonas lead (set here) and its threads with what is unread for you.
import type { AgentStage, GoLive } from "@countersign/core";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { type ApiState, useApi, useApiClient } from "../../api/useApi";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { ProgressBar, StatTile } from "../../ui/figures";
import { Select } from "../../ui/forms";
import { Columns, PageGrid, Section } from "../../ui/page";
import { Button, Card, EmptyState, ErrorNotice, Loading } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { STAGE_LABEL } from "../agents/GoLivePanel";
import { OPS_PATHS } from "../paths";
import { ClientBillingSection } from "../screens/ClientBilling";
import { ClientHealthSection } from "../screens/ClientHealth";
import { ClientFrame, type OpsClient, useClientPage } from "./ClientFrame";

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
  const health = useApi(apiRoutes.opsClientHealth, {
    params: { id: clientId },
    query: { status: "open" },
  });
  const data = client.data;
  if (!data) return client.error ? null : <Loading />;

  const agents = data.agents.filter((a) => !a.testCopy);
  const live = agents.filter((a) => a.liveVersionId !== null).length;
  const connected = data.connections.filter((c) => c.status === "connected").length;
  const needPerson = data.connections.length - connected;
  const waiting = inbox.data?.items ?? [];
  const findings = health.data?.findings.length;

  return (
    <>
      <Columns count={4}>
        <StatTile
          testId="ops-client-stat-live"
          label="Agents live"
          value={live}
          note={`of ${agents.length} ${agents.length === 1 ? "agent" : "agents"}`}
        />
        <StatTile
          testId="ops-client-stat-waiting"
          label="Waiting on us"
          value={inbox.data ? waiting.length : "–"}
          note={waiting.length > 0 ? "Open escalations" : "Nothing open"}
          {...(waiting.length > 0 ? { noteTone: "signal" as const } : {})}
        />
        <StatTile
          testId="ops-client-stat-connections"
          label="Connections"
          value={connected}
          note={
            data.connections.length === 0
              ? "None yet"
              : needPerson > 0
                ? `${needPerson} not connected`
                : "All connected"
          }
          {...(needPerson > 0 ? { noteTone: "risk" as const } : {})}
        />
        <StatTile
          testId="ops-client-stat-findings"
          label="Open findings"
          value={findings ?? "–"}
          note={health.data?.supervisor ? "From the supervisor" : "No supervisor yet"}
          alert={(findings ?? 0) > 0}
        />
      </Columns>

      <PageGrid rail={<Rail clientId={clientId} data={data} />}>
        {waiting.length > 0 ? (
          <Section
            title="Waiting on us"
            meta={`${waiting.length} open`}
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

        <GoLiveStages clientId={clientId} agents={agents} />
        <ClientHealthSection clientId={clientId} onChanged={client.reload} />
        <ClientBillingSection clientId={clientId} />
      </PageGrid>
    </>
  );
}

/** Each client agent on its way live: bench, trial, sign-off, live. */
function GoLiveStages({ clientId, agents }: { clientId: string; agents: AgentSummary[] }) {
  return (
    <Section title="Go-live stages" meta="Bench, trial, sign-off, live" testId="ops-client-go-live">
      {agents.length === 0 ? (
        <EmptyState>No agents yet. Start one on the Agents tab.</EmptyState>
      ) : (
        <Card>
          {agents.map((a) => (
            <StageRow key={a.id} clientId={clientId} agent={a} />
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
function stageNote(g: GoLive): string | null {
  if (g.pause) {
    const who = g.pause.side === "client" ? "the client" : "us";
    return `Paused by ${who}: ${g.pause.reason}`;
  }
  if (g.stage === "trial" && g.trial) {
    return `Day ${g.trial.days} of ${g.trial.minDays} · ${g.trial.runs} of ${g.trial.minRuns} live runs${g.trial.ready ? " · ready for sign-off" : ""}`;
  }
  if (g.stage === "signoff" && g.signoff) return `Asked ${shortDate(g.signoff.askedAt)}`;
  if ((g.stage ?? "bench") === "bench") {
    return g.writes ? "Test runs only" : "Writes nothing: goes straight to live";
  }
  return null;
}

function StageRow({ clientId, agent }: { clientId: string; agent: AgentSummary }) {
  const state = useApi(apiRoutes.opsAgentGoLive, { params: { id: agent.id } });
  const g = state.data?.goLive;
  const stage = g?.stage ?? "bench";
  const step = STAGES.indexOf(stage) + 1;
  const chip = g ? stageChip(g) : null;
  const note = g ? stageNote(g) : null;
  return (
    <div className="ui-activity" data-testid={`ops-client-stage-${agent.slug}`}>
      <span className="ui-activity__badge">
        <AgentBadge name={agent.serviceName ?? agent.name} size="sm" />
      </span>
      <span className="ui-activity__text flex min-w-0 flex-col gap-1.5">
        <Link
          to={`${OPS_PATHS.client(clientId)}/agents/${agent.slug}`}
          className="font-medium text-ink hover:underline"
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
            {note ? <span className="text-sm text-ink-muted">{note}</span> : null}
          </>
        ) : state.error ? (
          <span className="text-sm text-ink-muted">The stage could not be loaded.</span>
        ) : null}
      </span>
      <span className="ui-activity__end">
        {chip ? <StatusChip state={chip.state}>{chip.words}</StatusChip> : null}
      </span>
    </div>
  );
}

type Threads = ApiState<ResponseOf<typeof apiRoutes.opsThreads>>;

function Rail({ clientId, data }: { clientId: string; data: OpsClient }) {
  const threads = useApi(apiRoutes.opsThreads, { params: { id: clientId } });
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
        <Loading />
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
