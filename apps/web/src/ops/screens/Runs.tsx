// `/ops/runs` and `/ops/clients/:clientId/runs`, O9 Runs (docs/design/prototype.html `#O9-Runs`;
// ARCHITECTURE §10.10, §14): every run, every client, with cost. One typed filter (RunFilter) shown
// as chips; quick views; a question in plain words turned into the filter (`/api/ops/runs/ask`);
// saved views; failures grouped by error; retry or cancel the selected runs; the list as CSV. Polls
// while any run is still going.
import {
  askChips,
  OpsRunsQuery,
  type RunFilter,
  runFilterQuery,
  shortRunId,
} from "@countersign/core";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { duration, isRunGoing, runsPollMs, shortTime, usd } from "../../runs/format";
import { opsRunShortTitle, opsRunTitle } from "../../runs/subject";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { Clamp } from "../../ui/Clamp";
import { cx } from "../../ui/cx";
import { StatTile } from "../../ui/figures";
import { TextInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Loaded, Page } from "../../ui/page";
import {
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import {
  age,
  errorGroupLabel,
  NOBODY_TO_ACT_WORDS,
  plural,
  RUN_STATUS_WORDS,
  runChip,
  runErrorLine,
  waitOnWords,
} from "../run/words";

type Run = ResponseOf<typeof apiRoutes.opsRuns>["runs"][number];
type Group = NonNullable<ResponseOf<typeof apiRoutes.opsRuns>["groups"]>[number];

/** "client admin" → "Client admin", for a cell that starts with it. */
function capitalize(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The most runs the list loads. */
export const RUNS_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The quick views above the list (the prototype's segments). */
const VIEWS = [
  { id: "all", label: "All runs", filter: (): RunFilter => ({}) },
  {
    id: "running",
    label: "Running",
    filter: (): RunFilter => ({ statuses: ["queued", "running"] }),
  },
  {
    // A run waiting on a person (the client or us), whatever its stored status (UI cleanup).
    id: "waiting",
    label: "Waiting for approval",
    filter: (): RunFilter => ({ statuses: ["waiting"] }),
  },
  {
    id: "failed",
    label: "Failed 24 h",
    filter: (): RunFilter => ({
      statuses: ["failed"],
      since: new Date(Date.now() - DAY_MS).toISOString(),
    }),
  },
  { id: "cost", label: "Cost over $1", filter: (): RunFilter => ({ costOver: "1" }) },
  { id: "test", label: "Test runs", filter: (): RunFilter => ({ mode: "test" }) },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

const CHIP_WORDS: Record<string, string> = {
  clients: "client",
  agents: "agent",
  templates: "template",
  statuses: "status",
  startedBy: "started by",
  changedConnector: "changed in",
  since: "since",
  until: "until",
  mode: "mode",
  attemptsOver: "attempts over",
  amount: "amount",
  costOver: "cost over $",
  errorKey: "error",
  text: "text",
};

/** A filter without one key. */
function without(filter: RunFilter, key: string): RunFilter {
  return Object.fromEntries(Object.entries(filter).filter(([k]) => k !== key)) as RunFilter;
}

/** A time filter's value as people read it, and statuses in words. */
function chipValue(key: string, value: string): string {
  if ((key === "since" || key === "until") && !Number.isNaN(Date.parse(value))) {
    return shortTime(value);
  }
  if (key === "statuses") {
    return value
      .split(", ")
      .map((s) => RUN_STATUS_WORDS[s] ?? s)
      .join(", ");
  }
  if (key === "mode") return value === "test" ? "test runs" : "live runs";
  if (key === "errorKey") return errorGroupLabel(value);
  return value;
}

/**
 * The filter in the page's address (UI cleanup, stream A): the list's own query parameters
 * (`?statuses=waiting&mode=live`, or the older `?status=failed`), so other pages link to it filtered.
 * A client's own runs page adds its client itself.
 */
export function filterFromParams(params: URLSearchParams): RunFilter {
  const raw: Record<string, string> = {};
  for (const [key, value] of params) raw[key] = raw[key] ? `${raw[key]},${value}` : value;
  const parsed = OpsRunsQuery.safeParse(raw);
  return parsed.success ? parsed.data.filter : {};
}

/** The quick view a filter is, if it is one. */
export function viewOf(filter: RunFilter): ViewId | null {
  const keys = Object.keys(filter).filter((k) => k !== "mode" || filter.mode !== "live");
  const statuses = [...(filter.statuses ?? [])].sort().join(",");
  if (keys.length === 0) return filter.mode === "live" ? null : "all";
  if (keys.length === 1 && statuses === "waiting") return "waiting";
  if (keys.length === 1 && (statuses === "queued,running" || statuses === "running")) {
    return "running";
  }
  if (statuses === "failed" && keys.every((k) => k === "statuses" || k === "since")) {
    return "failed";
  }
  if (keys.length === 1 && filter.costOver === "1") return "cost";
  if (keys.length === 1 && filter.mode === "test") return "test";
  return null;
}

export function OpsRunsScreen() {
  const { clientId } = useParams();
  const api = useApiClient();
  const session = useSession();
  const clients = useMemo(() => new Map(session.tenants.map((t) => [t.id, t.name])), [session]);

  // The filter lives in the address, so a link can open the list filtered; the quick view
  // highlighted is the one the filter is.
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => filterFromParams(params), [params]);
  const view = viewOf(filter);
  const [grouped, setGrouped] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // One client's page lists that client's runs only.
  const effective: RunFilter = clientId ? { ...filter, clients: [clientId] } : filter;
  const query = { ...runFilterQuery(effective), limit: String(RUNS_LIMIT) };
  const state = useApi(apiRoutes.opsRuns, {
    query: { ...query, ...(grouped ? { groupBy: "error" as const } : {}) } as never,
  });
  const { data, loading, reload } = state;
  // Every 5 s while a run works, every 30 s while runs only wait on a person (2.2).
  const pollMs = data ? runsPollMs(data.runs, 5_000) : null;
  usePoll(reload, pollMs !== null, pollMs ?? 5_000, loading);
  const views = useApi(apiRoutes.opsSavedViews, { query: { surface: "ops_runs" } });

  const agents = useMemo(() => new Map((data?.agents ?? []).map((a) => [a.id, a])), [data?.agents]);
  const chips = askChips(filter, {
    agents: new Map([...agents].map(([id, a]) => [id, a.name])),
    clients,
    connectors: new Map(),
  });

  const apply = (next: RunFilter) => {
    setParams(runFilterQuery(next), { replace: true });
    setSelected(new Set());
    setNote(null);
  };

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (question.trim().length < 3) return;
    setAsking(true);
    setProblem(null);
    try {
      const answer = await api.call(apiRoutes.opsRunsAsk, {
        body: { text: question.trim(), ...(clientId ? { client: clientId } : {}) },
      });
      if (!answer.understood) {
        setNote(answer.message);
      } else {
        apply(without(answer.filter, clientId ? "clients" : ""));
        setQuestion("");
        setNote(answer.leftOut.length > 0 ? `We left out: ${answer.leftOut.join("; ")}.` : null);
      }
    } catch (error) {
      setProblem(error);
    } finally {
      setAsking(false);
    }
  };

  const runs = data?.runs ?? [];
  const chosen = runs.filter((r) => selected.has(r.id));
  const retryable = chosen.filter((r) => r.status === "failed" && r.mode === "live");
  const cancellable = chosen.filter((r) => isRunGoing(r.status));

  const bulk = async (what: "retry" | "cancel") => {
    const list = what === "retry" ? retryable : cancellable;
    setBusy(true);
    setProblem(null);
    let done = 0;
    const failures: string[] = [];
    for (const r of list) {
      try {
        const route = what === "retry" ? apiRoutes.opsRetryRun : apiRoutes.opsCancelRun;
        await api.call(route, { params: { id: r.id } });
        done += 1;
      } catch {
        failures.push(shortRunId(r.id));
      }
    }
    setBusy(false);
    setSelected(new Set());
    setNote(
      `${what === "retry" ? "Retried" : "Cancelled"} ${plural(done, "run", "runs")}.${
        failures.length > 0 ? ` These didn't go: ${failures.join(", ")}.` : ""
      }`,
    );
    reload();
  };

  const csv = `/api/ops/runs.csv?${new URLSearchParams(runFilterQuery(effective)).toString()}`;

  return (
    <Page testId="ops-runs-page">
      <PageHeader
        title="Runs"
        subtitle={
          clientId
            ? `Every run of ${clients.get(clientId) ?? "this client"}'s agents, test runs included, with cost, model calls and raw data.`
            : "Every run, every client. With cost, model calls and raw data."
        }
        actions={
          <>
            <SaveView filter={filter} onSaved={views.reload} />
            <a href={csv} download className={buttonClass("secondary")} data-testid="ops-runs-csv">
              Export
            </a>
          </>
        }
      />

      <div className="flex flex-col gap-3">
        <form
          className="ops-query"
          aria-label="Filter runs"
          onSubmit={ask}
          data-testid="ops-runs-query"
        >
          <Icon name="search" size={16} className="text-ink-muted" />
          {chips.map((c) => (
            <span key={c.key} className="ops-chip" data-testid={`ops-runs-chip-${c.key}`}>
              <b>{CHIP_WORDS[c.key] ?? c.key}</b> {chipValue(c.key, c.value)}
              <button
                type="button"
                aria-label={`Remove the ${CHIP_WORDS[c.key] ?? c.key} filter`}
                onClick={() => apply(without(filter, c.key))}
              >
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          <input
            aria-label="Ask about runs in plain words"
            placeholder="Ask in plain words: failed runs for a client this week, runs over $1"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            data-testid="ops-runs-ask"
            disabled={asking}
          />
          <span className="text-sm text-ink-muted figures" data-testid="ops-runs-count">
            {data
              ? runs.length >= RUNS_LIMIT
                ? `The latest ${RUNS_LIMIT}`
                : plural(runs.length, "run", "runs")
              : ""}
          </span>
        </form>
        {note ? (
          <p className="text-sm text-ink-muted" data-testid="ops-runs-note">
            {note}
          </p>
        ) : null}
        {problem ? <ErrorNotice error={problem} /> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <fieldset className="ds-seg m-0 flex-wrap">
            <legend className="sr-only">Quick views</legend>
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={view === v.id}
                data-testid={`ops-runs-view-${v.id}`}
                onClick={() => {
                  apply(v.filter());
                  setGrouped(v.id === "failed");
                }}
              >
                {v.label}
              </button>
            ))}
          </fieldset>
          <Button
            size="sm"
            aria-pressed={grouped}
            onClick={() => setGrouped(!grouped)}
            data-testid="ops-runs-group"
          >
            {grouped ? "Grouped by error" : "Group by error"}
          </Button>
        </div>
        <SavedViews state={views} onOpen={(f) => apply(f)} onDeleted={views.reload} />
      </div>

      {grouped && data?.groups ? (
        <ErrorGroups
          groups={data.groups}
          agents={agents}
          current={filter.errorKey}
          onPick={(key) =>
            apply(
              key === filter.errorKey
                ? without(filter, "errorKey")
                : { ...filter, statuses: ["failed"], errorKey: key },
            )
          }
        />
      ) : null}

      <Loaded state={state}>
        {() =>
          runs.length === 0 ? (
            <EmptyState
              icon="search"
              title="No runs match"
              line="Remove a filter or pick another view."
              action={{
                label: "Show every run",
                onClick: () => apply({}),
                testId: "ops-runs-clear",
              }}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {/* The list starts with its column heads; the bulk actions show once runs are picked. */}
              {chosen.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2" data-testid="ops-runs-bulk">
                  <span className="text-sm font-medium text-ink" data-testid="ops-runs-selected">
                    {chosen.length} selected
                  </span>
                  <Button
                    size="sm"
                    disabled={busy || retryable.length === 0}
                    onClick={() => void bulk("retry")}
                    data-testid="ops-runs-retry"
                  >
                    Retry from failed step
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || cancellable.length === 0}
                    onClick={() => void bulk("cancel")}
                    data-testid="ops-runs-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelected(new Set())}
                    data-testid="ops-runs-clear"
                  >
                    Clear
                  </Button>
                </div>
              ) : null}
              <Card testId="ops-runs-card">
                <RunsTable
                  runs={runs}
                  clients={clients}
                  agents={agents}
                  selected={selected}
                  onToggle={(id) => {
                    const next = new Set(selected);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    setSelected(next);
                  }}
                />
              </Card>
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}

/** The columns the runs list sorts by (in the browser, over the runs loaded). */
type SortKey = "run" | "client" | "agent" | "status" | "owner" | "started" | "took" | "cost";
/** Words sort A to Z first; times, durations and cost largest first. */
const TEXT_KEYS = new Set<SortKey>(["run", "client", "agent", "status", "owner"]);

function RunsTable({
  runs,
  clients,
  agents,
  selected,
  onToggle,
}: {
  runs: Run[];
  clients: Map<string, string>;
  agents: Map<string, { name: string }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "started",
    dir: "desc",
  });
  const sorted = useMemo(() => {
    const value = (r: Run): string | number => {
      switch (sort.key) {
        case "run":
          return opsRunShortTitle(r.subject, shortRunId(r.id)).toLowerCase();
        case "client":
          return (clients.get(r.tenantId) ?? "").toLowerCase();
        case "agent":
          return (agents.get(r.agentId)?.name ?? "").toLowerCase();
        case "status":
          return runChip(r).words.toLowerCase();
        case "owner":
          return r.waiting ? waitOnWords(r.waiting).toLowerCase() : "\uffff";
        case "started":
          return new Date(r.startedAt ?? r.createdAt).getTime();
        case "took":
          return r.startedAt
            ? (r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now()) -
                new Date(r.startedAt).getTime()
            : -1;
        case "cost":
          return Number(r.costUsd);
      }
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...runs].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return x < y ? -sign : x > y ? sign : 0;
    });
  }, [runs, sort, clients, agents]);
  const head = (key: SortKey, label: string, className?: string) => (
    <th
      className={className}
      aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="dt-sort"
        data-testid={`ops-runs-sort-${key}`}
        onClick={() =>
          setSort((old) =>
            old.key === key
              ? { key, dir: old.dir === "asc" ? "desc" : "asc" }
              : { key, dir: TEXT_KEYS.has(key) ? "asc" : "desc" },
          )
        }
      >
        {label}
      </button>
    </th>
  );
  return (
    <div className="dt dt-ana overflow-x-auto rounded-none border-0">
      <table data-testid="ops-runs">
        <thead>
          <tr className="dt-cols">
            <th>
              <span className="sr-only">Select</span>
            </th>
            {head("run", "Run")}
            {head("client", "Client")}
            {head("agent", "Agent")}
            {head("status", "Status")}
            {head("owner", "Owner")}
            {head("started", "Started")}
            {head("took", "Took")}
            <th>Error</th>
            {head("cost", "Cost", "text-right")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const short = shortRunId(r.id);
            const chip = runChip(r);
            const wait = r.waiting ?? null;
            return (
              <tr
                key={r.id}
                className={cx(
                  "cursor-pointer hover:bg-surface-subtle",
                  selected.has(r.id) && "is-selected",
                )}
                data-testid={`ops-run-row-${r.id}`}
                // The whole row opens the run; its check box and links keep their own clicks.
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a, button, input, label")) return;
                  navigate(`/ops/runs/${r.id}`);
                }}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => onToggle(r.id)}
                    aria-label={`Select ${short}`}
                    data-testid={`ops-run-${r.id}-select`}
                  />
                </td>
                <td>
                  {/* Titled by what the run is about: its invoice or its first change. The
                      vendor or customer is left to the tooltip; the table has the client. */}
                  <Clamp
                    tip={
                      opsRunTitle(r.subject, short) === opsRunShortTitle(r.subject, short)
                        ? null
                        : opsRunTitle(r.subject, short)
                    }
                  >
                    <Link
                      to={`/ops/runs/${r.id}`}
                      data-testid={`ops-run-${r.id}-open`}
                      className="text-link hover:underline"
                    >
                      {opsRunShortTitle(r.subject, short)}
                    </Link>
                  </Clamp>
                  {r.subject ? (
                    <span className="block reference text-xs text-ink-muted">{short}</span>
                  ) : null}
                </td>
                <td className="text-sm">
                  <Clamp>{clients.get(r.tenantId) ?? "Client"}</Clamp>
                </td>
                <td className="text-sm">
                  {/* The name only; what the agent was doing (its workflow) is in the tooltip. */}
                  <Clamp tip={r.workflowName} testId={`ops-run-${r.id}-agent`}>
                    {agents.get(r.agentId)?.name ?? "Agent"}
                  </Clamp>
                </td>
                <td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {/* The state alone ("Waiting for approval"); who it waits on is the Owner. */}
                    <StatusChip state={chip.state} testId={`ops-run-${r.id}-status`}>
                      {chip.words.split(" · ")[0]}
                    </StatusChip>
                    {r.mode === "test" ? (
                      <span className="text-xs text-ink-muted">Test</span>
                    ) : null}
                  </span>
                </td>
                <td className="text-sm" data-testid={`ops-run-${r.id}-owner`}>
                  {wait ? (
                    <Clamp
                      onlyWhenCut
                      tip={[
                        `${capitalize(waitOnWords(wait))}, for ${age(wait.since)}`,
                        wait.nobodyToAct ? NOBODY_TO_ACT_WORDS[wait.nobodyToAct] : null,
                      ]
                        .filter(Boolean)
                        .join(". ")}
                    >
                      <span className="block whitespace-nowrap">
                        {capitalize(waitOnWords(wait))}
                      </span>
                      <span
                        className="block text-xs text-ink-muted"
                        data-testid={`ops-run-${r.id}-wait`}
                      >
                        For {age(wait.since)}
                        {wait.nobodyToAct ? (
                          <span className="ui-tone-risk">
                            {" "}
                            · {NOBODY_TO_ACT_WORDS[wait.nobodyToAct]}
                          </span>
                        ) : null}
                      </span>
                    </Clamp>
                  ) : null}
                </td>
                <td className="text-sm figures">{shortTime(r.startedAt ?? r.createdAt)}</td>
                <td className="text-sm figures">{duration(r.startedAt, r.finishedAt)}</td>
                <td className="text-sm" data-testid={`ops-run-${r.id}-error`}>
                  {r.status === "failed" ? (
                    <Clamp className="ui-tone-risk">{runErrorLine(r.error, r.errorStep)}</Clamp>
                  ) : null}
                </td>
                <td className="n">{usd(r.costUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ErrorGroups({
  groups,
  agents,
  current,
  onPick,
}: {
  groups: Group[];
  agents: Map<string, { name: string }>;
  current: string | undefined;
  onPick: (key: string) => void;
}) {
  if (groups.length === 0) {
    return (
      <EmptyState
        tone="done"
        title="No failures to group"
        line="No failed runs match these filters."
      />
    );
  }
  return (
    <div className="ops-tiles" data-testid="ops-runs-errors">
      {groups.slice(0, 6).map((g, i) => (
        <button
          key={g.key}
          type="button"
          className="ops-pick"
          aria-pressed={current === g.key}
          onClick={() => onPick(g.key)}
          data-testid={`ops-runs-error-${g.key}`}
        >
          <StatTile
            label={errorGroupLabel(g.key)}
            value={g.count}
            alert={i === 0}
            note={[
              g.clients.map((c) => c.name).join(", "),
              g.agents.map((id) => agents.get(id)?.name ?? "Agent").join(", "),
              `last ${shortTime(g.latestAt)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        </button>
      ))}
    </div>
  );
}

function SaveView({ filter, onSaved }: { filter: RunFilter; onSaved: () => void }) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<unknown>(null);
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} data-testid="ops-runs-save-view">
        Save view
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        try {
          await api.call(apiRoutes.opsCreateSavedView, {
            body: { surface: "ops_runs", name: name.trim(), filters: filter },
          });
          setOpen(false);
          setName("");
          onSaved();
        } catch (error) {
          setProblem(error);
        }
      }}
    >
      <TextInput
        aria-label="View name"
        placeholder="Name this view"
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        className="w-48"
        data-testid="ops-runs-view-name"
      />
      <Button type="submit" variant="primary" data-testid="ops-runs-view-save">
        Save
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {problem ? <ErrorNotice error={problem} /> : null}
    </form>
  );
}

function SavedViews({
  state,
  onOpen,
  onDeleted,
}: {
  state: { data: ResponseOf<typeof apiRoutes.opsSavedViews> | undefined };
  onOpen: (filter: RunFilter) => void;
  onDeleted: () => void;
}) {
  const api = useApiClient();
  const views = state.data?.views ?? [];
  if (views.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="ops-runs-saved">
      <span className="text-ink-muted">Saved views</span>
      {views.map((v) => (
        <span key={v.id} className="ops-chip">
          <button
            type="button"
            onClick={() => onOpen(v.filters)}
            data-testid={`ops-runs-saved-${v.id}`}
            className="text-ink"
          >
            {v.name}
          </button>
          <button
            type="button"
            aria-label={`Delete the view ${v.name}`}
            onClick={async () => {
              await api.call(apiRoutes.opsDeleteSavedView, { params: { id: v.id } });
              onDeleted();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
    </div>
  );
}
