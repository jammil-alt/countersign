// The workflow builder for a step-model workflow (docs/step-model-plan.md §2 principle 6: same
// screens, navigation and flows as the v4 builder; only the step forms, the groupings in the
// pickers and what the new structure needs). One workflow of an agent's version, `schemaVersion: 5`:
// the chart (the builder's own, `../../flow`), the bar, the step's side panel with its form and Data
// tab, the palette of eight kinds, the workflow's outputs next to the triggers, and Publish, which
// shows `validateWorkflow`'s issues on their steps and refuses while any remain.
//
// Feedback, 2026-11-26: a step's settings open in a full-height side drawer over the page; the
// chart scrolls inside a frame the window's height under the bar; the outputs come after the chart;
// an issue on an output opens it; Try it and the Builder are back in the bar (both had gone with
// the v4 builder in #707), each in the same drawer beside the page.

import {
  type AgentBundle,
  canonicalJson,
  steps,
  triggerOnSchema,
  uuidv7,
  wantsDocument,
} from "@countersign/core";
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
import { samplePayload, type Triggered } from "../../agents/TestPayload";
import { StepPanel } from "../../flow/StepPanel";
import { StepTable } from "../../flow/StepTable";
import type { FlowEnds, InsertPoint, StatusMap, TryMark } from "../../flow/types";
import { triggerTitle } from "../../workflow/describe";
import { addWorkflow } from "../model";
import type { Member, People } from "../people";
import { AddWorkflowForm, WorkflowSwitcher } from "../workflow-switcher";
import { BuilderChat, useBuilderSession } from "./BuilderChat";
import { triggerFields, useStepsCatalog } from "./catalog";
import { Drawer, DrawerTab } from "./Drawer";
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
import { TryPanel } from "./TryPanel";
import type { Step, StepKind, Workflow } from "./types";
import { forgetKept, keptToOffer, readKept, useKeepUnsaved, useLeaveGuard } from "./unsaved";
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
    () =>
      (props.bundle as { workflows: { slug: string; name: string; enabled?: boolean }[] })
        .workflows,
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
  // What the builder opened on, worked out (stream G): changed by an edit, it is the person's work.
  const [opened] = useState(() => canonicalJson(history.present));
  const unsaved = dirty && canonicalJson(workflow) !== opened;
  // Edits kept in this browser from before a reload, offered back (owner, 2026-11-26).
  const [offer, setOffer] = useState(() =>
    keptToOffer(readKept(agent.id, props.workflow), from.id, history.present),
  );
  useKeepUnsaved({
    agentId: agent.id,
    slug: props.workflow,
    baseId: saved.id,
    workflow,
    dirty: unsaved,
    enabled: offer === null,
  });
  useLeaveGuard(unsaved);
  const [selection, setSelection] = useState<string | null>(null);
  const [addAt, setAddAt] = useState<InsertPoint | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<FlowView>(props.view === "steps" ? "list" : "chart");
  const [notice, setNotice] = useState<{ tone: "positive" | "warning"; body: string } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  // The drawer's other two uses: Try it and the Builder (a step's settings and the palette are
  // `selection` and `addAt`). One drawer at a time.
  const [tool, setTool] = useState<"try" | "builder" | null>(null);
  // Folded to a tab at the window's edge (a click outside, or a step opened): the conversation
  // and the try stay as they were, to open again.
  const [toolFolded, setToolFolded] = useState(false);
  const [tried, setTried] = useState<TryMark[]>([]);
  // The steps the Builder's last answer changed (by id), until its next answer or a save.
  const [builderChanged, setBuilderChanged] = useState<ReadonlySet<string>>(new Set());
  const [outputsOpen, setOutputsOpen] = useState(true);
  const api = useRef(action);
  api.current = action;

  const issues = useMemo(() => workflowIssues(workflow, catalog.uses), [workflow, catalog.uses]);
  const byStep = useMemo(() => issuesByStep(issues), [issues]);
  const statuses = useMemo(() => statusesFor(issues), [issues]);
  // What the chart and the list show: the issues, and the last try's result on each step.
  const shown = useMemo<StatusMap>(() => {
    if (tried.length === 0 && builderChanged.size === 0) return statuses;
    const out = new Map(statuses);
    // The steps the Builder's last answer changed, marked on the chart and the list.
    for (const id of builderChanged) {
      const s = out.get(id);
      const tag = { word: "Builder changed", tone: "neutral" as const };
      out.set(id, s ? { ...s, tag } : { stepId: id, level: "ok", items: [], decided: [], tag });
    }
    for (const t of tried) {
      const s = out.get(t.stepId);
      out.set(
        t.stepId,
        s
          ? { ...s, tried: t }
          : { stepId: t.stepId, level: "ok", items: [], decided: [], tried: t },
      );
    }
    return out;
  }, [statuses, tried, builderChanged]);
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
  // A step opens in the drawer in place of Try it or the Builder.
  // A step opens over Try it (folded to its tab); the Builder, when open, stays beside it.
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const select = useCallback((id: string | null) => {
    setSelection(id);
    if (id) {
      if (toolRef.current !== "builder") setToolFolded(true);
      setAddAt(null);
    }
  }, []);
  const askBuilderHere = () => {
    setTool("builder");
    setToolFolded(false);
  };
  const openTool = (t: "try" | "builder") => {
    setSelection(null);
    setAddAt(null);
    setTool(t);
    setToolFolded(false);
  };
  // "Show me" on an output's issue: the outputs open, and that output comes into view.
  const showOutput = (id: string) => {
    setOutputsOpen(true);
    requestAnimationFrame(() => {
      const el = document.getElementById(`output-${id}`);
      if (!el) return;
      el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      el.classList.add("flow-output-flash");
      el.querySelector<HTMLElement>("select, input, textarea, button")?.focus({
        preventScroll: true,
      });
      setTimeout(() => el.classList.remove("flow-output-flash"), 1600);
    });
  };

  // ── The chart's events ──
  const add = (kind: StepKind) => {
    const at = addAt ?? { container: ROOT, index: Math.max(0, workflow.steps.length - 1) };
    const step = newStep(kind);
    edit(insertStep(workflow, at, step));
    setAddAt(null);
    select(step.id);
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
    setBuilderChanged(new Set());
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

  // The Builder's conversation about this agent; its draft of this workflow comes back as an edit.
  const builder = useBuilderSession({
    agent,
    slug: props.workflow,
    workflow,
    ensureSaved: async () => {
      const v = dirty ? await save() : saved;
      return v ? { id: v.id } : null;
    },
    onDraft: (next) => {
      setBuilderChanged(changedSteps(workflow, next));
      edit(next);
    },
  });
  const sample = useMemo(
    () => samplePayload(workflow as unknown as Triggered, catalog.events as never),
    [workflow, catalog.events],
  );
  // The trigger carries a stored document: Try it makes up a document rather than JSON.
  const documentTrigger = useMemo(() => {
    const on = workflow.triggers[0]?.on;
    const events = Object.fromEntries(catalog.events.map((e) => [e.type, e]));
    return on ? wantsDocument(triggerOnSchema(on as never, { events: events as never })) : false;
  }, [workflow.triggers, catalog.events]);
  const tryBlocked = canPublish(issues)
    ? null
    : `Settle what stops Publish first: a test run is checked as a publish is. ${publishSummary(issues)}`;

  // The step before and after the open one, in reading order.
  const order = walk(workflow).map((l) => l.step.id);
  const stepAt = (delta: number): string | null => {
    const i = selection ? order.indexOf(selection) : -1;
    return i < 0 ? null : (order[i + delta] ?? null);
  };

  const stepName = (id: string) => findStep(workflow, id)?.step.name.trim() || "A step";
  const open = { issues: statuses.size, questions: 0 };
  const nextOpen = () => {
    const first = walk(workflow).find((l) => statuses.has(l.step.id));
    if (first) select(first.step.id);
  };

  return props.frame(
    // One frame at least as tall as the window under the header, ending the page as the v4
    // builder's does (`builder-frame`: the walkthrough checks the page scrolls no further).
    <div
      className="-mb-8 flex min-h-[calc(100vh-var(--header-h))] flex-col gap-3 md:-mb-12"
      data-testid="builder-frame"
    >
      <div className="contents" data-testid="steps-builder">
        {/* The bar stays in view while the page scrolls to the chart and the outputs. */}
        <div className="sticky top-[var(--header-h)] z-10">
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
            onAskBuilder={() => openTool("builder")}
            onTry={() => openTool("try")}
            tryBlocked={tryBlocked}
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
        </div>
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
        {offer ? (
          <Notice tone="warning" testId="steps-kept">
            You have changes here that weren't saved (
            {new Date(offer.at).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            ).{" "}
            <button
              type="button"
              className="font-medium underline"
              data-testid="steps-kept-restore"
              onClick={() => {
                edit(offer.workflow);
                setOffer(null);
              }}
            >
              Bring them back
            </button>{" "}
            or{" "}
            <button
              type="button"
              className="underline"
              data-testid="steps-kept-discard"
              onClick={() => {
                forgetKept(agent.id, props.workflow);
                setOffer(null);
              }}
            >
              discard them
            </button>
            .
          </Notice>
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
              if (findStep(workflow, id)) select(id);
              else if (workflow.outputs.some((o) => o.id === id)) showOutput(id);
            }}
          />
        ) : null}
        {/* Feedback, 2026-11-26: the chart scrolls inside a frame as tall as the window under the
            bar; it had no height of its own, so it never scrolled. */}
        <div
          className="h-[calc(100vh-var(--header-h)-88px)] min-h-[420px] shrink-0 border border-line bg-surface"
          data-testid="steps-canvas"
        >
          {view === "chart" ? (
            <Chart
              process={process}
              ends={ends}
              statuses={shown}
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
              onSelect={select}
              onInsert={(at) => {
                setSelection(null);
                setToolFolded(true);
                setAddAt(at);
              }}
              onMove={(id, to) => edit(moveStep(workflow, id, to))}
              onConnect={() => {}}
              onAddPath={addPath}
            />
          ) : (
            <div className="h-full overflow-auto p-4">
              <StepTable
                process={process}
                statuses={shown}
                selected={selection}
                onSelect={select}
                label={label as never}
                onAdd={() => {
                  setSelection(null);
                  setToolFolded(true);
                  setAddAt({ container: ROOT, index: Math.max(0, workflow.steps.length - 1) });
                }}
              />
            </div>
          )}
        </div>
        {/* Feedback, 2026-11-26: "the output should be at the bottom": what the workflow delivers
            comes after its steps. */}
        <details
          open={outputsOpen}
          onToggle={(e) => setOutputsOpen((e.currentTarget as HTMLDetailsElement).open)}
          data-testid="steps-outputs"
          className="border border-line bg-surface"
        >
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
      </div>
      {addAt ? (
        <Drawer label="Add a step" testId="steps-drawer" narrow onClose={() => setAddAt(null)}>
          <Palette onPick={add} onClose={() => setAddAt(null)} />
        </Drawer>
      ) : selected ? (
        <Drawer
          label="Step settings"
          testId="steps-drawer"
          onClose={() => setSelection(null)}
          {...(tool === "builder" && !toolFolded
            ? {
                companion: (
                  <BuilderChat
                    session={builder}
                    focus={{ id: selected.id, name: selected.name }}
                    onClose={() => setTool(null)}
                  />
                ),
                companionLabel: "Builder",
              }
            : {})}
        >
          <StepPanel
            stepId={selected.id}
            kind={`Step ${walk(workflow).findIndex((l) => l.step.id === selected.id) + 1} · ${kindLabel(selected.kind)}`}
            title={selected.name}
            onRename={(name) => edit(updateStep(workflow, selected.id, (s) => ({ ...s, name })))}
            status={shown.get(selected.id)}
            onClose={() => setSelection(null)}
            onDone={() => setSelection(null)}
            {...(tool === "builder" && !toolFolded ? {} : { onAskBuilder: askBuilderHere })}
            onPreviousStep={stepAt(-1) ? () => select(stepAt(-1) as string) : undefined}
            onNextStep={stepAt(1) ? () => select(stepAt(1) as string) : undefined}
            onRemove={
              canRemove(workflow, selected.id)
                ? () => {
                    edit(removeStep(workflow, selected.id));
                    setSelection(null);
                  }
                : undefined
            }
          >
            {builderChanged.has(selected.id) ? (
              <Notice tone="warning" testId="steps-builder-changed">
                The Builder just changed this step. Check it; each change has its own Undo in the
                Builder's answer.
              </Notice>
            ) : null}
            <StepEditor
              key={selected.id}
              step={selected}
              env={env}
              issues={byStep.get(selected.id) ?? []}
              onChange={(next: Step) => edit(updateStep(workflow, selected.id, () => next))}
            />
          </StepPanel>
        </Drawer>
      ) : null}
      {/* Try it and the Builder stay mounted while folded or under a step, so a message being
          typed and a try under way are kept; a tab at the edge opens them again. */}
      {tool && toolFolded && !selected && !addAt ? (
        <DrawerTab
          label={tool === "try" ? "Try it" : "Builder"}
          testId="steps-drawer-tab"
          onOpen={() => setToolFolded(false)}
        />
      ) : null}
      {tool === "try" ? (
        <Drawer
          label="Try it"
          testId="steps-tool-drawer"
          modal={false}
          hidden={toolFolded || !!selected || !!addAt}
          onCollapse={() => setToolFolded(true)}
          onClose={() => setTool(null)}
        >
          <TryPanel
            agent={{ id: agent.id, kind: agent.kind, tenantId: agent.tenantId ?? null }}
            workflow={workflow}
            slug={props.workflow}
            sample={sample}
            name={workflows.find((w) => w.slug === props.workflow)?.name ?? props.workflow}
            documentTrigger={documentTrigger}
            prepare={async () => {
              const v = dirty ? await save(undefined, "Saved to try it") : saved;
              return v?.id ?? null;
            }}
            onMarks={setTried}
            onSelect={select}
            onClose={() => setTool(null)}
          />
        </Drawer>
      ) : tool === "builder" ? (
        <Drawer
          label="Builder"
          testId="steps-tool-drawer"
          modal={false}
          // A step clicked on the chart or the list opens beside the Builder rather than folding it.
          keepOn={'.flow-box, [data-testid^="flow-list-row-"]'}
          hidden={toolFolded || !!selected || !!addAt}
          onCollapse={() => setToolFolded(true)}
          onClose={() => setTool(null)}
        >
          <BuilderChat session={builder} onClose={() => setTool(null)} />
        </Drawer>
      ) : null}
    </div>,
  );
}

