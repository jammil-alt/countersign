import { useLocation, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ErrorNotice } from "../../ui/primitives";
import { handedOver, useResolvedId } from "../screens/AgentPage";
import { AgentFrameSkeleton, AgentScreen } from "./AgentScreen";

export function TemplatePage() {
  const { slug = "" } = useParams();
  const location = useLocation();
  const base = `/ops/templates/${slug}`;
  // A page that has the template already (the lab, the `/ops/agents/:id` hop) hands it over, so
  // the page skips looking it up by slug (the owner's review: slow agent pages).
  const handed = handedOver(location.state, { slug, tenantId: null });
  const kept = useResolvedId(base, handed?.id);
  const given = handed ?? (kept ? { id: kept } : null);
  const list = useApi(apiRoutes.opsTemplates, given ? null : { query: { include: "discarded" } });
  const id = given?.id ?? list.data?.templates.find((t) => t.slug === slug)?.id;
  if (!id) {
    if (list.error) {
      return (
        <AgentFrameSkeleton
          base={base}
          error={<ErrorNotice error={list.error} onRetry={list.reload} />}
        />
      );
    }
    if (list.data) return <ErrorNotice error={new Error(`No template "${slug}".`)} />;
    return <AgentFrameSkeleton base={base} />;
  }
  return <AgentScreen agentId={id} base={base} initial={given?.detail} />;
}
