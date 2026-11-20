// `/ops/clients/:clientId/agents/:slug/client-view` (docs/plan.md §1.163, owner 2026-11-20): what
// the client sees for one agent in their portal, inside the back office and read only. The page
// is the portal agent page's Overview drawn with the portal's own parts (../../portal/screens/
// agentParts.tsx) from the portal's own answer, which the back office reads for a client it
// serves (`opsClientAgentView`). Nothing on it acts as the client: no Pause, no Run now, no
// approving or signing, and no link into the portal; its runs open the back office's run page.
// A banner says whose view it is and links to the agent lab to change the agent.
// DECISION (§1.163): the Overview tab only, from one back-office call: the portal's other tabs
// and its pack views each ask portal routes of their own, which an operator never calls as the
// client. What waits on the client shows as a count (no item, so nothing to approve or sign).
import { Link, useLocation, useParams } from "react-router-dom";
import { isApiError } from "../../api/client";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { AgentFiguresStrip, detailState, RunRows } from "../../portal/screens/agentParts";
import { AgentBadge } from "../../ui/badges";
import { Loaded, Page, PageGrid } from "../../ui/page";
import { buttonClass, Card, EmptyState, ErrorNotice, PageHeader, Tag } from "../../ui/primitives";
import { SkeletonLine, SkeletonRows, SkeletonStats } from "../../ui/skeleton";
import { StatusChip } from "../../ui/status";
import { useOpsClients } from "../OpsLayout";
import { OPS_PATHS } from "../paths";
import { runsLink } from "../run/links";
import { plural } from "../run/words";
import { type AgentLinkState, handedOver } from "../screens/AgentPage";

/** The portal's page shows this many runs on its Overview. */
const RECENT_RUNS = 8;

/**
 * Whether the client's portal shows the agent: one of its own (not a template's test copy) that
 * has been started (active, paused or retired), as the portal's agent route answers.
 */
export function clientSeesAgent(a: Pick<AgentSummary, "testCopy" | "runStatus">): boolean {
  return !a.testCopy && ["active", "paused", "retired"].includes(a.runStatus ?? "draft");
}

/** "What the client sees": the link from the client page's agent rows and cards. */
export function ClientViewLink({
  clientId,
  agent,
  className = "text-sm text-link hover:underline",
}: {
  clientId: string;
  agent: Pick<AgentSummary, "id" | "slug" | "testCopy" | "runStatus">;
  className?: string;
}) {
  if (!clientSeesAgent(agent)) return null;
  return (
    <Link
      to={OPS_PATHS.agentClientView(clientId, agent.slug)}
      state={{ agentId: agent.id } satisfies AgentLinkState}
      className={className}
      data-testid={`ops-client-view-link-${agent.slug}`}
    >
      What the client sees
    </Link>
  );
}

