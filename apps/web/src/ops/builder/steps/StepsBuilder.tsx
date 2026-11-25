// The workflow builder for a step-model workflow (docs/step-model-plan.md §2 principle 6: same
// screens, navigation and flows as the v4 builder; only the step forms, the groupings in the
// pickers and what the new structure needs). One workflow of an agent's version, `schemaVersion: 5`:
// the chart (the builder's own, `../../flow`), the bar, the step's side panel with its form and Data
// tab, the palette of eight kinds, the workflow's outputs next to the triggers, and Publish, which
// shows `validateWorkflow`'s issues on their steps and refuses while any remain.
//
// Not here yet (wave 1 stops at the forms): Try it and the Builder chat on a v5 draft need stream A's
// executor and bundle, and the List shows the same boxes as the chart.

import { type AgentBundle, canonicalJson, steps, uuidv7 } from "@countersign/core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../../api/routes";
import { useApi } from "../../../api/useApi";
import { Badge, Button, ErrorNotice } from "../../../ui/primitives";
import { Skeleton, SkeletonBlock } from "../../../ui/skeleton";
import { detailMessages, errorText, Notice, useAction } from "../../agents/ui";
import { Chart } from "../../flow/Chart";
import { FlowBar, type FlowView } from "../../flow/FlowBar";
import "../../flow/flow.css";
import { FLOW_START_ID } from "../../flow/layout";
import { StepPanel } from "../../flow/StepPanel";
import { StepTable } from "../../flow/StepTable";
import type { FlowEnds, InsertPoint } from "../../flow/types";
import { triggerTitle } from "../../workflow/describe";
import { addWorkflow } from "../model";
import type { Member, People } from "../people";
import { AddWorkflowForm, WorkflowSwitcher } from "../workflow-switcher";
import { triggerFields, useStepsCatalog } from "./catalog";
import { translateAll } from "./data";
import { type BoxWords, boxWords, displayProcess } from "./display";
import type { SaveAsSkill, StepFormEnv } from "./form-kit";
import { canRedo, canUndo, commit, redo, startHistory, undo } from "./history";
import { canPublish, issuesByStep, publishSummary, workflowIssues } from "./issues";
import {
  canRemove,
  findStep,
  insertStep,
  kindLabel,
  moveStep,
  newStep,
  PALETTE,
  ROOT,
  removeStep,
  updateStep,
  walk,
} from "./model";
import { OutputsEditor } from "./OutputsEditor";
import { StepEditor } from "./StepEditor";
import { statusesFor, stepCounts } from "./status";
import { guardedSuggestion, type SuggestFn, suggestBody, withStep } from "./suggest";
import type { Step, StepKind, Workflow } from "./types";
import { hasWrittenSteps, withStepSkillPins } from "./written";

export interface StepsBuilderProps {
  agent: AgentSummary;
  /** The version the builder opens. */
  from: VersionDetail;
  /** That version's bundle as stored. */
  bundle: unknown;
  /** The workflow's slug from the URL. */
  workflow: string;
  base: string;
  tabs: ReactNode;
  above?: ReactNode;
  members?: readonly Member[];
  onChanged(): void;
  view?: "canvas" | "steps";
}

interface StoredBundle {
  workflows: { slug: string; workflow: unknown; [k: string]: unknown }[];
  [k: string]: unknown;
}

/** Whether a stored workflow is in the step model (`schemaVersion: 5`). */
export function isStepModelWorkflow(bundle: unknown, slug: string): boolean {
  const entry = (bundle as StoredBundle | null)?.workflows?.find((w) => w.slug === slug);
  return (entry?.workflow as { schemaVersion?: unknown } | undefined)?.schemaVersion === 5;
}

/** The bundle with one workflow replaced; the rest as stored. */
export function withWorkflow(bundle: unknown, slug: string, workflow: Workflow): unknown {
  const b = bundle as StoredBundle;
  return { ...b, workflows: b.workflows.map((w) => (w.slug === slug ? { ...w, workflow } : w)) };
}

