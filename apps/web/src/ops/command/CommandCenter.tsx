// `/ops`, O1 Command center (docs/design/prototype.html `#O1-Command`; ARCHITECTURE §13.1): every
// agent, every client, right now. Six figures; "Needs us", the escalations sorted by how long a
// client has been blocked; all agents by client, template or status; the live feed; client health
// with the supervisor's findings; low-confidence readings and run oversight. Back office only:
// cost is shown here (invariant 11). Polls every 30 s; the feed every 10 s.
import {
  BLOCKED_LONG_HOURS,
  type CommandCenter,
  type Escalation,
  type FeedItem,
  HEALTH_DAYS,
  newestFeed,
} from "@countersign/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { shortTime, usd } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge } from "../../ui/badges";
import { ProgressBar, Sparkbars, StatTile } from "../../ui/figures";
import { Loaded, Page, PageGrid } from "../../ui/page";
import { Button, buttonClass, Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { OPS_PATHS } from "../paths";
import { age, ageSeconds, oversightLine, percent, plural } from "../run/words";

/** How often the figures reload, and the feed asks for what's new. */
export const COMMAND_POLL_MS = 30_000;
export const FEED_POLL_MS = 10_000;
/** The feed keeps this many items on screen. */
export const FEED_SHOWN = 12;
/** "Needs us" shows this many before "Show all". */
export const NEEDS_US_SHOWN = 8;

type Agent = CommandCenter["agents"][number];
type Grouping = "client" | "template" | "status";

export function CommandCenterScreen() {
  const state = useApi(apiRoutes.opsCommandCenter);
  usePoll(state.reload, true, COMMAND_POLL_MS, state.loading);
  // Template updates waiting, for the agents table's "N versions behind" (the overview lists them).
  const overview = useApi(apiRoutes.opsOverview);
  const behind = useMemo(
    () => new Map((overview.data?.updates ?? []).map((u) => [u.agent.id, u.behind])),
    [overview.data],
  );

  return (
    <Page testId="ops-command">
      <PageHeader
        title="Command center"
        subtitle="Every agent, every client, right now."
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
          <>
            <Figures data={data} />
            <PageGrid
              rail={
                <>
                  <LiveFeed />
                  <ClientHealth data={data} />
                  <LowConfidence data={data} />
                  <Oversight />
                </>
              }
            >
              <NeedsUs escalations={data.escalations} count={data.needUs.count} />
              <AllAgents agents={data.agents} behind={behind} />
            </PageGrid>
          </>
        )}
      </Loaded>
    </Page>
  );
}

// ── Figures ──

function Figures({ data }: { data: CommandCenter }) {
  const clean = percent(data.runsToday.cleanShare);
  return (
    <div className="ops-tiles" data-testid="ops-command-figures">
      <StatTile
        label="Agents live"
        value={data.agentsLive.count}
        note={plural(data.agentsLive.clients.length, "client", "clients")}
        testId="ops-command-live"
      />
      <StatTile
        label="Running now"
        value={data.runningNow.runs}
        note={`${plural(data.runningNow.steps, "step", "steps")} in flight`}
        testId="ops-command-running"
      />
      <StatTile
        label="Need us"
        value={data.needUs.count}
        alert={data.needUs.count > 0}
        note={
          data.needUs.blockedLong > 0
            ? `${data.needUs.blockedLong} blocked over ${BLOCKED_LONG_HOURS} h`
            : "None blocked long"
        }
        {...(data.needUs.blockedLong > 0 ? { noteTone: "risk" as const } : {})}
        testId="ops-command-need-us"
      />
      <StatTile
        label="Waiting on clients"
        value={data.waitingOnClients.count}
        note={
          data.waitingOnClients.count > 0
            ? `Oldest ${ageSeconds(data.waitingOnClients.oldestAgeSeconds)}`
            : "Nothing waiting"
        }
        {...(data.waitingOnClients.count > 0 ? { noteTone: "signal" as const } : {})}
        testId="ops-command-waiting"
      />
      <StatTile
        label="Runs today"
        value={data.runsToday.runs}
        note={clean ? `${clean} clean` : "No runs yet"}
        testId="ops-command-runs"
      />
      <StatTile
        label="Model spend today"
        value={usd(data.spendToday.costUsd)}
        note={
          data.spendToday.perRunUsd ? `${usd(data.spendToday.perRunUsd)} per run` : "No runs yet"
        }
        testId="ops-command-spend"
      />
    </div>
  );
}

// ── Needs us ──

