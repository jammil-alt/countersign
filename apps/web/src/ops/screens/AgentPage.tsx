// `/ops/clients/:clientId/agents/:slug`: a client agent (design screen 7). Agents are addressed by
// id in the API (ARCHITECTURE §14) and by slug in the URL, so the page finds the id in the client's
// agent list first; the page itself is the agent screen shared with templates.
//
// The owner's review: agent pages took 3+ seconds. The frame (bar and tabs) shows at once; the
// client's details (name, connections, people) load beside the agent instead of before it; and a
// page that already has the agent (the `/ops/agents/:id` hop, the lab) hands it over in the
// navigation's state, so no lookup by slug and no second wait.
import { useRef } from "react";
import { useLocation, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { AgentHuesProvider } from "../../ui/badges";
import { ErrorNotice } from "../../ui/primitives";
import { type AgentDetail, AgentFrameSkeleton, AgentScreen } from "../agents/AgentScreen";
import { useOpsClients } from "../OpsLayout";

/** What a page that links to an agent may hand over: its id, or the whole agent it has loaded. */
export interface AgentLinkState {
  agentId?: string;
  agent?: AgentDetail;
}

/**
 * The agent id this page resolved for an address, kept across its tabs: a tab's link carries no
 * state, and the page must not drop back to its skeleton to look the agent up again.
 */
export function useResolvedId(key: string, id: string | undefined): string | undefined {
  const ref = useRef<{ key: string; id: string } | null>(null);
  if (id) ref.current = { key, id };
  return id ?? (ref.current?.key === key ? ref.current.id : undefined);
}

/** The handed-over agent, when it is the one this address names. */
export function handedOver(
  state: unknown,
  match: { slug: string; tenantId: string | null },
): { id: string; detail?: AgentDetail | undefined } | null {
  const s = (state ?? {}) as AgentLinkState;
  const a = s.agent?.agent;
  if (a && a.slug === match.slug && a.tenantId === match.tenantId) {
    return { id: a.id, detail: s.agent };
  }
  return typeof s.agentId === "string" ? { id: s.agentId } : null;
}

export function AgentPage() {
  const { clientId = "", slug = "" } = useParams();
  const location = useLocation();
  const base = `/ops/clients/${clientId}/agents/${slug}`;
  const handed = handedOver(location.state, { slug, tenantId: clientId });
  const kept = useResolvedId(base, handed?.id);
  const given = handed ?? (kept ? { id: kept } : null);
  const clientNames = useOpsClients() ?? [];
  // In parallel: the client (for the bar and the bindings) never holds the agent back.
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  // The client's agents name the slug's id and give the bar its row (1.4): the agent's name, kind
  // and status show after this first call, before the agent itself.
  const row = client.data?.agents.find((a) => a.slug === slug);
  // DECISION (1.4): the client's own list is asked first, and the list with discarded drafts only
  // when the slug isn't in it (or the client didn't load): a discarded draft still opens by its
  // address, one call later, and every other agent page asks one call fewer.
  const lookUp = !given && (client.error !== undefined || (client.data !== undefined && !row));
  const agents = useApi(
    apiRoutes.opsClientAgents,
    lookUp ? { params: { id: clientId }, query: { include: "discarded" } } : null,
  );
  const id = given?.id ?? row?.id ?? agents.data?.agents.find((a) => a.slug === slug)?.id;
  const clientName = client.data?.client.name ?? clientNames.find((c) => c.id === clientId)?.name;

  if (!id) {
    if (agents.error) {
      return (
        <AgentFrameSkeleton
          base={base}
          clientName={clientName}
          error={<ErrorNotice error={agents.error} onRetry={agents.reload} />}
        />
      );
    }
    if (agents.data) {
      return <ErrorNotice error={new Error(`This client has no agent "${slug}".`)} />;
    }
    return <AgentFrameSkeleton base={base} clientName={clientName} />;
  }
  return (
    <AgentHuesProvider agents={client.data?.agents ?? []}>
      {client.error ? (
        <div className="mb-4">
          <ErrorNotice error={client.error} onRetry={client.reload} />
        </div>
      ) : null}
      <AgentScreen
        agentId={id}
        base={base}
        clientName={clientName}
        summary={row ?? agents.data?.agents.find((a) => a.id === id)}
        connections={client.data?.connections ?? []}
        members={client.data?.members ?? []}
        initial={given?.detail}
      />
    </AgentHuesProvider>
  );
}
