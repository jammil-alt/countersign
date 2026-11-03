// `/`: the client's overview. Services are the client's active agents as the portal sees them:
// name, plain-language description and status, never bundles, instructions or cost.
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  AgentAvatar,
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";

export function OverviewScreen() {
  const { data, error, loading, reload } = useApi(apiRoutes.portalOverview);

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={`${data ? `${data.client.name}: your` : "Your"} services, what they did, and what needs you.`}
      />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_340px]">
          <section>
            <SectionLabel>Your services</SectionLabel>
            {data.services.length === 0 ? (
              <EmptyState>No services yet. Your operator sets them up for you.</EmptyState>
            ) : (
              <div data-testid="portal-services" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {data.services.map((s) => (
                  <Card key={s.id} testId={`portal-service-${s.id}`} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <Link to={`/services/${s.id}`} className="flex items-center gap-3">
                        <AgentAvatar name={s.name} seed={s.id} size="md" />
                        <span className="font-semibold text-primary hover:underline">{s.name}</span>
                      </Link>
                      <Badge tone={s.status === "active" ? "positive" : "neutral"}>
                        {s.status}
                      </Badge>
                    </div>
                    {s.description ? <p className="mt-3 text-body">{s.description}</p> : null}
                  </Card>
                ))}
              </div>
            )}
          </section>
          <section>
            <SectionLabel
              action={
                <Link to="/inbox" className="text-sm text-link underline">
                  Open inbox
                </Link>
              }
            >
              Needs you
            </SectionLabel>
            <Card className="p-4" testId="portal-needs-you">
              <p className="font-mono text-[32px] leading-none text-primary">
                {data.needsYou.inbox}
              </p>
              <p className="mt-2 text-sm text-secondary">Approvals and questions waiting</p>
            </Card>
          </section>
        </div>
      ) : null}
    </div>
  );
}
