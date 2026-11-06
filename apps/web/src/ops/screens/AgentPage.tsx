// `/ops/clients/:clientId/agents/:slug`: a client agent (design screen 7). Agents are addressed by
// id in the API (ARCHITECTURE §14) and by slug in the URL, so the page finds the id in the client's
// agent list first; the page itself is the agent screen shared with templates.
import { useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ErrorNotice, Loading } from "../../ui/primitives";
import { AgentScreen } from "../agents/AgentScreen";

export function AgentPage() {
  const { clientId = "", slug = "" } = useParams();
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  // Discarded drafts leave the client's lists but still open by address (to restore them).
  const agents = useApi(apiRoutes.opsClientAgents, {
    params: { id: clientId },
    query: { include: "discarded" },
  });
  const summary = agents.data?.agents.find((a) => a.slug === slug);

  if (client.error) return <ErrorNotice error={client.error} onRetry={client.reload} />;
  if (agents.error) return <ErrorNotice error={agents.error} onRetry={agents.reload} />;
  if (!client.data || !agents.data) return <Loading />;
  if (!summary) {
    return <ErrorNotice error={new Error(`This client has no agent "${slug}".`)} />;
  }
  return (
    <AgentScreen
      agentId={summary.id}
      base={`/ops/clients/${clientId}/agents/${slug}`}
      clientName={client.data.client.name}
      connections={client.data.connections}
      members={client.data.members}
    />
  );
}
