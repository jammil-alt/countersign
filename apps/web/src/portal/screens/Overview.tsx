// `/`: the client's overview. Services are the client's active agents as the portal sees them:
// name, plain-language description and status, never bundles, instructions or cost. The
// supervisor's latest account check and the open findings that need the client (docs/plan.md
// §1.28) show here too: a title and plain steps each, nothing else.
import type { PortalFinding, PortalHealth } from "@countersign/core";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { shortTime } from "../../runs/format";
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
          <section className="flex flex-col gap-6">
            {data.health.findings.length > 0 ? <Findings findings={data.health.findings} /> : null}
            <div>
              <SectionLabel>{t("overview.services")}</SectionLabel>
              {data.services.length === 0 ? (
                <EmptyState>{t("overview.noServices")}</EmptyState>
              ) : (
                <div
                  data-testid="portal-services"
                  className="grid grid-cols-1 gap-4 lg:grid-cols-2"
                >
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
            </div>
          </section>
          <section className="flex flex-col gap-6">
            <div>
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
            </div>
            {data.health.summary ? <HealthCard summary={data.health.summary} /> : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** The open findings that need the client: each one's title and plain steps, in their language. */
function Findings({ findings }: { findings: PortalFinding[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div data-testid="portal-findings">
      <SectionLabel
        action={
          <Link to="/inbox" className="ds-btn ds-btn--link text-sm">
            {t("overview.openInbox")}
          </Link>
        }
      >
        {t("overview.findings")}
      </SectionLabel>
      <div className="flex flex-col gap-3">
        {findings.map((f) => (
          <Card key={f.id} testId={`portal-finding-${f.id}`} className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h3 className="font-medium text-ink">{f.title}</h3>
              <span className="flex items-center gap-2">
                {f.remindedAt ? (
                  <Badge tone="warning">{t("overview.findingReminder")}</Badge>
                ) : null}
                <span className="text-sm text-ink-muted">
                  {shortTime(f.remindedAt ?? f.createdAt, undefined, i18n)}
                </span>
              </span>
            </div>
            {f.steps.length > 0 ? (
              <ol className="list-decimal flex flex-col gap-1 pl-5 text-ink">
                {f.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
            <p className="text-sm text-ink-muted">{t("overview.findingMarkDone")}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** The supervisor's latest daily check: good, or what needs a look, with its counts. */
function HealthCard({ summary }: { summary: NonNullable<PortalHealth["summary"]> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const good = summary.state === "good";
  return (
    <div>
      <SectionLabel>{t("overview.health")}</SectionLabel>
      <Card className="flex flex-col gap-3 p-6" testId="portal-health">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={good ? "positive" : "warning"} testId="portal-health-state">
            {good ? t("overview.healthGood") : t("overview.healthAttention")}
          </Badge>
          <span className="text-sm text-ink-muted">
            {t("overview.healthChecked", { time: shortTime(summary.checkedAt, undefined, i18n) })}
          </span>
        </span>
        <ul className="flex flex-col gap-1.5 text-sm text-ink">
          <li>
            {t("overview.healthRuns", { count: summary.runs.total })}
            {summary.runs.failed > 0
              ? ` · ${t("overview.healthFailed", { count: summary.runs.failed })}`
              : ""}
          </li>
          {summary.connections.needsAttention > 0 ? (
            <li>
              {t("overview.healthConnections", { count: summary.connections.needsAttention })}
            </li>
          ) : null}
          {summary.waiting.count > 0 ? (
            <li>{t("overview.healthWaiting", { count: summary.waiting.count })}</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
