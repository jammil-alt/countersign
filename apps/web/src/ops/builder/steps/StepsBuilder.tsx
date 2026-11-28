// The workflow builder for a step-model workflow (docs/step-model-plan.md §2 principle 6: same
// screens, navigation and flows as the v4 builder; only the step forms, the groupings in the
// pickers and what the new structure needs). One workflow of an agent's version, `schemaVersion: 5`:
// the chart (the builder's own, `../../flow`), the bar, the step's side panel with its form and Data
// tab, the palette of eight kinds, the workflow's outputs next to the triggers, and Publish, which
// shows the server's publish check of the draft on its steps and refuses while any issue remains.
//
// One checker (staging, 2026-11-28): the issues are the server's (`./check`), asked as the page
// opens and after each edit, and the page never changes the workflow by itself: what opens is what
// is stored, and "Unsaved" means a person changed it.
//
// Feedback, 2026-11-26: a step's settings open in a full-height side drawer over the page; the
// chart scrolls inside a frame the window's height under the bar; the outputs come after the chart;
// an issue on an output opens it; Try it and the Builder are back in the bar (both had gone with
// the v4 builder in #707), each in the same drawer beside the page.

import {
  type AgentBundle,
  canonicalJson,
  type OversightReview,
  type OversightSettings,
  oversightReviewOf,
  steps,
  triggerOnSchema,
  uuidv7,
  wantsDocument,
  wantsMessage,
  withOversightReview,
} from "@countersign/core";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../../api/routes";
import { useApi } from "../../../api/useApi";
import { Badge, Button, cx, ErrorNotice } from "../../../ui/primitives";
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
import { useWorkflowCheck } from "./check";
import { Drawer, DrawerTab } from "./Drawer";
import { type BoxWords, boxWords, displayProcess } from "./display";
import { fixFor, type IssueFix } from "./fixes";
import type { SaveAsSkill, StepFormEnv } from "./form-kit";
import { canRedo, canUndo, commit, redo, startHistory, undo } from "./history";
import { type BuilderIssue, canPublish, issuesByStep, publishSummary } from "./issues";
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
import { agentModelsOf, runsOn } from "./runsOn";
import { StepEditor } from "./StepEditor";
import { SupervisorControl, SupervisorField, supervisorMarks } from "./Supervisor";
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

/** The supervisor's settings as the bundle stores them (`definition.oversight`), if any. */
export function oversightOf(bundle: unknown): OversightSettings | undefined {
  const d = (bundle as { definition?: { oversight?: OversightSettings } }).definition;
  return d?.oversight;
}

