// `/ops/clients`: every client the operator serves (the sidebar's "All N clients"), in the
// prototype's back-office style: a line of totals, then one row per client with its agents, what
// needs us there and its runs waiting for approval, and when it started. Each row opens the client
// page. Cards (the default) or a table; each card adds the last day's runs and failures, coloured
// by the client's worst state. "Needs us" is the command center's count for the client (the sidebar's badge reads the same
// field), and its figure links to Escalations for that client; waiting runs link to its runs.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { cx } from "../../ui/cx";
import type { AccentTone } from "../../ui/figures";
import { Loaded, Page } from "../../ui/page";
import { buttonClass, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { OPS_PATHS } from "../paths";
import { runsLink } from "../run/links";

type Clients = ResponseOf<typeof apiRoutes.opsClients>["clients"];

/** "4 clients · 9 agents · 2 need us · 1 run waiting for approval". */
export function clientsLine(clients: Clients): string {
  const agents = clients.reduce((n, c) => n + c.agents, 0);
  const needs = clients.reduce((n, c) => n + (c.needsUs ?? 0), 0);
  const waiting = clients.reduce((n, c) => n + (c.waitingRuns ?? 0), 0);
  return [
    `${clients.length} ${clients.length === 1 ? "client" : "clients"}`,
    `${agents} ${agents === 1 ? "agent" : "agents"}`,
    needs > 0 ? `${needs} ${needs === 1 ? "needs" : "need"} us` : "nothing needs us",
    waiting > 0 ? `${waiting} ${waiting === 1 ? "run" : "runs"} waiting for approval` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ClientsScreen() {
  const state = useApi(apiRoutes.opsClients);
  return (
    <Page testId="ops-clients-page">
      <PageHeader
        title="Clients"
        subtitle={
          state.data ? clientsLine(state.data.clients) : "Clients you serve and their agents."
        }
        actions={<NewClientLink />}
      />
      <Loaded state={state}>{(data) => <ClientList clients={data.clients} />}</Loaded>
    </Page>
  );
}

export function NewClientLink() {
  return (
    <Link to="/ops/clients/new" className={buttonClass("primary")} data-testid="ops-new-client">
      New client
    </Link>
  );
}

const since = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });

type Client = Clients[number];
type View = "cards" | "table";
const VIEW_KEY = "mezonas.clients.view";

/** Cards or table, remembered per viewer (a convenience: without storage it lasts the visit). */
function useClientsView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return window.localStorage.getItem(VIEW_KEY) === "table" ? "table" : "cards";
    } catch {
      return "cards";
    }
  });
  const choose = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  };
  return [view, choose];
}

/** A client's state in a word, worst first: failures, then waiting on us, then on approval. */
export function clientState(c: Client): {
  state: ChipState;
  words: string;
  tone: AccentTone | null;
} {
  const failed = c.runs24h?.failed ?? 0;
  if (failed > 0) return { state: "failed", words: "Failed runs", tone: "risk" };
  if ((c.needsUs ?? 0) > 0) return { state: "waiting", words: "Needs us", tone: "signal" };
  if ((c.waitingRuns ?? 0) > 0)
    return { state: "waiting", words: "Waiting for approval", tone: "signal" };
  if ((c.runs24h?.total ?? 0) > 0)
    return { state: "done", words: "Running well", tone: "positive" };
  return { state: "idle", words: "Quiet today", tone: null };
}

/** The five figures' short labels (one length, so the columns match) and their full words. */
const FIGURES = {
  agents: ["Agents", "Active agents"],
  runs: ["Runs 24h", "Live runs in the last 24 hours"],
  failed: ["Fails 24h", "Failed runs in the last 24 hours"],
  needs: ["Needs us", "Needs us: escalations at this client"],
  waiting: ["Approvals", "Runs waiting for approval"],
} as const;

/** Since 24 hours ago, for the runs list's links. */
function dayAgo(): string {
  return new Date(Date.now() - 24 * 3_600_000).toISOString();
}

function ClientList({ clients }: { clients: Clients }) {
  const [view, setView] = useClientsView();
  if (clients.length === 0)
    return (
      <EmptyState
        icon="customer"
        title="No clients yet"
        line="Add a client, connect their tools, then fork agents for them from your templates."
        action={{ label: "New client", to: "/ops/clients/new", testId: "ops-clients-empty-new" }}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="ds-seg m-0 self-end" data-testid="ops-clients-view">
        <legend className="sr-only">View as</legend>
        {(
          [
            ["cards", "Cards"],
            ["table", "Table"],
          ] as const
        ).map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            data-testid={`ops-clients-view-${v}`}
            onClick={() => setView(v)}
            className="hover:text-ink"
          >
            {text}
          </button>
        ))}
      </fieldset>
      {view === "cards" ? <ClientCards clients={clients} /> : <ClientRows clients={clients} />}
    </div>
  );
}

/** One figure on a client card: its number takes the state colour only when there is one. */
function Kpi({
  figure,
  value,
  tone,
  to,
  testId,
}: {
  figure: keyof typeof FIGURES;
  value: number;
  tone: "risk" | "signal" | null;
  to: string;
  testId: string;
}) {
  const [label, full] = FIGURES[figure];
  return (
    <Link
      to={to}
      title={full}
      data-testid={testId}
      className={cx("ui-clientkpi", tone && `ui-clientkpi--${tone}`)}
    >
      <span className="ui-clientkpi__value">{value}</span>
      <span className="ui-clientkpi__label">{label}</span>
    </Link>
  );
}

