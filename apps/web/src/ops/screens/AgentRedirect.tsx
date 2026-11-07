// `/ops/agents/:id`: an agent by its id (what search and the API name) sent on to its page, which
// is addressed by slug: a template's in the Agent lab, a client agent's under its client.
import { Navigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ErrorNotice, Loading } from "../../ui/primitives";

export function opsAgentHref(agent: {
  kind: "template" | "client";
  slug: string;
  tenantId: string | null;
}): string {
  return agent.kind === "template" || !agent.tenantId
    ? `/ops/templates/${agent.slug}`
    : `/ops/clients/${agent.tenantId}/agents/${agent.slug}`;
}

export function OpsAgentRedirect() {
  const { id = "" } = useParams();
  const { data, error, reload } = useApi(apiRoutes.opsAgent, { params: { id } });
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return <Navigate to={opsAgentHref(data.agent)} replace />;
}
