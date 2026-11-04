// `/`: the client's overview. Services are the client's active agents as the portal sees them:
// name, plain-language description and status, never bundles, instructions or cost.
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
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

const SERVICE_STATUS: Record<string, PlainKey> = {
  active: "service.status.active",
  paused: "service.status.paused",
  draft: "service.status.draft",
  retired: "service.status.retired",
};

export function OverviewScreen() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi(apiRoutes.portalOverview);
  const status = (s: string) => {
    const key = SERVICE_STATUS[s];
    return key ? t(key) : s.charAt(0).toUpperCase() + s.slice(1);
  };

  return (
    <div>
      <PageHeader
        title={t("overview.title")}
        subtitle={
          data
            ? t("overview.subtitleWithClient", { client: data.client.name })
            : t("overview.subtitle")
        }
      />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_340px]">
          <section>
            <SectionLabel>{t("overview.services")}</SectionLabel>
            {data.services.length === 0 ? (
              <EmptyState>{t("overview.noServices")}</EmptyState>
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
                        {status(s.status)}
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
                  {t("overview.openInbox")}
                </Link>
              }
            >
              {t("overview.needsYou")}
            </SectionLabel>
            {/* The Mezonas StatCard: one number, its unit, and what waits on you. */}
            <Card className="flex flex-col gap-3 p-6" testId="portal-needs-you">
              <span className="flex items-baseline gap-2">
                <span className="text-[30px] leading-[1.15] font-medium text-ink figures">
                  {data.needsYou.inbox}
                </span>
                <span className="ds-help text-sm">
                  {t("overview.inboxItems", { count: data.needsYou.inbox })}
                </span>
              </span>
              {data.needsYou.inbox > 0 ? (
                <span>
                  <Badge tone="warning">{t("common.waitingOnYou")}</Badge>
                </span>
              ) : null}
              <span className="flex flex-col gap-1.5 text-sm text-ink">
                <span className="flex items-center gap-2">
                  <Icon name="sign" className="text-ink-muted" />
                  {t("overview.changesWait")}
                </span>
                <span className="flex items-center gap-2">
                  <Icon name="message" className="text-ink-muted" />
                  {t("overview.questionsWait")}
                </span>
              </span>
            </Card>
          </section>
        </div>
      ) : null}
    </div>
  );
}