// DECISION: a client card is its name, its state (chip and top accent) and one strip of five
// figures: active agents, the last day's runs and failures, Needs us and runs waiting for
// approval, each a link to its list (2026-11-10). Only a figure that asks for something is
// coloured, and always under its word.
function ClientCards({ clients }: { clients: Clients }) {
  return (
    <div className="ui-clientgrid" data-testid="ops-clients-cards">
      {clients.map((c) => {
        const s = clientState(c);
        const total = c.runs24h?.total ?? 0;
        const failed = c.runs24h?.failed ?? 0;
        const needs = c.needsUs ?? 0;
        const waiting = c.waitingRuns ?? 0;
        return (
          <article
            key={c.id}
            className="ds-card ui-accent ui-clientcard"
            {...(s.tone ? { "data-tone": s.tone } : {})}
            data-testid={`ops-client-card-${c.id}`}
          >
            <div className="ui-clientcard__head">
              <div className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    to={OPS_PATHS.client(c.id)}
                    data-testid={`ops-client-${c.id}`}
                    className="ui-clientcard__link truncate font-medium text-ink"
                  >
                    {c.name}
                  </Link>
                  {c.sandbox ? <Tag>Sandbox</Tag> : null}
                </span>
                <p className="mt-0.5 truncate text-xs text-ink-muted">
                  {c.timezone} · since {since(c.createdAt)}
                </p>
              </div>
              <StatusChip state={s.state} testId={`ops-client-${c.id}-state`}>
                {s.words}
              </StatusChip>
            </div>
            <div className="ui-clientkpis">
              <Kpi
                figure="agents"
                value={c.agents}
                tone={null}
                to={OPS_PATHS.client(c.id)}
                testId={`ops-client-agents-${c.id}`}
              />
              <Kpi
                figure="runs"
                value={total}
                tone={null}
                to={runsLink({ clients: [c.id], mode: "live", since: dayAgo() })}
                testId={`ops-client-runs-${c.id}`}
              />
              <Kpi
                figure="failed"
                value={failed}
                tone={failed > 0 ? "risk" : null}
                to={runsLink({
                  clients: [c.id],
                  statuses: ["failed"],
                  mode: "live",
                  since: dayAgo(),
                })}
                testId={`ops-client-failed-${c.id}`}
              />
              <Kpi
                figure="needs"
                value={needs}
                tone={needs > 0 ? "signal" : null}
                to={`${OPS_PATHS.escalations}?client=${c.id}`}
                testId={`ops-client-needs-${c.id}`}
              />
              <Kpi
                figure="waiting"
                value={waiting}
                tone={waiting > 0 ? "signal" : null}
                to={runsLink({ clients: [c.id], statuses: ["waiting"], mode: "live" })}
                testId={`ops-client-waiting-${c.id}`}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ClientRows({ clients }: { clients: Clients }) {
  const navigate = useNavigate();
  return (
    <div className="dt dt-ana ui-clientstable overflow-x-auto">
      <table data-testid="ops-clients-table">
        <thead>
          <tr className="dt-cols">
            <th>Client</th>
            <th>State</th>
            {(Object.keys(FIGURES) as (keyof typeof FIGURES)[]).map((k) => (
              <th key={k} className="n" title={FIGURES[k][1]}>
                {FIGURES[k][0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const s = clientState(c);
            const failed = c.runs24h?.failed ?? 0;
            return (
              <tr
                key={c.id}
                className="cursor-pointer hover:bg-surface-subtle"
                data-testid={`ops-client-row-${c.id}`}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a")) return;
                  navigate(OPS_PATHS.client(c.id));
                }}
              >
                <td>
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      to={OPS_PATHS.client(c.id)}
                      data-testid={`ops-client-${c.id}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {c.name}
                    </Link>
                    {c.sandbox ? <Tag>Sandbox</Tag> : null}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {c.timezone} · since {since(c.createdAt)}
                  </span>
                </td>
                <td>
                  <StatusChip state={s.state}>{s.words}</StatusChip>
                </td>
                <td className="n">{c.agents}</td>
                <td className="n">{c.runs24h?.total ?? 0}</td>
                <td className={cx("n", failed > 0 && "text-risk-ink font-medium")}>{failed}</td>
                <td className="n" data-testid={`ops-client-needs-${c.id}`}>
                  {c.needsUs ? (
                    <Link
                      to={`${OPS_PATHS.escalations}?client=${c.id}`}
                      className="text-link hover:underline"
                    >
                      {c.needsUs}
                    </Link>
                  ) : (
                    0
                  )}
                </td>
                <td className="n" data-testid={`ops-client-waiting-${c.id}`}>
                  {c.waitingRuns ? (
                    <Link
                      to={runsLink({ clients: [c.id], statuses: ["waiting"], mode: "live" })}
                      className="text-link hover:underline"
                    >
                      {c.waitingRuns}
                    </Link>
                  ) : (
                    0
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
