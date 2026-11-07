// `/ops/runs` and `/ops/clients/:clientId/runs`, O9 Runs (docs/design/prototype.html `#O9-Runs`;
// ARCHITECTURE §10.10, §14): every run, every client, with cost. One typed filter (RunFilter) shown
// as chips; quick views; a question in plain words turned into the filter (`/api/ops/runs/ask`);
// saved views; failures grouped by error; retry or cancel the selected runs; the list as CSV. Polls
// while any run is still going.
import {
  askChips,
  errorGroupKey,
  type RunFilter,
  runFilterQuery,
  shortRunId,
} from "@countersign/core";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { duration, isRunGoing, shortTime, usd } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
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
import { plural, runChip, runErrorParts } from "../run/words";

type Run = ResponseOf<typeof apiRoutes.opsRuns>["runs"][number];
type Group = NonNullable<ResponseOf<typeof apiRoutes.opsRuns>["groups"]>[number];

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
    id: "waiting",
    label: "Waiting on clients",
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

/** A time filter's value as people read it. */
function chipValue(key: string, value: string): string {
  if ((key === "since" || key === "until") && !Number.isNaN(Date.parse(value))) {
    return shortTime(value);
  }
  return value;
}

export function OpsRunsScreen() {
  const { clientId } = useParams();
  const api = useApiClient();
  const session = useSession();
  const clients = useMemo(() => new Map(session.tenants.map((t) => [t.id, t.name])), [session]);

  const [view, setView] = useState<ViewId | null>("all");
  const [filter, setFilter] = useState<RunFilter>({});
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
  usePoll(reload, data?.runs.some((r) => isRunGoing(r.status)) ?? false, 5_000, loading);
  const views = useApi(apiRoutes.opsSavedViews, { query: { surface: "ops_runs" } });

  const agents = useMemo(() => new Map((data?.agents ?? []).map((a) => [a.id, a])), [data?.agents]);
  const chips = askChips(filter, {
    agents: new Map([...agents].map(([id, a]) => [id, a.name])),
    clients,
    connectors: new Map(),
  });

  const apply = (next: RunFilter, from: ViewId | null) => {
    setFilter(next);
    setView(from);
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
        apply(without(answer.filter, clientId ? "clients" : ""), null);
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
  const picked = runs.filter((r) => selected.has(r.id));
  const retryable = picked.filter((r) => r.status === "failed" && r.mode === "live");
  const cancellable = picked.filter((r) => isRunGoing(r.status));

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
                onClick={() => apply(without(filter, c.key), null)}
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
                  apply(v.filter(), v.id);
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
        <SavedViews state={views} onOpen={(f) => apply(f, null)} onDeleted={views.reload} />
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
              null,
            )
          }
        />
      ) : null}

      <Loaded state={state}>
        {() =>
          runs.length === 0 ? (
            <EmptyState>No runs match. Remove a filter or pick another view.</EmptyState>
          ) : (
            <Card testId="ops-runs-card">
              <div className="ui-card__head">
                <span className="text-sm font-medium text-ink" data-testid="ops-runs-selected">
                  {picked.length > 0
                    ? `${picked.length} selected`
                    : "Select runs to retry or cancel them."}
                </span>
                <span className="flex flex-wrap gap-2">
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
                </span>
              </div>
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
          )
        }
      </Loaded>
    </Page>
  );
}

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
  return (
    <div className="dt dt-ana overflow-x-auto rounded-none border-0">
      <table data-testid="ops-runs">
        <thead>
          <tr className="dt-cols">
            <th>
              <span className="sr-only">Select</span>
            </th>
            <th>Run</th>
            <th>Client</th>
            <th>Agent</th>
            <th>Status</th>
            <th>Started</th>
            <th>Took</th>
            <th>Error</th>
            <th className="text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const short = shortRunId(r.id);
            const chip = runChip(r.status);
            const err = r.status === "failed" ? runErrorParts(r.error) : null;
            return (
              <tr
                key={r.id}
                className={selected.has(r.id) ? "is-selected" : undefined}
                data-testid={`ops-run-row-${r.id}`}
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
                  <Link
                    to={`/ops/runs/${r.id}`}
                    data-testid={`ops-run-${r.id}-open`}
                    className="reference text-link hover:underline"
                  >
                    {short}
                  </Link>
                </td>
                <td className="text-sm">{clients.get(r.tenantId) ?? "Client"}</td>
                <td className="text-sm">
                  {agents.get(r.agentId)?.name ?? "Agent"}
                  <span className="ml-1 reference text-xs text-ink-muted">{r.workflowSlug}</span>
                </td>
                <td>
                  <span className="flex items-center gap-1.5">
                    <StatusChip state={chip.state}>{chip.words}</StatusChip>
                    {r.mode === "test" ? (
                      <span className="text-xs text-ink-muted">Test</span>
                    ) : null}
                  </span>
                </td>
                <td className="text-sm figures">{shortTime(r.startedAt ?? r.createdAt)}</td>
                <td className="text-sm figures">{duration(r.startedAt, r.finishedAt)}</td>
                <td className="text-sm">
                  {err ? (
                    <span className="ui-tone-risk">
                      {errorGroupKey(r.error)}
                      {err.nodeId ? (
                        <span className="text-ink-muted"> · at {err.nodeId}</span>
                      ) : null}
                    </span>
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
    return <EmptyState>No failed runs match, so there is nothing to group.</EmptyState>;
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
            label={g.key}
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
