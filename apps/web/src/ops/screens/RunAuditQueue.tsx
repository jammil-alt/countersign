// `/ops/run-audit` (wave 6, docs/plan.md §1.86 "Run audit (wave 6)"): the audit queue. Runs picked
// when they finished for a person to check (every run that wrote to a client's tools and a share
// of the rest, by the client's rule or an agent's override), newest first, filtered by client,
// agent and state (unaudited, audited, with a problem) in the URL. A reviewer opens a run in the
// run view and marks it there. Below the list: per client and per agent, runs queued, audited,
// problems found and when last audited. Operator only; clients never see it (invariant 11).
import {
  AUDIT_QUEUE_STATES,
  type AuditQueueRun,
  type AuditQueueState,
  type AuditStat,
  isUuid,
  shortRunId,
} from "@countersign/core";
import { Link, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { shortTime } from "../../runs/format";
import { useSession } from "../../session/session";
import { Field, Select } from "../../ui/forms";
import { Loaded, Page } from "../../ui/page";
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tag,
} from "../../ui/primitives";
import { reviewerName, VerdictBadge } from "../run/RunAudit";
import { runChip } from "../run/words";
import { TableCard } from "./business";
import { settingsPath } from "./ClientSettings";
import { UtilitiesTabs } from "./UtilitiesTabs";

const STATE_WORDS: Record<AuditQueueState, string> = {
  unaudited: "To audit",
  audited: "Audited",
  problem: "Problems",
  all: "All",
};

const REASON_WORDS: Record<AuditQueueRun["reason"], string> = {
  wrote: "Wrote to their tools",
  sampled: "Sampled",
  by_hand: "Marked by hand",
};

// DECISION (wave 6): a run is marked in the run view, where its whole trail is, not from a row
// here: the queue lists and filters; each row opens the run. The agent filter lists the agents
// the stats name (those with queued runs), so no other agents list is fetched.
export function OpsRunAuditScreen() {
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const client = isUuid(params.get("client") ?? "") ? (params.get("client") as string) : "";
  const agent = isUuid(params.get("agent") ?? "") ? (params.get("agent") as string) : "";
  const asked = params.get("state") ?? "";
  const state: AuditQueueState = (AUDIT_QUEUE_STATES as readonly string[]).includes(asked)
    ? (asked as AuditQueueState)
    : "unaudited";

  const scope = { ...(client ? { client } : {}), ...(agent ? { agent } : {}) };
  const queue = useApi(apiRoutes.opsAuditQueue, { query: { ...scope, state } as never });
  const stats = useApi(apiRoutes.opsAuditStats, { query: scope });
  // The agent filter offers the agents with runs in the queue, for the client picked (with an
  // agent picked, the stats above are that agent's alone, so the list is asked for apart).
  const clientStats = useApi(
    apiRoutes.opsAuditStats,
    agent ? { query: client ? { client } : {} } : null,
  );
  const agents = ((agent ? clientStats.data : stats.data)?.agents ?? []).filter((a) => a.agentId);
  const clients = session.tenants.filter((t) => t.role === "operator");
  const counts = queue.data?.counts;
  const filtered = Boolean(client || agent);

  return (
    <Page testId="ops-run-audit">
      <PageHeader
        eyebrow="Utilities"
        title="Audit queue"
        subtitle="Runs picked for a person to check: every run that wrote to a client's tools, and a share of the rest. Open one, read what it did, and mark it."
        actions={
          <StatusFilter
            value={state}
            onChange={(v) => set({ state: v === "unaudited" ? "" : v })}
            area="ops-run-audit-state"
            label="Show"
            options={AUDIT_QUEUE_STATES.map((s) => [
              s,
              counts && s !== "all" ? `${STATE_WORDS[s]} · ${counts[s]}` : STATE_WORDS[s],
            ])}
          />
        }
      />
      <UtilitiesTabs />

      <Card pad>
        <div className="flex flex-wrap items-end gap-3" data-testid="ops-run-audit-filters">
          <Field label="Client" className="w-48">
            <Select
              data-testid="ops-run-audit-client"
              value={client}
              onChange={(e) => set({ client: e.target.value, agent: "" })}
              className="h-8 w-48 text-sm"
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Agent" className="w-56">
            <Select
              data-testid="ops-run-audit-agent"
              value={agent}
              onChange={(e) => set({ agent: e.target.value })}
              className="h-8 w-56 text-sm"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId ?? ""}>
                  {client ? a.agentName : `${a.agentName} · ${a.clientName}`}
                </option>
              ))}
            </Select>
          </Field>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="ops-run-audit-clear"
              onClick={() => set({ client: "", agent: "" })}
            >
              Clear filters
            </Button>
          ) : null}
          {client ? (
            <Link
              to={settingsPath(client, "audit")}
              className="pb-1 text-sm text-link underline"
              data-testid="ops-run-audit-rule-link"
            >
              This client's sampling rule
            </Link>
          ) : null}
        </div>
      </Card>

      {queue.loading && !queue.data ? <Loading /> : null}
      {queue.error ? <ErrorNotice error={queue.error} onRetry={queue.reload} /> : null}
      {queue.data ? (
        queue.data.runs.length === 0 ? (
          <EmptyState>
            {state === "unaudited"
              ? "Nothing to audit. Runs join the queue as they finish."
              : state === "problem"
                ? "No problems found."
                : "No runs here yet."}
          </EmptyState>
        ) : (
          <QueueTable runs={queue.data.runs} />
        )
      ) : null}

      <Loaded state={stats}>
        {(s) => (
          <div className="flex flex-col gap-4" data-testid="ops-run-audit-stats">
            <StatsTable title="By client" rows={s.clients} kind="client" />
            <StatsTable title="By agent" rows={s.agents} kind="agent" />
          </div>
        )}
      </Loaded>
    </Page>
  );
}