/** The eight kinds a new step can be (§4). */
function Palette({ onPick, onClose }: { onPick(kind: StepKind): void; onClose(): void }) {
  return (
    <aside
      aria-label="Add a step"
      data-testid="steps-palette"
      className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto bg-surface p-4"
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
        {issues.map((i, n) => {
          // Feedback, 2026-11-26: "it tells me there is an issue, but I don't know what it is or
          // how to fix it". Each line says whether it is a step or an output, and Show me opens it.
          const output = !!i.at && props.name(i.at) === "A step" && props.outputName(i.at) !== i.at;
          const what = !i.at
            ? "This workflow"
            : output
              ? `Output “${props.outputName(i.at)}”`
              : `Step “${props.name(i.at)}”`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: issues have no ids; their order is their identity.
            <li key={n} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-ink">{what}:</span>
              <span className="text-ink">{i.message}</span>
              {i.at ? (
                <button
                  type="button"
                  className="text-slate underline"
                  data-testid="publish-issue-show"
                  onClick={() => props.onPick(i.at ?? "")}
                >
                  {output ? "Show me in Outputs" : "Open the step"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The steps (by id) whose settings differ between two drafts, added ones included. */
export function changedSteps(before: Workflow, after: Workflow): ReadonlySet<string> {
  // A step's own settings, not the steps inside it: a change inside a Fork marks that step only.
  const own = (step: Step) => {
    const {
      steps: _s,
      paths,
      otherwise,
      ...rest
    } = step as Step & {
      steps?: unknown;
      paths?: { steps: unknown }[];
      otherwise?: { steps: unknown };
    };
    return canonicalJson({
      ...rest,
      // A path's name and condition are the Fork's own; the steps on it are theirs.
      ...(paths ? { paths: paths.map(({ steps: _x, ...p }) => p) } : {}),
      ...(otherwise ? { otherwise: { ...otherwise, steps: [] } } : {}),
    });
  };
  const was = new Map(walk(before).map((l) => [l.step.id, own(l.step)]));
  const out = new Set<string>();
  for (const l of walk(after)) {
    if (was.get(l.step.id) !== own(l.step)) out.add(l.step.id);
  }
  return out;
}
