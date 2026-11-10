// The agent Overview tab (design screen 7, without pack KPIs): how it works as step chips from the
// version shown, its mission, the tools it works in, the skills it uses, and its latest runs.
// Connections, tools and skills read by their names, never their ids; empty parts are left out.
import { type AnyAgentBundle, allTriggers, processes, type SkillOption } from "@countersign/core";
import { Link } from "react-router-dom";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Icon } from "../../ui/icons";
import { Card, ErrorNotice, Loading, SectionLabel, StepKindTag, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { toolTitle } from "../builder/model";
import { runChip } from "../run/words";
import { KIND_LABEL, PROCESS_KIND_LABEL, triggerTitle, workflowStats } from "../workflow/describe";
import { optionFor } from "./definition-form";
import { useConnectorNames } from "./OperationPanel";
import { plural } from "./ui";

export function OverviewTab({
  agent,
  bundle,
  base,
  skills,
}: {
  agent: AgentSummary;
  bundle: AnyAgentBundle;
  /** The agent page's URL. */
  base: string;
  skills: readonly SkillOption[];
}) {
  const stats = workflowStats(bundle);
  const names = useConnectorNames(agent.id);
  // A tool by what it does and where: "Update lines bill · QuickBooks Online".
  const tools = toolsItWorksIn(bundle).map(
    (id) => `${toolTitle({ id })} · ${names(id.split(".")[0] ?? id)}`,
  );
  const worksIn = agent.kind === "client" ? Object.keys(agent.bindings).map(names) : [];
  const skillNames = bundle.definition.skills.map(
    (s) => optionFor(s.skill, skills)?.name ?? "A skill this agent can't use",
  );
  const workflowNames = new Map(bundle.workflows.map((w) => [w.slug, w.name] as const));
  const mission = bundle.definition.identity.mission.trim();
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-5">
        <Card
          testId="agent-how-it-works"
          pad
          title={`How it works · ${plural(stats.steps, "step")}, ${plural(stats.forks, "fork")}`}
          meta={
            bundle.workflows.length > 0 ? (
              <Link to={`${base}/workflow`} className="text-sm text-link">
                Open workflow
              </Link>
            ) : null
          }
        >
          {bundle.workflows.length === 0 ? (
            <p className="text-ink-muted">No workflows: this agent answers asks and commands.</p>
          ) : (
            bundle.workflows.map((w) => <StepChips key={w.slug} workflow={w} />)
          )}
        </Card>
        {mission ? (
          <Card title="Mission" pad>
            <p className="text-lg text-ink">{mission}</p>
          </Card>
        ) : null}
        {agent.kind === "client" ? (
          <LatestRuns agentId={agent.id} workflowNames={workflowNames} />
        ) : (
          <TemplateRunsNote />
        )}
      </div>
      <Card className="h-fit" title="Works in" pad>
        <div className="flex flex-col gap-4">
          {agent.kind === "client" ? (
            <Chips testId="agent-works-in" items={worksIn} empty="No connections bound yet." />
          ) : (
            <p className="text-sm text-ink-muted">
              Each client's copy is bound to that client's own connections.
            </p>
          )}
          {tools.length > 0 ? (
            <div>
              <SectionLabel>Tools</SectionLabel>
              <Chips testId="agent-tools" items={tools} empty="" />
            </div>
          ) : null}
          {skillNames.length > 0 ? (
            <div>
              <SectionLabel>Skills it uses</SectionLabel>
              <Chips testId="agent-skills" items={skillNames} empty="" />
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

/**
 * The tools the agent works in: its definition's extra tools, then the tools of its v4 processes'
 * read and write steps at any depth (a process names its tools on its steps, not in the
 * definition), each once.
 */
export function toolsItWorksIn(bundle: AnyAgentBundle): string[] {
  const ids = [...bundle.definition.extraTools];
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion !== 4) continue;
    for (const { step } of processes.allSteps(w.workflow)) {
      if (step.kind === "read" || step.kind === "write") ids.push(step.tool);
    }
  }
  return [...new Set(ids)];
}

/**
 * A workflow's first trigger and its top-level steps as chips. R8: a v4 process too, its steps in
 * the builder's words (an `if`, a write).
 */
function StepChips({ workflow }: { workflow: AnyAgentBundle["workflows"][number] }) {
  const w = workflow.workflow;
  const first = allTriggers(w)[0];
  const steps =
    w.schemaVersion === 4
      ? w.steps.map((s) => ({
          id: s.id,
          kind: s.kind,
          label: PROCESS_KIND_LABEL[s.kind],
          name: s.name,
        }))
      : w.steps.map((s) => ({ id: s.id, kind: s.kind, label: KIND_LABEL[s.kind], name: s.name }));
  return (
    <div className="mb-3 last:mb-0" data-testid={`agent-chips-${workflow.slug}`}>
      <p className="mb-2 text-sm font-medium text-ink">
        {workflow.name}
        {workflow.enabled ? "" : <span className="ml-2 text-ink-muted">off</span>}
      </p>
      <ol className="flex flex-wrap items-center gap-2">
        {first ? (
          <Chip kindId="trigger" kind={KIND_LABEL.trigger} label={triggerTitle(first)} />
        ) : null}
        {steps.map((s) => (
          <Chip key={s.id} kindId={s.kind} kind={s.label} label={s.name} />
        ))}
      </ol>
    </div>
  );
}

function Chip({ kindId, kind, label }: { kindId: string; kind: string; label: string }) {
  return (
    <li className="group flex items-center gap-2 text-sm text-ink">
      <span className="flex items-center gap-2 rounded-sm border border-line px-2 py-1">
        <StepKindTag kind={kindId} label={kind} />
        {label}
      </span>
      <Icon name="arrow" className="text-ink-muted group-last:hidden" />
    </li>
  );
}

function Chips({ items, empty, testId }: { items: string[]; empty: string; testId?: string }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid={testId}>
        {empty}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {[...new Set(items)].map((i) => (
        <Tag key={i}>{i}</Tag>
      ))}
    </div>
  );
}

/**
 * The agent's runs, newest first (live and test), each with its state as the runs list shows it: a
 * run waiting on a person is "Waiting for approval" and says on whom (UI cleanup, stream A).
 */
export function LatestRuns({
  agentId,
  limit = 5,
  workflowNames,
}: {
  agentId: string;
  limit?: number;
  /** Workflow names by slug: a run reads by its workflow's name, not its slug. */
  workflowNames?: ReadonlyMap<string, string>;
}) {
  const runs = useApi(apiRoutes.opsRuns, { query: { agent: agentId, limit } });
  return (
    <Card testId="agent-latest-runs" title={limit > 5 ? "Runs" : "Latest runs"} pad>
      {runs.error ? <ErrorNotice error={runs.error} onRetry={runs.reload} /> : null}
      {!runs.data && !runs.error ? <Loading /> : null}
      {runs.data && runs.data.runs.length === 0 ? (
        <p className="text-sm text-ink-muted">No runs yet.</p>
      ) : null}
      {runs.data && runs.data.runs.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {runs.data.runs.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="flex min-w-0 items-center gap-3">
                <span className="w-28 shrink-0 text-sm text-ink-muted figures">
                  {shortTime(r.startedAt ?? r.createdAt)}
                </span>
                <Link to={`/ops/runs/${r.id}`} className="truncate text-ink hover:underline">
                  {r.workflowName ??
                    workflowNames?.get(r.workflowSlug) ??
                    r.workflowSlug.replace(/[-_]+/g, " ")}
                </Link>
                {r.mode === "test" ? <Tag>Test</Tag> : null}
              </span>
              <StatusChip state={runChip(r).state} testId={`agent-run-${r.id}-status`}>
                {runChip(r).words}
              </StatusChip>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function TemplateRunsNote() {
  return (
    <Card title="Runs" pad>
      <p className="text-sm text-ink-muted">
        A template never runs for a client. Its test runs run as its test copy in the Sandbox
        client; each client's copy runs in its own client.
      </p>
    </Card>
  );
}
