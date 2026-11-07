// The client page's Agents tab (`/ops/clients/:clientId/agents`): the client's own agents as cards
// in the prototype's style (badge, name, what it does, its status in words, its version and the
// tools it is bound to), drafts dashed, and New agent. Each card opens the agent's page.
import { Link, useParams } from "react-router-dom";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { connectorName } from "../../inbox/change";
import { AgentBadge } from "../../ui/badges";
import { Columns, Section } from "../../ui/page";
import { Badge, buttonClass, Card, EmptyState, Loading, Tag } from "../../ui/primitives";
import { StatusChip, serviceChipState } from "../../ui/status";
import { OPS_PATHS } from "../paths";
import { summaryBadge } from "../versions";
import { ClientFrame, useClientPage } from "./ClientFrame";

const RUN_STATUS_WORDS: Record<string, string> = {
  active: "Running",
  paused: "Paused",
  retired: "Retired",
  draft: "Not started",
};

export function ClientAgentsScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame
      clientId={clientId}
      actions={
        <Link
          to={`${OPS_PATHS.client(clientId)}/agents/new`}
          className={buttonClass("primary")}
          data-testid="ops-client-new-agent"
        >
          New agent
        </Link>
      }
    >
      <Agents clientId={clientId} />
    </ClientFrame>
  );
}

function Agents({ clientId }: { clientId: string }) {
  const { data, error } = useClientPage();
  // Connector names for the cards' tool tags (never the raw ids).
  const catalog = useApi(apiRoutes.connectors);
  if (!data) return error ? null : <Loading />;
  const names = Object.fromEntries(
    (catalog.data?.connectors ?? []).map((c) => [c.id, c.name] as const),
  );
  const live = data.agents.filter((a) => a.liveVersionId !== null).length;
  return (
    <Section
      title="Agents"
      meta={`${live} live · ${data.agents.length - live} not live yet`}
      testId="ops-client-agents-section"
    >
      {data.agents.length === 0 ? (
        <EmptyState
          line="No agents yet. Fork a template into this client from Agent lab, or build one for it."
          action={{
            label: "New agent",
            to: OPS_PATHS.newAgent(clientId),
            testId: "ops-client-empty-new-agent",
          }}
        />
      ) : (
        <div data-testid="ops-client-agents">
          <Columns count={2}>
            {data.agents.map((a) => (
              <AgentCard key={a.id} clientId={clientId} agent={a} names={names} />
            ))}
          </Columns>
        </div>
      )}
    </Section>
  );
}

function AgentCard({
  clientId,
  agent,
  names,
}: {
  clientId: string;
  agent: AgentSummary;
  names: Record<string, string>;
}) {
  const badge = summaryBadge(agent);
  const connectors = Object.keys(agent.bindings);
  const origin = agent.testCopy
    ? "template test copy"
    : agent.templateId
      ? "from a template"
      : "built for this client";
  const name = agent.serviceName ?? agent.name;
  const status = agent.runStatus ?? "draft";
  return (
    <Card dashed={agent.liveVersionId === null} pad testId={`ops-agent-card-${agent.slug}`}>
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <Link
            to={`${OPS_PATHS.client(clientId)}/agents/${agent.slug}`}
            className="flex min-w-0 items-center gap-3"
          >
            <AgentBadge name={name} />
            <span className="min-w-0">
              <span className="block font-medium text-ink hover:underline">{name}</span>
              <span className="block truncate text-sm text-ink-muted">
                {[agent.role, origin].filter(Boolean).join(" · ")}
              </span>
            </span>
          </Link>
          <StatusChip state={serviceChipState(status)}>
            {RUN_STATUS_WORDS[status] ?? status}
          </StatusChip>
        </div>
        {agent.serviceDescription ? <p className="text-ink">{agent.serviceDescription}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {connectors.map((c) => (
            <Tag key={c}>{names[c] ?? connectorName(c)}</Tag>
          ))}
        </div>
      </div>
    </Card>
  );
}