function QueueTable({ runs }: { runs: AuditQueueRun[] }) {
  return (
    <TableCard title="Runs" meta="Newest first" testId="ops-run-audit-queue">
      <table>
        <thead>
          <tr className="dt-cols">
            <th>Run</th>
            <th>Client</th>
            <th>Agent</th>
            <th>Why</th>
            <th>Finished</th>
            <th>Mark</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const chip = runChip(r.status);
            return (
              <tr key={r.runId} data-testid={`ops-run-audit-row-${r.runId}`}>
                <td>
                  <Link
                    to={`/ops/runs/${r.runId}`}
                    className="reference text-link hover:underline"
                    data-testid={`ops-run-audit-open-${r.runId}`}
                  >
                    {shortRunId(r.runId)}
                  </Link>
                  {chip.state === "done" ? null : (
                    <span className="ml-2 text-xs text-ink-muted">{chip.words}</span>
                  )}
                </td>
                <td>{r.clientName}</td>
                <td>{r.agentName}</td>
                <td>
                  <Tag>{REASON_WORDS[r.reason]}</Tag>
                </td>
                <td className="figures">{shortTime(r.finishedAt ?? r.queuedAt)}</td>
                <td>
                  {r.latest ? (
                    <span className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <VerdictBadge
                          verdict={r.latest.verdict}
                          testId={`ops-run-audit-verdict-${r.runId}`}
                        />
                        <span className="text-xs text-ink-muted">
                          {reviewerName(r.latest)} · {shortTime(r.latest.createdAt)}
                          {r.marks > 1 ? ` · ${r.marks} marks` : ""}
                        </span>
                      </span>
                      {r.latest.note ? (
                        <span className="text-sm text-ink" title={r.latest.note}>
                          {r.latest.note.length > 80
                            ? `${r.latest.note.slice(0, 79)}…`
                            : r.latest.note}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <Link
                      to={`/ops/runs/${r.runId}`}
                      className="text-sm text-link underline"
                      data-testid={`ops-run-audit-check-${r.runId}`}
                    >
                      Check it
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableCard>
  );
}

function StatsTable({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: AuditStat[];
  kind: "client" | "agent";
}) {
  if (rows.length === 0) return null;
  return (
    <TableCard title={title} testId={`ops-run-audit-stats-${kind}`}>
      <table>
        <thead>
          <tr className="dt-cols">
            <th>{kind === "client" ? "Client" : "Agent"}</th>
            <th className="text-right">Queued</th>
            <th className="text-right">Audited</th>
            <th className="text-right">Problems</th>
            <th>Last audited</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={`${s.tenantId}-${s.agentId ?? ""}`}
              data-testid={`ops-run-audit-stat-${kind}-${s.agentId ?? s.tenantId}`}
            >
              <td>
                {kind === "client" ? (
                  <Link
                    to={settingsPath(s.tenantId, "audit")}
                    className="text-link hover:underline"
                  >
                    {s.clientName}
                  </Link>
                ) : (
                  <span className="flex flex-col">
                    <span className="text-ink">{s.agentName}</span>
                    <span className="text-xs text-ink-muted">{s.clientName}</span>
                  </span>
                )}
              </td>
              <td className="figures text-right">{s.queued}</td>
              <td className="figures text-right">{s.audited}</td>
              <td className={`figures text-right${s.problems > 0 ? " ui-tone-risk" : ""}`}>
                {s.problems}
              </td>
              <td className="figures">{s.lastAuditedAt ? shortTime(s.lastAuditedAt) : "Never"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}
