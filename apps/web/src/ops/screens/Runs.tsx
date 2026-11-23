// `/ops/runs` and `/ops/clients/:clientId/runs`, O9 Runs (docs/design/prototype.html `#O9-Runs`;
// ARCHITECTURE §10.10, §14): every run, every client, with cost. One typed filter (RunFilter) shown
// as chips; quick views; a question in plain words turned into the filter (`/api/ops/runs/ask`);
// saved views; failures grouped by error; retry or cancel the selected runs; the list as CSV. Polls
// while any run is still going.
import {
  type AskChip,
  aboutParam,
  askChips,
  OpsRunsQuery,
  type RunAboutName,
  type RunFilter,
  runFilterQuery,
  shortRunId,
  sumAmounts,
} from "@countersign/core";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { validZone } from "../../i18n/format";
import { periodEnd, viewerZone, zoneName } from "../../i18n/zone";
import { isRunGoing, msWords, runsPollMs, runWorkedMs, shortTime, usd } from "../../runs/format";
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
import { useOpsClients } from "../OpsLayout";
import {
  age,
  errorGroupLabel,
  foldSameFailures,
  NOBODY_TO_ACT_WORDS,
  plural,
  RUN_STATUS_WORDS,
  runChip,
  runErrorLine,
  runsCountWords,
  sameFailureWords,
  waitOnWords,
} from "../run/words";

type Run = ResponseOf<typeof apiRoutes.opsRuns>["runs"][number];
type Agent = ResponseOf<typeof apiRoutes.opsRuns>["agents"][number];
type Group = NonNullable<ResponseOf<typeof apiRoutes.opsRuns>["groups"]>[number];

/** "client admin" → "Client admin", for a cell that starts with it. */
function capitalize(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The runs a page of the list loads; "Show more" loads the next page (`before`, `next`). */
// DECISION (QA, runs and dates): 50 a page, then "Show 50 more" below the list, rather than numbered
// pages: the list is newest first and read from the top, and polling keeps the first page fresh.
export const RUNS_LIMIT = 50;

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
  about: "about",
};

/** A filter without one key. */
function without(filter: RunFilter, key: string): RunFilter {
  return Object.fromEntries(Object.entries(filter).filter(([k]) => k !== key)) as RunFilter;
}

/** R2: a filter without one chip: one `about` entry, else the chip's whole key. */
export function withoutChip(filter: RunFilter, chip: AskChip): RunFilter {
  if (chip.key !== "about" || chip.about === undefined) return without(filter, chip.key);
  const rest = (filter.about ?? []).filter((e) => aboutParam(e) !== chip.about);
  return rest.length ? { ...filter, about: rest } : without(filter, "about");
}

/** R2: the records an `about` filter names, by id, as the list names them back. */
export function aboutChipNames(names: readonly RunAboutName[] | undefined): Map<string, string> {
  return new Map(
    (names ?? []).map((n) => [n.id, [n.label, n.number].filter(Boolean).join(" · ") || n.kind]),
  );
}

/**
 * A time filter's value as people read it, and statuses in words. A period's ends read in the
 * client's zone when the list is one client's, named when it isn't the viewer's (S5.4).
 */