/** The bundle with the supervisor's settings replaced; absent leaves them as stored. */
export function withOversight(bundle: unknown, oversight: OversightSettings | undefined): unknown {
  if (!oversight) return bundle;
  const b = bundle as { definition: Record<string, unknown> };
  return { ...b, definition: { ...b.definition, oversight } };
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
  // The workflow as stored: nothing is worked out or filled in as the page opens (staging,
  // 2026-11-28: a step's input dropped on load was saved as a broken version).
  const [history, setHistory] = useState(() => startHistory(props.start));
  const workflow = history.present;
  const edit = useCallback((next: Workflow) => setHistory((h) => commit(h, next)), []);
  // The supervisor's settings (owner, 2026-11-27): the agent's `definition.oversight`, changed
  // from the bar and saved with the workflow as a new draft, like any edit.
  // DECISION: kept beside the workflow's history, not in it: Undo undoes steps, and the bar's
  // control sets the level back; edits kept in this browser hold the workflow only.
  const [oversight, setOversight] = useState(() => oversightOf(props.bundle));
  const [saved, setSaved] = useState({
    id: from.id,
    version: from.version,
    status: from.status,
    canon: canonicalJson(props.start),
    oversight: canonicalJson(oversightOf(props.bundle) ?? null),
  });
  const oversightDirty = canonicalJson(oversight ?? null) !== saved.oversight;
  // Only a person's edit makes the draft differ from what is stored.
  const dirty = canonicalJson(workflow) !== saved.canon || oversightDirty;
  // Each step as the page opened it: a step the person hasn't changed is never rewritten by its
  // form (the Input box offers what it works out instead).
  const openedSteps = useMemo(
    () => new Map(walk(props.start).map((l) => [l.step.id, canonicalJson(l.step)])),
    [props.start],
  );
  const review: OversightReview = oversightReviewOf(oversight);
  // Edits kept in this browser from before a reload, offered back (owner, 2026-11-26).
  const [offer, setOffer] = useState(() =>
    keptToOffer(readKept(agent.id, props.workflow), from.id, history.present),
  );
  useKeepUnsaved({
    agentId: agent.id,
    slug: props.workflow,
    baseId: saved.id,
    workflow,
    dirty,
    enabled: offer === null,
  });
  useLeaveGuard(dirty);
  const [selection, setSelection] = useState<string | null>(null);
  const [addAt, setAddAt] = useState<InsertPoint | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<FlowView>(props.view === "steps" ? "list" : "chart");
  const [notice, setNotice] = useState<{ tone: "positive" | "warning"; body: string } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  // The drawer's other two uses: Try it and the Builder (a step's settings and the palette are
  // `selection` and `addAt`). One drawer at a time.
  // `#try` (the Turn on sheet's Try it) opens with Try it open.
  const [tool, setTool] = useState<"try" | "builder" | null>(() =>
    typeof window !== "undefined" && window.location.hash === "#try" ? "try" : null,
  );
  // The sticky bar's height, measured: one row on a wide window, two or more when it wraps.
  const barRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(76);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setBarHeight(Math.ceil(el.getBoundingClientRect().height));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // Folded to a tab at the window's edge (a click outside, or a step opened): the conversation
  // and the try stay as they were, to open again.
  const [toolFolded, setToolFolded] = useState(false);
  const [tried, setTried] = useState<TryMark[]>([]);
  // The steps the Builder's last answer changed (by id), until its next answer or a save.
  const [builderChanged, setBuilderChanged] = useState<ReadonlySet<string>>(new Set());
  // Words put in the Builder's box by "Ask the Builder" on an issue, to read over and send.
  const [prefill, setPrefill] = useState<{ text: string; n: number } | null>(null);
  const [outputsOpen, setOutputsOpen] = useState(true);
  const api = useRef(action);
  api.current = action;

  // What would stop a publish, as the server's save and publish check it.
  const check = useWorkflowCheck({
    agentId: agent.id,
    slug: props.workflow,
    parentVersionId: saved.id,
    workflow,
  });
  const issues = useMemo(() => check.issues ?? [], [check.issues]);
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
  // The steps the supervisor checks after they succeed, with the words of their mark.
  const supervised = useMemo(
    () => supervisorMarks(workflow, review, catalog.uses),
    [workflow, review, catalog.uses],
  );
  const supervisor = useCallback((id: string) => supervised.get(id) ?? null, [supervised]);
  const process = useMemo(() => displayProcess(workflow, catalog.uses), [workflow, catalog.uses]);
  // The agent's own model and per-skill models, for what an AI step runs on when it sets none.
  const agentModels = useMemo(() => agentModelsOf(props.bundle), [props.bundle]);
  const label = useCallback(
    (s: { id: string }) => {
      const real = findStep(workflow, s.id)?.step;
      const w: BoxWords = real
        ? boxWords(real, catalog.uses, workflow)
        : { title: "", kind: "", detail: null };
      // Owner, 2026-11-26: every AI step's box names the model it runs on, set or not.
      const runs = real ? runsOn(real, catalog.uses, agentModels) : null;
      return { ...w, detail: w.detail, ...(runs ? { model: runs.id } : {}) };
    },
    [workflow, catalog.uses, agentModels],
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
      agentModels,
      agents: props.handoffAgents,
      saveAsSkill,
      edited: (id) => {
        const was = openedSteps.get(id);
        const now = findStep(workflow, id)?.step;
        return was === undefined || (now !== undefined && canonicalJson(now) !== was);
      },
    }),
    [
      workflow,
      catalog,
      props.people,
      suggest,
      props.handoffAgents,
      saveAsSkill,
      agentModels,
      openedSteps,
    ],
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
    const keptOversight = oversight;
    let bundle = withOversight(withWorkflow(props.bundle, props.workflow, snapshot), keptOversight);
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
      oversight: canonicalJson(keptOversight ?? null),
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
  // What the trigger carries: Try it makes up a document, a whole email, or JSON.
  const triggerKind = useMemo<"json" | "document" | "message">(() => {
    const on = workflow.triggers[0]?.on;
    const events = Object.fromEntries(catalog.events.map((e) => [e.type, e]));
    const schema = on ? triggerOnSchema(on as never, { events: events as never }) : undefined;
    return wantsDocument(schema) ? "document" : wantsMessage(schema) ? "message" : "json";
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
      className={cx(
        "-mb-8 flex min-h-[calc(100vh-var(--header-h))] flex-col gap-3 md:-mb-12",
        // Try it or the Builder open beside the page: on a wide window the page moves over, so
        // the chart isn't under them.
        tool && !toolFolded && !selected && !addAt && "flow-frame--beside",
      )}
      data-testid="builder-frame"
    >
      <div className="contents" data-testid="steps-builder">
        {/* The bar stays in view while the page scrolls to the chart and the outputs. */}
        {/* On a phone the bar wraps to several rows: it scrolls with the page there. */}
        <div ref={barRef} className="md:sticky md:top-[var(--header-h)] md:z-10">
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
            extra={
              <SupervisorControl
                review={review}
                set={oversight !== undefined}
                verifies={oversight === undefined || oversight.verify === "writes"}
                onChange={(r) => setOversight((o) => withOversightReview(o, r))}
              />
            }
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
        {check.failed ? (
          <p className="text-sm text-ink-muted" data-testid="steps-check-failed">
            We couldn't check this draft just now
            {check.issues ? ", so what stops Publish below may be out of date" : ""}. Saving still
            works; we'll check again after your next change.
          </p>
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
            fix={(i) => fixFor(i, workflow, catalog.uses)}
            onApply={(run) => edit(run(workflow))}
            onAsk={(i) => {
              setPrefill((p) => ({ text: `Fix this: ${i.message}`, n: (p?.n ?? 0) + 1 }));
              if (i.at && findStep(workflow, i.at)) {
                select(i.at);
                askBuilderHere();
              } else openTool("builder");
            }}
          />
        ) : null}
        {/* Feedback, 2026-11-26: the chart scrolls inside a frame as tall as the window under the
            bar; it had no height of its own, so it never scrolled. */}
        <div
          // Owner, 2026-11-26 ("the scroll does not go all the way to the bottom"): the frame is the
          // window's height under the bar as the bar really is (it wraps to two rows on a narrower
          // window), so the chart's last box is never below the window.
          style={{ "--flow-bar-h": `${barHeight}px` } as CSSProperties}
          className="h-[70vh] min-h-[420px] shrink-0 border border-line bg-surface md:h-[calc(100vh-var(--header-h)-var(--flow-bar-h)-12px)]"
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
              supervisor={supervisor}
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
                supervisor={supervisor}
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
                    prefill={prefill}
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
              settingsFooter={
                <SupervisorField
                  step={selected}
                  uses={catalog.uses}
                  review={review}
                  onChange={(next) => edit(updateStep(workflow, selected.id, () => next))}
                />
              }
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
            triggerKind={triggerKind}
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
          <BuilderChat session={builder} prefill={prefill} onClose={() => setTool(null)} />
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

/**
 * What stops Publish, each on its step or output, in plain words, with how to settle it
 * (owner, 2026-11-26): a fix in one click where there is one sensible answer, "For this to work…"
 * where what has to change is elsewhere, and the Builder for the rest.
 */
export function PublishIssues(props: {
  issues: readonly BuilderIssue[];
  show: boolean;
  name(id: string): string;
  outputName(id: string): string;
  onToggle(): void;
  onPick(id: string): void;
  /** How to settle an issue; absent: only its line and a way to open it. */
  fix?: ((issue: BuilderIssue) => IssueFix) | undefined;
  onApply?: ((run: (w: Workflow) => Workflow) => void) | undefined;
  onAsk?: ((issue: BuilderIssue) => void) | undefined;
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
      <ul className="flex flex-col gap-2">
        {(props.show || issues.length <= ISSUES_SHOWN ? issues : issues.slice(0, ISSUES_SHOWN)).map(
          (i, n) => {
            // Feedback, 2026-11-26: "it tells me there is an issue, but I don't know what it is or
            // how to fix it". Each line says whether it is a step or an output, and Show me opens it.
            const output =
              !!i.at && props.name(i.at) === "A step" && props.outputName(i.at) !== i.at;
            const what = !i.at
              ? "This workflow"
              : output
                ? `Output “${props.outputName(i.at)}”`
                : `Step “${props.name(i.at)}”`;
            const fix = props.fix?.(i) ?? {};
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: issues have no ids; their order is their identity.
              <li key={n} className="flex flex-col gap-1" data-testid="publish-issue">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-medium text-ink">{what}:</span>
                  <span className="text-ink">{i.message}</span>
                </div>
                {fix.elsewhere ? (
                  <p className="text-ink-muted" data-testid="publish-issue-elsewhere">
                    {fix.elsewhere.text}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {fix.apply && props.onApply ? (
                    <Button
                      size="sm"
                      variant="primary"
                      data-testid="publish-issue-fix"
                      onClick={() => props.onApply?.(fix.apply?.run as (w: Workflow) => Workflow)}
                    >
                      {fix.apply.label}
                    </Button>
                  ) : null}
                  {props.onAsk ? (
                    <Button
                      size="sm"
                      data-testid="publish-issue-ask"
                      onClick={() => props.onAsk?.(i)}
                    >
                      Ask the Builder
                    </Button>
                  ) : null}
                  {i.at || fix.elsewhere?.open ? (
                    <button
                      type="button"
                      className="text-slate underline"
                      data-testid="publish-issue-show"
                      onClick={() => props.onPick(fix.elsewhere?.open ?? i.at ?? "")}
                    >
                      {output && !fix.elsewhere?.open ? "Show me in Outputs" : "Open the step"}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          },
        )}
      </ul>
      {issues.length > ISSUES_SHOWN ? (
        <button
          type="button"
          className="self-start text-slate underline"
          data-testid="publish-issues-toggle"
          onClick={props.onToggle}
        >
          {props.show ? "Show fewer" : `Show all ${issues.length}`}
        </button>
      ) : null}
    </section>
  );
}

/** The issues listed before "Show all" (on a phone a long list hid the steps). */
const ISSUES_SHOWN = 3;

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