function escalationChip(e: Escalation): { state: ChipState; words: string } {
  switch (e.kind) {
    case "item":
      return { state: "waiting", words: `Waiting ${age(e.blockedSince)}` };
    case "low_confidence":
      return { state: "waiting", words: "Low confidence" };
    default:
      return { state: "blocked", words: `Blocked ${age(e.blockedSince)}` };
  }
}

function escalationLine(e: Escalation): string {
  switch (e.kind) {
    case "failed_run":
      return e.title;
    case "connection":
      return `The ${e.title} connection failed. The client signs in again from their portal.`;
    case "low_confidence":
      return `${e.title} was read under the confidence threshold today.`;
    default:
      return e.title;
  }
}

function escalationAction(e: Escalation): { to: string; label: string } {
  if (e.runId && e.kind !== "item") return { to: `/ops/runs/${e.runId}`, label: "Open run" };
  switch (e.kind) {
    case "connection":
      return { to: `/ops/clients/${e.client.id}/connections`, label: "Open connections" };
    case "low_confidence":
      return { to: `/ops/clients/${e.client.id}/documents`, label: "Open documents" };
    default:
      return { to: OPS_PATHS.escalations, label: "Open escalations" };
  }
}

function NeedsUs({ escalations, count }: { escalations: Escalation[]; count: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? escalations : escalations.slice(0, NEEDS_US_SHOWN);
  return (
    <Card
      title="Needs us"
      meta="Sorted by how long a client has been blocked"
      testId="ops-command-needs-us"
      footer={
        escalations.length > NEEDS_US_SHOWN || count > escalations.length ? (
          <>
            <span className="text-sm text-ink-muted">
              Showing {shown.length} of {count}.
            </span>
            {escalations.length > NEEDS_US_SHOWN ? (
              <Button variant="link" size="sm" onClick={() => setAll(!all)}>
                {all ? "Show fewer" : "Show all"}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {escalations.length === 0 ? (
        <div className="ui-card__body">
          <p className="text-ink-muted" data-testid="ops-command-clear">
            Nothing needs us. Failed runs, broken connections, low-confidence readings and items for
            us show here.
          </p>
        </div>
      ) : (
        shown.map((e) => {
          const chip = escalationChip(e);
          const action = escalationAction(e);
          const who = e.agent ? (e.agent.serviceName ?? e.agent.name) : null;
          return (
            <div key={`${e.kind}:${e.id}`} className="ops-row" data-testid={`ops-needs-${e.id}`}>
              <StatusChip state={chip.state}>{chip.words}</StatusChip>
              {who ? <AgentBadge name={e.agent?.name ?? who} size="sm" /> : null}
              <span className="ops-row__text">
                <span className="font-medium text-ink">
                  {[who, e.client.name].filter(Boolean).join(" · ")}
                </span>
                <span className="text-sm text-ink-muted">{escalationLine(e)}</span>
              </span>
              <Link to={action.to} className={buttonClass("secondary", undefined, "sm")}>
                {action.label}
              </Link>
            </div>
          );
        })
      )}
    </Card>
  );
}

// ── All agents ──

/** An agent's state for its chip: running with open runs, its last run failed, paused, … */
export function agentChip(a: Pick<Agent, "status" | "openRuns" | "recentRuns">): {
  state: ChipState;
  words: string;
} {
  if (a.status === "paused") return { state: "paused", words: "Paused" };
  if (a.status === "retired") return { state: "idle", words: "Retired" };
  if (a.status === "draft" || a.status === "testing")
    return { state: "setup", words: "Setting up" };
  const waiting = a.recentRuns.some((r) => r.status === "waiting");
  if (waiting) return { state: "waiting", words: "On client" };
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
  if (a.openRuns > 0) words.push(`${plural(a.openRuns, "run", "runs")} open`);
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
        <div className="ui-card__body">
          <EmptyState>
            No client agents yet. Fork a template into a client from the agent lab.
          </EmptyState>
        </div>
      ) : (
        <div className="dt dt-ana overflow-x-auto rounded-none border-0">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Agent</th>
                <th>Template</th>
                <th>Status</th>
                <th>Now</th>
                <th>Last runs</th>
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
        return (
          <tr key={a.id} data-testid={`ops-agent-${a.id}`}>
            <td>
              <Link
                to={`/ops/agents/${a.id}`}
                className="flex items-center gap-2 font-medium text-ink hover:underline"
              >
                <AgentBadge name={a.name} size="sm" />
                <span>
                  {a.name}
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
              {runs.length > 0 ? (
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

// ── The live feed ──

/** "17:33": the feed's narrow time column. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function feedText(item: FeedItem): ReactNode {
  switch (item.kind) {
    case "failure":
      return <span className="ui-tone-risk">failed: {item.text}</span>;
    case "signature":
      return (
        <>
          <span className="text-copper-ink">signed</span> {item.text}
        </>
      );
    case "write":
      return `updated ${item.text}`;
    case "draft":
      return `drafted ${item.text}`;
    default:
      return item.text;
  }
}

/** The feed: the last 24 hours on load, then what's new every 10 s. */
function LiveFeed() {
  const api = useApiClient();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [problem, setProblem] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const since = useRef<string | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const controller = new AbortController();
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const page = await api.call(apiRoutes.opsFeed, {
          query: since.current ? { since: since.current } : {},
          signal: controller.signal,
        });
        if (stopped) return;
        since.current = page.at;
        setItems((old) => {
          const seen = new Set(old.map((i) => i.id));
          return newestFeed([...page.items.filter((i) => !seen.has(i.id)), ...old], FEED_SHOWN);
        });
        setProblem(null);
        setLoaded(true);
      } catch (error) {
        if (!stopped) {
          setProblem(error);
          setLoaded(true);
        }
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), FEED_POLL_MS);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [api]);

  return (
    <Card title="Live" meta="All clients" testId="ops-command-feed">
      {!loaded ? (
        <p className="ui-card__body text-ink-muted">Loading the feed</p>
      ) : items.length === 0 ? (
        <p className="ui-card__body text-ink-muted">
          {problem
            ? "The feed couldn't load. We try again in a moment."
            : "Nothing in the last day."}
        </p>
      ) : (
        items.map((i) => (
          <ActivityRow
            key={i.id}
            time={clock(i.at)}
            {...(i.runId ? { to: `/ops/runs/${i.runId}` } : {})}
            testId={`ops-feed-${i.id}`}
          >
            <span className="text-sm">
              {i.agent ? <b className="font-medium">{i.agent.name} · </b> : null}
              {i.client.name} · {feedText(i)}
            </span>
          </ActivityRow>
        ))
      )}
    </Card>
  );
}

// ── Client health ──

const HEALTH_WORDS = { good: "Good", watch: "Watch", bad: "Needs us" } as const;
const HEALTH_TONE = { good: "accent", watch: "waiting", bad: "risk" } as const;

function ClientHealth({ data }: { data: CommandCenter }) {
  const agents = new Map(data.agentsLive.clients.map((c) => [c.id, c.agents]));
  return (
    <Card
      title="Client health"
      testId="ops-command-health"
      footer={
        <span className="text-sm text-ink-muted">
          Health is clean runs, how fast the client answers and open escalations, last {HEALTH_DAYS}{" "}
          days.
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
    HEALTH_WORDS[client.status],
    clean ? `${clean} clean` : "no live runs",
    client.medianResponseHours === null
      ? null
      : `answers in ${Math.round(client.medianResponseHours)} h`,
    plural(client.openEscalations, "escalation", "escalations"),
  ].filter(Boolean);
  return (
    <div className="ops-row" data-testid={`ops-health-${client.id}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-center justify-between gap-3 text-sm">
          <Link to={OPS_PATHS.client(client.id)} className="font-medium text-ink hover:underline">
            {client.name}
          </Link>
          <span className="text-ink-muted">{plural(agents, "agent", "agents")} live</span>
        </span>
        <ProgressBar
          value={Math.round((client.cleanShare ?? 0) * 100)}
          max={100}
          tone={HEALTH_TONE[client.status]}
          label={`${client.name}: ${facts.join(", ")}`}
        />
        <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
          <span data-testid={`ops-health-${client.id}-facts`}>{facts.join(" · ")}</span>
          <Button
            variant="link"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            data-testid={`ops-health-${client.id}-findings`}
          >
            {open ? "Hide findings" : "Findings"}
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
    <Card title="Low confidence today" testId="ops-command-low-confidence">
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

function Oversight() {
  const state = useApi(apiRoutes.opsOversight, { query: { limit: 5 } });
  if (!state.data || state.data.decisions.length === 0) return null;
  const { totals, decisions } = state.data;
  return (
    <Card
      title="Run oversight"
      meta={`${plural(totals.count, "decision", "decisions")} · ${usd(totals.costUsd)}`}
      testId="ops-command-oversight"
    >
      {decisions.map((d) => (
        <ActivityRow key={d.id} time={shortTime(d.createdAt)} to={`/ops/runs/${d.runId}`}>
          <span className="text-sm">{oversightLine(d)}</span>
        </ActivityRow>
      ))}
    </Card>
  );
}