export function chipValue(key: string, value: string, timeZone?: string): string {
  if ((key === "since" || key === "until") && !Number.isNaN(Date.parse(value))) {
    const words = periodEnd(key, value, "en-US", timeZone);
    const zone = validZone(timeZone);
    return zone && zone !== validZone(viewerZone()) ? `${words} (${zoneName(zone)})` : words;
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
  // S5.4: one client's list reads its period in that client's zone.
  const opsClients = useOpsClients();
  const oneClient = effective.clients?.length === 1 ? effective.clients[0] : undefined;
  const clientZone = oneClient ? opsClients?.find((c) => c.id === oneClient)?.timezone : undefined;
  const query = { ...runFilterQuery(effective), limit: String(RUNS_LIMIT) };
  const state = useApi(apiRoutes.opsRuns, {
    query: { ...query, ...(grouped ? { groupBy: "error" as const } : {}) } as never,
  });
  const { data, loading, reload } = state;
  // The pages loaded past the first, for this filter only: another filter starts from the top.
  const pageKey = JSON.stringify(query);
  const [later, setLater] = useState<{
    key: string;
    runs: Run[];
    agents: Agent[];
    next: string | null;
  } | null>(null);
  const more = later?.key === pageKey ? later : null;
  const [loadingMore, setLoadingMore] = useState(false);
  // Every 5 s while a run works, every 30 s while runs only wait on a person (2.2).
  const pollMs = data ? runsPollMs(data.runs, 5_000) : null;
  usePoll(reload, pollMs !== null, pollMs ?? 5_000, loading);
  const views = useApi(apiRoutes.opsSavedViews, { query: { surface: "ops_runs" } });

  const agents = useMemo(
    () => new Map([...(data?.agents ?? []), ...(more?.agents ?? [])].map((a) => [a.id, a])),
    [data?.agents, more?.agents],
  );
  const chips = askChips(filter, {
    agents: new Map([...agents].map(([id, a]) => [id, a.name])),
    clients,
    connectors: new Map(),
    about: aboutChipNames(data?.about),
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

  const runs = useMemo(() => {
    const first = data?.runs ?? [];
    const seen = new Set(first.map((r) => r.id));
    return [...first, ...(more?.runs ?? []).filter((r) => !seen.has(r.id))];
  }, [data?.runs, more?.runs]);
  const next = more ? more.next : (data?.next ?? null);
  // S4.9: how many rows the table shows once it folds repeated failures (the order doesn't change
  // what folds).
  const rowCount = useMemo(() => foldSameFailures(runs).length, [runs]);

  const showMore = async () => {
    const last = runs[runs.length - 1];
    if (!next || !last) return;
    setLoadingMore(true);
    setProblem(null);
    try {
      const page = await api.call(apiRoutes.opsRuns, {
        query: { ...query, before: last.id } as never,
      });
      setLater({
        key: pageKey,
        runs: [...(more?.runs ?? []), ...page.runs],
        agents: [...(more?.agents ?? []), ...page.agents],
        next: page.next ?? null,
      });
    } catch (error) {
      setProblem(error);
    } finally {
      setLoadingMore(false);
    }
  };

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
            <span
              key={`${c.key}:${c.about ?? ""}`}
              className="ops-chip"
              data-testid={`ops-runs-chip-${c.key}`}
            >
              <b>{CHIP_WORDS[c.key] ?? c.key}</b> {chipValue(c.key, c.value, clientZone)}
              <button
                type="button"
                aria-label={
                  c.about === undefined
                    ? `Remove the ${CHIP_WORDS[c.key] ?? c.key} filter`
                    : `Remove ${c.value}`
                }
                onClick={() => apply(withoutChip(filter, c))}
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
            {data ? runsCountWords(runs.length, rowCount, next !== null) : ""}
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
                  onToggle={(ids, on) => {
                    const picked = new Set(selected);
                    for (const id of ids) {
                      if (on) picked.add(id);
                      else picked.delete(id);
                    }
                    setSelected(picked);
                  }}
                />
              </Card>
              {next ? (
                <div className="flex justify-center">
                  <Button
                    onClick={() => void showMore()}
                    disabled={loadingMore}
                    data-testid="ops-runs-more"
                  >
                    {loadingMore ? "Loading…" : `Show ${RUNS_LIMIT} more`}
                  </Button>
                </div>
              ) : null}
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
  onToggle: (ids: string[], on: boolean) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "started",
    dir: "desc",
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
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
          return r.waiting ? waitOnWords(r.waiting).toLowerCase() : "￿";
        case "started":
          return new Date(r.startedAt ?? r.createdAt).getTime();
        case "took":
          return runWorkedMs(r) ?? -1;
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
  const items = useMemo(() => foldSameFailures(sorted), [sorted]);
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
  const row = (r: Run, inGroup = false) => (
    <RunRow
      key={r.id}
      run={r}
      clients={clients}
      agents={agents}
      selected={selected.has(r.id)}
      inGroup={inGroup}
      onToggle={() => onToggle([r.id], !selected.has(r.id))}
    />
  );
  return (
    // The table scrolls inside its own box when the page is narrow; Cost stays pinned on the right.
    <div className="dt dt-ana ops-runs-table overflow-x-auto rounded-none border-0">
      <table data-testid="ops-runs">
        <thead>
          <tr className="dt-cols">
            <th>
              <span className="sr-only">Select</span>
            </th>
            {head("run", "Run", "ops-runs-col-run")}
            {head("client", "Client")}
            {head("agent", "Agent")}
            {head("status", "Status")}
            {head("owner", "Owner")}
            {head("started", "Started")}
            {head("took", "Took")}
            <th className="ops-runs-col-error">Error</th>
            {head("cost", "Cost", "ops-runs-cost text-right")}
          </tr>
        </thead>
        <tbody>
          {items.flatMap((item) => {
            if (item.kind === "run") return [row(item.run)];
            const ids = item.runs.map((r) => r.id);
            const expanded = open.has(item.key);
            return [
              <SameFailureRow
                key={`same-${item.key}`}
                runs={item.runs}
                clients={clients}
                agents={agents}
                expanded={expanded}
                selected={ids.every((id) => selected.has(id))}
                onToggle={(on) => onToggle(ids, on)}
                onExpand={() => {
                  const next = new Set(open);
                  if (expanded) next.delete(item.key);
                  else next.add(item.key);
                  setOpen(next);
                }}
              />,
              ...(expanded ? item.runs.map((r) => row(r, true)) : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "4 min", with the time it waited on people beneath ("Waited 7 d on people"). */
function TookCell({ run: r }: { run: Run }) {
  const worked = runWorkedMs(r);
  const waited = r.waitedMs ?? 0;
  if (worked === null) return null;
  return (
    <>
      <span className="block whitespace-nowrap">{msWords(worked)}</span>
      {waited >= 60_000 ? (
        <span className="block text-xs text-ink-muted" data-testid={`ops-run-${r.id}-waited`}>
          Waited {msWords(waited)}
        </span>
      ) : null}
    </>
  );
}

function RunRow({
  run: r,
  clients,
  agents,
  selected,
  inGroup,
  onToggle,
}: {
  run: Run;
  clients: Map<string, string>;
  agents: Map<string, { name: string }>;
  selected: boolean;
  inGroup: boolean;
  onToggle: () => void;
}) {
  const navigate = useNavigate();
  const short = shortRunId(r.id);
  const chip = runChip(r);
  const wait = r.waiting ?? null;
  return (
    <tr
      className={cx("cursor-pointer hover:bg-surface-subtle", selected && "is-selected")}
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
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${short}`}
          data-testid={`ops-run-${r.id}-select`}
        />
      </td>
      <td className={cx("ops-runs-col-run", inGroup && "ops-runs-in-group")}>
        {/* Titled by what the run is about: its invoice or its first change. The vendor or
            customer is left to the tooltip; the table has the client. */}
        <Clamp
          lines={2}
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
        {r.subject ? <span className="block reference text-xs text-ink-muted">{short}</span> : null}
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
          {r.mode === "test" ? <span className="text-xs text-ink-muted">Test</span> : null}
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
            <span className="block whitespace-nowrap">{capitalize(waitOnWords(wait))}</span>
            <span className="block text-xs text-ink-muted" data-testid={`ops-run-${r.id}-wait`}>
              For {age(wait.since)}
              {wait.nobodyToAct ? (
                <span className="ui-tone-risk"> · {NOBODY_TO_ACT_WORDS[wait.nobodyToAct]}</span>
              ) : null}
            </span>
          </Clamp>
        ) : null}
      </td>
      <td className="text-sm figures">{shortTime(r.startedAt ?? r.createdAt)}</td>
      <td className="text-sm figures" data-testid={`ops-run-${r.id}-took`}>
        <TookCell run={r} />
      </td>
      <td className="ops-runs-col-error text-sm" data-testid={`ops-run-${r.id}-error`}>
        {r.status === "failed" ? (
          <Clamp lines={2} className="ui-tone-risk">
            {runErrorLine(r.error, r.errorStep)}
          </Clamp>
        ) : null}
      </td>
      <td className="n ops-runs-cost">{usd(r.costUsd)}</td>
    </tr>
  );
}

/** Failed runs alike, as one row: how many, the error once, and a button that shows them. */
function SameFailureRow({
  runs,
  clients,
  agents,
  expanded,
  selected,
  onToggle,
  onExpand,
}: {
  runs: Run[];
  clients: Map<string, string>;
  agents: Map<string, { name: string }>;
  expanded: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onExpand: () => void;
}) {
  const first = runs[0] as Run;
  const latest = runs.reduce((a, b) =>
    new Date(b.startedAt ?? b.createdAt) > new Date(a.startedAt ?? a.createdAt) ? b : a,
  );
  const total = sumAmounts(runs.map((r) => r.costUsd || "0"));
  const words = sameFailureWords(runs);
  return (
    <tr className={cx(selected && "is-selected")} data-testid={`ops-runs-same-${first.id}`}>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(!selected)}
          aria-label={`Select the ${words}`}
          data-testid={`ops-runs-same-${first.id}-select`}
        />
      </td>
      <td className="ops-runs-col-run">
        <button
          type="button"
          className="text-link hover:underline text-left"
          aria-expanded={expanded}
          onClick={onExpand}
          data-testid={`ops-runs-same-${first.id}-open`}
        >
          {words}
        </button>
        <span className="block text-xs text-ink-muted">
          {expanded ? "Showing each below" : "Show each"}
        </span>
      </td>
      <td className="text-sm">
        <Clamp>{clients.get(first.tenantId) ?? "Client"}</Clamp>
      </td>
      <td className="text-sm">
        <Clamp>{agents.get(first.agentId)?.name ?? "Agent"}</Clamp>
      </td>
      <td>
        <StatusChip state="failed">Failed</StatusChip>
      </td>
      <td />
      <td className="text-sm figures">Last {shortTime(latest.startedAt ?? latest.createdAt)}</td>
      <td />
      <td className="ops-runs-col-error text-sm">
        <Clamp lines={2} className="ui-tone-risk">
          {runErrorLine(first.error, first.errorStep)}
        </Clamp>
      </td>
      <td className="n ops-runs-cost">{usd(total)}</td>
    </tr>
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
