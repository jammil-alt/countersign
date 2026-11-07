// O2 Agent lab (docs/design/prototype.html `#O2-Lab`; docs/ui-plan.md): build an agent for one
// client, then turn it into a template the next client starts from. On the left the templates
// (published), drafts and client-only agents; on the right the chosen template: where it runs
// (its client agents, versions behind, merges to review and changes to promote), its workflow,
// the panels it adds to the client's agent page, and its test bench. Publishing a template
// changes no client agent: each takes the new version as a reviewed update merge (invariant 11).
import {
  type AgentBundle,
  type LabResponse,
  type LabTemplate,
  pickLocalized,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { AgentBadge } from "../../ui/badges";
import { Loaded, Page } from "../../ui/page";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tag,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { StepList } from "../../ui/steps";
import { SuiteSummary } from "../agents/TestsTab";
import { errorText, Notice, notifyAgentsChanged, plural, Select, useAction } from "../agents/ui";
import type { AgentLinkState } from "../screens/AgentPage";
import { parseBundle } from "../versions";
import { workflowStats } from "../workflow/describe";
import { workflowStepItems } from "./steps";

type Tab = "templates" | "drafts" | "client";
type UsedBy = ResponseOf<typeof apiRoutes.opsUsedBy>["agents"][number];

const TABS: readonly Tab[] = ["templates", "drafts", "client"];

function templatePath(slug: string): string {
  return `/ops/templates/${slug}`;
}

/** The template's id travels with links to its page, so the page needn't look it up by slug. */
function handOver(id: string): AgentLinkState {
  return { agentId: id };
}

// DECISION: a panel still loading after 8 s says so and offers Try again, rather than "Loading…"
// for ever (the owner's review: "Where it runs" never finished). A request that never answers
// (a dropped connection, a Worker past its limit) is the one case useApi can't turn into an error.
const SLOW_MS = 8_000;

/** True once `loading` has lasted `ms`; false again when it stops. */
export function useSlow(loading: boolean, ms = SLOW_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(timer);
  }, [loading, ms]);
  return slow;
}

export function LabScreen() {
  const lab = useApi(apiRoutes.opsLab);
  // Each template's role and status; discarded drafts too, so they can be found and restored.
  const templates = useApi(apiRoutes.opsTemplates, { query: { include: "discarded" } });
  const [search, setSearch] = useSearchParams();
  const tabParam = search.get("tab");
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "templates";

  function choose(next: { tab?: Tab; t?: string }) {
    const params = new URLSearchParams(search);
    if (next.tab) {
      params.set("tab", next.tab);
      params.delete("t");
    }
    if (next.t) params.set("t", next.t);
    setSearch(params, { replace: true });
  }

  return (
    <Page testId="ops-lab">
      <PageHeader
        title="Agent lab"
        subtitle="Build an agent for one client, then turn it into a template the next client starts from."
        actions={
          <Link to="/ops/templates/new" className={buttonClass("primary")} data-testid="lab-new">
            New template
          </Link>
        }
      />
      <Loaded state={lab}>
        {(data) => {
          const summaries = new Map(
            (templates.data?.templates ?? []).map((t) => [t.id, t] as const),
          );
          const discarded = (templates.data?.templates ?? []).filter(
            (t) => t.status === "disabled",
          );
          const list = tab === "templates" ? data.published : tab === "drafts" ? data.drafts : [];
          const selected = list.find((t) => t.agent.id === search.get("t")) ?? list[0] ?? null;
          return (
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
              <div className="flex flex-col gap-3 lg:w-80 lg:shrink-0">
                <LabTabs data={data} tab={tab} onChoose={(t) => choose({ tab: t })} />
                {tab === "client" ? (
                  <ClientOnlyList agents={data.clientOnly} />
                ) : list.length === 0 && (tab === "templates" || discarded.length === 0) ? (
                  <EmptyState>
                    {tab === "templates"
                      ? "No published templates yet. Publish a draft, or promote a client agent's changes into one."
                      : "No drafts. A new template starts as a draft until its first publish."}
                  </EmptyState>
                ) : (
                  <>
                    {list.map((t) => (
                      <TemplateCard
                        key={t.agent.id}
                        entry={t}
                        role={summaries.get(t.agent.id)?.role ?? null}
                        selected={t.agent.id === selected?.agent.id}
                        onSelect={() => choose({ t: t.agent.id })}
                      />
                    ))}
                    {tab === "drafts" && discarded.length > 0 ? (
                      <DiscardedList agents={discarded} />
                    ) : null}
                  </>
                )}
              </div>
              <div className="min-w-0 flex-1">
                {tab !== "client" && selected ? (
                  <TemplateDetail
                    key={selected.agent.id}
                    entry={selected}
                    role={summaries.get(selected.agent.id)?.role ?? null}
                    onTested={lab.reload}
                  />
                ) : tab === "client" ? (
                  <Card pad>
                    <p className="text-sm text-ink-muted">
                      Client-only agents were written for one client from no template. Open one to
                      test it, version it, or copy it into another client from that client's New
                      agent page.
                    </p>
                  </Card>
                ) : null}
              </div>
            </div>
          );
        }}
      </Loaded>
    </Page>
  );
}

