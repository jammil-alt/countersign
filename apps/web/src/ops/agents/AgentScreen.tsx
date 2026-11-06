// One agent page for templates and client agents (docs/ui-plan.md "Agent page (back office)", in
// the style of the prototype's `#O6-Builder` and `#O7-Triggers` agent bar): the agent's bar with
// its versions, what it is, Test run and Publish, then the tabs Overview, Workflow, Triggers, Runs,
// Versions, Tests and Settings (open question 3, the plan's default). Versions holds a client
// agent's run status and go-live stage beside its history; Settings its service, connections and
// grants, people and channels, price and definition. Workflow and Triggers host UI-2c's screens.
// `/revise` asks the Builder for a new draft. `?version=N` shows an older version on the bundle tabs.
import type { AgentBundle } from "@countersign/core";
import type { ReactNode } from "react";
import { lazy, Suspense, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useMatch,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { OpsChannelsSection, OpsPeopleSection } from "../../people/PeoplePanel";
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
import { liveAndDraft, parseBundle, versionBadges } from "../versions";
import { workflowStats } from "../workflow/describe";
import { StepList } from "../workflow/StepList";
import { ReviseTab } from "./BuilderParts";
import { DefinitionEditor, type SaveResult } from "./DefinitionEditor";
import { canDiscard, DiscardButton, DiscardedNotice } from "./DiscardDraft";
import { OperationPanel, ServicePanel } from "./OperationPanel";
import { LatestRuns, OverviewTab } from "./OverviewTab";
import { PricePanel } from "./PricePanel";
import { TestsTab } from "./TestsTab";
import { TriggersTab } from "./TriggersTab";
import { detailMessages, errorText, Notice, notifyAgentsChanged, plural, useAction } from "./ui";
import { VersionsTab } from "./VersionsTab";

type Connection = ResponseOf<typeof apiRoutes.opsClient>["connections"][number];
type AgentDetail = ResponseOf<typeof apiRoutes.opsAgent>;

// The builder (with drag and drop) is its own chunk inside /ops, fetched when a workflow opens.
const WorkflowBuilder = lazy(() => import("../builder/WorkflowBuilder"));

const RUN_STATUS_WORDS: Record<string, string> = {
  active: "Running",
  paused: "Paused",
  retired: "Retired",
  draft: "Not started",
};

export function AgentScreen({
  agentId,
  base,
  clientName,
  connections = [],
  members = [],
}: {
  agentId: string;
  /** The page's URL: `/ops/clients/<id>/agents/<slug>` or `/ops/templates/<slug>`. */
  base: string;
  /** A client agent's client, for its bar. */
  clientName?: string;
  /** A client agent's client's connections, for its bindings. */
  connections?: readonly Connection[];
  /** A client agent's client's people, for approvers and assignees. */
  members?: readonly Member[];
}) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const builder = useMatch(`${base}/workflows/:workflow`);
  const workflowTab = useMatch(`${base}/workflow`);
  const agent = useApi(apiRoutes.opsAgent, { params: { id: agentId } });
  const skills = useApi(apiRoutes.opsAgentSkills, { params: { id: agentId } });

  // `?version=N` shows an older version; live and latest come with the agent, others are fetched.
  const requestedNumber = Number.parseInt(search.get("version") ?? "", 10);
  const requested = Number.isNaN(requestedNumber)
    ? undefined
    : agent.data?.versions.find((v) => v.version === requestedNumber);
  const inHand = requested
    ? [agent.data?.live, agent.data?.latest].find((d) => d?.id === requested.id)
    : undefined;
  const fetched = useApi(
    apiRoutes.opsAgentVersion,
    requested && !inHand ? { params: { id: agentId, vid: requested.id } } : null,
  );

  if (agent.error) return <ErrorNotice error={agent.error} onRetry={agent.reload} />;
  if (!agent.data) return <Loading />;

  const { agent: view, versions } = agent.data;
  const { live, draft } = liveAndDraft(view, versions);
  const shown: VersionDetail | null = requested
    ? (inHand ?? fetched.data?.version ?? null)
    : (agent.data.live ?? agent.data.latest);
  const parsed = shown ? parseBundle(shown) : null;
  const bundle = parsed?.ok ? parsed.bundle : null;
  const liveParsed = agent.data.live ? parseBundle(agent.data.live) : null;
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

  // The builder edits the latest version (draft or live), like the definition editor.
  const latestParsed = agent.data.latest ? parseBundle(agent.data.latest) : null;
  const latestBundle = latestParsed?.ok ? latestParsed.bundle : null;
  const builderStart = latestBundle?.workflows[0]?.slug ?? "main";
  const isClient = view.kind === "client";
  const tabs = (
    <Tabs
      items={[
        { to: `${base}${keep}`, label: "Overview", end: true },
        {
          to: `${base}/workflows/${builderStart}`,
          label: "Workflow",
          active: builder !== null || workflowTab !== null,
        },
        { to: `${base}/triggers`, label: "Triggers" },
        { to: `${base}/runs${keep}`, label: "Runs" },
        { to: `${base}/versions${keep}`, label: "Versions", count: versions.length },
        { to: `${base}/tests`, label: "Tests" },
        { to: `${base}/settings${keep}`, label: "Settings" },
      ]}
    />
  );

  if (builder) {
    const latest = agent.data.latest;
    if (!latest || !latestBundle) {
      return (
        <div>
          <AgentBar view={view} clientName={clientName} bundle={null} live={live} draft={draft}>
            {tabs}
          </AgentBar>
          <div className="pt-6">
            {latestParsed && !latestParsed.ok ? (
              <ErrorNotice error={new Error(latestParsed.message)} />
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
          key={view.id}
          agent={view}
          from={latest}
          bundle={latestBundle}
          workflow={builder.params.workflow ?? builderStart}
          base={base}
          tabs={tabs}
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
        bundle={latestBundle ?? bundle}
        live={live}
        draft={draft}
        actions={
          <AgentActions
            view={view}
            base={base}
            detail={agent.data}
            canRevise={latestBundle !== null}
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
          <Route
            path="triggers"
            element={
              isClient ? (
                <TriggersTab agentId={view.id} base={base} />
              ) : (
                <EmptyState>
                  A template's triggers are part of its workflows: set them in the workflow builder.
                  Each client agent forked from it lists its own on its page.
                </EmptyState>
              )
            }
          />
          <Route
            path="revise"
            element={
              <ReviseTab
                agent={view}
                base={base}
                latestVersion={agent.data.latest?.version ?? null}
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
                  update={agent.data.update}
                  onChanged={reload}
                />
              </div>
            }
          />
          <Route
            path="tests"
            element={
              <TestsTab agent={view} detail={agent.data} liveBundle={liveBundle} base={base} />
            }
          />
          <Route
            path="settings"
            element={
              <SettingsTab
                agent={view}
                detail={agent.data}
                skills={skills}
                connections={connections}
                onChanged={reload}
              />
            }
          />
        </Routes>
      </div>
    </div>
  );
}

/**
 * The agent's bar (prototype `#O6-Builder`): its tile, name and versions, what it is in one line,
 * its actions on the right and the tabs underneath.
 */
function AgentBar({
  view,
  clientName,
  bundle,
  live,
  draft,
  actions,
  children,
}: {
  view: AgentSummary;
  clientName: string | undefined;
  bundle: AgentBundle | null;
  live: { version: number } | null;
  draft: { version: number } | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const stats = bundle ? workflowStats(bundle) : null;
  const status = view.runStatus ?? "draft";
  const line = [
    clientName,
    view.kind === "template" ? "Template" : null,
    view.role,
    bundle ? plural(bundle.workflows.length, "workflow") : null,
    stats ? plural(stats.steps, "step") : null,
    stats && stats.forks > 0 ? plural(stats.forks, "fork") : null,
    bundle ? plural(bundle.definition.skills.length, "skill") : null,
  ].filter(Boolean);
  const title =
    view.serviceName && view.serviceName !== view.name
      ? `${view.name} · ${view.serviceName}`
      : view.name;
  return (
    <Card testId="agent-bar">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pt-5 pb-1">
        <div className="flex min-w-0 items-start gap-4">
          <AgentBadge name={view.name} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="type-heading text-ink">{title}</h1>
              <span className="flex flex-wrap gap-1.5" data-testid="agent-version-badges">
                {versionBadges(live, draft).map((b) => (
                  <Badge key={b.label} tone={b.tone}>
                    {b.label}
                  </Badge>
                ))}
                {view.kind === "template" ? <Badge tone="accent">Template</Badge> : null}
                {view.testCopy ? <Badge tone="neutral">Test copy</Badge> : null}
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
  const { draft } = liveAndDraft(view, detail.versions);

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
          to={`${base}/tests`}
          className={buttonClass("secondary", undefined, "sm")}
          data-testid="agent-test-run"
        >
          Test run
        </Link>
        {draft && view.status === "active" ? (
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
          {view.kind === "template" ? " Client agents take it as a reviewed update." : ""}
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

function WorkflowTab({ bundle, version }: { bundle: AgentBundle; version: VersionDetail }) {
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

function SettingsTab({
  agent,
  detail,
  skills,
  connections,
  onChanged,
}: {
  agent: AgentSummary;
  detail: AgentDetail;
  skills: ApiState<ResponseOf<typeof apiRoutes.opsAgentSkills>>;
  connections: readonly Connection[];
  onChanged(): void;
}) {
  const [result, setResult] = useState<
    { kind: "saved"; save: SaveResult } | { kind: "no_change"; from: number } | null
  >(null);
  const latest = detail.latest;
  const parsed = latest ? parseBundle(latest) : null;

  return (
    <div className="flex flex-col gap-6">
      {agent.kind === "client" ? (
        <ServicePanel agent={agent} connections={connections} onChanged={onChanged} />
      ) : null}

      {agent.kind === "client" ? (
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

      {!agent.testCopy && agent.status === "active" ? <PricePanel agent={agent} /> : null}

      <div>
        <h2 className="mb-1 type-subheading text-ink">Definition</h2>
        <p className="mb-4 text-sm text-ink-muted">
          {agent.kind === "template"
            ? "Editing a template changes no client agent: they take its new versions as reviewed updates."
            : "Changes to this client's agent only. Its template is not touched."}{" "}
          Each step's model is set on the step, in the workflow builder.
        </p>
        {result?.kind === "saved" ? (
          <div className="mb-4">
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
          </div>
        ) : null}
        {result?.kind === "no_change" ? (
          <div className="mb-4">
            <Notice tone="neutral" testId="agent-editor-no-change">
              Nothing changed since v{result.from}, so no version was saved.
            </Notice>
          </div>
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
    </div>
  );
}
