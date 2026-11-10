// One agent page for templates and client agents (docs/ui-plan.md "Agent page (back office)", in
// the style of the prototype's `#O6-Builder` agent bar): the agent's bar with its versions, which
// agent it is (a template, or whose copy of which template), Test run and Publish, then five tabs
// (the owner's review): Overview, Workflow (its triggers first, then the builder), Runs, Versions
// (a client agent's run status and go-live stage, its history, and the test bench: test before you
// publish) and Settings, split into Access (applies at once, logged) and Definition (a new draft
// version). The old Triggers and Tests addresses open their new homes. `/revise` asks the Builder
// for a new draft. `?version=N` shows an older version on the bundle tabs.
import { type AnyAgentBundle, holdsProcess } from "@countersign/core";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useMatch,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { OpsChannelsSection, OpsPeopleSection } from "../../people/PeoplePanel";
import { HeaderSwitcher } from "../../shell/HeaderSwitcher";
import { AgentBadge } from "../../ui/badges";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
  Tabs,
} from "../../ui/primitives";
import { StatusChip, serviceChipState } from "../../ui/status";
import type { Member } from "../builder/Inspector";
import { OPS_PATHS } from "../paths";
import { TriggersPanel } from "../triggers/TriggersScreen";
import { liveAndDraft, parseAnyBundle, versionBadges } from "../versions";
import { workflowStats } from "../workflow/describe";
import { StepList } from "../workflow/StepList";
import { ReviseTab } from "./BuilderParts";
import { DefinitionEditor, type SaveResult } from "./DefinitionEditor";
import { canDiscard, DiscardButton, DiscardedNotice } from "./DiscardDraft";
import { AgentLineage, agentKindBadge } from "./Lineage";
import { OperationPanel, ServicePanel } from "./OperationPanel";
import { LatestRuns, OverviewTab } from "./OverviewTab";
import { PricePanel } from "./PricePanel";
import { TestsTab } from "./TestsTab";
import { detailMessages, errorText, Notice, notifyAgentsChanged, plural, useAction } from "./ui";
import { VersionsTab } from "./VersionsTab";

type Connection = ResponseOf<typeof apiRoutes.opsClient>["connections"][number];
export type AgentDetail = ResponseOf<typeof apiRoutes.opsAgent>;

// The builder (with drag and drop) is its own chunk inside /ops, fetched when a workflow opens.
const WorkflowBuilder = lazy(() => import("../builder/WorkflowBuilder"));

// An agent's own status (switched on, paused…), not a run's: "Active", never "Running", so it
// can't be read as a run's status (the owner's decision 1).
const RUN_STATUS_WORDS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  retired: "Retired",
  draft: "Not started",
};

/** The page's tabs; the Workflow tab opens the builder on `workflow` (its first workflow). */
function AgentTabs({
  base,
  keep,
  workflow,
  versions,
  workflowActive,
}: {
  base: string;
  keep: string;
  workflow: string | null;
  versions: number | null;
  workflowActive: boolean;
}) {
  return (
    <Tabs
      items={[
        { to: `${base}${keep}`, label: "Overview", end: true },
        {
          to: workflow ? `${base}/workflows/${workflow}` : `${base}/workflow`,
          label: "Workflow",
          active: workflowActive,
        },
        { to: `${base}/runs${keep}`, label: "Runs" },
        {
          to: `${base}/versions${keep}`,
          label: "Versions",
          ...(versions === null ? {} : { count: versions }),
        },
        { to: `${base}/settings`, label: "Settings" },
      ]}
    />
  );
}

/**
 * The page's frame while the agent loads (the owner's review: pages hung on "Loading…"): the bar's
 * place and the tabs at once, so the page doesn't jump when the agent arrives.
 */
export function AgentFrameSkeleton({
  base,
  error,
  tabs = true,
}: {
  base: string;
  error?: ReactNode;
  /** False while the page's own address isn't known yet (`/ops/agents/:id`). */
  tabs?: boolean;
}) {
  const workflowTab = useMatch(`${base}/workflow`);
  const builder = useMatch(`${base}/workflows/*`);
  const workflowActive = workflowTab !== null || builder !== null;
  return (
    <div className="flex flex-col gap-6" data-testid="agent-skeleton">
      <Card>
        <div className="flex items-start gap-4 px-6 pt-5 pb-1" aria-hidden>
          <span className="ds-avatar ds-avatar--lg bg-surface-subtle" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <span className="h-6 w-56 max-w-full rounded-sm bg-surface-subtle" />
            <span className="h-4 w-80 max-w-full rounded-sm bg-surface-subtle" />
          </div>
        </div>
        {tabs ? (
          <div className="px-6 [&>nav]:border-b-0">
            <AgentTabs
              base={base}
              keep=""
              workflow={null}
              versions={null}
              workflowActive={workflowActive}
            />
          </div>
        ) : (
          <div className="h-4" />
        )}
      </Card>
      {error ?? <Loading label="Loading the agent…" />}
    </div>
  );
}

