// `/ops/clients/:clientId`: the client's home in the back office (design screen 1): its agents as
// cards with the live/draft badge. KPIs, "needs you" and tool updates arrive with runs and inbox.
import { Link, useParams } from "react-router-dom";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  AgentAvatar,
  Badge,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  Tag,
} from "../../ui/primitives";
import { summaryBadge } from "../versions";
import { ClientApproverRules } from "./ClientApproverRules";
import { ClientBillingSection } from "./ClientBilling";
import { ClientFeedbackSetting } from "./ClientFeedbackSetting";
import { ClientTabs } from "./ClientKnowledge";
import { ClientLanguageSetting } from "./ClientLanguageSetting";

export function ClientDetailScreen() {
  const { clientId = "" } = useParams();
  const { data, error, loading, reload } = useApi(apiRoutes.opsClient, {
    params: { id: clientId },
  });

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;

  const live = data.agents.filter((a) => a.liveVersionId !== null).length;
  return (
    <div>
      <PageHeader
        title={data.client.name}
        subtitle={`${live} of ${data.agents.length} agents live · ${data.client.timezone}`}
        actions={
          <Link
            to={`/ops/clients/${data.client.id}/messaging`}
            className={buttonClass("secondary")}
            data-testid="ops-client-messaging"
          >
            Texts and contacts
          </Link>
        }
      />
      <ClientTabs clientId={data.client.id} />
      <SectionLabel>Agents</SectionLabel>
      {data.agents.length === 0 ? (
        <EmptyState>No agents yet. Fork a template into this client to start.</EmptyState>
      ) : (
        <div data-testid="ops-client-agents" className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {data.agents.map((a) => (
            <AgentCard key={a.id} clientId={data.client.id} agent={a} />
          ))}
        </div>
      )}
      <ClientLanguageSetting
        clientId={data.client.id}
        settings={data.client.settings}
        onSaved={reload}
      />
      <ClientApproverRules clientId={data.client.id} />
      <ClientBillingSection clientId={data.client.id} />
      <ClientFeedbackSetting clientId={data.client.id} />
    </div>
  );
}

function AgentCard({ clientId, agent }: { clientId: string; agent: AgentSummary }) {
  const isDraftOnly = agent.liveVersionId === null;
  const badge = summaryBadge(agent);
  const connectors = Object.keys(agent.bindings);
  const origin = agent.testCopy
    ? "template test copy"
    : agent.templateId
      ? "from a template"
      : null;
  const meta = [agent.role, origin, agent.runStatus].filter(Boolean);

  return (
    <Card dashed={isDraftOnly} testId={`ops-agent-card-${agent.slug}`} className="p-5">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={`/ops/clients/${clientId}/agents/${agent.slug}`}
          className="flex min-w-0 items-center gap-3"
        >
          <AgentAvatar name={agent.name} seed={agent.slug} size="md" />
          <span className="min-w-0">
            <span className="block font-medium text-ink hover:underline">
              {agent.serviceName ?? agent.name}
            </span>
            <span className="block truncate text-sm text-ink-muted">{meta.join(" · ")}</span>
          </span>
        </Link>
        <div className="flex shrink-0 gap-1.5">
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
      </div>
      {agent.serviceDescription ? (
        <p className="mt-3 text-ink">{agent.serviceDescription}</p>
      ) : null}
      {connectors.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {connectors.map((c) => (
            <Tag key={c}>{c}</Tag>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
