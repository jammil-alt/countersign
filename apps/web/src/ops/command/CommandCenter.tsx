// `/ops`, O1 Command center (docs/design/prototype.html `#O1-Command`; ARCHITECTURE §13.1): every
// agent, every client, right now. Up to four figures, each a link to its filtered list (Needs us,
// waiting for approval, running now, failed today; a figure at 0 is left out); "Needs us", the
// escalations sorted by how long a client has been blocked, beside the recent runs (by client and
// status); all agents by client, template or status; then client health with the supervisor's
// findings, low-confidence readings and run oversight. Back office only: cost is shown here (invariant 11).
// Polls every 30 s; the recent runs every 10 s.
import {
  APPROVAL_OVERDUE_HOURS,
  BLOCKED_LONG_HOURS,
  type CommandCenter,
  type DayRuns,
  type Escalation,
  goLiveCounts,
  HEALTH_DAYS,
  KPI_DAYS,
  shortRunId,
} from "@countersign/core";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { shortTime, usd } from "../../runs/format";
import { opsRunTitle } from "../../runs/subject";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge, AgentHuesProvider } from "../../ui/badges";
import { hasRuns, Sparkbars, Sparkline, StatTile } from "../../ui/figures";
import { Select } from "../../ui/forms";
import { Columns, Loaded, Page } from "../../ui/page";
import { Button, buttonClass, Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { useShareCounts } from "../OpsLayout";
import { OPS_PATHS } from "../paths";
import { failedRunsSince, RUNNING_RUNS, runsLink, WAITING_RUNS } from "../run/links";
import { age, oversightLine, percent, plural, runChip } from "../run/words";
import { escalationAction, escalationChip, escalationLine, escalationTone } from "./escalations";

/** How often the figures reload, and the recent runs. */
export const COMMAND_POLL_MS = 30_000;
export const RUNS_POLL_MS = 10_000;
/** The feed keeps this many items on screen. */
export const RECENT_RUNS_SHOWN = 8;
/** "Needs us" shows this many before "Show all". */
export const NEEDS_US_SHOWN = 6;

type Agent = CommandCenter["agents"][number];
type Grouping = "client" | "template" | "status";

export function CommandCenterScreen() {
  const state = useApi(apiRoutes.opsCommandCenter);
  usePoll(state.reload, true, COMMAND_POLL_MS, state.loading);
  // DECISION: one request for the page (docs/plan.md §1.84). The agents table's "N versions behind"
  // and Run oversight come with the command center, and so do the badges' counts, which the frame
  // takes from here instead of computing Needs us again.
  const behind = useMemo(
    () =>
      new Map(
        (state.data?.agents ?? []).flatMap((a) => (a.behind ? [[a.id, a.behind] as const] : [])),
      ),
    [state.data],
  );
  const counts = useMemo(
    () =>
      state.data
        ? { needsUs: state.data.needUs.count, clients: state.data.clientCounts ?? [] }
        : null,
    [state.data],
  );
  useShareCounts(counts);

  return (
    <Page testId="ops-command">
      <PageHeader
        title="Command center"
        subtitle={state.data ? todayLine(state.data) : "Every agent, every client, right now."}
        actions={
          <span className="flex flex-wrap items-center gap-3">
            {state.data ? (
              <StatusChip state="checked" testId="ops-command-at">
                Live · {shortTime(state.data.at)}
              </StatusChip>
            ) : null}
            <Link to={OPS_PATHS.lab} className={buttonClass("secondary")}>
              Open agent lab
            </Link>
          </span>
        }
      />
      <Loaded state={state}>
        {(data) => (
          <AgentHuesProvider agents={data.agents.map((a) => ({ id: a.id, group: a.client.id }))}>
            <Figures data={data} />
            {/* What needs us beside what just ran: the two lists read side by side. */}
            <Columns count={2}>
              <NeedsUs escalations={data.escalations} count={data.needUs.count} />
              <RecentRuns />
            </Columns>
            <AllAgents agents={data.agents} behind={behind} />
            <ClientHealth data={data} />
            <LowConfidence data={data} />
            <Oversight data={data.oversight} />
          </AgentHuesProvider>
        )}
      </Loaded>
    </Page>
  );
}

// ── Figures ──

/**
 * "$41.80 model spend today · 2 agents live · 1 in trial": under the title. Today's runs are the
 * first figure, so they aren't repeated here. "Live" is core's `isLiveAgent` (switched on, at the
 * live stage); trial and sign-off are named as such.
 */
export function todayLine(data: CommandCenter): string {
  return [`${usd(data.spendToday.costUsd)} model spend today`, liveWords(data.agents)].join(" · ");
}

/** "2 agents live · 1 in trial · 1 in sign-off", from the agents' go-live stages. */
export function liveWords(agents: readonly Pick<Agent, "status" | "stage">[]): string {
  const n = goLiveCounts(agents.map((a) => ({ runStatus: a.status, stage: a.stage })));
  return [
    `${plural(n.live, "agent", "agents")} live`,
    n.trial > 0 ? `${n.trial} in trial` : null,
    n.signoff > 0 ? `${n.signoff} in sign-off` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A day's failed runs as a sparkline's points. */
const failedDays = (days: readonly DayRuns[]) => days.map((d) => ({ runs: d.failed }));

/**
 * Up to four figures, each a link to its list filtered (UI cleanup, stream A), in its state colour
 * (design pass): Needs us (risk, Escalations), waiting for approval (signal), runs today (slate,
 * with live runs each day for 14 days; always shown) and failed today (risk). Needs us, waiting
 * and failed are left out at 0.
 */
function Figures({ data }: { data: CommandCenter }) {
  const waiting = data.waitingForApproval ?? {
    runs: 0,
    oldestSince: null,
    overdue: 0,
    nobodyToAct: 0,
  };
  const failed = data.failedToday?.runs ?? 0;
  const days = data.perDay;
  const runs14 = (days ?? []).reduce((n, d) => n + d.runs, 0);
  const failed14 = (days ?? []).reduce((n, d) => n + d.failed, 0);
  const clean = percent(data.runsToday.cleanShare);
  const running = data.runningNow.runs;
  return (
    <div className="ops-tiles" data-testid="ops-command-figures">
      {data.needUs.count > 0 ? (
        <StatTile
          testId="ops-command-need-us"
          to={OPS_PATHS.escalations}
          label="Needs us"
          value={data.needUs.count}
          alert
          tone="risk"
          note={
            data.needUs.blockedLong > 0
              ? `${data.needUs.blockedLong} blocked over ${BLOCKED_LONG_HOURS} h`
              : "None blocked long"
          }
          {...(data.needUs.blockedLong > 0 ? { noteTone: "risk" as const } : {})}
        />
      ) : null}
      {waiting.runs > 0 ? (
        <StatTile
          testId="ops-command-waiting"
          to={WAITING_RUNS}
          label="Waiting for approval"
          value={waiting.runs}
          tone="signal"
          note={
            waiting.nobodyToAct > 0
              ? `Nobody can approve ${waiting.nobodyToAct}`
              : waiting.overdue > 0
                ? `${waiting.overdue} over ${APPROVAL_OVERDUE_HOURS} h`
                : `Oldest ${age(waiting.oldestSince)}`
          }
          {...(waiting.nobodyToAct > 0 ? { noteTone: "risk" as const } : {})}
        />
      ) : null}
      <StatTile
        testId="ops-command-runs-today"
        to={running > 0 ? RUNNING_RUNS : runsLink({ mode: "live", since: data.today })}
        label="Live runs today"
        value={data.runsToday.runs}
        tone="slate"
        mark={
          hasRuns(days) ? (
            <Sparkline
              days={days}
              label={`Live runs each day, last ${days.length} days: ${runs14} in all, ${failed14} failed`}
              testId="ops-command-runs-spark"
            />
          ) : undefined
        }
        note={
          running > 0
            ? `${plural(running, "run", "runs")} running now, ${plural(data.runningNow.steps, "step", "steps")} in flight`
            : clean
              ? `${clean} clean`
              : "None yet today"
        }
      />
      {failed > 0 ? (
        <StatTile
          testId="ops-command-failed"
          to={failedRunsSince(data.today)}
          label="Failed today"
          value={failed}
          tone="risk"
          mark={
            days && failed14 > 0 ? (
              <Sparkline
                days={failedDays(days)}
                label={`Failed live runs each day, last ${days.length} days: ${failed14} in all`}
              />
            ) : undefined
          }
          note="Live runs"
          noteTone="risk"
        />
      ) : null}
    </div>
  );
}

// ── Needs us ──

/** The Needs us type filter: each kind of escalation in words. */
const NEEDS_KINDS: [Escalation["kind"], string][] = [
  ["approval", "Approvals"],
  ["failed_run", "Failed runs"],
  ["connection", "Connections"],
  ["item", "Items for us"],
  ["low_confidence", "Low confidence"],
];

/**
 * Needs us, longest blocked first, filtered by client and by type in the browser (the list is
 * already here, polled with the figures). Its filters match Recent runs' beside it.
 */
function NeedsUs({ escalations, count }: { escalations: Escalation[]; count: number }) {
  const [all, setAll] = useState(false);
  const [client, setClient] = useState("");
  const [kind, setKind] = useState("");
  const clients = useMemo(() => {
    const byId = new Map(escalations.map((e) => [e.client.id, e.client.name]));
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [escalations]);
  const kinds = NEEDS_KINDS.filter(([k]) => escalations.some((e) => e.kind === k));
  const filtered = escalations.filter(
    (e) => (!client || e.client.id === client) && (!kind || e.kind === kind),
  );
  const narrowed = Boolean(client || kind);
  const shown = all ? filtered : filtered.slice(0, NEEDS_US_SHOWN);
  const total = narrowed ? filtered.length : count;

  const filters =
    escalations.length > 0 ? (
      <span className="flex items-center gap-2">
        <Select
          aria-label="Client"
          data-testid="ops-needs-client"
          className="h-7 w-36 text-xs"
          value={client}
          onChange={(e) => setClient(e.target.value)}
        >
          <option value="">All clients</option>
          {clients.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Type"
          data-testid="ops-needs-kind"
          className="h-7 w-32 text-xs"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All types</option>
          {kinds.map(([k, words]) => (
            <option key={k} value={k}>
              {words}
            </option>
          ))}
        </Select>
      </span>
    ) : undefined;

  return (
    <Card
      titleAbove
      title="Needs us"
      meta={filters}
      testId="ops-command-needs-us"
      footer={
        filtered.length > NEEDS_US_SHOWN || total > filtered.length ? (
          <>
            <span className="text-sm text-ink-muted">
              Showing {shown.length} of {total}, longest blocked first.
            </span>
            {filtered.length > NEEDS_US_SHOWN ? (
              <Button variant="link" size="sm" onClick={() => setAll(!all)}>
                {all ? "Show fewer" : "Show all"}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {escalations.length === 0 ? (
        <EmptyState
          compact
          tone="done"
          testId="ops-command-clear"
          title="Nothing needs us."
          line="Failed runs, broken connections, low-confidence readings and approvals stuck at a client show here."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          compact
          icon="filter"
          testId="ops-needs-none"
          line="Nothing needs us here. Pick another client or type."
          action={{
            label: "Show all",
            onClick: () => {
              setClient("");
              setKind("");
            },
          }}
        />
      ) : (
        shown.map((e) => {
          const chip = escalationChip(e);
          const action = escalationAction(e);
          const who = e.agent ? (e.agent.serviceName ?? e.agent.name) : null;
          return (
            <div
              key={`${e.kind}:${e.id}`}
              className="ops-row ops-row--link ops-row--compact ui-accent ui-accent--left"
              data-tone={escalationTone(chip.state)}
              data-testid={`ops-needs-${e.id}`}
            >
              {who ? <AgentBadge name={who} seed={e.agent?.id} size="sm" /> : <span />}
              <span className="ops-row__text">
                <span className="truncate text-sm font-medium text-ink">
                  {[who, e.client.name].filter(Boolean).join(" · ")}
                </span>
                <span className="ops-row__clamp text-xs text-ink-muted" title={escalationLine(e)}>
                  {escalationLine(e)}
                </span>
              </span>
              <span className="ops-row__end">
                <StatusChip state={chip.state}>{chip.words}</StatusChip>
                <Link to={action.to} className="ops-row__link text-xs text-link">
                  {action.label}
                </Link>
              </span>
            </div>
          );
        })
      )}
    </Card>
  );
}

// ── All agents ──

/**
 * An agent's state for its chip: waiting for approval when any of its runs waits on a person,
 * running with other open runs, its last run failed, paused, …
 */
export function agentChip(
  a: Pick<Agent, "status" | "openRuns" | "recentRuns"> & { waitingRuns?: number | undefined },
): {
  state: ChipState;
  words: string;
} {
  if (a.status === "paused") return { state: "paused", words: "Paused" };
  if (a.status === "retired") return { state: "idle", words: "Retired" };
  if (a.status === "draft" || a.status === "testing")
    return { state: "setup", words: "Setting up" };
  const waiting =
    (a.waitingRuns ?? 0) > 0 || a.recentRuns.some((r) => r.status === "waiting" || r.waiting);
  if (waiting) return { state: "waiting", words: "Waiting for approval" };
  if (a.openRuns > 0) return { state: "running", words: "Running" };
  if (a.recentRuns[0]?.status === "failed") return { state: "failed", words: "Last run failed" };
  return { state: "idle", words: "Idle" };
}

const STAGE_WORDS: Record<string, string> = {
  bench: "On the test bench",
  trial: "In trial",
  signoff: "In sign-off",
};

function agentNow(a: Agent): ReactNode {
  const words: string[] = [];
  const waiting = a.waitingRuns ?? 0;
  if (waiting > 0) words.push(`${plural(waiting, "run", "runs")} waiting`);
  if (a.openRuns - waiting > 0) {
    words.push(`${plural(a.openRuns - waiting, "run", "runs")} running`);
  }
  const stage = a.stage ? STAGE_WORDS[a.stage] : undefined;
  if (stage) words.push(stage);
  if (words.length === 0) return <span className="text-ink-muted">Nothing open</span>;
  return words.join(" · ");
}

function groupKey(a: Agent, by: Grouping): string {
  if (by === "client") return a.client.name;
  if (by === "template") return a.template?.name ?? "Built for this client";
  return agentChip(a).words;
}

function AllAgents({ agents, behind }: { agents: Agent[]; behind: Map<string, number> }) {
  const [by, setBy] = useState<Grouping>("client");
  const groups = useMemo(() => {
    const out = new Map<string, Agent[]>();
    for (const a of agents) {
      const k = groupKey(a, by);
      out.set(k, [...(out.get(k) ?? []), a]);
    }
    return [...out].sort(([a], [b]) => a.localeCompare(b));
  }, [agents, by]);

  return (
    <Card
      titleAbove
      title="All agents"
      testId="ops-command-agents"
      meta={
        <fieldset className="ds-seg m-0">
          <legend className="sr-only">Group agents by</legend>
          {(
            [
              ["client", "By client"],
              ["template", "By template"],
              ["status", "By status"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={by === value}
              data-testid={`ops-agents-by-${value}`}
              onClick={() => setBy(value)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      }
    >
      {agents.length === 0 ? (
        <EmptyState
          compact
          icon="team"
          title="No client agents yet"
          line="Fork a template into a client from the agent lab."
          action={{ label: "Open agent lab", to: OPS_PATHS.lab }}
        />
      ) : (
        <div className="dt dt-ana overflow-x-auto rounded-none border-0">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Agent</th>
                <th>Template</th>
                <th>Status</th>
                <th>Now</th>
                <th>Runs, {KPI_DAYS} days</th>
                <th className="text-right">Cost 7d</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([name, list]) => (
                <AgentGroup
                  key={name}
                  name={name}
                  agents={list}
                  behind={behind}
                  showClient={by !== "client"}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AgentGroup({
  name,
  agents,
  behind,
  showClient,
}: {
  name: string;
  agents: Agent[];
  behind: Map<string, number>;
  showClient: boolean;
}) {
  return (
    <>
      <tr className="ops-group" data-testid={`ops-agents-group-${name}`}>
        <td colSpan={6}>
          <span className="font-medium text-ink">{name}</span>
          <span className="ml-2 text-sm text-ink-muted">
            {plural(agents.length, "agent", "agents")}
          </span>
        </td>
      </tr>
      {agents.map((a) => {
        const chip = agentChip(a);
        const runs = [...a.recentRuns].reverse();
        const failed = runs.filter((r) => r.status === "failed").length;
        const late = behind.get(a.id);
        // Fix 1 of the design pass: the name the client knows (the service name); the bundle's
        // own name is on the agent page, under its title.
        const name = a.serviceName ?? a.name;
        const days = a.perDay;
        const days14 = (days ?? []).reduce((n, d) => n + d.runs, 0);
        const failed14 = (days ?? []).reduce((n, d) => n + d.failed, 0);
        return (
          <tr key={a.id} data-testid={`ops-agent-${a.id}`}>
            <td>
              <Link
                to={`/ops/agents/${a.id}`}
                className="flex items-center gap-2 font-medium text-ink hover:underline"
              >
                <AgentBadge name={name} seed={a.id} size="sm" />
                <span>
                  {name}
                  {showClient ? (
                    <span className="block text-xs font-normal text-ink-muted">
                      {a.client.name}
                    </span>
                  ) : null}
                </span>
              </Link>
            </td>
            <td className="text-sm">
              {a.template ? a.template.name : <span className="text-ink-muted">Custom</span>}
              {late ? (
                <Link to={`/ops/agents/${a.id}/merge`} className="ml-2 inline-flex">
                  <Tag>{plural(late, "version", "versions")} behind</Tag>
                </Link>
              ) : null}
            </td>
            <td>
              <StatusChip state={chip.state}>{chip.words}</StatusChip>
            </td>
            <td className="whitespace-nowrap text-sm text-ink">{agentNow(a)}</td>
            <td>
              {days ? (
                hasRuns(days) ? (
                  <Sparkline
                    days={days}
                    label={`Runs each day, last ${days.length} days: ${days14} in all, ${failed14} failed`}
                    testId={`ops-agent-spark-${a.id}`}
                  />
                ) : (
                  <span className="text-sm text-ink-muted">No runs</span>
                )
              ) : runs.length > 0 ? (
                <Sparkbars
                  values={runs.map((r) => ({ value: 1, failed: r.status === "failed" }))}
                  label={`Last ${runs.length} runs: ${failed} failed`}
                />
              ) : (
                <span className="text-sm text-ink-muted">No runs</span>
              )}
            </td>
            <td className="n">{usd(a.cost7dUsd)}</td>
          </tr>
        );
      })}
    </>
  );
}

// ── Recent runs ──

/** The status filter's choices and the run statuses each one stands for. */
const RUN_STATES = [
  ["all", "All statuses", null],
  ["going", "In progress", ["queued", "running", "waiting"]],
  ["succeeded", "Success", ["succeeded"]],
  ["failed", "Failed", ["failed"]],
] as const;
type RunState = (typeof RUN_STATES)[number][0];

/** "10 Nov" over "08:23": the date stacked on the time, so the time column stays narrow. */
export function dayTime(iso: string): ReactNode {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="ops-when" title={`${day} ${time}`}>
      <span>{day}</span>
      <span>{time}</span>
    </span>
  );
}

/**
 * The latest live runs across the clients served, by client and by status, each a link to the run.
 * DECISION: the Command center lists runs, not the activity feed (2026-11-10): the owner reads this
 * card as runs; every step, write and sign-off stays on the run itself.
 */
function RecentRuns() {
  const session = useSession();
  const clients = useMemo(() => new Map(session.tenants.map((t) => [t.id, t.name])), [session]);
  const [client, setClient] = useState("");
  const [state, setState] = useState<RunState>("all");
  const statuses = RUN_STATES.find(([v]) => v === state)?.[2] ?? null;
  const runs = useApi(apiRoutes.opsRuns, {
    query: {
      mode: "live",
      limit: String(RECENT_RUNS_SHOWN),
      ...(client ? { client } : {}),
      ...(statuses ? { status: statuses.join(",") } : {}),
    },
  });
  usePoll(runs.reload, true, RUNS_POLL_MS, runs.loading);

  // Two compact dropdowns, so the heading stays one line in its half of the row (beside Needs us).
  const filters = (
    <span className="flex items-center gap-2">
      <Select
        aria-label="Client"
        data-testid="ops-recent-client"
        className="h-7 w-36 text-xs"
        value={client}
        onChange={(e) => setClient(e.target.value)}
      >
        <option value="">All clients</option>
        {session.tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Status"
        data-testid="ops-recent-status"
        className="h-7 w-32 text-xs"
        value={state}
        onChange={(e) => setState(e.target.value as RunState)}
      >
        {RUN_STATES.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </Select>
    </span>
  );

  return (
    <Card
      titleAbove
      title="Recent runs"
      meta={filters}
      testId="ops-command-runs"
      className="ops-recent"
    >
      <Loaded state={runs}>
        {(data) => {
          const agents = new Map(data.agents.map((a) => [a.id, a.name]));
          if (data.runs.length === 0) {
            return (
              <EmptyState
                compact
                icon={client || statuses ? "filter" : "table"}
                line={client || statuses ? "No runs match these filters." : "No runs yet."}
                action={
                  client || statuses
                    ? {
                        label: "Show all",
                        onClick: () => {
                          setClient("");
                          setState("all");
                        },
                      }
                    : undefined
                }
              />
            );
          }
          return (
            <>
              {data.runs.map((r) => {
                const chip = runChip(r);
                return (
                  <ActivityRow
                    key={r.id}
                    time={dayTime(r.startedAt ?? r.createdAt)}
                    to={`/ops/runs/${r.id}`}
                    testId={`ops-recent-${r.id}`}
                    end={
                      <StatusChip state={chip.state} testId={`ops-recent-${r.id}-status`}>
                        {/* The status alone ("Waiting for approval"); who it waits on is on the run. */}
                        {chip.words.split(" · ")[0]}
                      </StatusChip>
                    }
                  >
                    {/* Two short lines, as the Needs us rows beside it: who, then what. */}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-ink">
                        {agents.get(r.agentId) ?? "Agent"} · {clients.get(r.tenantId) ?? "Client"}
                      </span>
                      <span className="truncate text-xs text-ink-muted">
                        {opsRunTitle(r.subject, shortRunId(r.id))}
                      </span>
                    </span>
                  </ActivityRow>
                );
              })}
              <div className="ui-card__body">
                <Link
                  to={OPS_PATHS.runs}
                  className="text-sm text-link hover:underline"
                  data-testid="ops-recent-all"
                >
                  All runs
                </Link>
              </div>
            </>
          );
        }}
      </Loaded>
    </Card>
  );
}

// ── Client health ──

// UI cleanup (stream A): health is a chip with its word (the bars drew nothing for a client with no
// clean runs this week); "bad" reads "At risk" so it isn't mistaken for Needs us.
const HEALTH_WORDS = { good: "Good", watch: "Watch", bad: "At risk" } as const;
const HEALTH_CHIP: Record<keyof typeof HEALTH_WORDS, ChipState> = {
  good: "done",
  watch: "idle",
  bad: "blocked",
};

function ClientHealth({ data }: { data: CommandCenter }) {
  const agents = new Map(data.agentsLive.clients.map((c) => [c.id, c.agents]));
  return (
    <Card
      titleAbove
      title="Client health"
      testId="ops-command-health"
      footer={
        <span className="text-sm text-ink-muted">
          Health is clean runs, how fast the client answers and open escalations, last {HEALTH_DAYS}{" "}
          days. The supervisor is the agent that checks each client's account every day; what it
          finds is listed under each client.
        </span>
      }
    >
      {data.health.length === 0 ? (
        <p className="ui-card__body text-ink-muted">No clients yet.</p>
      ) : (
        data.health.map((c) => <HealthRow key={c.id} client={c} agents={agents.get(c.id) ?? 0} />)
      )}
    </Card>
  );
}

function HealthRow({
  client,
  agents,
}: {
  client: CommandCenter["health"][number];
  agents: number;
}) {
  const [open, setOpen] = useState(false);
  const clean = percent(client.cleanShare);
  const facts = [
    clean ? `${clean} of ${plural(client.runs, "run", "runs")} clean` : "no live runs",
    client.medianResponseHours === null
      ? null
      : `answers in ${Math.round(client.medianResponseHours)} h`,
    plural(client.openEscalations, "escalation", "escalations"),
  ].filter(Boolean);
  return (
    <div className="ops-row" data-testid={`ops-health-${client.id}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-center justify-between gap-3 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <StatusChip
              state={HEALTH_CHIP[client.status]}
              testId={`ops-health-${client.id}-status`}
            >
              {HEALTH_WORDS[client.status]}
            </StatusChip>
            <Link
              to={OPS_PATHS.client(client.id)}
              className="truncate font-medium text-ink hover:underline"
            >
              {client.name}
            </Link>
          </span>
          <span className="shrink-0 text-ink-muted">{plural(agents, "agent", "agents")} live</span>
        </span>
        <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
          <span data-testid={`ops-health-${client.id}-facts`}>{facts.join(" · ")}</span>
          <Button
            variant="link"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            data-testid={`ops-health-${client.id}-findings`}
          >
            {open ? "Hide what the supervisor found" : "What the supervisor found"}
          </Button>
        </span>
        {open ? <SupervisorFindings clientId={client.id} /> : null}
      </div>
    </div>
  );
}

/** The supervisor's open findings for one client (docs/plan.md §1.28). */
function SupervisorFindings({ clientId }: { clientId: string }) {
  const state = useApi(apiRoutes.opsClientHealth, {
    params: { id: clientId },
    query: { status: "open" },
  });
  return (
    <Loaded state={state}>
      {(data) =>
        !data.supervisor ? (
          <p className="text-sm text-ink-muted">
            No supervisor on this client.{" "}
            <Link to={OPS_PATHS.client(clientId)} className="text-link underline">
              Add one on the client page
            </Link>
            .
          </p>
        ) : data.findings.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No open findings
            {data.summary ? ` at the last check, ${shortTime(data.summary.checkedAt)}` : ""}.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid={`ops-health-${clientId}-list`}>
            {data.findings.map((f) => (
              <li key={f.id}>
                <span className="text-ink">{f.title}</span>
                <span className="text-ink-muted">
                  {" "}
                  · for {f.audience === "operator" ? "us" : "the client admin"}
                </span>
              </li>
            ))}
          </ul>
        )
      }
    </Loaded>
  );
}

// ── Low confidence and oversight ──

function LowConfidence({ data }: { data: CommandCenter }) {
  if (data.lowConfidence.length === 0) return null;
  return (
    <Card titleAbove title="Low confidence today" testId="ops-command-low-confidence">
      {data.lowConfidence.map((l) => {
        const share = percent(Number(l.threshold));
        return (
          <div key={`${l.client.id}:${l.versionId ?? "none"}`} className="ops-row">
            <span className="ops-row__text">
              <span className="text-sm font-medium text-ink">
                {[l.agent?.name ?? "Background readings", l.client.name].join(" · ")}
              </span>
              <span className="text-sm text-ink-muted">
                {plural(l.readings, "reading", "readings")} under {share}, lowest{" "}
                {percent(Number(l.lowest))}.
                {l.template ? ` ${l.template.name} v${l.template.version}.` : ""}
              </span>
            </span>
          </div>
        );
      })}
    </Card>
  );
}

function Oversight({ data }: { data: CommandCenter["oversight"] }) {
  if (!data || data.decisions.length === 0) return null;
  const { totals, decisions } = data;
  return (
    <Card
      titleAbove
      title="Run oversight"
      meta={`${plural(totals.count, "decision", "decisions")} · ${usd(totals.costUsd)}`}
      testId="ops-command-oversight"
      footer={
        <span className="text-sm text-ink-muted">
          When a step fails or reaches a checkpoint, the agent decides to go on, retry, correct the
          input, ask a person or stop. Its latest decisions.
        </span>
      }
    >
      {decisions.map((d) => (
        <ActivityRow key={d.id} time={shortTime(d.createdAt)} to={`/ops/runs/${d.runId}`}>
          <span className="text-sm">{oversightLine(d)}</span>
        </ActivityRow>
      ))}
    </Card>
  );
}
