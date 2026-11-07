// `/ops/agents/:id`: an agent by its id (what search and the API name) sent on to its page, which
// is addressed by slug: a template's in the Agent lab, a client agent's under its client. The
// agent it loaded travels with the redirect, so its page shows at once (the owner's review: agent
// pages took 3+ seconds and then redirected).
import { Navigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ErrorNotice } from "../../ui/primitives";
import { AgentFrameSkeleton } from "../agents/AgentScreen";
import type { AgentLinkState } from "./AgentPage";

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
  const base = `/ops/agents/${id}`;
  if (error) {
    return (
      <AgentFrameSkeleton
        base={base}
        tabs={false}
        error={<ErrorNotice error={error} onRetry={reload} />}
      />
    );
  }
  if (!data) return <AgentFrameSkeleton base={base} tabs={false} />;
  const state: AgentLinkState = { agent: data };
  return <Navigate to={opsAgentHref(data.agent)} replace state={state} />;
}
