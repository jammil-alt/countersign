// One agent page for templates and client agents (design screen 7; ARCHITECTURE §15): header with
// the live/draft badges, tabs Overview, Workflow, Runs, Versions and Settings. Client agents add
// their operation (bindings, approver, service, activate/pause/retire) to Settings and lineage to
// Versions; templates show "Used by". `?version=N` shows an older version on the bundle tabs.
import type { AgentBundle } from "@countersign/core";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, Route, Routes, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
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
  Tabs,
} from "../../ui/primitives";
import { liveAndDraft, parseBundle, versionBadges } from "../versions";
import { StepList } from "../workflow/StepList";
import { DefinitionEditor, type SaveResult } from "./DefinitionEditor";
import { OperationPanel } from "./OperationPanel";
import { LatestRuns, OverviewTab } from "./OverviewTab";
import { Notice, notifyAgentsChanged } from "./ui";
import { VersionsTab } from "./VersionsTab";

type Connection = ResponseOf<typeof apiRoutes.opsClient>["connections"][number];

export function AgentScreen({
  agentId,
  base,
  connections = [],
}: {
  agentId: string;
  /** The page's URL: `/ops/clients/<id>/agents/<slug>` or `/ops/templates/<slug>`. */
  base: string;
  /** A client agent's client's connections, for its bindings. */
  connections?: readonly Connection[];
}) {
  const [search] = useSearchParams();
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

  const firstWorkflow = bundle?.workflows[0]?.slug;
  return (
    <div>
      <PageHeader
        leading={<AgentAvatar name={view.name} seed={view.slug} size="lg" />}
        title={view.serviceName ?? view.name}
        badge={
          <span className="flex gap-1.5" data-testid="agent-version-badges">
            {versionBadges(live, draft).map((b) => (
              <Badge key={b.label} tone={b.tone}>
                {b.label}
              </Badge>
            ))}
            {view.kind === "template" ? <Badge tone="accent">Template</Badge> : null}
            {view.testCopy ? <Badge tone="neutral">Test copy</Badge> : null}
          </span>
        }
        subtitle={[view.role, bundle?.definition.identity.mission].filter(Boolean).join(" · ")}
        actions={
          firstWorkflow ? (
            <Link
              to={`${base}/workflows/${firstWorkflow}`}
              className={buttonClass("secondary")}
              data-testid="agent-edit-workflow"
            >
              Edit workflow
            </Link>
          ) : null
        }
      />
      <Tabs
        items={[
          { to: `${base}${keep}`, label: "Overview", end: true },
          { to: `${base}/workflow${keep}`, label: "Workflow" },
          { to: `${base}/runs${keep}`, label: "Runs" },
          { to: `${base}/versions${keep}`, label: "Versions", count: versions.length },
          { to: `${base}/settings${keep}`, label: "Settings" },
        ]}
      />
      <div className="pt-6">
        {shown && shown.id !== live?.id ? (
          <p className="mb-4 text-sm text-secondary" data-testid="agent-shown-version">
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
              blocked ?? (bundle && shown ? <WorkflowTab bundle={bundle} version={shown} /> : null)
            }
          />
          <Route
            path="runs"
            element={
              view.kind === "client" ? (
                <LatestRuns agentId={view.id} limit={50} />
              ) : (
                <EmptyState>
                  Templates don't run for clients. Their test runs belong to their test copy in the
                  Sandbox client.
                </EmptyState>
              )
            }
          />
          <Route
            path="versions"
            element={
              <VersionsTab
                agent={view}
                versions={versions}
                liveId={live?.id ?? null}
                base={base}
                update={agent.data.update}
                onChanged={reload}
              />
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
                liveBundle={liveBundle}
                onChanged={reload}
              />
            }
          />
        </Routes>
      </div>
    </div>
  );
}

function WorkflowTab({ bundle, version }: { bundle: AgentBundle; version: VersionDetail }) {
  if (bundle.workflows.length === 0) {
    return <EmptyState>v{version.version} has no workflows.</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-secondary">
        Steps run top to bottom; a fork takes the first path whose rules match, then continues after
        the fork. Edit them in the workflow builder.
      </p>
      {bundle.workflows.map((w) => (
        <section key={w.slug} data-testid={`workflow-${w.slug}`}>
          <SectionLabel>
            {w.name}
            {w.enabled ? "" : " · off"}
          </SectionLabel>
          <div className="rounded-lg border border-edge bg-subtle px-6 py-6">
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
  liveBundle,
  onChanged,
}: {
  agent: AgentSummary;
  detail: ResponseOf<typeof apiRoutes.opsAgent>;
  skills: ApiState<ResponseOf<typeof apiRoutes.opsAgentSkills>>;
  connections: readonly Connection[];
  liveBundle: AgentBundle | null;
  onChanged(): void;
}) {
  const [result, setResult] = useState<
    { kind: "saved"; save: SaveResult } | { kind: "no_change"; from: number } | null
  >(null);
  const latest = detail.latest;
  const parsed = latest ? parseBundle(latest) : null;
  const live = detail.versions.find((v) => v.id === agent.liveVersionId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      {agent.kind === "client" ? (
        <OperationPanel
          agent={agent}
          connections={connections}
          live={live}
          liveBundle={liveBundle}
          onChanged={onChanged}
        />
      ) : null}

      <div>
        <h2 className="mb-1 text-lg font-semibold text-primary">Definition</h2>
        <p className="mb-4 text-sm text-secondary">
          {agent.kind === "template"
            ? "Editing a template changes no client agent: they take its new versions as reviewed updates."
            : "Changes to this client's agent only. Its template is not touched."}
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
                " Publish it from Versions."
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
