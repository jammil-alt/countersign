// The agent Overview tab (design screen 7, without pack KPIs): how it works as step chips from the
// version shown, its mission, the tools it works in, the skills it uses, and its latest runs.
import type { AgentBundle, SkillOption } from "@countersign/core";
import { Link } from "react-router-dom";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Badge, Card, ErrorNotice, Loading, SectionLabel, type Tone } from "../../ui/primitives";
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
        <Card className="p-5" testId="agent-how-it-works">
          <SectionLabel
            action={
              bundle.workflows.length > 0 ? (
                <Link to={`${base}/workflow`} className="text-sm text-link underline">
                  Open workflow
                </Link>
              ) : null
            }
          >
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
          <p className="font-serif text-[17px] text-body">
            {bundle.definition.identity.mission || "No mission written yet."}
          </p>
        </Card>
        {agent.kind === "client" ? <LatestRuns agentId={agent.id} /> : <TemplateRunsNote />}
      </div>
      <Card className="h-fit p-5">
        <SectionLabel>Works in</SectionLabel>
        {agent.kind === "client" ? (
          <Chips
            testId="agent-works-in"
            items={Object.keys(agent.bindings)}
            empty="No connections bound yet."
          />
        ) : (
          <p className="text-sm text-secondary">
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
      <p className="mb-2 text-sm font-medium text-primary">
        {workflow.name}
        {workflow.enabled ? "" : <span className="ml-2 text-secondary">off</span>}
      </p>
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
    <li className="flex items-center gap-2 rounded-sm border border-edge px-2 py-1 text-sm text-primary after:ml-1 after:text-secondary after:content-['→'] last:after:content-none">
      <span className="label-caps text-[10px] text-secondary">{kind}</span>
      {label}
    </li>
  );
}

function Chips({ items, empty, testId }: { items: string[]; empty: string; testId?: string }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-secondary" data-testid={testId}>
        {empty}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
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

const STATUS_TONE: Record<string, Tone> = {
  succeeded: "positive",
  failed: "warning",
  cancelled: "neutral",
  waiting: "accent",
  running: "accent",
  queued: "neutral",
};

/** The agent's runs, newest first (live and test). */
export function LatestRuns({ agentId, limit = 5 }: { agentId: string; limit?: number }) {
  const runs = useApi(apiRoutes.opsRuns, { query: { agent: agentId, limit } });
  return (
    <Card className="p-5" testId="agent-latest-runs">
      <SectionLabel>{limit > 5 ? "Runs" : "Latest runs"}</SectionLabel>
      {runs.error ? <ErrorNotice error={runs.error} onRetry={runs.reload} /> : null}
      {!runs.data && !runs.error ? <Loading /> : null}
      {runs.data && runs.data.runs.length === 0 ? (
        <p className="text-sm text-secondary">No runs yet.</p>
      ) : null}
      {runs.data && runs.data.runs.length > 0 ? (
        <ul className="flex flex-col divide-y divide-divider">
          {runs.data.runs.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="flex min-w-0 items-center gap-3">
                <span className="font-mono text-xs text-secondary">
                  {(r.startedAt ?? r.createdAt).slice(5, 16).replace("T", " ")}
                </span>
                <Link to={`/ops/runs/${r.id}`} className="truncate text-primary hover:underline">
                  {r.workflowSlug}
                </Link>
                {r.mode === "test" ? <Badge tone="neutral">test</Badge> : null}
              </span>
              <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function TemplateRunsNote() {
  return (
    <Card className="p-5">
      <SectionLabel>Runs</SectionLabel>
      <p className="text-sm text-secondary">
        A template never runs for a client. Its test runs run as its test copy in the Sandbox
        client; its client agents run in their own clients.
      </p>
    </Card>
  );
}
