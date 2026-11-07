// `/ops/inbox`, Escalations (ARCHITECTURE §11, §15; not in the prototype, drafted in its style):
// the items for us (delegated approvals, escalations, budget hits, test runs' questions, and every
// item of the Sandbox, which has no client people) and, under "All clients", every item in the
// clients served. We resolve only what the server marks as ours; a client's own approvals say who
// they wait on. Resolving resumes the waiting run; an approval can be taken back inside its undo
// window (`/api/ops/inbox/:id/undo`).
import type { OpsAgentRef } from "@countersign/core";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { InboxCard, outcomeText } from "../../inbox/InboxCard";
import { OPEN_RESOLVED, StatusFilter } from "../../inbox/StatusFilter";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { Select } from "../../ui/forms";
import { Loaded, Page, Section } from "../../ui/page";
import { EmptyState, PageHeader } from "../../ui/primitives";
import { plural } from "../run/words";

type Item = ResponseOf<typeof apiRoutes.opsInbox>["items"][number];

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

/** Inside its undo window: approved, and the run not told yet. */
function undoable(item: Pick<Item, "deliverAfter">): boolean {
  return !!item.deliverAfter && new Date(item.deliverAfter).getTime() > Date.now();
}

export function OpsInboxScreen() {
  const api = useApiClient();
  const session = useSession();
  // A run page's "See it in Escalations" opens on its client, everything waiting there.
  const [params] = useSearchParams();
  const [assigned, setAssigned] = useState<"operator" | "all">(
    params.get("assigned") === "all" ? "all" : "operator",
  );
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [client, setClient] = useState(params.get("client") ?? "");
  // What we just resolved, kept on screen with Undo while its window lasts.
  const [recent, setRecent] = useState<Item[]>([]);
  const state = useApi(apiRoutes.opsInbox, {
    query: { assigned, status, ...(client ? { client } : {}) },
  });
  const { data, loading, reload } = state;
  usePoll(reload, status === "open", 20_000, loading);

  const clients = new Map(session.tenants.map((t) => [t.id, t.name]));
  const agents = new Map<string, OpsAgentRef>((data?.agents ?? []).map((a) => [a.id, a]));
  const recentIds = new Set(recent.map((i) => i.id));
  const items = (data?.items ?? []).filter((i) => !recentIds.has(i.id));
  const mineOpen = items.filter((i) => i.status === "open" && operatorMayResolve(i)).length;

  const card = (item: Item) => {
    const agent = item.agentId ? agents.get(item.agentId) : undefined;
    const mine = operatorMayResolve(item);
    const resolution = (item.resolution ?? {}) as { approved?: unknown; decision?: unknown };
    const approved =
      typeof resolution.approved === "boolean"
        ? resolution.approved
        : resolution.decision === undefined
          ? null
          : resolution.decision === "approve";
    const byUs = item.resolvedBy === session.user.id;
    const by = byUs
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
                const out = await api.call(apiRoutes.opsResolveInbox, {
                  params: { id: item.id },
                  body,
                });
                if (undoable(out.item)) setRecent((r) => [out.item, ...r]);
                reload();
              }
            : null
        }
        onUndo={
          item.status === "resolved" && byUs && undoable(item)
            ? async () => {
                await api.call(apiRoutes.opsUndoInbox, { params: { id: item.id } });
                setRecent((r) => r.filter((i) => i.id !== item.id));
                reload();
              }
            : null
        }
      />
    );
  };

  return (
    <Page testId="ops-escalations">
      <PageHeader
        title="Escalations"
        subtitle={
          data && status === "open" && assigned === "operator"
            ? mineOpen === 0
              ? "Nothing is waiting on us."
              : `${plural(mineOpen, "item waits", "items wait")} on us. Approvals delegated to us, escalations and test runs' questions.`
            : "Approvals delegated to us, escalations and test runs' questions; and, across your clients, everything waiting on someone."
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter
          value={assigned}
          onChange={setAssigned}
          area="ops-inbox-assigned"
          label="Whose items"
          options={[
            ["operator", "For us"],
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
        <Select
          aria-label="Client"
          data-testid="ops-inbox-client-select"
          value={client}
          onChange={(e) => setClient(e.target.value)}
          className="h-8 w-48 text-sm"
        >
          <option value="">All clients</option>
          {[...clients].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      </div>
      {recent.length > 0 ? (
        <Section title="Just resolved" meta="You can undo an approval for a short while.">
          <div className="flex flex-col gap-4" data-testid="ops-inbox-recent">
            {recent.map(card)}
          </div>
        </Section>
      ) : null}
      <Loaded state={state}>
        {() =>
          items.length === 0 ? (
            <EmptyState>
              {status === "open"
                ? assigned === "operator"
                  ? "Nothing is waiting on us. Approvals delegated to us and escalations show here."
                  : "Nothing is waiting in your clients' inboxes."
                : "Nothing resolved yet."}
            </EmptyState>
          ) : (
            <div data-testid="ops-inbox-list" className="flex flex-col gap-4">
              {items.map(card)}
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}