export function ClientAgentViewScreen() {
  const { clientId = "", slug = "" } = useParams();
  const location = useLocation();
  const { t } = useI18n();
  const handed = handedOver(location.state, { slug, tenantId: clientId });
  // The client (its name, and the slug's agent) beside the view: a link that hands over the
  // agent's id starts both at once.
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  const row = client.data?.agents.find((a) => a.slug === slug);
  const id = handed?.id ?? row?.id;
  const view = useApi(
    apiRoutes.opsClientAgentView,
    id ? { params: { id: clientId, agentId: id } } : null,
  );
  const clients = useOpsClients();
  const clientName =
    client.data?.client.name ?? clients?.find((c) => c.id === clientId)?.name ?? null;
  const labPath = OPS_PATHS.agent(clientId, slug);
  const detail = view.data ?? null;
  const name = detail?.service.name ?? row?.serviceName ?? row?.name ?? null;
  const state = detail ? detailState(detail, t) : null;
  // The portal answers 404 for an agent it doesn't show (not started yet, or not this client's).
  const unseen =
    (isApiError(view.error) && view.error.status === 404) ||
    (client.data !== undefined && !row && !handed);
  const waiting = detail?.runsNow?.waitingOnYou ?? 0;

  return (
    <Page testId="ops-client-agent-view">
      <ClientViewBanner clientName={clientName} labPath={labPath} />
      {unseen ? (
        <EmptyState
          testId="ops-client-view-unseen"
          line={`${clientName ?? "The client"} doesn't see this agent in their portal yet. It shows there once it is started.`}
          action={{ label: "Open in the agent lab", to: labPath }}
        />
      ) : view.error ? (
        <ErrorNotice error={view.error} onRetry={view.reload} />
      ) : (
        <>
          <PageHeader
            eyebrow={
              <Link to={OPS_PATHS.client(clientId)} className="hover:underline">
                {clientName ?? "Client"}
              </Link>
            }
            leading={name !== null ? <AgentBadge name={name} seed={id ?? slug} size="lg" /> : null}
            title={name ?? <SkeletonLine width={220} size="title" />}
            badge={
              state ? (
                <span className="flex items-center gap-2">
                  <StatusChip state={state.chip.state} testId="agent-state">
                    {state.chip.label}
                  </StatusChip>
                  {state.stage ? <Tag>{state.stage}</Tag> : null}
                </span>
              ) : null
            }
            subtitle={detail?.service.description ?? undefined}
          />
          <Loaded state={view} skeleton={<SkeletonStats count={3} />}>
            {(data) => (
              <AgentFiguresStrip
                id={data.service.id}
                detail={data}
                kpis={data.kpis ?? []}
                perDay={undefined}
                waiting={waiting}
                linked={false}
              />
            )}
          </Loaded>
          <PageGrid
            rail={
              <WaitingOnThem agentId={id ?? null} name={name} waiting={detail ? waiting : null} />
            }
          >
            <Card titleAbove title={t("agent.recentRuns")} testId="agent-recent">
              <Loaded state={view} skeleton={<SkeletonRows rows={4} columns={2} />}>
                {(data) =>
                  data.recentRuns.length === 0 ? (
                    <EmptyState compact icon="report" line={t("service.noRuns")} />
                  ) : (
                    <RunRows
                      runs={data.recentRuns.slice(0, RECENT_RUNS)}
                      prefix="agent-recent-run"
                      href={(runId) => `${OPS_PATHS.runs}/${runId}`}
                    />
                  )
                }
              </Loaded>
            </Card>
          </PageGrid>
        </>
      )}
    </Page>
  );
}

/** Whose view this is, that it is read only, and where the agent is changed. */
function ClientViewBanner({ clientName, labPath }: { clientName: string | null; labPath: string }) {
  return (
    <div
      className="ds-card ui-accent ui-accent--left mb-6 flex flex-wrap items-center justify-between gap-3 px-5 py-4"
      data-tone="slate"
      role="note"
      data-testid="ops-client-view-banner"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-ink">What {clientName ?? "the client"} sees</span>
        <span className="text-sm text-ink-muted">
          This agent's page in their portal, read only. Nothing here acts for them.
        </span>
      </span>
      <Link
        to={labPath}
        className={buttonClass("secondary", undefined, "sm")}
        data-testid="ops-client-view-edit"
      >
        Edit in the agent lab
      </Link>
    </div>
  );
}

/**
 * The portal page's rail lists what waits on the client from this agent, to approve or answer
 * there. Here only how many runs wait on them, never the items' buttons; they open the back
 * office's runs, filtered to this agent.
 */
function WaitingOnThem({
  agentId,
  name,
  waiting,
}: {
  agentId: string | null;
  name: string | null;
  waiting: number | null;
}) {
  const { t } = useI18n();
  return (
    <Card titleAbove title={t("agent.actionItems")} testId="agent-actions">
      {waiting === null ? (
        <SkeletonRows rows={2} columns={1} />
      ) : waiting === 0 ? (
        <EmptyState
          compact
          tone="done"
          line={name ? t("agent.noActionItems", { name }) : t("inbox.emptyOpen")}
        />
      ) : (
        <div
          className="ui-accent ui-accent--left flex flex-col items-start gap-2 px-6 py-4"
          data-tone="signal"
          data-testid="ops-client-view-waiting"
        >
          <StatusChip state="waiting">
            {`${plural(waiting, "run", "runs")} waiting on them`}
          </StatusChip>
          {agentId ? (
            <Link
              to={runsLink({ statuses: ["waiting"], mode: "live", agents: [agentId] })}
              className="text-sm text-link hover:underline"
            >
              See them in Runs
            </Link>
          ) : null}
        </div>
      )}
    </Card>
  );
}
