// `/ops/inbox` (ARCHITECTURE §11, §15): the operator inbox (items assigned to the operator:
// delegated approvals, escalations, budget hits, test runs' questions, and every item of the
// Sandbox, which has no client people) and, under "All clients",
// every item in the clients served. The operator resolves only what is theirs; a client's own
// approvals show who they wait on. Resolving resumes the waiting run.
import type { OpsAgentRef } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { InboxCard, outcomeText } from "../../inbox/InboxCard";
import { OPEN_RESOLVED, StatusFilter } from "../../inbox/StatusFilter";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { EmptyState, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";
import { Select } from "../agents/ui";

const ROLE_WORDS: Record<string, string> = {
  client_admin: "the client admin",
  client_user: "the client's team",
  operator: "the operator",
};

/**
 * Whether the signed-in operator may resolve an item: the server decides (`resolvableByOperator`,
 * packages/agents' mayResolve), including every item of the Sandbox client.
 */
export function operatorMayResolve(item: { resolvableByOperator: boolean }): boolean {
  return item.resolvableByOperator;
}

export function OpsInboxScreen() {
  const api = useApiClient();
  const session = useSession();
  const [assigned, setAssigned] = useState<"operator" | "all">("operator");
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [client, setClient] = useState("");
  const { data, error, loading, reload } = useApi(apiRoutes.opsInbox, {
    query: { assigned, status, ...(client ? { client } : {}) },
  });
  usePoll(reload, status === "open", 20_000);

  const clients = new Map(session.tenants.map((t) => [t.id, t.name]));
  const agents = new Map<string, OpsAgentRef>((data?.agents ?? []).map((a) => [a.id, a]));

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Inbox"
        subtitle="Approvals delegated to you, escalations and test runs' questions; and, across your clients, everything waiting on someone."
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusFilter
          value={assigned}
          onChange={setAssigned}
          area="ops-inbox-assigned"
          label="Whose items"
          options={[
            ["operator", "Assigned to you"],
            ["all", "All clients"],
          ]}
        />
        <StatusFilter
          value={status}
          onChange={setStatus}
          area="ops-inbox"
          label="Status"
          options={OPEN_RESOLVED}
        />
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Select is the label's control. */}
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          Client
          <Select
            data-testid="ops-inbox-client-select"
            value={client}
            onChange={(e) => setClient(e.target.value)}
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
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.items.length === 0 ? (
        <EmptyState>
          {status === "open"
            ? assigned === "operator"
              ? "Nothing is waiting on you."
              : "Nothing is waiting in your clients' inboxes."
            : "Nothing resolved yet."}
        </EmptyState>
      ) : null}
      <div data-testid="ops-inbox-list" className="flex flex-col gap-4">
        {data?.items.map((item) => {
          const agent = item.agentId ? agents.get(item.agentId) : undefined;
          const mine = operatorMayResolve(item);
          const resolution = (item.resolution ?? {}) as { approved?: unknown; decision?: unknown };
          const approved =
            typeof resolution.approved === "boolean"
              ? resolution.approved
              : resolution.decision === undefined
                ? null
                : resolution.decision === "approve";
          const by =
            item.resolvedBy === session.user.id
              ? "you"
              : item.resolvedBy
                ? (ROLE_WORDS[item.assigneeRole ?? "client_admin"] ?? null)
                : null;
          return (
            <InboxCard
              key={item.id}
              item={item}
              context={[
                agent ? (agent.serviceName ?? agent.name) : null,
                clients.get(item.tenantId) ?? null,
                item.payload.testRun === true ? "test run" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              showToolId
              runHref={item.runId ? `/ops/runs/${item.runId}` : null}
              recordHref={(id) => `/ops/clients/${item.tenantId}/records/${id}`}
              outcome={item.status === "resolved" ? outcomeText(item.kind, approved, by) : null}
              waitingOn={
                mine
                  ? null
                  : `Waiting on ${
                      item.assigneeUserId
                        ? "a named person at the client"
                        : (ROLE_WORDS[item.assigneeRole ?? "client_admin"] ?? "the client")
                    }. Only they can answer it.`
              }
              onResolve={
                item.status === "open" && mine
                  ? async (body) => {
                      await api.call(apiRoutes.opsResolveInbox, { params: { id: item.id }, body });
                      reload();
                    }
                  : null
              }
            />
          );
        })}
      </div>
    </div>
  );
}