export function AgentScreen({
  agentId,
  base,
  clientName,
  connections = [],
  members = [],
  initial,
}: {
  agentId: string;
  /** The page's URL: `/ops/clients/<id>/agents/<slug>` or `/ops/templates/<slug>`. */
  base: string;
  /** A client agent's client, for its bar. */
  clientName?: string | undefined;
  /** A client agent's client's connections, for its bindings. */
  connections?: readonly Connection[];
  /** A client agent's client's people, for approvers and assignees. */
  members?: readonly Member[];
  /** The agent as a page that sent here had it already: shown while it is fetched again. */
  initial?: AgentDetail | undefined;
}) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const builder = useMatch(`${base}/workflows/:workflow`);
  const workflowTab = useMatch(`${base}/workflow`);
  const agent = useApi(apiRoutes.opsAgent, { params: { id: agentId } });
  const data = agent.data ?? (initial?.agent.id === agentId ? initial : undefined);
  const skills = useApi(apiRoutes.opsAgentSkills, { params: { id: agentId } });
  // A client agent's template: its name and versions, for the bar and the Versions tab.
  const templateId = data?.agent.kind === "client" ? data.agent.templateId : null;
  const template = useApi(apiRoutes.opsAgent, templateId ? { params: { id: templateId } } : null);

  // `?version=N` shows an older version; live and latest come with the agent, others are fetched.
  const requestedNumber = Number.parseInt(search.get("version") ?? "", 10);
  const requested = Number.isNaN(requestedNumber)
    ? undefined
    : data?.versions.find((v) => v.version === requestedNumber);
  const inHand = requested
    ? [data?.live, data?.latest].find((d) => d?.id === requested.id)
    : undefined;
  const fetched = useApi(
    apiRoutes.opsAgentVersion,
    requested && !inHand ? { params: { id: agentId, vid: requested.id } } : null,
  );
  // A trigger added above the builder is a new draft the builder didn't make: once the agent has
  // reloaded with it, the builder opens afresh on it (else its next save would drop the trigger).
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [builderEpoch, setBuilderEpoch] = useState(0);
  const latestId = data?.latest?.id ?? null;
  useEffect(() => {
    if (awaiting && latestId === awaiting) {
      setAwaiting(null);
      setBuilderEpoch((n) => n + 1);
    }
  }, [awaiting, latestId]);

  if (!data) {
    return (
      <AgentFrameSkeleton
        base={base}
        error={agent.error ? <ErrorNotice error={agent.error} onRetry={agent.reload} /> : undefined}
      />
    );
  }

  const { agent: view, versions } = data;
  const { live, draft } = liveAndDraft(view, versions);
  const shown: VersionDetail | null = requested
    ? (inHand ?? fetched.data?.version ?? null)
    : (data.live ?? data.latest);
  const parsed = shown ? parseAnyBundle(shown) : null;
  const bundle = parsed?.ok ? parsed.bundle : null;
  const liveParsed = data.live ? parseAnyBundle(data.live) : null;
  const liveBundle = liveParsed?.ok ? liveParsed.bundle : null;

  const keep = search.toString() ? `?${search.toString()}` : "";
  const reload = () => {
    agent.reload();
    notifyAgentsChanged();
  };

  // What the bundle tabs show when there is no bundle to read.
  const blocked: ReactNode = fetched.error ? (
    <ErrorNotice error={fetched.error} onRetry={fetched.reload} />
  ) : requested && !shown ? (
    <Loading />
  ) : !shown ? (
    <EmptyState>This agent has no versions yet.</EmptyState>
  ) : parsed && !parsed.ok ? (
    <ErrorNotice error={new Error(parsed.message)} />
  ) : null;

  // The builder edits the latest version (draft or live), like the definition editor. R8: every
  // tab reads a version that holds v4 processes too (what the builder saves, and the templates'
  // v4 versions and their forks).
  const latestAnyParsed = data.latest ? parseAnyBundle(data.latest) : null;
  const latestAny = latestAnyParsed?.ok ? latestAnyParsed.bundle : null;
  const builderStart = latestAny?.workflows[0]?.slug ?? "main";
  const isClient = view.kind === "client";
  const tabs = (
    <AgentTabs
      base={base}
      keep={keep}
      workflow={builderStart}
      versions={versions.length}
      workflowActive={builder !== null || workflowTab !== null}
    />
  );
  const lineage = (
    <AgentLineage view={view} detail={data} clientName={clientName} template={template} />
  );

  if (builder) {
    const latest = data.latest;
    if (!latest || !latestAny) {
      return (
        <div>
          <AgentBar
            view={view}
            clientName={clientName}
            bundle={null}
            live={live}
            draft={draft}
            lineage={lineage}
          >
            {tabs}
          </AgentBar>
          <div className="pt-6">
            {latestAnyParsed && !latestAnyParsed.ok ? (
              <ErrorNotice error={new Error(latestAnyParsed.message)} />
            ) : (
              <EmptyState>This agent has no versions yet.</EmptyState>
            )}
          </div>
        </div>
      );
    }
    return (
      <Suspense fallback={<Loading label="Opening the workflow builder…" />}>
        <WorkflowBuilder
          key={`${view.id}:${builderEpoch}`}
          agent={view}
          from={latest}
          bundle={latestAny}
          workflow={builder.params.workflow ?? builderStart}
          base={base}
          tabs={tabs}
          above={
            // The workflow's first step is how it starts: the agent's triggers, then the canvas.
            <div className="flex flex-col gap-4" data-testid="agent-workflow-top">
              {lineage}
              <TriggersPanel
                agent={view}
                latest={latest}
                bundle={latestAny}
                onChanged={(versionId) => {
                  setAwaiting(versionId);
                  reload();
                }}
              />
            </div>
          }
          connections={connections}
          members={members}
          onChanged={reload}
        />
      </Suspense>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <AgentBar
        view={view}
        clientName={clientName}
        bundle={latestAny ?? bundle}
        live={live}
        draft={draft}
        lineage={lineage}
        actions={
          <AgentActions
            view={view}
            base={base}
            detail={data}
            // The Builder's server sessions draft v3 only, so a version holding processes isn't
            // offered to it (as before, when this page couldn't read one).
            canRevise={latestAny !== null && !holdsProcess(latestAny)}
            onChanged={reload}
            onDiscarded={() =>
              navigate(view.kind === "template" ? "/ops/lab" : `/ops/clients/${view.tenantId}`)
            }
          />
        }
      >
        {tabs}
      </AgentBar>
      {view.status === "disabled" ? <DiscardedNotice agent={view} onRestored={reload} /> : null}
      <div>
        {shown && shown.id !== live?.id ? (
          <p className="mb-4 text-sm text-ink-muted" data-testid="agent-shown-version">
            Showing v{shown.version} ({shown.status}).
          </p>
        ) : null}
        <Routes>
          <Route
            index
            element={
              blocked ??
              (bundle ? (
                <OverviewTab
                  agent={view}
                  bundle={bundle}
                  base={base}
                  skills={skills.data?.skills ?? []}
                />
              ) : null)
            }
          />
          <Route
            path="workflow"
            element={
              blocked ??
              (requested && bundle && shown ? (
                // An older version is read, not edited: the builder always opens the latest.
                <WorkflowTab bundle={bundle} version={shown} />
              ) : (
                <Navigate to={`${base}/workflows/${builderStart}`} replace />
              ))
            }
          />
          {/* Triggers moved into the Workflow tab (its first step); the old address opens it. */}
          <Route
            path="triggers"
            element={<Navigate to={`${base}/workflows/${builderStart}`} replace />}
          />
          <Route
            path="revise"
            element={
              <ReviseTab
                agent={view}
                base={base}
                latestVersion={data.latest?.version ?? null}
                onChanged={reload}
              />
            }
          />
          <Route
            path="runs"
            element={
              isClient ? (
                <LatestRuns agentId={view.id} limit={50} />
              ) : (
                <EmptyState>
                  Templates don't run for clients. Their test runs belong to their test copy in the
                  Sandbox client.
                </EmptyState>
              )
            }
          />
          {/* People moved into Settings; the old tab's address still opens it. */}
          <Route path="people" element={<Navigate to={`${base}/settings`} replace />} />
          <Route
            path="versions"
            element={
              <div className="flex flex-col gap-6">
                {isClient ? (
                  <OperationPanel
                    agent={view}
                    live={live}
                    liveBundle={liveBundle}
                    onChanged={reload}
                  />
                ) : null}
                <VersionsTab
                  agent={view}
                  versions={versions}
                  liveId={live?.id ?? null}
                  base={base}
                  update={data.update}
                  template={templateId ? template : null}
                  onChanged={reload}
                  tests={
                    <TestsTab agent={view} detail={data} liveBundle={liveBundle} base={base} />
                  }
                />
              </div>
            }
          />
          {/* Tests moved into Versions (test before you publish); the old address opens it. */}
          <Route path="tests" element={<Navigate to={`${base}/versions${keep}`} replace />} />
          {["settings", "settings/:part"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <SettingsTab
                  agent={view}
                  base={base}
                  detail={data}
                  skills={skills}
                  connections={connections}
                  onChanged={reload}
                />
              }
            />
          ))}
        </Routes>
      </div>
    </div>
  );
}

