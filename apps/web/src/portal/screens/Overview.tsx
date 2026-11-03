// `/`: the client's overview. Services are the client's active agents as the portal sees them:
// name, plain-language description and status, never bundles, instructions or cost.
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Icon } from "../../ui/icons";
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
              <EmptyState>No services yet. We set them up with you, and they show here.</EmptyState>
            ) : (
              <div data-testid="portal-services" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {data.services.map((s) => (
                  <Card key={s.id} testId={`portal-service-${s.id}`} className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <Link to={`/services/${s.id}`} className="flex items-center gap-3">
                        <AgentAvatar name={s.name} seed={s.id} size="md" />
                        <span className="font-medium text-ink hover:underline">{s.name}</span>
                      </Link>
                      <Badge tone={s.status === "active" ? "positive" : "neutral"}>
                        {s.status.charAt(0).toUpperCase() + s.status.slice(1)}
                      </Badge>
                    </div>
                    {s.description ? <p className="mt-3 text-ink">{s.description}</p> : null}
                  </Card>
                ))}
              </div>
            )}
          </section>
          <section>
            <SectionLabel
              action={
                <Link to="/inbox" className="ds-btn ds-btn--link text-sm">
                  Open inbox
                </Link>
              }
            >
              Needs you
            </SectionLabel>
            {/* The Mezonas StatCard: one number, its unit, and what waits on you. */}
            <Card className="flex flex-col gap-3 p-6" testId="portal-needs-you">
              <span className="flex items-baseline gap-2">
                <span className="text-[30px] leading-[1.15] font-medium text-ink figures">
                  {data.needsYou.inbox}
                </span>
                <span className="ds-help text-sm">
                  {data.needsYou.inbox === 1 ? "item" : "items"} in your inbox
                </span>
              </span>
              {data.needsYou.inbox > 0 ? (
                <span>
                  <Badge tone="warning">Waiting on you</Badge>
                </span>
              ) : null}
              <span className="flex flex-col gap-1.5 text-sm text-ink">
                <span className="flex items-center gap-2">
                  <Icon name="sign" className="text-ink-muted" />
                  Changes to your tools wait for you to sign
                </span>
                <span className="flex items-center gap-2">
                  <Icon name="message" className="text-ink-muted" />
                  Questions wait for your answer
                </span>
              </span>
            </Card>
          </section>
        </div>
      ) : null}
    </div>
  );
}
