// `/ops/clients/:clientId/agents/:slug`: a client agent (design screen 7), with tabs Overview,
// Workflow, Runs, Versions and Settings. Agents are addressed by id in the API (ARCHITECTURE §14)
// and by slug in the URL, so the page finds the id in the client's agent list first.
import type { AgentBundle } from "@countersign/core";
import type { ReactNode } from "react";
import { Link, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import {
  type AgentSummary,
  apiRoutes,
  type VersionDetail,
  type VersionSummary,
} from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  AgentAvatar,
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Placeholder,
  SectionLabel,
  Tabs,
} from "../../ui/primitives";
import { liveAndDraft, parseBundle, versionBadges } from "../versions";
import { KIND_LABEL, triggerTitle, workflowStats } from "../workflow/describe";
import { StepList } from "../workflow/StepList";

export function AgentPage() {
  const { clientId = "", slug = "" } = useParams();
  const [search] = useSearchParams();
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  const summary = client.data?.agents.find((a) => a.slug === slug);
  const agent = useApi(apiRoutes.opsAgent, summary ? { params: { id: summary.id } } : null);

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
    summary && requested && !inHand ? { params: { id: summary.id, vid: requested.id } } : null,
  );

  if (client.error) return <ErrorNotice error={client.error} onRetry={client.reload} />;
  if (client.data && !summary) {
    return <ErrorNotice error={new Error(`This client has no agent "${slug}".`)} />;
  }
  if (agent.error) return <ErrorNotice error={agent.error} onRetry={agent.reload} />;
  if (!agent.data) return <Loading />;

  const { agent: view, versions } = agent.data;
  const { live, draft } = liveAndDraft(view, versions);
  const shown: VersionDetail | null = requested
    ? (inHand ?? fetched.data?.version ?? null)
    : (agent.data.live ?? agent.data.latest);
  const parsed = shown ? parseBundle(shown) : null;
  const bundle = parsed?.ok ? parsed.bundle : null;

  const base = `/ops/clients/${clientId}/agents/${slug}`;
  const keep = search.toString() ? `?${search.toString()}` : "";

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
          </span>
        }
        subtitle={[view.role, bundle?.definition.identity.mission].filter(Boolean).join(" · ")}
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
            element={blocked ?? (bundle ? <OverviewTab agent={view} bundle={bundle} /> : null)}
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
              <Placeholder title="Runs">This agent's runs arrive with the run views.</Placeholder>
            }
          />
          <Route
            path="versions"
            element={<VersionsTab versions={versions} liveId={live?.id ?? null} base={base} />}
          />
          <Route path="settings" element={<SettingsTab agent={view} />} />
        </Routes>
      </div>
    </div>
  );
}

function OverviewTab({ agent, bundle }: { agent: AgentSummary; bundle: AgentBundle }) {
  const stats = workflowStats(bundle);
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-5">
        <Card className="p-5">
          <SectionLabel>
            How it works · {plural(stats.steps, "step")}, {plural(stats.forks, "fork")}
          </SectionLabel>
          {bundle.workflows.length === 0 ? (
            <p className="text-secondary">No workflows: this agent answers asks and commands.</p>
          ) : (
            bundle.workflows.map((w) => <StepChips key={w.slug} workflow={w} />)
          )}
        </Card>
        <Card className="p-5">
          <SectionLabel>Mission</SectionLabel>
          <p className="font-serif text-[17px] text-body">{bundle.definition.identity.mission}</p>
        </Card>
      </div>
      <Card className="p-5">
        <SectionLabel>Works in</SectionLabel>
        <Chips items={Object.keys(agent.bindings)} empty="No connections bound yet." />
        <div className="mt-4">
          <SectionLabel>Skills it uses</SectionLabel>
          <Chips items={bundle.definition.skills.map((s) => s.skill)} empty="No skills." />
        </div>
      </Card>
    </div>
  );
}

function StepChips({ workflow }: { workflow: AgentBundle["workflows"][number] }) {
  const w = workflow.workflow;
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-2 text-sm font-medium text-primary">{workflow.name}</p>
      <ol className="flex flex-wrap items-center gap-2">
        <Chip kind={KIND_LABEL.trigger} label={triggerTitle(w.trigger)} />
        {w.steps.map((s) => (
          <Chip key={s.id} kind={KIND_LABEL[s.kind]} label={s.name} />
        ))}
      </ol>
    </div>
  );
}

function Chip({ kind, label }: { kind: string; label: string }) {
  return (
    <li className="flex items-center gap-2 rounded-sm border border-edge px-2 py-1 text-sm text-primary">
      <span className="label-caps text-[10px] text-secondary">{kind}</span>
      {label}
    </li>
  );
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-secondary">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span
          key={i}
          className="rounded-sm border border-edge bg-subtle px-1.5 py-0.5 text-xs text-body"
        >
          {i}
        </span>
      ))}
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
        Read-only for now: the drag-and-drop builder replaces this view. Steps run top to bottom; a
        fork takes the first path whose rules match, then continues after the fork.
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

function VersionsTab({
  versions,
  liveId,
  base,
}: {
  versions: VersionSummary[];
  liveId: string | null;
  base: string;
}) {
  if (versions.length === 0) return <EmptyState>No versions yet.</EmptyState>;
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  return (
    <Card className="overflow-hidden">
      <table data-testid="agent-versions" className="w-full text-left">
        <thead className="border-b border-edge bg-subtle">
          <tr className="label-caps text-secondary">
            <th className="px-4 py-2.5 font-medium">Version</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Change</th>
            <th className="px-4 py-2.5 font-medium">Template base</th>
            <th className="px-4 py-2.5 font-medium">By</th>
            <th className="px-4 py-2.5 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v) => (
            <tr
              key={v.id}
              data-testid={`agent-version-${v.version}`}
              className="border-b border-divider last:border-0"
            >
              <td className="px-4 py-3 font-mono">
                <Link
                  to={`${base}/workflow?version=${v.version}`}
                  className="text-link hover:underline"
                >
                  v{v.version}
                </Link>
              </td>
              <td className="px-4 py-3">
                <Badge
                  tone={v.id === liveId ? "positive" : v.status === "draft" ? "neutral" : "warning"}
                >
                  {v.id === liveId ? "live" : v.status}
                </Badge>
              </td>
              <td className="px-4 py-3 text-body">{v.changeNote ?? "—"}</td>
              <td className="px-4 py-3 text-secondary">
                {v.basedOnTemplateVersionId ? "yes" : "—"}
              </td>
              <td className="px-4 py-3 text-secondary">{v.authorType}</td>
              <td className="px-4 py-3 font-mono text-xs text-secondary">
                {v.createdAt.slice(0, 10)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function SettingsTab({ agent }: { agent: AgentSummary }) {
  const rows: [string, string][] = [
    ["Service name", agent.serviceName ?? "—"],
    ["Service description", agent.serviceDescription ?? "—"],
    ["Run status", agent.runStatus ?? "—"],
    ["Approver", agent.approver ?? "the client's setting"],
    [
      "Template",
      agent.templateId ? (agent.linked ? "forked, linked" : "forked, detached") : "none",
    ],
    [
      "Bindings",
      Object.entries(agent.bindings)
        .map(([connector, connection]) => `${connector} → ${connection}`)
        .join(", ") || "none",
    ],
  ];
  return (
    <Card className="p-5">
      <SectionLabel>Operation</SectionLabel>
      <dl className="grid grid-cols-[200px_1fr] gap-x-6 gap-y-3">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-secondary">{k}</dt>
            <dd className="text-primary">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm text-secondary">Editing these arrives with client agents (M6).</p>
    </Card>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