export default function StepsBuilder(props: StepsBuilderProps) {
  const entry = (props.bundle as StoredBundle).workflows.find((w) => w.slug === props.workflow);
  const parsed = useMemo(() => steps.Workflow.safeParse(entry?.workflow), [entry]);
  const catalog = useStepsCatalog(props.agent.id);
  const hours = useApi(
    apiRoutes.opsClientHours,
    props.agent.kind === "client" && props.agent.tenantId
      ? { params: { id: props.agent.tenantId } }
      : null,
  );
  const people = useMemo<People>(
    () => ({
      members: props.members ?? [],
      people: (hours.data?.people ?? []).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    }),
    [props.members, hours.data],
  );
  const handoff = useApi(
    apiRoutes.opsClientHandoffAgents,
    props.agent.kind === "client" && props.agent.tenantId
      ? { params: { id: props.agent.tenantId } }
      : null,
  );
  const frame = (child: ReactNode) => (
    <div>
      <div className="overflow-x-auto">{props.tabs}</div>
      {props.above ? <div className="pt-4">{props.above}</div> : null}
      <div className="pt-6">{child}</div>
    </div>
  );
  if (!parsed.success) {
    return frame(
      <Notice tone="warning">
        This workflow doesn't read in the step model:{" "}
        {parsed.error.issues[0]?.message ?? "see its JSON"}.
      </Notice>,
    );
  }
  if (catalog.error) return frame(<ErrorNotice error={catalog.error} onRetry={catalog.reload} />);
  if (!catalog.ready) {
    return frame(
      <Skeleton label="Loading actions, skills and models…" testId="builder-skeleton">
        <SkeletonBlock height={480} />
      </Skeleton>,
    );
  }
  return (
    <Body
      // Another workflow of the agent is another chart, with its own history.
      key={props.workflow}
      {...props}
      start={parsed.data}
      catalog={catalog}
      people={people}
      handoffAgents={(handoff.data?.agents ?? [])
        .filter((a) => a.slug !== props.agent.slug)
        .map((a) => ({ slug: a.slug, name: a.name }))}
      frame={frame}
    />
  );
}

