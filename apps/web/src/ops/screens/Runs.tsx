// `/ops/runs` and `/ops/clients/:clientId/runs` (ARCHITECTURE §15): runs across the clients served,
// or one client's, with status, mode, time and model cost (operator only). Polls while any run is
// still going.
import type { OpsAgentRef } from "@countersign/core";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import {
  duration,
  isRunGoing,
  runStatusLabel,
  runStatusTone,
  shortTime,
  usd,
} from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import {
  AgentAvatar,
  Badge,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
} from "../../ui/primitives";
import { Select } from "../agents/ui";

const STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
type RunStatus = (typeof STATUSES)[number];

export function OpsRunsScreen() {
  const { clientId } = useParams();
  const session = useSession();
  const clients = new Map(session.tenants.map((t) => [t.id, t.name]));
  const [mode, setMode] = useState<"all" | "live" | "test">("all");
  const [status, setStatus] = useState<RunStatus | "">("");
  const [picked, setPicked] = useState("");
  const client = clientId ?? picked;
  const { data, error, loading, reload } = useApi(apiRoutes.opsRuns, {
    query: {
      limit: 100,
      ...(client ? { client } : {}),
      ...(status ? { status } : {}),
      ...(mode === "all" ? {} : { mode }),
    },
  });
  usePoll(reload, data?.runs.some((r) => isRunGoing(r.status)) ?? false, 5_000);
  const agents = new Map<string, OpsAgentRef>((data?.agents ?? []).map((a) => [a.id, a]));

  return (
    <div>
      <PageHeader
        title="Runs"
        subtitle={
          clientId
            ? `Everything ${clients.get(clientId) ?? "this client"}'s agents ran, test runs included.`
            : "Runs across your clients, test runs included."
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusFilter
          value={mode}
          onChange={setMode}
          area="ops-runs-mode"
          label="Mode"
          options={[
            ["all", "All"],
            ["live", "Live"],
            ["test", "Test"],
          ]}
        />
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Select is the label's control. */}
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          Status
          <Select
            data-testid="ops-runs-status-select"
            value={status}
            onChange={(e) => setStatus(e.target.value as RunStatus | "")}
            className="h-8 w-36 text-sm"
          >
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {runStatusLabel(s)}
              </option>
            ))}
          </Select>
        </label>
        {clientId ? null : (
          // biome-ignore lint/a11y/noLabelWithoutControl: the Select is the label's control.
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            Client
            <Select
              data-testid="ops-runs-client-select"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="h-8 w-44 text-sm"
            >
              <option value="">All clients</option>
              {[...clients].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.runs.length === 0 ? <EmptyState>No runs match.</EmptyState> : null}
      {data && data.runs.length > 0 ? (
        <div className="dt dt-ana overflow-x-auto">
          <table data-testid="ops-runs">
            <thead>
              <tr className="dt-cols">
                {["Agent", "Client", "Workflow", "Status", "Started", "Took", "Cost"].map((h) => (
                  <th key={h} className={h === "Cost" ? "n" : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => {
                const a = agents.get(r.agentId);
                const name = a?.name ?? "Agent";
                return (
                  <tr key={r.id}>
                    <td>
                      <Link
                        to={`/ops/runs/${r.id}`}
                        data-testid={`ops-run-${r.id}-open`}
                        className="flex items-center gap-3 font-medium text-ink hover:underline"
                      >
                        <AgentAvatar name={name} seed={a?.slug ?? r.agentId} />
                        {name}
                      </Link>
                    </td>
                    <td className="text-ink">{clients.get(r.tenantId) ?? "—"}</td>
                    <td className="reference text-ink">{r.workflowSlug}</td>
                    <td>
                      <span className="flex items-center gap-1.5">
                        <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
                        {r.mode === "test" ? <Badge>Test</Badge> : null}
                      </span>
                    </td>
                    <td className="text-ink figures">{shortTime(r.startedAt ?? r.createdAt)}</td>
                    <td className="text-ink figures">{duration(r.startedAt, r.finishedAt)}</td>
                    <td className="n">{usd(r.costUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
