// The agent Overview tab (design screen 7, without pack KPIs): how it works as step chips from the
// version shown, its mission, the tools it works in, the skills it uses, and its latest runs.
import type { AgentBundle, SkillOption } from "@countersign/core";
import { Link } from "react-router-dom";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { runStatusLabel, runStatusTone, shortTime } from "../../runs/format";
import { Icon } from "../../ui/icons";
import {
  Badge,
  Card,
  ErrorNotice,
  Loading,
  SectionLabel,
  StepKindTag,
  Tag,
} from "../../ui/primitives";
import { KIND_LABEL, triggerTitle, workflowStats } from "../workflow/describe";
import { optionFor } from "./definition-form";
import { plural } from "./ui";

export function OverviewTab({
  agent,
  bundle,
  base,
  skills,
}: {
  agent: AgentSummary;
  bundle: AgentBundle;
  /** The agent page's URL. */
  base: string;
  skills: readonly SkillOption[];
}) {
  const stats = workflowStats(bundle);
  const extraTools = bundle.definition.extraTools;
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
        <Card title="Mission" pad>
          <p className="text-lg text-ink">
            {bundle.definition.identity.mission || "No mission written yet."}
          </p>
        </Card>
        {agent.kind === "client" ? <LatestRuns agentId={agent.id} /> : <TemplateRunsNote />}
      </div>
      <Card className="h-fit" title="Works in" pad>
        {agent.kind === "client" ? (
          <Chips
            testId="agent-works-in"
            items={Object.keys(agent.bindings)}
            empty="No connections bound yet."
          />
        ) : (
          <p className="text-sm text-ink-muted">
            Each client agent forked from it is bound to that client's own connections.
          </p>
        )}
        {extraTools.length > 0 ? (
          <div className="mt-4">
            <SectionLabel>Extra tools</SectionLabel>
            <Chips items={extraTools} empty="" />
          </div>
        ) : null}
        <div className="mt-4">
          <SectionLabel>Skills it uses</SectionLabel>
          <Chips
            testId="agent-skills"
            items={bundle.definition.skills.map((s) => optionFor(s.skill, skills)?.name ?? s.skill)}
            empty="No skills."
          />
        </div>
      </Card>
    </div>
  );
}

function StepChips({ workflow }: { workflow: AgentBundle["workflows"][number] }) {
  const w = workflow.workflow;
  return (
    <div className="mb-3 last:mb-0" data-testid={`agent-chips-${workflow.slug}`}>
      <p className="mb-2 text-sm font-medium text-ink">
        {workflow.name}
        {workflow.enabled ? "" : <span className="ml-2 text-ink-muted">off</span>}
      </p>
      <ol className="flex flex-wrap items-center gap-2">
        <Chip kindId="trigger" kind={KIND_LABEL.trigger} label={triggerTitle(w.trigger)} />
        {w.steps.map((s) => (
          <Chip key={s.id} kindId={s.kind} kind={KIND_LABEL[s.kind]} label={s.name} />
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
      {items.map((i) => (
        <Tag key={i}>{i}</Tag>
      ))}
    </div>
  );
}

/** The agent's runs, newest first (live and test). */
export function LatestRuns({ agentId, limit = 5 }: { agentId: string; limit?: number }) {
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
                  {r.workflowSlug}
                </Link>
                {r.mode === "test" ? <Tag>Test</Tag> : null}
              </span>
              <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
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
        client; its client agents run in their own clients.
      </p>
    </Card>
  );
}