/**
 * The agent's bar (prototype `#O6-Builder`): its tile, name, versions and what kind of agent it is,
 * what it is in one line and which agent it is (template or whose copy), its actions on the right
 * and the tabs underneath.
 */
function AgentBar({
  view,
  clientName,
  bundle,
  live,
  draft,
  lineage,
  actions,
  children,
}: {
  view: AgentSummary;
  clientName: string | undefined;
  bundle: AnyAgentBundle | null;
  live: { version: number } | null;
  draft: { version: number } | null;
  lineage: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const stats = bundle ? workflowStats(bundle) : null;
  const status = view.runStatus ?? "draft";
  const kind = agentKindBadge(view);
  // Fix 1 of the design pass: the title is the name the client knows (the service name); the
  // bundle's own name, where it differs, is in the line under it, the one place it matters.
  const title = view.serviceName ?? view.name;
  const ownName = view.serviceName && view.serviceName !== view.name ? view.name : null;
  const line = [
    ownName ? `Its definition calls it ${ownName}` : null,
    view.role,
    bundle && bundle.workflows.length > 1 ? plural(bundle.workflows.length, "workflow") : null,
    stats ? plural(stats.steps, "step") : null,
    stats && stats.forks > 0 ? plural(stats.forks, "fork") : null,
    bundle && bundle.definition.skills.length > 0
      ? plural(bundle.definition.skills.length, "skill")
      : null,
  ].filter(Boolean);
  return (
    <Card testId="agent-bar">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pt-5 pb-1">
        <div className="flex min-w-0 items-start gap-4">
          <AgentBadge name={title} seed={view.id} size="lg" />
          <div className="min-w-0">
            {/* Where it is (its client, or the lab) and the switcher to the client's others. */}
            <div className="ui-crumbs mb-1.5" data-testid="agent-bar-crumbs">
              <p className="eyebrow text-ink-muted">
                {view.kind === "client" && view.tenantId ? (
                  <Link to={OPS_PATHS.client(view.tenantId)} className="hover:underline">
                    {clientName ?? "Client"}
                  </Link>
                ) : (
                  <Link to={OPS_PATHS.lab} className="hover:underline">
                    Agent lab
                  </Link>
                )}
              </p>
              <HeaderSwitcher />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="type-heading text-ink">{title}</h1>
              <span className="flex flex-wrap gap-1.5" data-testid="agent-version-badges">
                <Badge tone={kind.tone} testId="agent-kind">
                  {kind.label}
                </Badge>
                {versionBadges(live, draft).map((b) => (
                  <Badge key={b.label} tone={b.tone}>
                    {b.label}
                  </Badge>
                ))}
                {view.status === "disabled" ? <Badge tone="neutral">Discarded</Badge> : null}
              </span>
              {view.kind === "client" && !view.testCopy ? (
                <StatusChip state={serviceChipState(status)} testId="agent-bar-status">
                  {RUN_STATUS_WORDS[status] ?? status}
                </StatusChip>
              ) : null}
            </div>
            {line.length > 0 ? (
              <p className="mt-1 text-sm text-ink-muted" data-testid="agent-bar-line">
                {line.join(" · ")}
              </p>
            ) : null}
            <div className="mt-1">{lineage}</div>
          </div>
        </div>
        {actions}
      </div>
      <div className="overflow-x-auto px-6 [&>nav]:border-b-0">{children}</div>
    </Card>
  );
}

/** Discard, revise with the Builder, Test run and Publish the newest draft. */
function AgentActions({
  view,
  base,
  detail,
  canRevise,
  onChanged,
  onDiscarded,
}: {
  view: AgentSummary;
  base: string;
  detail: AgentDetail;
  canRevise: boolean;
  onChanged(): void;
  onDiscarded(): void;
}) {
  const action = useAction();
  const [published, setPublished] = useState<number | null>(null);
  const { live, draft } = liveAndDraft(view, detail.versions);

  async function publish() {
    if (!draft) return;
    setPublished(null);
    const res = await action.call(apiRoutes.opsPublish, {
      params: { id: view.id, vid: draft.id },
    });
    if (res.ok) {
      setPublished(draft.version);
      onChanged();
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <span className="flex flex-wrap items-center justify-end gap-2">
        {canDiscard(view) ? <DiscardButton agent={view} onDiscarded={onDiscarded} /> : null}
        {canRevise && !view.testCopy && view.status === "active" ? (
          <Link
            to={`${base}/revise`}
            className={buttonClass("ghost", undefined, "sm")}
            data-testid="agent-revise"
          >
            Revise with the Builder
          </Link>
        ) : null}
        <Link
          to={`${base}/versions#tests`}
          className={buttonClass("secondary", undefined, "sm")}
          data-testid="agent-test-run"
        >
          Test run
        </Link>
        {/* Only a draft newer than the live version publishes; a live version says Live. */}
        {draft && draft.id !== live?.id && view.status === "active" ? (
          <Button
            variant="primary"
            size="sm"
            data-testid="agent-publish"
            disabled={action.busy}
            onClick={publish}
          >
            {action.busy ? "Publishing…" : `Publish v${draft.version}`}
          </Button>
        ) : null}
      </span>
      {published !== null ? (
        <Notice tone="positive" testId="agent-publish-done">
          v{published} is live.
          {view.kind === "template" ? " Client agents take it when you merge it into each." : ""}
        </Notice>
      ) : null}
      {action.error ? (
        <Notice tone="warning" testId="agent-publish-error">
          {errorText(action.error)}
          {detailMessages(action.error).length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {detailMessages(action.error).map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
    </div>
  );
}

function WorkflowTab({ bundle, version }: { bundle: AnyAgentBundle; version: VersionDetail }) {
  if (bundle.workflows.length === 0) {
    return <EmptyState>v{version.version} has no workflows.</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-ink-muted">
        Steps run top to bottom; a fork takes the first path whose rules match, then continues after
        the fork. This is v{version.version} as it was saved; the workflow builder edits the latest
        version.
      </p>
      {bundle.workflows.map((w) => (
        <section key={w.slug} data-testid={`workflow-${w.slug}`}>
          <SectionLabel>
            {w.name}
            {w.enabled ? "" : " · off"}
          </SectionLabel>
          <div className="rounded-lg border border-line bg-surface-subtle px-6 py-6">
            <StepList workflow={w.workflow} />
          </div>
        </section>
      ))}
    </div>
  );
}

type SettingsPart = "access" | "definition";

/**
 * Settings in two clearly different parts (the owner's review): Access applies at once and is
 * logged (a client agent's service, connections, grants, human release, people and channels, and
 * its price); Definition makes a new draft version (identity, instructions, skills, permissions,
 * budgets). A template has no access of its own: its part is its price.
 */
function SettingsTab({
  agent,
  base,
  detail,
  skills,
  connections,
  onChanged,
}: {
  agent: AgentSummary;
  base: string;
  detail: AgentDetail;
  skills: ApiState<ResponseOf<typeof apiRoutes.opsAgentSkills>>;
  connections: readonly Connection[];
  onChanged(): void;
}) {
  const navigate = useNavigate();
  const { part: param } = useParams();
  const isClient = agent.kind === "client";
  const showPrice = !agent.testCopy && agent.status === "active";
  const hasAccess = isClient || showPrice;
  const part: SettingsPart =
    param === "definition" || !hasAccess
      ? "definition"
      : param === "access"
        ? "access"
        : isClient
          ? "access"
          : "definition";
  const parts: { id: SettingsPart; label: string }[] = hasAccess
    ? [
        { id: "access", label: isClient ? "Access" : "Price" },
        { id: "definition", label: "Definition" },
      ]
    : [];

  return (
    <div className="flex flex-col gap-5">
      {parts.length > 1 ? (
        <div className="ds-seg self-start" data-testid="agent-settings-parts">
          {parts.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={part === p.id}
              data-testid={`agent-settings-${p.id}`}
              onClick={() => navigate(`${base}/settings/${p.id}`)}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
      {part === "access" ? (
        <AccessPart
          agent={agent}
          connections={connections}
          showPrice={showPrice}
          onChanged={onChanged}
        />
      ) : (
        <DefinitionPart agent={agent} detail={detail} skills={skills} onChanged={onChanged} />
      )}
    </div>
  );
}

function PartHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="type-subheading text-ink">{title}</h2>
      <p className="mt-1 text-sm text-ink-muted">{children}</p>
    </div>
  );
}

function AccessPart({
  agent,
  connections,
  showPrice,
  onChanged,
}: {
  agent: AgentSummary;
  connections: readonly Connection[];
  showPrice: boolean;
  onChanged(): void;
}) {
  const isClient = agent.kind === "client";
  return (
    <div className="flex flex-col gap-6" data-testid="agent-settings-access-part">
      <PartHeader title={isClient ? "Access" : "Price"}>
        Applies at once, with no new version. Every change is logged.
      </PartHeader>
      {isClient ? (
        <ServicePanel agent={agent} connections={connections} onChanged={onChanged} />
      ) : null}

      {isClient ? (
        <Card title="People and channels" testId="agent-people" pad>
          <p className="mb-4 text-sm text-ink-muted">
            Who this agent reaches for each of its roles, and how. The client's admin can change
            these too; consent and opt-outs stay with each contact.
          </p>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_380px]">
            <OpsPeopleSection agentId={agent.id} />
            <OpsChannelsSection agentId={agent.id} />
          </div>
        </Card>
      ) : null}

      {showPrice ? <PricePanel agent={agent} /> : null}
    </div>
  );
}

function DefinitionPart({
  agent,
  detail,
  skills,
  onChanged,
}: {
  agent: AgentSummary;
  detail: AgentDetail;
  skills: ApiState<ResponseOf<typeof apiRoutes.opsAgentSkills>>;
  onChanged(): void;
}) {
  const [result, setResult] = useState<
    { kind: "saved"; save: SaveResult } | { kind: "no_change"; from: number } | null
  >(null);
  const latest = detail.latest;
  const parsed = latest ? parseAnyBundle(latest) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="agent-settings-definition-part">
      <PartHeader title="Definition">
        Saving makes a new draft version; it takes effect when you publish it.{" "}
        {agent.kind === "template"
          ? "Clients' agents don't change until you merge the new version into each."
          : "Changes this client's agent only; its template is not touched."}{" "}
        Each step's model is set on the step, in the workflow builder.
      </PartHeader>
      {result?.kind === "saved" ? (
        <Notice
          tone={result.save.errors.length ? "warning" : "positive"}
          testId="agent-editor-saved"
        >
          Saved v{result.save.version.version} as a draft.
          {result.save.errors.length ? (
            <>
              {" "}
              Before it can be published:
              <ul className="mt-2 list-disc pl-5">
                {result.save.errors.map((e) => (
                  <li key={`${e.stepId}:${e.field}:${e.code}`}>
                    {e.stepId ? `Step ${e.stepId}: ` : ""}
                    {e.message}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            " Publish it from the bar above."
          )}
        </Notice>
      ) : null}
      {result?.kind === "no_change" ? (
        <Notice tone="neutral" testId="agent-editor-no-change">
          Nothing changed since v{result.from}, so no version was saved.
        </Notice>
      ) : null}
      {!latest ? <EmptyState>This agent has no versions yet.</EmptyState> : null}
      {parsed && !parsed.ok ? <ErrorNotice error={new Error(parsed.message)} /> : null}
      {skills.error ? <ErrorNotice error={skills.error} onRetry={skills.reload} /> : null}
      {latest && parsed?.ok && skills.data ? (
        <DefinitionEditor
          key={latest.id}
          agent={agent}
          from={latest}
          bundle={parsed.bundle}
          skills={skills.data.skills}
          onSaved={(save) => {
            setResult({ kind: "saved", save });
            onChanged();
          }}
          onNoChange={() => setResult({ kind: "no_change", from: latest.version })}
        />
      ) : latest && parsed?.ok && !skills.error ? (
        <Card className="p-5">
          <Loading label="Loading skills…" />
        </Card>
      ) : null}
    </div>
  );
}