function LabTabs({
  data,
  tab,
  onChoose,
}: {
  data: LabResponse;
  tab: Tab;
  onChoose(tab: Tab): void;
}) {
  const items: { id: Tab; label: string }[] = [
    { id: "templates", label: `Templates · ${data.published.length}` },
    { id: "drafts", label: `Drafts · ${data.drafts.length}` },
    { id: "client", label: `Client-only · ${data.clientOnly.length}` },
  ];
  return (
    <div className="ds-seg self-start" data-testid="lab-tabs">
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          aria-pressed={tab === i.id}
          data-testid={`lab-tab-${i.id}`}
          onClick={() => onChoose(i.id)}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

/** "3 clients · 1 behind", "4 clients · current", "0 clients · testing". */
function reachLine(t: LabTemplate): string {
  const clients = plural(t.clients, "client");
  if (t.agent.liveVersion === null) return `${clients} · testing`;
  return t.behind > 0 ? `${clients} · ${t.behind} behind` : `${clients} · current`;
}

function TemplateCard({
  entry,
  role,
  selected,
  onSelect,
}: {
  entry: LabTemplate;
  role: string | null;
  selected: boolean;
  onSelect(): void;
}) {
  const a = entry.agent;
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-testid={`lab-template-${a.slug}`}
      onClick={onSelect}
      className={cx(
        "ds-card flex w-full flex-col gap-2 p-4 text-left",
        selected ? "border-slate ring-1 ring-slate" : "hover:border-line-strong",
      )}
    >
      <span className="flex items-center gap-2">
        <AgentBadge name={a.name} seed={a.id} size="sm" />
        <b className="min-w-0 flex-1 truncate font-medium text-ink">{a.name}</b>
        {a.liveVersion !== null ? (
          <span className="reference text-ink-muted">v{a.liveVersion}</span>
        ) : (
          <Tag>Draft</Tag>
        )}
      </span>
      {role ? <span className="text-sm text-ink-muted">{role}</span> : null}
      <span className="text-sm text-ink">{reachLine(entry)}</span>
    </button>
  );
}

function DiscardedList({ agents }: { agents: AgentSummary[] }) {
  return (
    <Card title="Discarded drafts" testId="lab-discarded">
      <ul className="flex flex-col divide-y divide-line">
        {agents.map((a) => (
          <li key={a.id} className="px-6 py-2.5">
            <Link
              to={templatePath(a.slug)}
              state={handOver(a.id)}
              className="text-sm text-link hover:underline"
            >
              {a.name}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ClientOnlyList({ agents }: { agents: LabResponse["clientOnly"] }) {
  if (agents.length === 0) {
    return (
      <EmptyState>No client-only agents: every client agent comes from a template.</EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="lab-client-only">
      {agents.map(({ agent, client }) => (
        <Link
          key={agent.id}
          to={`/ops/clients/${client.id}/agents/${agent.slug}`}
          data-testid={`lab-client-only-${agent.slug}`}
          className="ds-card flex flex-col gap-2 p-4 hover:border-line-strong"
        >
          <span className="flex items-center gap-2">
            <AgentBadge name={agent.name} seed={agent.id} size="sm" />
            <b className="min-w-0 flex-1 truncate font-medium text-ink">{agent.name}</b>
            {agent.liveVersion !== null ? (
              <span className="reference text-ink-muted">v{agent.liveVersion}</span>
            ) : (
              <Tag>Draft</Tag>
            )}
          </span>
          <span className="text-sm text-ink-muted">{client.name}</span>
        </Link>
      ))}
    </div>
  );
}

function TemplateDetail({
  entry,
  role,
  onTested,
}: {
  entry: LabTemplate;
  role: string | null;
  onTested(): void;
}) {
  const a = entry.agent;
  const detail = useApi(apiRoutes.opsAgent, { params: { id: a.id } });
  const latest = detail.data?.latest ?? null;
  const parsed = latest ? parseBundle(latest) : null;
  const bundle = parsed?.ok ? parsed.bundle : null;
  const stats = bundle ? workflowStats(bundle) : null;
  const base = templatePath(a.slug);
  const hasDraft = a.latestVersion !== null && a.latestVersion !== a.liveVersion;
  const [assigning, setAssigning] = useState(false);

  const line = [
    role,
    stats ? plural(stats.steps, "step") : null,
    bundle ? plural(bundle.definition.skills.length, "skill") : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-5" data-testid="lab-detail">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <AgentBadge name={a.name} seed={a.id} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="type-heading text-ink">{a.name}</h2>
                {a.liveVersion !== null ? (
                  <StatusChip state="done">Published v{a.liveVersion}</StatusChip>
                ) : (
                  <Badge tone="neutral">Draft v{a.latestVersion ?? 1}</Badge>
                )}
              </div>
              {line.length > 0 ? (
                <p className="mt-1 text-sm text-ink-muted">{line.join(" · ")}</p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to={`${base}/workflow`}
              state={handOver(a.id)}
              className={buttonClass("secondary", undefined, "sm")}
              data-testid="lab-edit"
            >
              {hasDraft ? `Edit draft v${a.latestVersion}` : "Edit"}
            </Link>
            {a.liveVersion !== null ? (
              <Button
                size="sm"
                variant="primary"
                data-testid="lab-assign"
                aria-expanded={assigning}
                onClick={() => setAssigning((x) => !x)}
              >
                Assign to a client
              </Button>
            ) : null}
          </div>
        </div>
        {assigning ? (
          <AssignForm
            templateId={a.id}
            version={a.liveVersion}
            onCancel={() => setAssigning(false)}
          />
        ) : null}
        <nav
          aria-label="Template"
          className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line px-6 py-3 text-sm"
        >
          <Link to={base} state={handOver(a.id)} className="text-link hover:underline">
            Overview
          </Link>
          <Link
            to={`${base}/workflow`}
            state={handOver(a.id)}
            className="text-link hover:underline"
          >
            Workflow
          </Link>
          <Link
            to={`${base}/versions`}
            state={handOver(a.id)}
            className="text-link hover:underline"
          >
            Versions and tests
          </Link>
          <Link
            to={`${base}/settings`}
            state={handOver(a.id)}
            className="text-link hover:underline"
          >
            Settings
          </Link>
        </nav>
      </Card>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <WhereItRuns templateId={a.id} />
        <Card
          title="Workflow"
          testId="lab-workflow"
          meta={
            <Link to={`${base}/workflow`} state={handOver(a.id)} className="text-sm text-link">
              Open builder
            </Link>
          }
        >
          {detail.error ? (
            <div className="px-6 py-4">
              <ErrorNotice error={detail.error} onRetry={detail.reload} />
            </div>
          ) : !detail.data ? (
            <div className="px-6">
              <Loading />
            </div>
          ) : parsed && !parsed.ok ? (
            <div className="px-6 py-4">
              <ErrorNotice error={new Error(parsed.message)} />
            </div>
          ) : (
            <LabWorkflow bundle={bundle} version={latest?.version ?? null} />
          )}
        </Card>
        <ClientViewCard agentId={a.id} />
        <Card
          title="Test bench"
          testId="lab-tests"
          meta={<RunTests entry={entry} onDone={onTested} />}
          pad
        >
          <SuiteSummary
            cases={entry.tests.cases}
            run={entry.tests.latest}
            testId="lab-tests-summary"
          />
        </Card>
      </div>
    </div>
  );
}

function LabWorkflow({ bundle, version }: { bundle: AgentBundle | null; version: number | null }) {
  const first = bundle?.workflows[0];
  if (!bundle || !first) {
    return <p className="px-6 py-5 text-sm text-ink-muted">No workflows yet.</p>;
  }
  const more = bundle.workflows.length - 1;
  return (
    <div className="px-6 py-4">
      <p className="mb-3 text-sm text-ink-muted">
        {first.name}
        {version ? ` · v${version}` : ""}
        {more > 0 ? ` · and ${plural(more, "more workflow")}` : ""}
      </p>
      <StepList steps={workflowStepItems(first.workflow)} testId="lab-steps" />
    </div>
  );
}

function usedByChip(u: UsedBy) {
  if (!u.agent.liveVersionId) return <StatusChip state="idle">Not live</StatusChip>;
  if (!u.agent.linked) return <StatusChip state="idle">Detached</StatusChip>;
  if (u.behind > 0) return <StatusChip state="waiting">{u.behind} behind</StatusChip>;
  return <StatusChip state="done">Current</StatusChip>;
}

function WhereItRuns({ templateId }: { templateId: string }) {
  const res = useApi(apiRoutes.opsUsedBy, { params: { id: templateId } });
  const slow = useSlow(res.loading && !res.data);
  return (
    <Card
      title="Where it runs"
      meta={<span className="text-sm text-ink-muted">Lineage</span>}
      testId="lab-used-by"
    >
      {res.error ? (
        <div className="px-6 py-4">
          <ErrorNotice error={res.error} onRetry={res.reload} />
        </div>
      ) : null}
      {!res.data && !res.error ? (
        slow ? (
          <div
            className="flex flex-wrap items-center gap-3 px-6 py-4"
            data-testid="lab-used-by-slow"
          >
            <p className="text-sm text-ink-muted">
              This is taking longer than it should. Your clients' copies are still on their way.
            </p>
            <Button size="sm" variant="ghost" onClick={res.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="px-6">
            <Loading />
          </div>
        )
      ) : null}
      {res.data && res.data.agents.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          No client has a copy yet. Assign it to a client to fork it in as that client's own agent.
        </p>
      ) : null}
      {res.data && res.data.agents.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {res.data.agents.map((u) => (
            <li
              key={u.agent.id}
              className="flex items-start gap-3 px-6 py-4"
              data-testid={`lab-used-by-${u.agent.id}`}
            >
              <AgentBadge name={u.agent.name} seed={u.agent.id} size="sm" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link
                  to={`/ops/clients/${u.client.id}/agents/${u.agent.slug}`}
                  className="font-medium text-ink hover:underline"
                >
                  {u.client.name}'s copy · {u.agent.serviceName ?? u.agent.name}
                </Link>
                <span className="text-sm text-ink-muted">
                  {u.baseVersion ? `From v${u.baseVersion}` : "Forked"}
                  {" · "}
                  {u.customizations > 0
                    ? plural(u.customizations, "client change")
                    : "no client changes"}
                  {u.conflicts ? ` · ${plural(u.conflicts, "conflict")} to settle` : ""}
                </span>
                {u.agent.linked && u.behind > 0 && res.data?.templateLiveVersion ? (
                  <Link
                    to={`/ops/agents/${u.agent.id}/merge?mode=update`}
                    className="text-sm text-link hover:underline"
                    data-testid={`lab-used-by-${u.agent.id}-merge`}
                  >
                    Update it from template v{res.data.templateLiveVersion}
                  </Link>
                ) : null}
                {u.customizations > 0 && u.agent.liveVersionId ? (
                  <Link
                    to={`/ops/agents/${u.agent.id}/merge?mode=promote`}
                    className="text-sm text-link hover:underline"
                    data-testid={`lab-used-by-${u.agent.id}-promote`}
                  >
                    Promote its changes to the template
                  </Link>
                ) : null}
              </div>
              {usedByChip(u)}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function ClientViewCard({ agentId }: { agentId: string }) {
  const res = useApi(apiRoutes.opsAgentClientView, { params: { id: agentId } });
  return (
    <Card
      title="Client view"
      testId="lab-client-view"
      meta={res.data?.clientView?.panels.length ? <Tag>Custom</Tag> : null}
      pad
    >
      {res.error ? <ErrorNotice error={res.error} onRetry={res.reload} /> : null}
      {!res.data && !res.error ? <Loading /> : null}
      {res.data ? (
        res.data.clientView && res.data.clientView.panels.length > 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">
              Panels this template adds to the client's agent page. They travel with every fork.
            </p>
            {res.data.clientView.panels.map((p) => {
              const kpis = res.data?.clientView?.kpis ?? [];
              return (
                <div key={p.id} className="rounded-md bg-surface-subtle px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <b className="font-medium text-ink">
                      {p.kind === "kpis"
                        ? p.kpis
                            .map((id) => {
                              const k = kpis.find((x) => x.id === id);
                              return k ? pickLocalized(k.label) : id;
                            })
                            .join(", ")
                        : p.report}
                    </b>
                    <span className="text-sm text-ink-muted">
                      {p.kind === "kpis"
                        ? plural(p.kpis.length, "figure")
                        : `${p.pack} · pack report`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            {res.data.versionId
              ? "No panels: the client's agent page shows its runs and changes only."
              : "Publish a version to set what the client's agent page shows."}
          </p>
        )
      ) : null}
    </Card>
  );
}

function RunTests({ entry, onDone }: { entry: LabTemplate; onDone(): void }) {
  const action = useAction();
  const versionId = entry.agent.latestVersionId;
  const version = entry.agent.latestVersion;
  if (!versionId || entry.tests.cases === 0) return null;
  return (
    <span className="flex items-center gap-2">
      {action.error ? (
        <span className="text-sm text-risk" role="alert">
          {errorText(action.error)}
        </span>
      ) : null}
      <Button
        size="sm"
        data-testid="lab-run-tests"
        disabled={action.busy}
        onClick={async () => {
          const res = await action.call(apiRoutes.opsRunTests, {
            body: { targetKind: "template", targetId: entry.agent.id, versionId },
          });
          if (res.ok) onDone();
        }}
      >
        {action.busy ? "Running…" : `Run v${version}`}
      </Button>
    </span>
  );
}

function AssignForm({
  templateId,
  version,
  onCancel,
}: {
  templateId: string;
  version: number | null;
  onCancel(): void;
}) {
  const clients = useApi(apiRoutes.opsClients);
  const [clientId, setClientId] = useState("");
  const action = useAction();
  const navigate = useNavigate();
  const choices = (clients.data?.clients ?? []).filter((c) => !c.sandbox);
  const chosen = clientId || choices[0]?.id || "";

  async function assign() {
    if (!chosen) return;
    const res = await action.call(apiRoutes.opsFork, {
      params: { id: templateId },
      body: { clientId: chosen },
    });
    if (res.ok) {
      notifyAgentsChanged();
      navigate(`/ops/clients/${chosen}/agents/${res.data.agent.slug}`, {
        state: handOver(res.data.agent.id),
      });
    }
  }

  return (
    <div
      className="flex flex-col gap-3 border-t border-line px-6 py-4"
      data-testid="lab-assign-form"
    >
      <p className="text-sm text-ink-muted">
        Forks v{version} into the client as its own agent, as a draft: bind its connections, test it
        there, then start its trial.
      </p>
      {clients.error ? <ErrorNotice error={clients.error} onRetry={clients.reload} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Client"
          className="w-64"
          data-testid="lab-assign-client-select"
          value={chosen}
          onChange={(e) => setClientId(e.target.value)}
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button
          variant="primary"
          size="sm"
          data-testid="lab-assign-confirm"
          disabled={action.busy || !chosen}
          onClick={assign}
        >
          {action.busy ? "Assigning…" : "Assign"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {action.error ? <Notice tone="warning">{errorText(action.error)}</Notice> : null}
    </div>
  );
}