function Body(
  props: StepsBuilderProps & {
    start: Workflow;
    catalog: ReturnType<typeof useStepsCatalog>;
    people: People;
    handoffAgents: readonly { slug: string; name: string }[];
    frame(child: ReactNode): ReactNode;
  },
) {
  const { agent, from, catalog } = props;
  const action = useAction();
  const navigate = useNavigate();
  // The agent's workflows to switch to, and "+ Workflow" (the v4 builder's, `../workflow-switcher`).
  const [adding, setAdding] = useState(false);
  const workflows = useMemo(
    () => (props.bundle as { workflows: { slug: string; name: string; enabled?: boolean }[] }).workflows,
    [props.bundle],
  );
  // Stream G: every Do step's incoming side worked out on load, opened or not; what changes shows
  // as unsaved, as an edit would.
  const [history, setHistory] = useState(() =>
    startHistory(
      translateAll(props.start, catalog.uses, triggerFields(props.start, catalog.events)),
    ),
  );
  const workflow = history.present;
  const edit = useCallback((next: Workflow) => setHistory((h) => commit(h, next)), []);
  const [saved, setSaved] = useState({
    id: from.id,
    version: from.version,
    status: from.status,
    canon: canonicalJson(props.start),
  });
  const dirty = canonicalJson(workflow) !== saved.canon;
  const [selection, setSelection] = useState<string | null>(null);
  const [addAt, setAddAt] = useState<InsertPoint | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<FlowView>(props.view === "steps" ? "list" : "chart");
  const [notice, setNotice] = useState<{ tone: "positive" | "warning"; body: string } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const api = useRef(action);
  api.current = action;

  const issues = useMemo(() => workflowIssues(workflow, catalog.uses), [workflow, catalog.uses]);
  const byStep = useMemo(() => issuesByStep(issues), [issues]);
  const statuses = useMemo(() => statusesFor(issues), [issues]);
  const counts = useMemo(() => stepCounts(workflow, catalog.uses), [workflow, catalog.uses]);
  const process = useMemo(() => displayProcess(workflow, catalog.uses), [workflow, catalog.uses]);
  const label = useCallback(
    (s: { id: string }) => {
      const real = findStep(workflow, s.id)?.step;
      const w: BoxWords = real
        ? boxWords(real, catalog.uses, workflow)
        : { title: "", kind: "", detail: null };
      return { ...w, detail: w.detail };
    },
    [workflow, catalog.uses],
  );

  // Suggest: the workflow as drawn goes with the step the form holds (the route's shape).
  const suggest = useCallback<SuggestFn>(
    async (request) => {
      const res = await api.current.call(apiRoutes.opsStepSuggest, {
        params: { id: agent.id },
        body: suggestBody(workflow, request),
      });
      if (!res.ok) throw new Error("suggest failed");
      return guardedSuggestion(res.data, request.step);
    },
    [agent.id, workflow],
  );
  // Save as skill: a template's skills are shared (it is no client's); a client agent's may be
  // its client's only or shared. The skill is in the library and the Uses picker at once.
  const saveAsSkill = useMemo<SaveAsSkill>(
    () => ({
      scopes: agent.kind === "client" ? ["client", "shared"] : ["shared"],
      run: async (request) => {
        const res = await api.current.call(apiRoutes.opsStepSaveAsSkill, {
          params: { id: agent.id },
          body: {
            workflow: withStep(workflow, request.step),
            stepId: request.step.id,
            name: request.name,
            description: request.description,
            scope: request.scope,
          },
        });
        if (!res.ok) throw new Error(errorText(res.error));
        catalog.reload();
        return res.data.step as Step;
      },
    }),
    [agent.id, agent.kind, workflow, catalog],
  );
  const env = useMemo<StepFormEnv>(
    () => ({
      workflow,
      uses: catalog.uses,
      trigger: triggerFields(workflow, catalog.events),
      people: props.people,
      suggest,
      models: catalog.models,
      agents: props.handoffAgents,
      saveAsSkill,
    }),
    [workflow, catalog, props.people, suggest, props.handoffAgents, saveAsSkill],
  );

  const selected = selection ? (findStep(workflow, selection)?.step ?? null) : null;

  // ── The chart's events ──
  const add = (kind: StepKind) => {
    const at = addAt ?? { container: ROOT, index: Math.max(0, workflow.steps.length - 1) };
    const step = newStep(kind);
    edit(insertStep(workflow, at, step));
    setAddAt(null);
    setSelection(step.id);
  };
  const addPath = (forkId: string) =>
    edit(
      updateStep(workflow, forkId, (s) =>
        s.kind === "fork"
          ? {
              ...s,
              paths: [
                ...s.paths,
                { id: uuidv7(), name: "", when: { match: "all", rules: [] }, steps: [] },
              ],
            }
          : s,
      ),
    );

  // ── Save and publish ──
  const save = async (added: AgentBundle["workflows"] = [], note?: string) => {
    const snapshot = workflow;
    let bundle = withWorkflow(props.bundle, props.workflow, snapshot);
    if (added.length > 0) {
      const b = bundle as { workflows: unknown[] };
      bundle = { ...b, workflows: [...b.workflows, ...added] };
    }
    // The rules and the AI written in steps are stored behind them, as drafts of the agent's own
    // skills, and this version pins them, so what ran is what the version says. Nothing is saved
    // if they can't be stored: a version that names no text would run nothing.
    if (hasWrittenSteps(snapshot)) {
      const stored = await action.call(apiRoutes.opsStepSkillsStore, {
        params: { id: agent.id },
        body: { workflow: snapshot },
      });
      if (!stored.ok) {
        setNotice({
          tone: "warning",
          body: `Not saved: the rules or AI written in a step couldn't be stored as skills. ${errorText(stored.error)}`,
        });
        return null;
      }
      bundle = withStepSkillPins(
        bundle,
        agent.id,
        stored.data.skills.map((s) => s.pin),
      );
    } else {
      bundle = withStepSkillPins(bundle, agent.id, []);
    }
    const res = await action.call(apiRoutes.opsSaveVersion, {
      params: { id: agent.id },
      body: {
        bundle: bundle as never,
        parentVersionId: saved.id,
        changeNote: note ?? "Edited in the workflow builder",
      },
    });
    if (!res.ok) return null;
    const next = {
      id: res.data.version.id,
      version: res.data.version.version,
      status: res.data.version.status,
      canon: canonicalJson(snapshot),
    };
    setSaved(next);
    props.onChanged();
    return next;
  };
  const publish = async () => {
    if (!canPublish(issues)) {
      setShowIssues(true);
      return;
    }
    const v = dirty ? await save() : saved;
    if (!v) return;
    const res = await action.call(apiRoutes.opsPublish, { params: { id: agent.id, vid: v.id } });
    if (res.ok) {
      setSaved((s) => ({ ...s, id: res.data.version.id, status: "live" }));
      setNotice({ tone: "positive", body: `Published v${res.data.version.version}.` });
      props.onChanged();
    }
  };

  const ends = useMemo<FlowEnds>(
    () => ({
      start: {
        title: "Starts when",
        lines: workflow.triggers.map((t) => triggerTitle(t as never)),
      },
      givesBack: null,
    }),
    [workflow.triggers],
  );

  // Undo and redo from the keyboard, as the v4 builder does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const target = e.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      e.preventDefault();
      setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stepName = (id: string) => findStep(workflow, id)?.step.name.trim() || "A step";
  const open = { issues: statuses.size, questions: 0 };
  const nextOpen = () => {
    const first = walk(workflow).find((l) => statuses.has(l.step.id));
    if (first) setSelection(first.step.id);
  };

  return props.frame(
    // One frame at least as tall as the window under the header, ending the page as the v4
    // builder's does (`builder-frame`: the walkthrough checks the page scrolls no further).
    <div
      className="-mb-8 flex min-h-[calc(100vh-var(--header-h))] flex-col gap-3 md:-mb-12"
      data-testid="builder-frame"
    >
      <div className="contents" data-testid="steps-builder">
        <FlowBar
          lead={
            <WorkflowSwitcher
              workflows={workflows}
              current={props.workflow}
              base={props.base}
              adding={adding}
              onAdd={() => setAdding((a) => !a)}
              view={view}
            />
          }
          name={agent.serviceName ?? agent.name}
          version={
            dirty
              ? { state: "unsaved", version: saved.version }
              : { state: saved.status === "live" ? "live" : "draft", version: saved.version }
          }
          counts={{ ...counts }}
          open={open}
          onNextOpen={nextOpen}
          view={view}
          onView={setView}
          canUndo={canUndo(history)}
          canRedo={canRedo(history)}
          onUndo={() => setHistory(undo)}
          onRedo={() => setHistory(redo)}
          onSave={() => void save()}
          saving={action.busy}
          saved={!dirty}
          primary={
            <Button
              variant="primary"
              size="sm"
              data-testid="steps-publish"
              disabled={action.busy || (!dirty && saved.status === "live")}
              title={canPublish(issues) ? undefined : publishSummary(issues)}
              onClick={() => void publish()}
            >
              Publish
            </Button>
          }
        />
        {adding ? (
          <AddWorkflowForm
            bundle={{ workflows }}
            events={catalog.events.map((e) => e.type)}
            onCancel={() => setAdding(false)}
            onCreate={async (input) => {
              // A new workflow starts in the step model, saved at once with any edits here, then
              // opened (the builder opens a saved version).
              const ok = await save([addWorkflow(input)], `Added the workflow ${input.name}`);
              if (!ok) return;
              setAdding(false);
              navigate(`${props.base}/${view === "list" ? "steps" : "workflows"}/${input.slug}`);
            }}
          />
        ) : null}
        {notice ? <Notice tone={notice.tone}>{notice.body}</Notice> : null}
        {action.error ? (
          <Notice tone="warning" testId="builder-error">
            {errorText(action.error)}
            {detailMessages(action.error).length ? (
              <ul className="mt-2 list-disc pl-5">
                {detailMessages(action.error).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}
        {showIssues || !canPublish(issues) ? (
          <PublishIssues
            issues={issues}
            show={showIssues}
            name={stepName}
            outputName={(id) => workflow.outputs.find((o) => o.id === id)?.name ?? id}
            onToggle={() => setShowIssues((s) => !s)}
            onPick={(id) => {
              if (findStep(workflow, id)) setSelection(id);
            }}
          />
        ) : null}
        <details open data-testid="steps-outputs" className="border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-ink">
            Outputs · {workflow.outputs.length}
            <span className="ml-2 text-xs font-normal text-ink-muted">
              What this workflow promises: every End delivers one or more of them.
            </span>
          </summary>
          <div className="px-4 pb-4">
            <OutputsEditor
              workflow={workflow}
              env={env}
              issues={issues.filter(
                (i) => i.at !== undefined && workflow.outputs.some((o) => o.id === i.at),
              )}
              onChange={edit}
            />
          </div>
        </details>
        <div className="flex flex-1 gap-3">
          <div className="min-w-0 flex-1 border border-line bg-surface" data-testid="steps-canvas">
            {view === "chart" ? (
              <Chart
                process={process}
                ends={ends}
                statuses={statuses}
                selected={selection}
                folded={folded}
                onFold={(id, fold) =>
                  setFolded((f) => {
                    const next = new Set(f);
                    if (fold) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
                label={label as never}
                onSelect={setSelection}
                onInsert={(at) => setAddAt(at)}
                onMove={(id, to) => edit(moveStep(workflow, id, to))}
                onConnect={() => {}}
                onAddPath={addPath}
              />
            ) : (
              <StepTable
                process={process}
                statuses={statuses}
                selected={selection}
                onSelect={setSelection}
                label={label as never}
                onAdd={() =>
                  setAddAt({ container: ROOT, index: Math.max(0, workflow.steps.length - 1) })
                }
              />
            )}
          </div>
          {addAt ? (
            <Palette onPick={add} onClose={() => setAddAt(null)} />
          ) : selected ? (
            <StepPanel
              stepId={selected.id}
              kind={`Step ${walk(workflow).findIndex((l) => l.step.id === selected.id) + 1} · ${kindLabel(selected.kind)}`}
              title={selected.name}
              onRename={(name) => edit(updateStep(workflow, selected.id, (s) => ({ ...s, name })))}
              status={statuses.get(selected.id)}
              onClose={() => setSelection(null)}
              onRemove={
                canRemove(workflow, selected.id)
                  ? () => {
                      edit(removeStep(workflow, selected.id));
                      setSelection(null);
                    }
                  : undefined
              }
            >
              <StepEditor
                key={selected.id}
                step={selected}
                env={env}
                issues={byStep.get(selected.id) ?? []}
                onChange={(next: Step) => edit(updateStep(workflow, selected.id, () => next))}
              />
            </StepPanel>
          ) : selection === FLOW_START_ID ? null : null}
        </div>
      </div>
    </div>,
  );
}

/** The eight kinds a new step can be (§4). */
function Palette({ onPick, onClose }: { onPick(kind: StepKind): void; onClose(): void }) {
  return (
    <aside
      aria-label="Add a step"
      data-testid="steps-palette"
      className="flex w-72 shrink-0 flex-col gap-2 border border-line bg-surface p-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="eyebrow text-ink-muted">Add a step</h3>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <ul className="flex flex-col">
        {PALETTE.map((p) => (
          <li key={p.kind}>
            <button
              type="button"
              data-testid={`palette-${p.kind}`}
              className="flex w-full flex-col items-start px-2 py-1.5 text-left hover:bg-surface-muted"
              onClick={() => onPick(p.kind)}
            >
              <span className="text-sm text-ink">{p.label}</span>
              <span className="text-xs text-ink-muted">{p.does}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** What stops Publish, each on its step, in plain words; a step's line opens it. */
export function PublishIssues(props: {
  issues: ReturnType<typeof workflowIssues>;
  show: boolean;
  name(id: string): string;
  outputName(id: string): string;
  onToggle(): void;
  onPick(id: string): void;
}) {
  const { issues } = props;
  return (
    <section
      data-testid="publish-issues"
      className="flex flex-col gap-2 border border-risk-line bg-risk-tint p-3 text-sm"
    >
      <div className="flex items-center gap-2">
        <Badge tone="risk">Can't publish yet</Badge>
        <span className="text-risk-ink">{publishSummary(issues)}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {issues.map((i, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: issues have no ids; their order is their identity.
          <li key={n} className="flex gap-2">
            {i.at ? (
              <button
                type="button"
                className="text-left font-medium text-ink underline"
                onClick={() => props.onPick(i.at ?? "")}
              >
                {props.name(i.at) === "A step" ? props.outputName(i.at) : props.name(i.at)}
              </button>
            ) : (
              <span className="font-medium text-ink">This workflow</span>
            )}
            <span className="text-ink">{i.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
