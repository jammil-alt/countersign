// O6 Workflow builder (ARCHITECTURE §10.5), one for templates and client agents:
// `/ops/templates/:slug/workflows/:workflow` and `/ops/clients/:id/agents/:slug/workflows/:workflow`
// (and `steps/:workflow`, the same builder opened on its List). It edits the agent's latest version
// as a whole bundle (every workflow, so switching workflows keeps unsaved edits), validates on
// every change with core's validator (the server's own rules), and saves drafts, test-runs and
// publishes through the agent routes. Loaded lazily inside the /ops chunk, so its drag-and-drop
// code is fetched only when an operator opens a workflow.
// R8 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14): it edits v4 processes. A stored v3 version
// opens converted (`readProcessBundle`, every id kept) and the next save writes schemaVersion 4 as
// a new version; the stored one is never edited (invariant 3).
//
// F6 (docs/builder-plan.md §12, docs/plan.md §1.170): the builder on one screen is its face. One
// bar (../flow/FlowBar: Chart or List, Undo and Redo, Ask the Builder, Try it, Save draft, Publish);
// the rail of steps to add on the left (../flow/Rail, today's palette); the chart in the middle
// (../flow/Chart), or the List (../flow/StepTable); and on the right the selected step's side panel
// (../flow/StepPanel: its connections, the inspector's fields, the Builder on that step), the
// whole-flow Builder, or the test run. A For each or a Repeat opens its own steps in the same
// frame. Everything it holds is as before: the history (undo and redo), the rolling draft, saving,
// publishing, rebasing onto a newer version, the Builder session and the validator. Only how it is
// drawn changed; every chart event goes to the same operations in ./model, and no id is made twice.
import {
  type AgentBundle,
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  agentSkillEntry,
  type BuildDetail,
  type BuilderCatalog,
  canonicalJson,
  codeRequestRoutes,
  effectiveModel,
  lookupSkill,
  type ProcessAgentBundle,
  parseSkillRef,
  processes,
  providerModelName,
  Slug,
  skillKind,
  type TriggerOn,
  type TypingContext,
  toolLookup,
  toolUsesModel,
  uuidv7,
} from "@countersign/core";
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { builderDraftKey } from "../../session/drafts";
import { useOptionalSession } from "../../session/session";
import { HeaderSwitcher } from "../../shell/HeaderSwitcher";
import { AgentBadge } from "../../ui/badges";
import { Icon } from "../../ui/icons";
import { Badge, Button, buttonClass, cx, ErrorNotice, Tag } from "../../ui/primitives";
import { Skeleton, SkeletonBlock } from "../../ui/skeleton";
import { slugify } from "../agents/definition-form";
import {
  JSON_INPUT_PROPS,
  type PayloadSource,
  PayloadSourceSelect,
  parsePayload,
  payloadFor,
  samplePayload,
  triggerEventType,
  useRecentEvents,
} from "../agents/TestPayload";
import {
  detailMessages,
  errorText,
  Field,
  isCode,
  Notice,
  plural,
  TextArea,
  useAction,
} from "../agents/ui";
import { automationStepsPath } from "../flow/automation/paths";
import { Chart } from "../flow/Chart";
import { dispatchFlowDrop, flowCollision, resolveFlowDrop } from "../flow/dnd";
import { FlowBar, type FlowView } from "../flow/FlowBar";
import "../flow/flow.css";
import {
  agentEnds,
  chartLabel,
  devQueuePath,
  hostPoint,
  isLoop,
  loopEnds,
  loopProcess,
  placeWords,
  setupItems,
  withCodeRequests,
} from "../flow/frame";
import { fromBuild } from "../flow/fromBuild";
import { FLOW_GIVES_BACK_ID, FLOW_START_ID } from "../flow/layout";
import { CustomizationsList, StepDiff } from "../flow/lineage/CustomizationsList";
import { LineageStrip } from "../flow/lineage/LineageStrip";
import { Rail } from "../flow/Rail";
import { type BuilderSize, StepPanel } from "../flow/StepPanel";
import { StepTable } from "../flow/StepTable";
import { buildStatuses, FIX_HINT, nextOpen, counts as openCounts, stepOrder } from "../flow/status";
import { TryPanel } from "../flow/TryPanel";
import { TurnOnSheet } from "../flow/TurnOnSheet";
import type { InsertPoint, SettleItem, StatusMap, TryMark } from "../flow/types";
import { useOpsClients } from "../OpsLayout";
import { OPS_PATHS } from "../paths";
import { SchedulePicker, type ScheduleValue } from "../triggers/SchedulePicker";
import { PROCESS_KIND_LABEL, type StepLabels, triggerTitle } from "../workflow/describe";
import { BuilderPanel, SaveAsAutomation, useBuilderSession } from "./BuilderPanel";
import {
  type BuilderData,
  type BuilderProblem,
  boundMatrices,
  catalogSkillKind,
  connectorName,
  paletteConnectors,
  paletteSections,
  TESTKIT,
  toolConnector,
  typingContext,
  validateProcessesLikeServer,
  writeLabelOf,
} from "./catalog";
import { movePrompt, newProblems, type Reconnect, reconnect } from "./connections";
import { ConnectionsSection, type MoveRequest } from "./connections-step";
// v0.18 (docs/plan.md §1.103): what each step reads and saves, and what's left on a draft.
import {
  agentDataSummary,
  type ClientSetup,
  type DataNames,
  type LeftItem,
  problemConnector,
  stepDataLines,
  stepDataWarnings,
  whatsLeft,
} from "./data-use";
import { FixDialog, type FixRequest } from "./FixDialog";
import { EventOptions, SmallInput, SmallSelect } from "./fields";
// Hand off (owner, 2026-11-11): the client's agents a hand-off step can start.
import { handoffNames, useHandoffAgents } from "./handoff";
import { type FocusRequest, Inspector, type Selection } from "./Inspector";
import {
  type ApprovalEnv,
  addActionAfter,
  addTrigger,
  addWorkflow,
  allowStep,
  type ContainerId,
  commit,
  containersWithin,
  createStep,
  customizedSteps,
  editWorkflow,
  getContainer,
  type History,
  holdsV3,
  ifOfBranch,
  insertStep,
  locate,
  moveStep,
  newPath,
  type PaletteItem,
  type Process,
  ROOT,
  readProcessBundle,
  redo,
  removeStep,
  removeTrigger,
  replaceStep,
  setTrigger,
  startHistory,
  undo,
  updateStep,
  workflowCounts,
} from "./model";
import {
  addRouteAfter,
  approvalRouteNames,
  plainOutcomeProblem,
  testRunApprovalNote,
} from "./outcomes";
import { type Member, type People, personName } from "./people";
import { type ProblemLine, problemLines, problemPlace, readableErrors } from "./problems";
import { rebase } from "./rebase";
// Reshape data (2026-11-11)
import { addReshapeBefore, addReshapeThenAction, newReshapeStep } from "./reshape";
import { useClientScriptTools } from "./scripts";
import { applySkillMove } from "./skill-move";
// v0.18: the Builder on the step that is open (F6: under its setup in the side panel).
import { readStepChatSize, StepChat, writeStepChatSize } from "./step-chat";
import { WhatsLeft } from "./whats-left";

type Connection = ResponseOf<typeof apiRoutes.opsClient>["connections"][number];
type AgentDetail = ResponseOf<typeof apiRoutes.opsAgent>;

/** What the right side shows: the selected step, the whole-flow Builder, or the test run. */
type Side = "step" | "builder" | "test" | null;

/** Whether the rail of steps is folded, per viewer (a convenience: shown when unknown). */
const RAIL_KEY = "mezonas.builder.rail";

export interface WorkflowBuilderProps {
  agent: AgentSummary;
  /** The version the builder opens: the agent's latest, draft or live. */
  from: VersionDetail;
  /** That version's bundle as stored: v3 workflows, v4 processes, or both. */
  bundle: AgentBundle | AnyAgentBundle;
  /** The workflow slug from the URL. */
  workflow: string;
  /** The agent page's URL. */
  base: string;
  tabs: ReactNode;
  /** What the agent page shows between its tabs and the builder: which agent this is, its triggers. */
  above?: ReactNode;
  connections?: readonly Connection[];
  members?: readonly Member[];
  /** After a save or publish, so the agent page and sidebar follow. */
  onChanged(): void;
  /**
   * The agent page's Steps tab (docs/plan.md §1.108): the builder opens on its List in place of
   * the chart, the same side panel on the step clicked. Default the chart.
   */
  view?: "canvas" | "steps";
  // ── What the agent page knows that the one screen shows (docs/builder-plan.md §12) ──
  /**
   * GET /api/ops/agents/:id for this agent: its live and latest versions and the template update
   * it is offered. With it the line under the bar says whose agent this is and what it owes its
   * template (F8, ../flow/lineage). Absent (a part rendered on its own): no line.
   */
  detail?: AgentDetail | undefined;
  /** A client agent's template (GET /api/ops/agents/:templateId), once the page has it. */
  templateDetail?: Pick<AgentDetail, "agent" | "versions"> | null | undefined;
  /**
   * The agent's open build, if it has one: its issues, questions and decisions sit on their steps
   * (F3, ../flow/fromBuild), and a try of its draft is the build's own.
   */
  buildId?: string | null | undefined;
}

export default function WorkflowBuilder(props: WorkflowBuilderProps) {
  const catalog = useApi(apiRoutes.opsBuilderCatalog, {
    params: { id: props.agent.id },
    life: "catalog",
  });
  // Skill model (2026-11-10): skill versions a step moved to in this session, so the builder
  // types the step with the version it now names (the server resolves it the same way).
  const [moved, setMoved] = useState<BuilderCatalog["skills"]>([]);
  const events = useApi(apiRoutes.opsEventCatalog, { life: "catalog" });
  // F8: the template version the agent is based on (the one an update merge starts from), never
  // the template's latest.
  const baseVersionId =
    props.detail?.update?.baseVersionId ??
    props.detail?.live?.basedOnTemplateVersionId ??
    props.from.basedOnTemplateVersionId;
  const templateVersion = useApi(
    apiRoutes.opsAgentVersion,
    props.agent.kind === "client" && props.agent.templateId && baseVersionId
      ? { params: { id: props.agent.templateId, vid: baseVersionId } }
      : null,
  );
  const template = useMemo(() => {
    const raw = templateVersion.data?.version.bundle;
    const parsed = raw === undefined ? null : AnyAgentBundleSchema.safeParse(raw);
    return parsed?.success ? parsed.data : null;
  }, [templateVersion.data]);
  // R8: who a step asks or tells, from the client's People list (with their hours).
  const hours = useApi(
    apiRoutes.opsClientHours,
    props.agent.kind === "client" && props.agent.tenantId
      ? { params: { id: props.agent.tenantId } }
      : null,
  );
  const scripts = useClientScriptTools(props.agent); // Wave 4: the client's recorded scripts
  const handoff = useHandoffAgents(props.agent);
  const people = useMemo<People>(
    () => ({
      members: props.members ?? [],
      people: (hours.data?.people ?? []).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    }),
    [props.members, hours.data],
  );

  const failed = catalog.error ?? events.error;
  if (failed) {
    return (
      <Frame {...props}>
        <ErrorNotice
          error={failed}
          onRetry={() => {
            catalog.reload();
            events.reload();
          }}
        />
      </Frame>
    );
  }
  if (!catalog.data || !events.data) {
    return (
      <Frame {...props}>
        <Skeleton label="Loading skills, tools and events…" testId="builder-skeleton">
          <SkeletonBlock height={480} />
        </Skeleton>
      </Frame>
    );
  }
  return (
    <BuilderBody
      {...props}
      data={{
        catalog: {
          ...catalog.data,
          skills: [
            ...catalog.data.skills.filter((s) => !moved.some((m) => m.ref === s.ref)),
            ...moved,
          ],
        },
        events: events.data.events,
        scripts,
        handoff,
      }}
      onCatalogSkill={(entry) =>
        setMoved((list) => [...list.filter((m) => m.ref !== entry.ref), entry])
      }
      template={template}
      people={people}
    />
  );
}

function Frame(props: WorkflowBuilderProps & { children: ReactNode }) {
  return (
    <div>
      <BuilderBar agent={props.agent} line={null} />
      <div className="overflow-x-auto">{props.tabs}</div>
      {props.above ? <div className="pt-4">{props.above}</div> : null}
      <div className="pt-6">{props.children}</div>
    </div>
  );
}

/** "Remy · Card receipts": the agent's name, and its service's when that differs. */
/** The name the client knows (the service name), as the agent page's title (design pass, fix 1). */
function agentTitle(agent: AgentSummary): string {
  return agent.serviceName ?? agent.name;
}

/** The builder's bar (prototype `#O6-Builder`): the agent, its version and counts, its actions. */
function BuilderBar({
  agent,
  badge,
  line,
  actions,
}: {
  agent: AgentSummary;
  badge?: ReactNode;
  line: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pb-3">
      <div className="flex min-w-0 items-center gap-3">
        <AgentBadge name={agentTitle(agent)} seed={agent.id} size="md" />
        <div className="min-w-0">
          <div className="ui-crumbs">
            <h1 className="type-subheading text-ink">{agentTitle(agent)}</h1>
            {badge}
            <HeaderSwitcher />
          </div>
          {line ? <p className="text-sm text-ink-muted">{line}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// ── The rolling draft (docs/plan.md §1.2 "Workflow model") ──────────────────────────────────────

// DECISION: versions are immutable rows, so the editor session's rolling draft is kept in this
// browser (per person, agent and the version it was opened on), saved after 2 s of idle editing;
// it becomes a version only when the operator saves, test-runs or publishes. History gets one
// version per deliberate save instead of one per pause, and a reload or a crash loses nothing.
// The key names the signed-in person (../../session/drafts.ts) and sign-out removes every draft;
// with no one signed in (a part rendered on its own) nothing is kept.
const IDLE_MS = 2000;

interface StoredDraft {
  from: string;
  at: number;
  bundle: unknown;
}

function readDraft(key: string | null): StoredDraft | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string | null, draft: StoredDraft | null) {
  if (!key) return;
  try {
    if (draft) window.localStorage.setItem(key, JSON.stringify(draft));
    else window.localStorage.removeItem(key);
  } catch {
    // Storage may be full or blocked; the builder works without it.
  }
}

/** The draft kept on this device, read as processes; null when it is the version it opened. */
function restoredDraft(
  key: string | null,
  from: VersionDetail,
  start: ProcessAgentBundle,
  ctx: TypingContext,
) {
  const stored = readDraft(key);
  if (!stored || stored.from !== from.id) return null;
  const parsed = AnyAgentBundleSchema.safeParse(stored.bundle);
  if (!parsed.success) return null;
  const bundle = readProcessBundle(parsed.data, ctx);
  if (canonicalJson(bundle) === canonicalJson(start)) return null;
  return { bundle, at: stored.at };
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Body ─────────────────────────────────────────────────────────────────────────────────────────

interface Saved {
  id: string;
  version: number;
  status: string;
  canon: string;
}

function BuilderBody(
  props: WorkflowBuilderProps & {
    data: BuilderData;
    template: AnyAgentBundle | null;
    people: People;
    /** Skill model (2026-11-10): a skill version a step moved to joins the builder's catalog. */
    onCatalogSkill?(entry: BuilderCatalog["skills"][number]): void;
  },
) {
  const { agent, from, data, base } = props;
  const navigate = useNavigate();
  // docs/plan.md §1.125: steps that require code, with their request's status in the Dev queue.
  const codeRequests = useApi(codeRequestRoutes.opsAgentCodeRequests, { params: { id: agent.id } });
  const ctx = useMemo(() => typingContext(data), [data]);
  // The version as the builder edits it: v3 workflows read as processes, every id kept. It is the
  // starting point, not an edit: nothing is unsaved until the operator changes something.
  const [start] = useState(() => readProcessBundle(props.bundle, ctx));
  const opensV3 = holdsV3(props.bundle);
  const template = useMemo(
    () => (props.template ? readProcessBundle(props.template, ctx) : null),
    [props.template, ctx],
  );
  // The rolling draft's key: this person's, for this agent; null with no one signed in.
  const owner = useOptionalSession()?.user.id ?? null;
  const draftKey = owner ? builderDraftKey(owner, agent.id) : null;
  const [restored] = useState(() => restoredDraft(draftKey, from, start, ctx));
  const [history, setHistory] = useState<History>(() => startHistory(restored?.bundle ?? start));
  const bundle = history.present;
  // §1.164: the inspector types a Read table step's rows by the agent's columns too (its Settings).
  const agentSkills = bundle.definition.skills;
  const inspectorCtx = useMemo(() => ({ ...ctx, agentSkills }), [ctx, agentSkills]);
  const [saved, setSaved] = useState<Saved>(() => ({
    id: from.id,
    version: from.version,
    status: from.status,
    canon: canonicalJson(start),
  }));
  const canon = useMemo(() => canonicalJson(bundle), [bundle]);
  const dirty = canon !== saved.canon;
  // The bundle the saved version holds (the base an edit made here is carried from), and the
  // canvas now, for answers that come back after the screen re-rendered (FLOW-6, FLOW-9).
  const savedBundle = useRef(start);
  const present = useRef(bundle);
  present.current = bundle;
  const [draftAt, setDraftAt] = useState<number | null>(restored?.at ?? null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  // What a rail item being dragged says under the pointer (a box moves by itself).
  const [dragLabel, setDragLabel] = useState<{ title: string; kind: string } | null>(null);
  const [addingWorkflow, setAddingWorkflow] = useState(false);
  // Whether "What's left" is open above the chart; null follows whether anything is left.
  const [leftShown, setLeftShown] = useState<boolean | null>(null);
  // Chart or List: the route says which one it opens on (`steps/:workflow` is the List).
  const [view, setView] = useState<FlowView>(props.view === "steps" ? "list" : "chart");
  useEffect(() => setView(props.view === "steps" ? "list" : "chart"), [props.view]);
  // The right side: the selected step or trigger, the whole-flow Builder, or the test run.
  const [side, setSide] = useState<Side>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  // The place the next step picked in the rail goes to (a + pressed on the chart, "a new step
  // here" from a step's connections); null adds at the end of the list in the frame.
  const [addAt, setAddAt] = useState<InsertPoint | null>(null);
  // v0.18: the missing step the rail's pick replaces, while "Replace with a step" is on.
  const [replacing, setReplacing] = useState<string | null>(null);
  // A template's connectors the operator chose to build with in this session.
  const [extraConnectors, setExtraConnectors] = useState<string[]>([]);
  const railRef = useRef<HTMLDivElement>(null);
  // The rail folds to a thin strip, remembered per viewer in this browser.
  const [railFolded, setRailFoldedState] = useState(() => {
    try {
      return window.localStorage.getItem(RAIL_KEY) === "folded";
    } catch {
      return false;
    }
  });
  const setRailFolded = (folded: boolean) => {
    setRailFoldedState(folded);
    try {
      window.localStorage.setItem(RAIL_KEY, folded ? "folded" : "shown");
    } catch {
      // Storage blocked: it stays as chosen for this visit.
    }
  };
  // Loops folded to one box on the chart (how it is drawn, never stored).
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  // The For each or Repeat whose own steps are in the frame; null is the whole flow.
  const [openLoop, setOpenLoop] = useState<string | null>(null);
  // A connection asked for on the chart (a step's dot dragged onto another), for that step's
  // "Comes after" to check and make as a pick there is.
  const [propose, setPropose] = useState<{
    stepId: string;
    end: Reconnect["end"];
    to: string;
    nonce: number;
  } | null>(null);
  const proposals = useRef(0);
  // Read once by the step's connections when they render with it; then it is done.
  useEffect(() => {
    if (propose) setPropose(null);
  }, [propose]);
  // How much of the step panel the Builder takes, as last chosen in this browser.
  const [chatSize, setChatSizeState] = useState<BuilderSize>(readStepChatSize);
  const setChatSize = (size: BuilderSize) => {
    setChatSizeState(size);
    writeStepChatSize(size);
  };
  // Top-level steps picked for "Save as automation"; null while not picking.
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [notice, setNotice] = useState<{
    tone: "positive" | "warning" | "neutral";
    body: ReactNode;
  } | null>(
    restored
      ? {
          tone: "neutral",
          body: `Restored your unsaved changes from ${clock(restored.at)}.`,
        }
      : opensV3
        ? {
            tone: "neutral",
            body: `v${from.version} is stored in the older workflow format. It opens here in the new format with every step as it was; your next save makes a new version in the new format, and v${from.version} stays as it is.`,
          }
        : null,
  );
  const action = useAction();
  const api = useApiClient();

  // Selecting a step or the trigger opens its side panel.
  useEffect(() => {
    if (selection) setSide("step");
  }, [selection]);

  const slug = props.workflow;
  const entry = bundle.workflows.find((w) => w.slug === slug);
  const workflow = entry?.workflow;

  // A new workflow starts on its whole flow, with nowhere chosen to add.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per workflow.
  useEffect(() => {
    setOpenLoop(null);
    setAddAt(null);
    setReplacing(null);
  }, [slug]);

  // ── What is in the frame: the whole flow, or a loop's own steps ──
  const shownLoop = useMemo(
    () => (workflow && openLoop ? loopProcess(workflow, openLoop) : null),
    [workflow, openLoop],
  );
  const loopId = shownLoop?.loop.id ?? null;
  const shown = shownLoop?.view ?? workflow;
  /** The list a step is added to when nowhere is chosen: the one in the frame. */
  const frameList: ContainerId = loopId ? `loop:${loopId}` : ROOT;

  // ── The side panel ──
  /**
   * Where the panel sits below the chart (narrow screens), it is scrolled into view and focused,
   * so a click on a step visibly lands somewhere.
   */
  const revealStep = () => {
    window.requestAnimationFrame(() => {
      const el = sideRef.current;
      if (!el?.parentElement) return;
      const beside =
        el.getBoundingClientRect().left - el.parentElement.getBoundingClientRect().left;
      if (beside > 10) return;
      el.scrollIntoView?.({ block: "start", behavior: "smooth" });
      // Not when focus is already in the panel (a field clicked before this frame): the field
      // keeps it, so what is typed there isn't lost.
      if (!el.contains(document.activeElement))
        el.querySelector<HTMLElement>("[data-testid='builder-inspector']")?.focus({
          preventScroll: true,
        });
    });
  };
  const selectStep = (id: string) => {
    setSelection({ type: "step", id });
    setSide("step");
    revealStep();
  };
  const selectTrigger = (id: string) => {
    setSelection({ type: "trigger", id });
    setSide("step");
    revealStep();
  };
  const closeSide = () => {
    setSide(null);
    setSelection(null);
  };
  /** The rail, with the place its next pick goes to (or the missing step it replaces). */
  const askWhere = (at: InsertPoint | null, replace: string | null = null) => {
    setAddAt(at);
    setReplacing(replace);
    setRailFolded(false);
    window.requestAnimationFrame(() =>
      railRef.current
        ?.querySelector<HTMLElement>("[data-testid='flow-rail-search']")
        ?.focus({ preventScroll: true }),
    );
  };
  const cancelWhere = () => {
    setAddAt(null);
    setReplacing(null);
  };
  /** The rail, adding right before or right after a step, on its list. */
  const addBeside = (stepId: string, where: "before" | "after") => {
    if (!workflow) return;
    const loc = locate(workflow, stepId);
    if (!loc) return;
    askWhere({ container: loc.container, index: where === "before" ? loc.index : loc.index + 1 });
  };
  /** Where the rail's next pick goes, in words; null while it goes to the end. */
  const targetText = useMemo(() => {
    if (!workflow) return null;
    // v0.18: the pick takes a missing step's place.
    const replaced = replacing ? locate(workflow, replacing)?.step : undefined;
    if (replaced) return `in place of “${replaced.name || "the missing step"}”`;
    return addAt ? placeWords(workflow, addAt) : null;
  }, [workflow, addAt, replacing]);

  // ── Whose tools the palette offers ──
  // DECISION (2.5): the frame's clients list (OpsLayout's `clients?view=names`) says whether the
  // client is the Sandbox; the builder asks for its own only outside the frame (a screen test), or
  // while the frame's is still on its way (the same request then, shared by the store).
  const frameClients = useOpsClients();
  const asks = agent.kind === "client" && !agent.testCopy;
  const clients = useApi(
    apiRoutes.opsClients,
    asks && frameClients === null ? { query: { view: "names" }, life: "catalog" } : null,
  );
  const sandbox =
    asks &&
    (frameClients ?? clients.data?.clients)?.find((c) => c.id === agent.tenantId)?.sandbox === true;
  const connectors = useMemo(
    () =>
      paletteConnectors({
        agent,
        bundle,
        data,
        connections: props.connections ?? [],
        sandbox,
        extra: extraConnectors,
      }),
    [agent, bundle, data, props.connections, sandbox, extraConnectors],
  );
  // Names for the steps' second lines: skills and automations by name, tools by their connector,
  // people by their name.
  const labels = useMemo<StepLabels>(
    () => ({
      skill: (ref) =>
        data.catalog.skills.find((s) => s.ref === ref || parseSkillRef(s.ref).id === ref)
          ?.definition.name,
      automation: (ref) => data.catalog.automations?.find((a) => a.ref === ref)?.name,
      handoff: (to) => handoffNames(data, to),
      connector: (toolId) => {
        const c = toolConnector(toolId, data);
        return c ? connectorName(data, c) : undefined;
      },
      // The chart's mark on a read or a write: the connector its tool is on, or an action's own.
      connectorOf: (step) => {
        if (step.kind !== "read" && step.kind !== "write") return undefined;
        const id =
          step.kind === "write" && step.action !== undefined
            ? (step.via ?? null)
            : step.tool !== undefined
              ? toolConnector(step.tool, data)
              : null;
        return id ? { id, name: connectorName(data, id) } : undefined;
      },
      changesClientTool: (toolId) => {
        const tool = ctx.tools?.[toolId];
        return tool ? tool.sideEffect === "external" : undefined;
      },
      // Skill model (2026-11-10): each skill step's kind, each write by where it writes.
      skillKind: (ref) => catalogSkillKind(data, ref),
      // Review: a read or a write on a tool that calls a model inside reads AI.
      toolUsesModel: (toolId) => {
        const tool = ctx.tools?.[toolId];
        return tool ? toolUsesModel(tool) : undefined;
      },
      writeLabel: (toolId) => writeLabelOf(data, toolId),
      stepModel: (step) => {
        if (step.kind !== "skill") return undefined;
        const def = lookupSkill(step.skill, ctx);
        if (!def) return undefined;
        const runs = effectiveModel({
          skill: def,
          agentModel: bundle.definition.model,
          agentSkill: agentSkillEntry(bundle.definition, parseSkillRef(step.skill).id)?.model,
          step: step.model ?? step.customize?.model,
        });
        return runs ? providerModelName(runs.model.id) : undefined;
      },
      person: (id) => {
        // A role reads as its own words ("client admin"); a person by their name.
        if (["client_admin", "client_user", "operator", "lead"].includes(id)) return undefined;
        return personName(props.people, id);
      },
      description: (step) => {
        if (step.kind === "skill") {
          return data.catalog.skills.find(
            (s) => s.ref === step.skill || parseSkillRef(s.ref).id === step.skill,
          )?.definition.description;
        }
        // v4: a read or a write by its tool (an action write has none: its kind says it).
        if ((step.kind === "read" || step.kind === "write") && step.tool !== undefined) {
          return data.catalog.tools.find((t) => t.id === step.tool)?.description;
        }
        if (step.kind === "process") {
          return (
            data.catalog.automations?.find((a) => a.ref === step.process)?.description ?? undefined
          );
        }
        return undefined;
      },
    }),
    [data, ctx, props.people, bundle],
  );

  // ── Edits ──
  const apply = useCallback(
    (fn: (b: ProcessAgentBundle) => ProcessAgentBundle, key: string | null = null) =>
      setHistory((h) => commit(h, fn(h.present), key)),
    [],
  );
  const edit = useCallback(
    (fn: (w: Process) => Process, key: string | null = null) =>
      apply((b) => editWorkflow(b, slug, fn), key),
    [apply, slug],
  );

  /**
   * Adds what the rail offers: pressed, it goes to the place chosen (a + on the chart) or to the
   * end of the list in the frame; dropped on the chart, to `target`, where it was dropped.
   */
  const addItem = (item: PaletteItem, target?: InsertPoint) => {
    if (!workflow) return;
    if (item.type === "trigger") {
      // It replaces the trigger in the panel, else the first: a trigger keeps its id.
      const id =
        selection?.type === "trigger" && workflow.triggers.some((t) => t.id === selection.id)
          ? selection.id
          : workflow.triggers[0]?.id;
      edit((w) => setTrigger(w, item.on, id));
      if (id) setSelection({ type: "trigger", id });
      return;
    }
    const step = createStep(item, ctx);
    // v0.18: "Replace with a step" puts the pick in the missing step's place, with its id.
    if (replacing && !target) {
      const id = replacing;
      cancelWhere();
      apply((b) =>
        allowStep(
          editWorkflow(b, slug, (w) => replaceStep(w, id, step)),
          step,
          ctx,
        ),
      );
      setSelection({ type: "step", id });
      return;
    }
    const at = target ??
      addAt ?? {
        container: frameList,
        index: getContainer(workflow, frameList)?.length ?? workflow.steps.length,
      };
    cancelWhere();
    apply((b) =>
      allowStep(
        editWorkflow(b, slug, (w) => insertStep(w, at.container, at.index, step)),
        step,
        ctx,
      ),
    );
    // The new step opens in the side panel.
    setSelection({ type: "step", id: step.id });
  };
  const remove = (id: string) => {
    edit((w) => removeStep(w, id));
    if (selection?.type === "step" && selection.id === id) closeSide();
  };

  // ── Validation (the server's rules, on every change) ──
  const matrices = useMemo(
    () => (agent.kind === "client" ? boundMatrices(agent.bindings, props.connections ?? []) : {}),
    [agent, props.connections],
  );
  // While a stored v3 version is open unchanged, Publish sends that version as stored and the
  // server validates it as v3, so the problem list and the Publish button read the stored bundle
  // (core validates an all-v3 bundle exactly as `validateBundle` does). After the first edit they
  // read the process the next save writes.
  // DECISION (web, wave 3b): validate what Publish would send: the stored v3 bundle until the first
  // edit, then the v4 process; the converted reading isn't shown as the version's own problems.
  const unchangedV3 = opensV3 && !dirty && saved.id === from.id;
  const result = useMemo(() => {
    const r = validateProcessesLikeServer(unchangedV3 ? props.bundle : bundle, ctx, {
      clientAgent: agent.kind === "client",
      publish: agent.kind === "client" ? { matrices } : undefined,
      handoff: data.handoff,
    });
    // Wave 5: a condition on how a step ended says what's wrong in the builder's words.
    const plain = <
      P extends {
        workflow?: string | undefined;
        stepId: string | null;
        field: string;
        code: string;
        message: string;
      },
    >(
      p: P,
    ): P => {
      const process = bundle.workflows.find((w) => w.slug === p.workflow)?.workflow;
      return process ? { ...p, message: plainOutcomeProblem(process, p) } : p;
    };
    return { ...r, errors: r.errors.map(plain), warnings: r.warnings.map(plain) };
  }, [unchangedV3, props.bundle, bundle, ctx, matrices, agent.kind, data.handoff]);
  // Counted as the problems list shows them: one step's references to the same step are one.
  const problemCount = useMemo(
    () => problemLines(result.errors, bundle).length,
    [result.errors, bundle],
  );
  // Connections (owner, 2026-11-14): the same check on this workflow as an edit would leave it,
  // for the inspector's "Prior step" and "Next step" (always the v4 process the next save writes).
  // `checkRaw` keeps the validator's own words (for the Builder), `assess` reads them plainly.
  const checkRaw = useCallback(
    (next: Process) =>
      validateProcessesLikeServer(
        editWorkflow(bundle, slug, () => next),
        ctx,
        {
          clientAgent: agent.kind === "client",
          publish: agent.kind === "client" ? { matrices } : undefined,
          handoff: data.handoff,
        },
      ).errors.filter((e) => e.workflow === slug),
    [bundle, slug, ctx, agent.kind, matrices, data.handoff],
  );
  const assess = useCallback(
    (next: Process) =>
      readableErrors(
        checkRaw(next).map((e) => ({ ...e, message: plainOutcomeProblem(next, e) })),
        editWorkflow(bundle, slug, () => next),
      ),
    [checkRaw, bundle, slug],
  );
  // In plain words for the step panel and its fields; the list below groups them too.
  const workflowErrors = useMemo(
    () =>
      readableErrors(
        result.errors.filter((e) => e.workflow === slug),
        bundle,
      ),
    [result.errors, slug, bundle],
  );
  const mode = bundle.definition.permissions.mode;
  const env = useMemo<ApprovalEnv>(
    () => ({
      ctx,
      agentKind: agent.kind,
      mode,
      matrices,
      connectorName: (id) => connectorName(data, id),
    }),
    [ctx, agent.kind, mode, matrices, data],
  );
  const counts = workflow ? workflowCounts(workflow, env) : null;
  const templateWorkflow = template?.workflows.find((w) => w.slug === slug)?.workflow;
  const customized = useMemo(
    () => (workflow && template ? customizedSteps(workflow, templateWorkflow) : new Map()),
    [workflow, template, templateWorkflow],
  );

  // ── v0.18: what each step reads and saves, and what's left (docs/plan.md §1.103) ──
  const client = asks ? agent.tenantId : null;
  // DECISION (v0.18): the packs and the test run come from the routes the back office already has
  // (the client's packs, the runs list filtered to this agent's test runs of this version); while
  // either is loading or fails, what's left leaves that item out rather than guessing.
  const clientPacks = useApi(
    apiRoutes.opsClientPacks,
    client ? { params: { id: client }, life: "catalog" } : null,
  );
  const testRuns = useApi(
    apiRoutes.opsRuns,
    client ? { query: { agent: agent.id, mode: "test", versions: saved.id, limit: 1 } } : null,
  );
  // A test run started here, of the version it saved first.
  const [testedHere, setTestedHere] = useState<string | null>(null);
  const dataNames = useMemo<DataNames>(
    () => ({
      connector: (id) => connectorName(data, id),
      pack: (id) =>
        clientPacks.data?.packs.find((p) => p.id === id)?.name ?? connectorName(data, id),
    }),
    [data, clientPacks.data],
  );
  const dataCtx = useMemo(
    () => ({ ...ctx, connectors: new Set(data.catalog.connectors.map((c) => c.id)) }),
    [ctx, data.catalog.connectors],
  );
  const clientName =
    (frameClients ?? clients.data?.clients)?.find((c) => c.id === agent.tenantId)?.name ??
    "this client";
  const setup = useMemo<ClientSetup | null>(() => {
    if (!client) return null;
    const live = (props.connections ?? []).filter((c) => c.status !== "disconnected");
    return {
      name: clientName,
      connected: new Set(live.map((c) => c.connector)),
      bound: new Set(
        Object.entries(agent.bindings)
          .filter(([connector, id]) => live.some((c) => c.id === id && c.connector === connector))
          .map(([connector]) => connector),
      ),
      packs: clientPacks.data
        ? new Map(clientPacks.data.packs.map((p) => [p.id, p.enabled]))
        : null,
    };
  }, [client, clientName, props.connections, agent.bindings, clientPacks.data]);
  // DECISION (v0.18): "tested" means a test run of the saved version with no change since; a
  // template's test runs run as test copies in clients, so for a template it isn't known (no item).
  const tested: boolean | null = !client
    ? null
    : dirty
      ? false
      : testedHere === saved.id || (testRuns.data ? testRuns.data.runs.length > 0 : null);
  const leftItems = useMemo(
    () => whatsLeft({ bundle, ctx: dataCtx, client: setup, names: dataNames, tested }),
    [bundle, dataCtx, setup, dataNames, tested],
  );
  const dataSummary = useMemo(
    () => agentDataSummary(bundle, dataCtx, dataNames),
    [bundle, dataCtx, dataNames],
  );
  const dataOf = useCallback(
    (step: processes.Step) => {
      const use = processes.stepDataUse(step, dataCtx);
      return {
        lines: stepDataLines(use, dataNames),
        warnings: stepDataWarnings(use, setup, dataNames),
      };
    },
    [dataCtx, dataNames, setup],
  );
  // The problems list leaves out what's left lists on its own: missing steps, and a connection
  // the client setup items already name.
  const setupConnectors = new Set(
    leftItems.flatMap((i) => (i.kind === "connection" ? [i.key.slice("connection:".length)] : [])),
  );
  const listedErrors = result.errors.filter(
    (e) =>
      e.code !== "missing_step" &&
      !(e.code === "connection_missing" && setupConnectors.has(problemConnector(e.message) ?? "")),
  );
  const selectLeft = (item: Extract<LeftItem, { stepId: string }>) =>
    showError({
      workflow: item.workflow,
      stepId: item.stepId,
      field: "",
      code: "missing_step",
      message: "",
    });
  // Draft the skill a missing step needs: a Builder conversation about a new skill (§9.6), for
  // this client's agents when the agent is a client's.
  const [draftingSkill, setDraftingSkill] = useState(false);
  const draftSkill = async (step: processes.MissingStep) => {
    setDraftingSkill(true);
    try {
      const started = await action.call(apiRoutes.opsStartBuilderSession, {
        body: { kind: "skill", ...(client ? { clientId: client } : {}) },
      });
      if (!started.ok) return;
      const id = started.data.session.id;
      await action.call(apiRoutes.opsBuilderTurn, {
        params: { id },
        body: {
          text: `Draft a skill for the step "${step.name}" of the agent ${agent.name}. What is missing: ${step.need}`,
        },
      });
      // The builder's draft is kept on this device now, so nothing is lost by going to the skill.
      if (dirty) writeDraft(draftKey, { from: saved.id, at: Date.now(), bundle });
      navigate(`/ops/skills/new?session=${id}`);
    } finally {
      setDraftingSkill(false);
    }
  };

  // ── The rolling draft ──
  useEffect(() => {
    if (!dirty || !draftKey) return;
    const t = window.setTimeout(() => {
      const at = Date.now();
      writeDraft(draftKey, { from: saved.id, at, bundle });
      setDraftAt(at);
    }, IDLE_MS);
    return () => window.clearTimeout(t);
  }, [draftKey, bundle, dirty, saved.id]);

  // ── Undo / redo keys ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
    }
  };

  // ── The chart's events: each one an operation of ./model on the workflow ──
  /**
   * The dot under `fromId` dragged onto `toId`: that step comes next. On the same list it is the
   * step's "Comes after" set to the other, checked first and reviewed where it breaks something
   * (today's `assessReconnect`, in the step's connections); from another list the step moves to
   * right after it, as its box dragged onto that step does.
   */
  const connect = (fromId: string, toId: string) => {
    if (!workflow) return;
    const from = locate(workflow, fromId);
    const to = locate(workflow, toId);
    if (!from || !to) return;
    if (from.container === to.container) {
      proposals.current += 1;
      setPropose({ stepId: toId, end: "prior", to: fromId, nonce: proposals.current });
      setSelection({ type: "step", id: toId });
      setSide("step");
      return;
    }
    if (containersWithin(to.step).has(from.container)) return;
    edit((w) => moveStep(w, toId, from.container, from.index + 1));
    setSelection({ type: "step", id: toId });
  };
  // F7: the automations by slug, asked for once, when the first one is opened.
  const automationIds = useRef<Promise<ReadonlyMap<string, string>> | null>(null);
  /** A loop opens its own steps in the frame; an automation opens in its own editor. */
  const openGroup = async (id: string) => {
    const step = workflow ? locate(workflow, id)?.step : undefined;
    if (!step) return;
    if (isLoop(step)) {
      setOpenLoop(id);
      return;
    }
    if (step.kind !== "process") return;
    // DECISION (F6): the catalog names an automation by its pinned `slug@version`, not its id, so
    // its editor is found through the automations list (the client's own before a shared one of
    // the same slug); the Library's list when it isn't there.
    const used = data.catalog.automations?.find((a) => a.ref === step.process);
    const automation = used?.slug ?? step.process.split("@")[0];
    automationIds.current ??= api.call(apiRoutes.opsAutomations, { query: {} }).then((list) => {
      const ids = new Map<string, string>();
      for (const a of list.automations) {
        if (a.clientId !== null && a.clientId !== agent.tenantId) continue;
        if (a.clientId !== null || !ids.has(a.slug)) ids.set(a.slug, a.id);
      }
      return ids;
    });
    let found: string | undefined;
    try {
      found = (await automationIds.current).get(automation ?? "");
    } catch {
      // The list didn't answer: ask again next time, and go to the Library's automations.
      automationIds.current = null;
    }
    // The builder's draft is kept on this device first, so nothing is lost by leaving: it comes
    // back, unsaved, when this workflow is opened again.
    if (dirty) writeDraft(draftKey, { from: saved.id, at: Date.now(), bundle });
    navigate(found ? automationStepsPath(found) : "/ops/library/skills?tab=automations");
  };
  const chartEvents = {
    onSelect: (id: string | null) => {
      if (id === null) {
        if (side === "step") closeSide();
        return;
      }
      if (id === FLOW_START_ID || id === FLOW_GIVES_BACK_ID) {
        // A loop's start and end are the loop's own settings; an agent's start is its triggers.
        if (loopId) selectStep(loopId);
        else if (id === FLOW_START_ID && workflow) {
          const current =
            selection?.type === "trigger" && workflow.triggers.some((t) => t.id === selection.id)
              ? selection.id
              : workflow.triggers[0]?.id;
          if (current) selectTrigger(current);
        }
        return;
      }
      selectStep(id);
    },
    onInsert: (at: InsertPoint, item?: unknown) => {
      const to = hostPoint(loopId, at);
      if (item) addItem(item as PaletteItem, to);
      else askWhere(to);
    },
    onMove: (id: string, at: InsertPoint) => {
      const to = hostPoint(loopId, at);
      edit((w) => moveStep(w, id, to.container, to.index));
    },
    onConnect: connect,
    onAddPath: (ifId: string) => {
      // One id, however often the edit is applied.
      const id = uuidv7();
      edit((w) =>
        updateStep(w, ifId, (s) =>
          s.kind === "if"
            ? { ...s, paths: [...s.paths, newPath(s.paths.length + 1, () => id)] }
            : s,
        ),
      );
      selectStep(ifId);
      // Ask what it is first (owner, 2026-11-21): the panel opens on the new path's name, ready
      // to be typed over; when a run takes it is the question under it.
      setFocus({ node: id, field: "name", select: true, nonce: Date.now() });
    },
    onOpenGroup: (id: string) => void openGroup(id),
  };

  // ── Drag and drop (the chart's boxes and dots, the rail's items) ──
  const sensors = useSensors(
    // After a 4px move, so a click still selects.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const onDragEnd = (e: DragEndEvent) => {
    setDragLabel(null);
    dispatchFlowDrop(resolveFlowDrop(e.active, e.over), chartEvents);
  };

  // ── Selecting what an error names ──
  const showError = (e: BuilderProblem) => {
    if (e.workflow && e.workflow !== slug) {
      navigate(`${base}/${view === "list" ? "steps" : "workflows"}/${e.workflow}`);
      return;
    }
    if (!workflow || !e.stepId) return;
    const stepId = e.stepId;
    if (workflow.triggers.some((t) => t.id === stepId)) {
      setOpenLoop(null);
      setSelection({ type: "trigger", id: stepId });
    } else {
      const owner = locate(workflow, e.stepId)?.step ?? ifOfBranch(workflow, e.stepId);
      if (!owner) return;
      // A step outside the loop in the frame: back to the whole flow, where it is.
      if (shownLoop && !processes.findStep({ steps: shownLoop.loop.steps }, owner.id)) {
        setOpenLoop(null);
      }
      setSelection({ type: "step", id: owner.id });
    }
    setFocus({ node: e.stepId, field: e.field, nonce: Date.now() });
  };

  // ── Save, test run, publish ──
  const save = async (): Promise<Saved | null> => {
    const snapshot = bundle;
    const snapshotCanon = canonicalJson(snapshot);
    const res = await action.call(apiRoutes.opsSaveVersion, {
      params: { id: agent.id },
      body: {
        bundle: snapshot,
        parentVersionId: saved.id,
        changeNote: "Edited in the workflow builder",
      },
    });
    if (res.ok) {
      const next: Saved = {
        id: res.data.version.id,
        version: res.data.version.version,
        status: res.data.version.status,
        canon: snapshotCanon,
      };
      setSaved(next);
      savedBundle.current = snapshot;
      writeDraft(draftKey, null);
      setDraftAt(null);
      props.onChanged();
      return next;
    }
    if (isCode(res.error, "no_op")) {
      const next = { ...saved, canon: snapshotCanon };
      setSaved(next);
      savedBundle.current = snapshot;
      writeDraft(draftKey, null);
      setDraftAt(null);
      action.clear();
      return next;
    }
    return null;
  };

  const onSave = async () => {
    setNotice(null);
    const v = await save();
    if (v) {
      setNotice({
        tone: "positive",
        body: `Saved v${v.version} as a draft.${result.valid ? " Test-run it, then publish." : " Fix the problems below before it can be published."}`,
      });
    }
  };

  // Publishing (the save before it included): the button says so at once and can't be pressed
  // twice; nothing reads as published before the server says it is (1.8, invariant 8).
  const [publishing, setPublishing] = useState(false);
  const onPublish = async () => {
    setNotice(null);
    setPublishing(true);
    try {
      await publishLatest();
    } finally {
      setPublishing(false);
    }
  };
  const publishLatest = async () => {
    const v = dirty ? await save() : saved;
    if (!v) return;
    const res = await action.call(apiRoutes.opsPublish, {
      params: { id: agent.id, vid: v.id },
    });
    if (res.ok) {
      setSaved((s) => ({ ...s, id: res.data.version.id, status: "live" }));
      setNotice({
        tone: "positive",
        body:
          agent.kind === "template"
            ? `Published v${res.data.version.version}. Client agents take it as a reviewed update.`
            : `Published v${res.data.version.version}.`,
      });
      props.onChanged();
    }
  };

  // FLOW-6 (QA 2026-11-19): a version saved on top of this one while it is open (a trigger added
  // or removed in "Starts when" above) used to reopen the builder on it, and its unsaved edits were
  // gone. The builder now moves onto it with them carried over, so its next save builds on it.
  // A version saved on top of another isn't taken: the edits stay, and a save of them is refused
  // by the API as stale rather than made over the newer version.
  // DECISION: rebase onto the new version with core's three-way merge, rather than save the
  // builder's edits first (a version the operator didn't ask for) or put the panel's triggers on
  // the canvas unsaved (the panel says it saved a version, and the agent's other tabs read it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per new version.
  useEffect(() => {
    if (from.id === saved.id || from.parentVersionId !== saved.id) return;
    const theirs = readProcessBundle(props.bundle, ctx);
    const next = rebase(savedBundle.current, present.current, theirs, (b) =>
      readProcessBundle(b, ctx),
    );
    if (!next) {
      setNotice({
        tone: "warning",
        body: `v${from.version} was saved while you edited here, and changes the same part of the workflow. Your changes stay on the canvas, unsaved; reload to start again from v${from.version}.`,
      });
      return;
    }
    setHistory((h) =>
      canonicalJson(h.present) === saved.canon ? startHistory(next) : commit(h, next),
    );
    setSaved({
      id: from.id,
      version: from.version,
      status: from.status,
      canon: canonicalJson(theirs),
    });
    savedBundle.current = theirs;
  }, [from.id]);

  const session = useBuilderSession({
    agent,
    bundle,
    read: (b) => readProcessBundle(b, ctx),
    ensureSaved: async () => (dirty ? await save() : saved),
    // FLOW-9 (QA 2026-11-19): the Builder's draft answers the canvas as it was when the words were
    // sent; edits made on the canvas while it worked are carried onto it, not undone.
    // DECISION: merge, not lock: core's three-way merge (the update merge's) keeps both, and the
    // canvas stays usable for the minute a turn can take. Where both changed the same thing the
    // canvas is kept and the Builder's change stays in the conversation, to ask again.
    onDraft: (next, base) => {
      const merged = rebase(base, present.current, next, (b) => readProcessBundle(b, ctx));
      if (merged) {
        apply(() => merged);
        return;
      }
      setNotice({
        tone: "warning",
        body: "You changed the same steps while the Builder worked, so its change isn't on the canvas. Your edits are kept; ask the Builder again.",
      });
    },
  });
  // ── v0.18: working on steps with the Builder (docs/plan.md §1.105) ──
  // F6: always under the step's setup in the side panel, in the size chosen there.
  const steps = useMemo(() => (workflow ? processes.allSteps(workflow) : []), [workflow]);
  // The step the conversation is on: the selected step, in run order, with its neighbours.
  // DECISION (v0.18): previous and next go through every step in run order, nested ones included
  // (a path's steps, a loop's), so "step by step" reaches all of them.
  const stepFocus = (() => {
    if (side !== "step" || selection?.type !== "step") return null;
    const at = steps.findIndex((l) => l.step.id === selection.id);
    const here = steps[at];
    if (!here) return null;
    return {
      step: {
        id: here.step.id,
        name: here.step.name,
        place: `step ${at + 1} of ${steps.length}`,
      },
      previous: steps[at - 1]?.step.id,
      next: steps[at + 1]?.step.id,
    };
  })();

  // ── Fix: a problem explained and a fix proposed by the Builder, in a dialog ──
  const [fixing, setFixing] = useState<FixRequest | null>(null);
  const workflowName = (s?: string) =>
    bundle.workflows.find((w) => w.slug === (s ?? slug))?.name ?? "this workflow";
  const fixLine = (line: ProblemLine) =>
    setFixing({
      error: line.error,
      place: problemPlace(line.error, bundle, slug),
      text: line.text,
      raw: line.all.map((e) => e.message),
      workflowName: workflowName(line.error.workflow),
    });
  /** From the step panel, whose errors are already in plain words: the raw ones match by place. */
  const fixError = (e: BuilderProblem) => {
    const raw = result.errors.filter(
      (r) =>
        r.workflow === slug && r.stepId === e.stepId && r.field === e.field && r.code === e.code,
    );
    setFixing({
      error: raw[0] ?? e,
      place: problemPlace(raw[0] ?? { ...e, workflow: slug }, bundle, slug),
      text: e.message,
      raw: raw.length ? raw.map((r) => r.message) : [e.message],
      workflowName: workflowName(),
    });
  };

  // Connections (owner, 2026-11-14): the move made, then the Builder asked to resolve all it breaks.
  const askBuilderAboutMove = (move: MoveRequest) => {
    if (!workflow) return;
    const after = reconnect(workflow, move.stepId, move.change);
    const made = newProblems(checkRaw(workflow), checkRaw(after));
    const first = made[0];
    edit((w) => reconnect(w, move.stepId, move.change), `${move.stepId}:connect:${uuidv7()}`);
    if (!first) return;
    const stepName = locate(after, move.stepId)?.step.name || "this step";
    const readable = newProblems(assess(workflow), assess(after));
    setFixing({
      error: first,
      place: stepName,
      text: `Moved “${stepName}” to run ${move.to}. ${readable.length === 1 ? "It makes 1 problem" : `It makes ${readable.length} problems`}: ${readable.map((e) => e.message).join(" ")}`,
      raw: made.map((e) => e.message),
      workflowName: workflowName(),
      prompt: movePrompt({
        stepName,
        workflowName: workflowName(),
        from: move.from,
        to: move.to,
        problems: made,
      }),
      short: "Resolve what this move breaks and propose a fix.",
      why: "A step can only use what the trigger gave or what a step before it on the same path gave back, in the shape it takes.",
    });
  };

  const saveAutomation = async (name: string, automationSlug: string) => {
    if (!checked || !workflow) return false;
    // In the canvas's order, as the steps run.
    const ids = workflow.steps.map((s) => s.id).filter((id) => checked.has(id));
    const ok = await session.saveAutomation(ids, name, automationSlug);
    if (ok) {
      setChecked(null);
      setNotice({
        tone: "positive",
        body: `Saved “${name}” as an automation draft and used it in place of ${plural(ids.length, "step")}. Save this draft to keep it.`,
      });
    }
    return ok;
  };

  const invalidReason = result.valid
    ? null
    : `Fix ${plural(problemCount, "problem")} first: only a valid workflow can be test-run or published.`;
  const publishBlocked =
    invalidReason ?? (!dirty && saved.status === "live" ? "Nothing new to publish." : null);

  // ── Each step's status: what the chart, the List, the bar and the side panel all read ──
  const requests = codeRequests.data?.steps;
  // F3: the open build's issues, questions and decisions, on the steps they name. The validator's
  // problems are the live ones here, so the build's copy of them is left out.
  const buildAsked = useApi(
    apiRoutes.opsBuild,
    props.buildId ? { params: { id: props.buildId } } : null,
  );
  const [buildNow, setBuildNow] = useState<BuildDetail | null>(null);
  const build = buildNow ?? buildAsked.data ?? null;
  const marks = useMemo(() => (build ? fromBuild(build, { problems: false }) : null), [build]);
  // F3: Try it on the chart: the bar at its top while a try runs, and what each step did.
  const [trying, setTrying] = useState<{ clientId: string | null } | null>(null);
  const [tried, setTried] = useState<TryMark[]>([]);
  const statuses = useMemo<StatusMap>(() => {
    if (!workflow) return new Map();
    // A connection the client lacks reads as the validator says it where it finds it; the setup
    // item says it only where the validator doesn't (a pack that is off, a draft's first look).
    const named = new Set(
      workflowErrors.flatMap((e) =>
        e.code === "connection_missing" && e.stepId ? [e.stepId] : [],
      ),
    );
    const setup = setupItems(leftItems, slug).filter((i) => !named.has(i.stepId));
    return withCodeRequests(
      buildStatuses({
        process: workflow,
        problems: workflowErrors,
        workflow: slug,
        items: [...setup, ...(marks?.items ?? [])],
        decided: marks?.decided,
        customized,
        tried,
      }),
      requests ?? [],
      slug,
    );
  }, [workflow, workflowErrors, slug, leftItems, marks, customized, requests, tried]);
  const order = useMemo(
    () => (workflow ? stepOrder(workflow, { triggers: true }) : []),
    [workflow],
  );
  const label = useMemo(() => chartLabel(labels, env), [labels, env]);
  const ends = useMemo(
    () =>
      shownLoop && workflow
        ? loopEnds(shownLoop.loop, workflow, dataCtx, (s) => dataOf(s).lines)
        : workflow
          ? agentEnds(workflow)
          : { start: null, givesBack: null },
    [shownLoop, workflow, dataCtx, dataOf],
  );
  const selectedId = selection?.id ?? null;
  const openNext = () => {
    const id = nextOpen(statuses, order, selectedId);
    if (!id || !workflow) return;
    if (workflow.triggers.some((t) => t.id === id)) selectTrigger(id);
    else selectStep(id);
  };
  const stepName = (id: string): string => {
    if (!workflow) return "";
    const trigger = workflow.triggers.find((t) => t.id === id);
    if (trigger) return triggerTitle(trigger);
    const step = locate(workflow, id)?.step;
    return step ? label(step).title : "";
  };

  // ── F3 and F4: Try it and Turn on ──
  const startTry = (clientId: string | null = null) => {
    setTried([]);
    setTrying({ clientId });
    if (side === "test") setSide(null);
  };
  /** Unsaved changes are saved as a draft first; the version a try or Turn on acts on. */
  const ensureSaved = async () => (dirty ? await save() : saved);
  // F4: Turn on is the bar's action while the agent is new: a template never published, a client's
  // agent still on the bench (or with no stage and nothing live). After that it is Publish.
  const isNew =
    agent.kind === "template"
      ? !agent.liveVersionId
      : agent.stage === "bench" || (!agent.stage && !agent.liveVersionId);
  const [turningOn, setTurningOn] = useState(false);
  // A template is turned on for a client: the ones the operator serves, asked for with the sheet.
  const turnOnClients = useApi(
    apiRoutes.opsClients,
    turningOn && agent.kind === "template" && frameClients === null
      ? { query: { view: "names" }, life: "catalog" }
      : null,
  );
  const openTurnOn = async () => {
    setNotice(null);
    if (await ensureSaved()) setTurningOn(true);
  };

  // ── Leaving the page from inside the builder ──
  /**
   * The line under the bar links to the merge screen and the template. A merge makes a new version
   * of this agent, which a draft kept on this device would not survive, so unsaved changes are
   * saved as a draft first; if that fails the builder stays, and says why.
   */
  const guardLeave = async (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest?.("a[href]");
    const href = link?.getAttribute("href");
    if (!dirty || !href || href.startsWith("http") || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (await save()) navigate(href);
  };

  // ── The side panel's parts ──
  /** The validator's problem a settle item stands for, and its place among the step's problems. */
  const problemOf = (item: SettleItem) => {
    if (item.source !== "problem" || !item.key.startsWith("problem:")) return null;
    const hit = workflowErrors.find((e) => `problem:${e.code}:${e.stepId}:${e.field}` === item.key);
    if (!hit) return null;
    const n = (statuses.get(item.stepId)?.items ?? [])
      .filter((i) => i.key.startsWith("problem:"))
      .findIndex((i) => i.key === item.key);
    return { hit, n };
  };
  /**
   * How an open item on a step is settled there: one button (owner, 2026-11-21: "provide
   * suggested fixes or options for the decisions… one button"). A problem's is Fix it, which has
   * the Builder draft the change to check; a path with no rule yet is answered in its own field.
   * "Show me where" beside it is the panel's (`onShowItem`).
   */
  const itemActions = (item: SettleItem): ReactNode => {
    const problem = problemOf(item);
    if (problem) {
      const { hit, n } = problem;
      if (item.level === "question") {
        return (
          <button
            type="button"
            className="ds-btn ds-btn--secondary ds-btn--sm"
            data-testid={`builder-inspector-error-${n}-answer`}
            onClick={() => showError({ ...hit, workflow: slug })}
          >
            Say when
          </button>
        );
      }
      return (
        <button
          type="button"
          className="ds-btn ds-btn--secondary ds-btn--sm"
          data-testid={`builder-inspector-error-${n}-fix`}
          onClick={() => fixError(hit)}
        >
          Fix it
        </button>
      );
    }
    if (item.source === "missing" && item.refId) {
      return (
        <Link
          to={devQueuePath(item.refId)}
          className="text-sm font-medium text-link underline"
          data-testid={`builder-steps-request-${item.stepId}`}
        >
          Open {item.refId} in the Dev queue
        </Link>
      );
    }
    if ((item.source === "build_item" || item.source === "decision") && props.buildId) {
      return (
        <Link
          to={OPS_PATHS.build(props.buildId)}
          className="text-sm font-medium text-link underline"
          data-testid={`builder-item-build-${item.stepId}`}
          onClick={() => {
            // The builder's draft is kept on this device, so nothing is lost by going there.
            if (dirty) writeDraft(draftKey, { from: saved.id, at: Date.now(), bundle });
          }}
        >
          Settle it on the build
        </Link>
      );
    }
    return null;
  };

  /** What an item's button does, in a line: the suggested fix. */
  const itemHint = (item: SettleItem): string | null => {
    const problem = problemOf(item);
    if (!problem) return null;
    return item.level === "question"
      ? "Suggested: say when in its rule below, or ask the Builder to write it from the path's name."
      : (FIX_HINT[problem.hit.code] ??
          "Suggested: let the Builder draft the fix. You see the change before it is kept.");
  };
  /** "Show me where": the field of a problem, opened and focused in the setup. */
  const onShowItem = (item: SettleItem) => {
    const problem = problemOf(item);
    if (problem) showError({ ...problem.hit, workflow: slug });
  };

  const inspector = workflow ? (
    <Inspector
      layout="panel"
      workflow={workflow}
      bundle={bundle}
      selection={selection}
      data={data}
      ctx={inspectorCtx}
      env={env}
      errors={workflowErrors}
      template={template ? { bundle: template, workflow: templateWorkflow } : null}
      people={props.people}
      focus={focus}
      connectors={connectors}
      onStep={(id, fn, key) => edit((w) => updateStep(w, id, fn), key)}
      onTrigger={(id, on: TriggerOn, key) => edit((w) => setTrigger(w, on, id), key)}
      onAddTrigger={(on) => {
        const id = uuidv7();
        edit((w) => addTrigger(w, on, () => id));
        setSelection({ type: "trigger", id });
      }}
      onRemoveTrigger={(id) => {
        edit((w) => removeTrigger(w, id));
        closeSide();
      }}
      onDelete={remove}
      // Skill model (2026-11-10): "Move to vN", references remapped, one undo.
      agentId={agent.id}
      tenantId={agent.tenantId}
      onMoveSkill={(move) => {
        props.onCatalogSkill?.({
          ref: move.to,
          source: "pinned",
          version: move.version,
          definition: move.definition,
          kind: skillKind(move.definition, toolLookup(data.catalog.tools)),
          palette: false,
        });
        edit((w) => applySkillMove(w, move.stepId, move.to, move.remaps));
      }}
      // DECISION (wave 5, web): the step stays selected after "Add a route", so its
      // panel says what was set; the new if waits on the chart for its steps.
      onAddRoute={(id, option) => edit((w) => addRouteAfter(w, id, option)?.process ?? w)}
      // Skill model (2026-11-10): the write a skill's output fits, selected once
      // added so its panel shows the tool it will use.
      onAddAction={(id, fit) => {
        const newId = uuidv7();
        edit((w) => addActionAfter(w, id, fit, ctx, () => newId)?.process ?? w);
        setSelection({ type: "step", id: newId });
      }}
      // Reshape data (2026-11-11): a Reshape step before a step whose inputs can't
      // be filled, or between a skill and a write it fits in part; the agent gets
      // the skill in the same edit, and the new step opens with its mapping.
      onAddReshape={(at) => {
        const made = [uuidv7(), uuidv7()];
        apply((b) => {
          // The same ids however often the edit is applied.
          let n = 0;
          const ids = () => made[n++] ?? uuidv7();
          const next = editWorkflow(
            b,
            slug,
            (w) =>
              ("before" in at
                ? addReshapeBefore(w, at.before, ctx, ids)
                : addReshapeThenAction(w, at.after, at.action, ctx, ids)
              )?.process ?? w,
          );
          return allowStep(next, newReshapeStep(), ctx);
        });
        setSelection({ type: "step", id: made[0] as string });
      }}
      onProcess={(fn, key) => edit(fn, key)}
      onFix={fixError}
      // v0.18: each step's data, and what fills a missing step.
      dataOf={dataOf}
      missing={{
        onDraftSkill: draftSkill,
        onReplace: (id) => askWhere(null, id),
        drafting: draftingSkill,
      }}
      assess={assess}
      onAddHere={addBeside}
      onAskBuilder={askBuilderAboutMove}
    />
  ) : null;

  const stepPanel = (() => {
    if (!workflow || !selection) return null;
    const settle = {
      itemActions,
      itemHint,
      // Only a validator's problem has a field to show.
      onShowItem: (item: SettleItem) => onShowItem(item),
      onNext: (id: string) =>
        workflow.triggers.some((t) => t.id === id) ? selectTrigger(id) : selectStep(id),
    };
    const nextId = nextOpen(statuses, order, selection.id);
    const next = nextId ? { id: nextId, name: stepName(nextId) } : null;
    if (selection.type === "trigger") {
      const trigger = workflow.triggers.find((t) => t.id === selection.id);
      if (!trigger) return null;
      return (
        <StepPanel
          key={trigger.id}
          stepId={trigger.id}
          kind="Starts when"
          title={triggerTitle(trigger)}
          status={statuses.get(trigger.id)}
          next={next}
          {...settle}
          onClose={closeSide}
        >
          {workflow.triggers.length > 1 ? (
            // Each way it starts, to open: the chart's start box is all of them.
            <fieldset className="ds-seg flex-wrap" aria-label="How it starts">
              {workflow.triggers.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={t.id === trigger.id}
                  data-testid={`builder-trigger-${t.id}-select`}
                  onClick={() => selectTrigger(t.id)}
                >
                  {triggerTitle(t)}
                </button>
              ))}
            </fieldset>
          ) : null}
          {inspector}
        </StepPanel>
      );
    }
    const loc = locate(workflow, selection.id);
    if (!loc) return null;
    const step = loc.step;
    const words = label(step);
    const siblings = getContainer(workflow, loc.container) ?? [];
    return (
      <StepPanel
        key={step.id}
        stepId={step.id}
        kind={words.kind}
        place={{ n: loc.index + 1, of: siblings.length }}
        title={step.name}
        // One undo per run of typing, as the inspector's own name field made it.
        onRename={(name) =>
          edit((w) => updateStep(w, step.id, (s) => ({ ...s, name })), `${step.id}:name`)
        }
        status={statuses.get(step.id)}
        next={next}
        {...settle}
        connections={
          <ConnectionsSection
            key={step.id}
            layout="panel"
            step={step}
            workflow={workflow}
            ctx={ctx}
            assess={assess}
            onProcess={(fn, key) => edit(fn, key)}
            onAddHere={(where) => addBeside(step.id, where)}
            onAskBuilder={askBuilderAboutMove}
            propose={propose?.stepId === step.id ? propose : null}
          />
        }
        builder={
          stepFocus
            ? (size) => <StepChat session={session} step={stepFocus.step} size={size} />
            : undefined
        }
        builderSize={chatSize}
        onBuilderSize={setChatSize}
        // The step before and after, from the Builder's head (they were a row of the chat).
        onPreviousStep={((id) => (id ? () => selectStep(id) : undefined))(stepFocus?.previous)}
        onNextStep={((id) => (id ? () => selectStep(id) : undefined))(stepFocus?.next)}
        // An if and a missing step say how they are removed among their own settings.
        onRemove={step.kind === "if" ? undefined : () => remove(step.id)}
        removeLabel={step.kind === "missing" ? "Remove it" : undefined}
        onClose={closeSide}
      >
        {agent.kind === "client" ? (
          <StepDiff
            step={step}
            process={workflow}
            template={templateWorkflow}
            onChange={(next) => edit(() => next)}
          />
        ) : null}
        {inspector}
      </StepPanel>
    );
  })();

  const publish = isNew ? (
    // F4: Turn on in one button (publish, the copy for a template, the bindings, the trial).
    <Button
      variant="primary"
      size="sm"
      data-testid="flow-bar-turn-on"
      disabled={invalidReason !== null || action.busy}
      title={invalidReason ?? undefined}
      onClick={() => void openTurnOn()}
    >
      Turn on
    </Button>
  ) : !dirty && saved.status === "live" ? null : (
    // A live version with nothing new offers no publish: its badge says Live.
    <Button
      variant="primary"
      size="sm"
      data-testid="builder-publish"
      disabled={publishBlocked !== null || action.busy || publishing}
      title={publishBlocked ?? undefined}
      onClick={onPublish}
    >
      {publishing ? "Publishing…" : dirty ? "Save and publish" : `Publish v${saved.version}`}
    </Button>
  );

  const topSteps = workflow?.steps ?? [];
  // "What's left" above the chart: its count always shows; the list opens by itself only for
  // what no step on this chart says (the agent's own problems, another workflow's), since a
  // step's problems are on its box, on the bar and in its panel. Folded or opened by hand, it stays.
  // DECISION (F6): folded by default so the chart keeps the room; nothing is hidden that the
  // chart doesn't show.
  const leftTotal = leftItems.length + problemLines(listedErrors, bundle).length;
  const offChart = listedErrors.some((e) => !e.stepId || (e.workflow && e.workflow !== slug));
  const leftOpen = leftShown ?? offChart;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+Z / Ctrl+Shift+Z anywhere in the builder.
    <div data-testid="builder" onKeyDown={onKeyDown}>
      <BuilderBar
        agent={agent}
        badge={agent.kind === "template" ? <Badge tone="accent">Template</Badge> : null}
        line={agent.role}
      />
      <div className="overflow-x-auto">{props.tabs}</div>
      {props.above ? <div className="pt-4">{props.above}</div> : null}

      {notice || action.error ? (
        <div className="mt-4 flex flex-col gap-2">
          {notice ? (
            <Notice tone={notice.tone} testId="builder-notice">
              <span className="flex items-center justify-between gap-4">
                <span>{notice.body}</span>
                {restored && notice.tone === "neutral" ? (
                  <button
                    type="button"
                    data-testid="builder-discard-draft"
                    className="text-sm underline"
                    onClick={() => {
                      setHistory(startHistory(savedBundle.current));
                      writeDraft(draftKey, null);
                      setDraftAt(null);
                      setNotice(null);
                    }}
                  >
                    Discard them
                  </button>
                ) : null}
              </span>
            </Notice>
          ) : null}
          {action.error && !isCode(action.error, "no_op") ? (
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
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={flowCollision}
        onDragStart={(e) => {
          const d = e.active.data.current as { type?: string; item?: PaletteItem } | undefined;
          setDragLabel(
            d?.type === "palette" && d.item ? { title: d.item.title, kind: d.item.type } : null,
          );
        }}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragLabel(null)}
      >
        {/* F6: one frame as tall as the window under the header: the bar, then the rail, the chart
            or the List, and the side panel. On a narrow screen they stack and the page scrolls. */}
        <div className="flow-host -mx-4 -mb-8 mt-4 md:-mx-10 md:-mb-12" data-testid="builder-frame">
          <FlowBar
            lead={
              <WorkflowSwitcher
                bundle={bundle}
                current={slug}
                base={base}
                adding={addingWorkflow}
                onAdd={() => setAddingWorkflow((a) => !a)}
                view={view}
              />
            }
            name={entry?.name ?? agentTitle(agent)}
            version={
              dirty
                ? { state: "unsaved", version: saved.version }
                : { state: saved.status === "live" ? "live" : "draft", version: saved.version }
            }
            counts={counts ?? { steps: 0, ifs: 0, writes: 0, needApproval: 0 }}
            open={openCounts(statuses)}
            onNextOpen={openNext}
            view={view}
            onView={(v) => {
              setView(v);
              // The agent page's Workflow and Steps tabs follow: the same builder, the other view.
              navigate(`${base}/${v === "list" ? "steps" : "workflows"}/${slug}`);
            }}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            onUndo={() => setHistory(undo)}
            onRedo={() => setHistory(redo)}
            onAskBuilder={() => setSide(side === "builder" ? null : "builder")}
            onTry={workflow ? () => startTry() : undefined}
            tryBlocked={invalidReason}
            onSave={onSave}
            saved={!dirty}
            primary={publish}
          />
          {props.detail ? (
            // F8: whose agent this is and what it owes its template. Its links leave the page.
            <div data-testid="builder-lineage" onClickCapture={(e) => void guardLeave(e)}>
              <LineageStrip
                agent={agent}
                detail={props.detail}
                template={props.templateDetail}
                customized={customized}
                customizations={
                  workflow ? (
                    <CustomizationsList
                      process={workflow}
                      template={templateWorkflow}
                      onSelect={selectStep}
                      onChange={(next) => edit(() => next)}
                      label={label}
                      selected={side === "step" ? selectedId : null}
                    />
                  ) : null
                }
                onChanged={props.onChanged}
              />
            </div>
          ) : null}
          {shownLoop && entry ? (
            <nav className="flow-host__crumb" aria-label="Where this is" data-testid="flow-crumb">
              <button
                type="button"
                className="ds-btn ds-btn--link"
                data-testid="flow-crumb-back"
                onClick={() => setOpenLoop(null)}
              >
                <Icon name="arrow" className="rotate-180" />
                {entry.name}
              </button>
              <span aria-hidden>/</span>
              <span className="text-ink" data-testid="flow-crumb-here">
                {shownLoop.loop.name || PROCESS_KIND_LABEL[shownLoop.loop.kind]}
              </span>
              <span>
                · the steps it runs{" "}
                {shownLoop.loop.kind === "repeat" ? "each pass" : "for each item"}
              </span>
            </nav>
          ) : null}
          <div className="flow-host__body">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere in the rail forgets the place chosen. */}
            <div
              ref={railRef}
              className="flow-host__rail"
              onKeyDown={(e) => {
                if (e.key === "Escape" && (addAt || replacing)) {
                  e.stopPropagation();
                  cancelWhere();
                }
              }}
            >
              {targetText && !railFolded ? (
                <p className="flow-host__note" data-testid="builder-palette-target">
                  The step you pick goes {targetText}.{" "}
                  <button
                    type="button"
                    className="ds-btn ds-btn--link"
                    data-testid="builder-palette-cancel"
                    onClick={cancelWhere}
                  >
                    Cancel
                  </button>
                </p>
              ) : null}
              <div className="min-h-0 flex-1">
                <Rail
                  sections={paletteSections(bundle, data, connectors)}
                  onPick={(item) => addItem(item)}
                  onSay={(words) => {
                    // The words go to the Builder, with the place chosen when there is one.
                    setSide("builder");
                    void session.send(
                      targetText ? `Add a step ${targetText}: ${words}` : `Add a step: ${words}`,
                    );
                  }}
                  // A new start is offered while the start is open: the pick replaces that trigger.
                  triggers={selection?.type === "trigger" && side === "step"}
                  folded={railFolded}
                  onFold={setRailFolded}
                />
              </div>
              {railFolded ? null : (
                <div className="flow-host__foot">
                  {agent.kind === "template" ? (
                    <MoreConnectors
                      data={data}
                      shown={connectors}
                      onAdd={(id) => setExtraConnectors((x) => [...x, id])}
                    />
                  ) : (
                    <p className="text-xs text-ink-muted" data-testid="builder-palette-connected">
                      Only the tools this client has connected show here. Connect more on the
                      client's Setup page.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flow-host__main">
              <div className="flow-host__strip" data-testid="builder-strip">
                {addingWorkflow || bundle.workflows.length === 0 ? (
                  <AddWorkflowForm
                    bundle={bundle}
                    events={data.events
                      .filter((e) => !e.connector || connectors.has(e.connector))
                      .map((e) => e.type)}
                    onCancel={() => setAddingWorkflow(false)}
                    onCreate={(input) => {
                      apply((b) => addWorkflow(b, input));
                      setAddingWorkflow(false);
                      closeSide();
                      navigate(`${base}/${view === "list" ? "steps" : "workflows"}/${input.slug}`);
                    }}
                  />
                ) : null}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    className="ds-btn ds-btn--ghost ds-btn--sm"
                    aria-expanded={leftOpen}
                    data-testid="builder-strip-toggle"
                    onClick={() => setLeftShown(!leftOpen)}
                  >
                    <Icon name={leftOpen ? "chevron-down" : "chevron-right"} />
                    {leftTotal > 0 ? `What's left · ${leftTotal}` : "Nothing left to do"}
                  </button>
                  {checked ? (
                    <span className="flex flex-col gap-2">
                      <SaveAsAutomation
                        count={checked.size}
                        busy={session.busy}
                        onSave={saveAutomation}
                        onClear={() => setChecked(null)}
                      />
                      {/* The top-level steps, to pick: they become one automation step. */}
                      <fieldset className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Steps">
                        {topSteps.map((s, i) => (
                          <label key={s.id} className="flex items-center gap-1.5 text-sm text-ink">
                            <input
                              type="checkbox"
                              data-testid={`builder-step-${s.id}-check`}
                              checked={checked.has(s.id)}
                              onChange={(e) =>
                                setChecked((c) => {
                                  const next = new Set(c ?? []);
                                  if (e.target.checked) next.add(s.id);
                                  else next.delete(s.id);
                                  return next;
                                })
                              }
                            />
                            <span className="figures text-ink-muted">{i + 1}</span>
                            {s.name || PROCESS_KIND_LABEL[s.kind]}
                          </label>
                        ))}
                      </fieldset>
                    </span>
                  ) : topSteps.length > 0 && !loopId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="builder-select-steps"
                      onClick={() => setChecked(new Set())}
                    >
                      Save steps as an automation
                    </Button>
                  ) : (
                    <span />
                  )}
                  {workflow?.triggers[0] ? (
                    // Today's test run form: a recent event of the client's, or a template's client.
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="builder-test-run"
                      disabled={invalidReason !== null}
                      title={invalidReason ?? undefined}
                      onClick={() => setSide(side === "test" ? null : "test")}
                    >
                      Test-run on a recent event
                    </Button>
                  ) : null}
                  {dirty ? (
                    <span className="text-xs text-ink-muted" data-testid="builder-draft-status">
                      {draftAt
                        ? `Draft kept on this device · ${clock(draftAt)}`
                        : "Unsaved changes"}
                    </span>
                  ) : null}
                </div>
                {/* Folded, it stays in the page (a problem's Fix still opens from the step). */}
                <div hidden={!leftOpen} data-testid="builder-strip-left">
                  <WhatsLeft
                    items={leftItems}
                    problemCount={problemLines(listedErrors, bundle).length}
                    problems={
                      <Problems
                        errors={listedErrors}
                        valid={result.errors.length === 0}
                        bundle={bundle}
                        slug={slug}
                        onShow={showError}
                        onFix={fixLine}
                      />
                    }
                    summary={dataSummary}
                    onSelect={selectLeft}
                    onTest={() => startTry()}
                  />
                  <Advice warnings={result.warnings.filter((w) => w.workflow === slug)} />
                </div>
              </div>

              {trying && workflow ? (
                <div className="flow-host__try" data-testid="builder-try">
                  <TryPanel
                    process={workflow}
                    agent={agent}
                    workflow={slug}
                    versionId={saved.id}
                    prepare={async () => {
                      const v = await ensureSaved();
                      if (v) setTestedHere(v.id);
                      return v?.id ?? null;
                    }}
                    build={build}
                    clientId={trying.clientId}
                    sample={samplePayload(workflow, data.events)}
                    onMarks={setTried}
                    onDone={() => {
                      setTrying(null);
                      setTried([]);
                    }}
                    onBuild={setBuildNow}
                  />
                </div>
              ) : null}
              <div className="flow-host__stage" data-view={view}>
                {shown && view === "list" ? (
                  <div className="flow-host__list">
                    <StepTable
                      process={shown}
                      statuses={statuses}
                      selected={side === "step" ? selectedId : null}
                      onSelect={(id) =>
                        workflow?.triggers.some((t) => t.id === id)
                          ? selectTrigger(id)
                          : selectStep(id)
                      }
                      label={label}
                      onAdd={() => askWhere(null)}
                    />
                  </div>
                ) : shown ? (
                  <Chart
                    process={shown}
                    ends={ends}
                    statuses={statuses}
                    selected={
                      side !== "step" || !selection
                        ? null
                        : selection.type === "trigger"
                          ? FLOW_START_ID
                          : selection.id
                    }
                    folded={folded}
                    onFold={(id, fold) =>
                      setFolded((f) => {
                        const next = new Set(f);
                        if (fold) next.add(id);
                        else next.delete(id);
                        return next;
                      })
                    }
                    label={label}
                    {...chartEvents}
                  />
                ) : bundle.workflows.length > 0 ? (
                  <p className="p-4 text-ink-muted" data-testid="builder-no-workflow">
                    This agent has no workflow “{slug}”. Pick one above.
                  </p>
                ) : null}
              </div>
            </div>

            <div
              ref={sideRef}
              className={cx("flow-host__side scroll-mt-[var(--header-h)]", !side && "hidden")}
              data-testid="builder-side"
              data-side={side ?? undefined}
            >
              {/* Kept while another side shows, so what is typed to the Builder stays. */}
              <div
                className={cx("flow-host__sheet", side !== "builder" && "hidden")}
                data-testid="builder-side-builder"
              >
                <div className="flex justify-end">
                  <button
                    type="button"
                    aria-label="Close"
                    title="Close"
                    data-testid="builder-side-close"
                    onClick={() => setSide(null)}
                    className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink"
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <BuilderPanel session={session} />
                </div>
              </div>
              {side === "step" ? stepPanel : null}
              {side === "test" && workflow?.triggers[0] && entry ? (
                <div className="flow-host__sheet">
                  <TestRunPanel
                    agent={agent}
                    workflowName={entry.name}
                    slug={slug}
                    // DECISION: a test run starts from the first trigger's sample, as v3 had one trigger.
                    sample={samplePayload(workflow, data.events)}
                    eventType={triggerEventType(workflow)}
                    // Wave 5 review: routes on an approval go the no-approval way in a test run.
                    approvalNote={testRunApprovalNote(approvalRouteNames(workflow))}
                    busy={action.busy}
                    onClose={() => setSide(null)}
                    run={async (payload, clientId) => {
                      const v = dirty ? await save() : saved;
                      if (!v) return null;
                      const res = await action.call(apiRoutes.opsTestRun, {
                        params: { id: agent.id, vid: v.id },
                        body: { workflow: slug, payload, ...(clientId ? { clientId } : {}) },
                      });
                      if (res.ok) setTestedHere(v.id);
                      return res.ok ? res.data.runId : null;
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {turningOn ? (
          <TurnOnSheet
            agentId={agent.id}
            template={agent.kind === "template"}
            clients={(frameClients ?? turnOnClients.data?.clients ?? [])
              .filter((c) => !c.sandbox)
              .map((c) => ({ id: c.id, name: c.name }))}
            clientId={build?.build.client?.id ?? null}
            versionId={saved.id}
            toSettle={openCounts(statuses).issues + openCounts(statuses).questions}
            onTry={(clientId) => {
              setTurningOn(false);
              startTry(clientId);
            }}
            onNextOpen={() => {
              setTurningOn(false);
              openNext();
            }}
            onStarted={() => {
              // What it turned on is published; the agent page follows (its stage, its versions).
              setSaved((v) => ({ ...v, status: "live" }));
              props.onChanged();
            }}
            onChanged={() => props.onChanged()}
            onClose={() => setTurningOn(false)}
          />
        ) : null}
        {fixing ? (
          <FixDialog
            fix={fixing}
            session={session}
            onClose={() => setFixing(null)}
            onShowStep={fixing.error.stepId ? () => showError(fixing.error) : undefined}
          />
        ) : null}
        {/* Only while a rail item is dragged: a box moves by itself, and an overlay there (even an
            empty one) would stand in for it when the drop is worked out. */}
        {dragLabel ? (
          <DragOverlay dropAnimation={null}>
            <DragCard title={dragLabel.title} kind={dragLabel.kind} />
          </DragOverlay>
        ) : null}
      </DndContext>
    </div>
  );
}

/** What the drag overlay shows while a rail item is dragged onto the chart. */
function DragCard({ title, kind }: { title: string; kind: string }) {
  return (
    <div
      data-drag-overlay=""
      className="flex max-w-[420px] items-center gap-3 rounded-md border border-slate bg-surface px-4 py-3"
    >
      <Tag>{kind}</Tag>
      <span className="truncate font-medium text-ink">{title}</span>
    </div>
  );
}

// ── Problems ─────────────────────────────────────────────────────────────────────────────────────

function Problems({
  errors,
  valid,
  bundle,
  slug,
  onShow,
  onFix,
}: {
  errors: BuilderProblem[];
  /** v0.18: whether the bundle has no errors at all (what's left lists missing steps itself). */
  valid: boolean;
  bundle: ProcessAgentBundle;
  slug: string;
  onShow(e: BuilderProblem): void;
  /** Opens the Fix dialog for a line: the Builder explains it and proposes a fix. */
  onFix(line: ProblemLine): void;
}) {
  const [open, setOpen] = useState(true);
  if (errors.length === 0) {
    if (!valid) return null;
    return (
      <p className="mb-4 text-sm text-ink-muted" data-testid="builder-valid">
        Valid: ready to test-run and publish.
      </p>
    );
  }
  const lines = problemLines(errors, bundle);
  return (
    <div data-testid="builder-problems" className="ds-banner mb-4 block">
      <button
        type="button"
        aria-expanded={open}
        data-testid="builder-problems-toggle"
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium"
      >
        {plural(lines.length, "problem")} before this can be test-run or published
        {errors.some((e) => e.workflow && e.workflow !== slug) ? " (some in other workflows)" : ""}
      </button>
      {open ? (
        <ul className="mt-2 flex flex-col gap-1">
          {lines.map((line, i) => {
            const e = line.error;
            return (
              <li
                key={`${e.workflow}:${e.stepId}:${e.field}:${e.code}:${e.message}`}
                className="flex items-start justify-between gap-3"
              >
                <button
                  type="button"
                  data-testid={`builder-problem-${i}`}
                  onClick={() => onShow(e)}
                  className="min-w-0 text-left text-sm hover:underline"
                >
                  <span className="font-medium">{problemPlace(e, bundle, slug)}</span>: {line.text}
                </button>
                <button
                  type="button"
                  data-testid={`builder-problem-${i}-fix`}
                  aria-label={`Fix: ${problemPlace(e, bundle, slug)}`}
                  onClick={() => onFix(line)}
                  className="ds-btn ds-btn--secondary ds-btn--sm shrink-0"
                >
                  Fix
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The split signals (ARCHITECTURE §10.14 "When to split"): advice, never errors. The operator
 * decides whether a long or deeply nested process is better as two agents joined by a handoff.
 */
function Advice({ warnings }: { warnings: readonly { message: string; code: string }[] }) {
  if (warnings.length === 0) return null;
  return (
    <div
      data-testid="builder-advice"
      className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink-muted"
    >
      <p className="font-medium text-ink">Worth a look</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {warnings.map((w) =>
          // Wave 5: a condition on an outcome its step never reaches is its own advice.
          w.code === "outcome_unreachable" ? (
            <li key={`${w.code}:${w.message}`} data-testid="builder-advice-outcome">
              {w.message}
            </li>
          ) : (
            <li key={`${w.code}:${w.message}`}>
              {w.message}. Two agents joined by a handoff may read better.
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

// ── A template's connectors ──────────────────────────────────────────────────────────────────────

/**
 * A template's palette offers the connectors it already uses; this adds another one's steps for
 * this session (the Testkit is never offered here: it is for the Sandbox).
 */
function MoreConnectors({
  data,
  shown,
  onAdd,
}: {
  data: BuilderData;
  shown: ReadonlySet<string>;
  onAdd(id: string): void;
}) {
  const others = data.catalog.connectors
    .filter((c) => !shown.has(c.id) && c.id !== TESTKIT)
    // Only connectors with something to build with: a tool, or an event that starts a run.
    .filter((c) => data.catalog.tools.some((t) => (t.connector ?? t.source) === c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (others.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-4">
      <p className="text-xs text-ink-muted">
        This template's own tools show above. Build with another one:
      </p>
      <SmallSelect
        aria-label="Build with another connector"
        data-testid="builder-palette-more"
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
        }}
      >
        <option value="">Choose a connector…</option>
        {others.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SmallSelect>
    </div>
  );
}

// ── Workflows ────────────────────────────────────────────────────────────────────────────────────

/**
 * In the bar, before the workflow's name: the agent's other workflows to switch to (only when it
 * has several), and "+ Workflow".
 */
function WorkflowSwitcher({
  bundle,
  current,
  base,
  adding,
  onAdd,
  view,
}: {
  bundle: Pick<ProcessAgentBundle, "workflows">;
  current: string;
  base: string;
  adding: boolean;
  onAdd(): void;
  view: FlowView;
}) {
  return (
    <nav
      aria-label="Workflows"
      className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-md border border-line bg-surface p-1"
    >
      {bundle.workflows.length > 1
        ? bundle.workflows.map((w) => (
            <Link
              key={w.slug}
              to={`${base}/${view === "list" ? "steps" : "workflows"}/${w.slug}`}
              data-testid={`builder-workflow-${w.slug}-select`}
              aria-current={w.slug === current ? "page" : undefined}
              className={cx(
                "rounded-sm px-2.5 py-1 text-sm",
                w.slug === current
                  ? "bg-slate-tint font-medium text-ink"
                  : "text-ink-muted hover:bg-surface-subtle hover:text-ink",
              )}
            >
              {w.name}
              {w.enabled ? "" : " · off"}
            </Link>
          ))
        : null}
      <button
        type="button"
        data-testid="builder-workflow-add"
        aria-label="Add a workflow"
        aria-expanded={adding}
        onClick={onAdd}
        className="ds-btn ds-btn--link px-2.5 text-sm"
      >
        <Icon name="add" />
        Workflow
      </button>
    </nav>
  );
}

const TRIGGER_TYPES: { type: TriggerOn["type"]; label: string }[] = [
  { type: "manual", label: "By hand" },
  { type: "event", label: "When something happens" },
  { type: "schedule", label: "On a schedule" },
  { type: "command", label: "From a thread command" },
];

function AddWorkflowForm({
  bundle,
  events,
  onCreate,
  onCancel,
}: {
  bundle: Pick<ProcessAgentBundle, "workflows">;
  events: string[];
  onCreate(input: { slug: string; name: string; on: TriggerOn }): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [type, setType] = useState<TriggerOn["type"]>("manual");
  const [event, setEvent] = useState(events[0] ?? "");
  const [schedule, setSchedule] = useState<ScheduleValue>({ cron: "0 7 * * 1-5" });
  const [command, setCommand] = useState("");
  const [touched, setTouched] = useState(false);
  const effectiveSlug = slug ?? slugify(name);

  const problem = !name.trim()
    ? "Give it a name."
    : !Slug.safeParse(effectiveSlug).success
      ? "The slug takes lowercase letters, digits and dashes."
      : bundle.workflows.some((w) => w.slug === effectiveSlug)
        ? `This agent already has a workflow “${effectiveSlug}”.`
        : type === "event" && !event
          ? "Pick an event."
          : type === "command" && !command.trim()
            ? "Name the command."
            : null;

  const on = (): TriggerOn => {
    switch (type) {
      case "event":
        return { type, event };
      case "schedule":
        return { type, ...schedule };
      case "command":
        return { type, command: command.trim().replace(/^\//, "") };
      // v0.12 W2-E: the new kinds aren't offered here yet; anything else starts by hand.
      default:
        return { type: "manual", input: { type: "object", properties: {} } };
    }
  };

  return (
    <form
      data-testid="builder-workflow-form"
      className="mt-3 flex flex-col gap-3 rounded-md border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (problem) return;
        onCreate({ slug: effectiveSlug, name: name.trim(), on: on() });
      }}
    >
      <p className="font-medium text-ink">
        {bundle.workflows.length === 0
          ? "This agent has no workflows yet. Add one."
          : "New workflow"}
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Name">
          <SmallInput
            data-testid="builder-workflow-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Slug">
          <SmallInput
            data-testid="builder-workflow-slug"
            value={effectiveSlug}
            className="font-mono"
            onChange={(e) => setSlug(e.target.value)}
          />
        </Field>
        <Field label="Starts">
          <SmallSelect
            data-testid="builder-workflow-trigger"
            value={type}
            onChange={(e) => setType(e.target.value as TriggerOn["type"])}
          >
            {TRIGGER_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </SmallSelect>
        </Field>
      </div>
      {type === "event" ? (
        <Field label="Event">
          <SmallSelect
            data-testid="builder-workflow-event"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
          >
            <EventOptions events={events} />
          </SmallSelect>
        </Field>
      ) : null}
      {type === "schedule" ? (
        <SchedulePicker
          small
          testId="builder-workflow-schedule"
          cronTestId="builder-workflow-cron"
          value={schedule}
          onChange={setSchedule}
        />
      ) : null}
      {type === "command" ? (
        <Field label="Command">
          <SmallInput
            data-testid="builder-workflow-command"
            value={command}
            className="font-mono"
            placeholder="reprice"
            onChange={(e) => setCommand(e.target.value)}
          />
        </Field>
      ) : null}
      {touched && problem ? (
        <p className="text-sm text-risk" data-testid="builder-workflow-form-error">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {bundle.workflows.length > 0 ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <button
          type="submit"
          className={buttonClass("primary")}
          data-testid="builder-workflow-create"
        >
          Add workflow
        </button>
      </div>
    </form>
  );
}

// ── Test run ─────────────────────────────────────────────────────────────────────────────────────

function TestRunPanel({
  agent,
  workflowName,
  slug,
  sample,
  eventType,
  approvalNote,
  busy,
  run,
  onClose,
}: {
  agent: AgentSummary;
  workflowName: string;
  slug: string;
  /** The trigger's sample payload; undefined when its event type has none. */
  sample: unknown;
  /** The trigger's event type, for "Use a recent event"; null for other triggers. */
  eventType: string | null;
  /** Wave 5 review: routes that read an approval, which reads "needed no approval" in a test. */
  approvalNote?: string | null;
  busy: boolean;
  /** `clientId`: a template's chosen client (none: the Sandbox). */
  run(payload: unknown, clientId: string | null): Promise<string | null>;
  onClose(): void;
}) {
  const hasSample = sample !== undefined;
  // No sample: a blank box (`{}` is its placeholder), never a prefilled `{}` that typing `{…}`
  // would leave an extra brace after.
  const sampleText = hasSample ? JSON.stringify(sample, null, 2) : "";
  const isTemplate = agent.kind === "template";
  // A template can run on the Sandbox's fixture data or on a client the operator serves.
  const clients = useApi(
    apiRoutes.opsClients,
    isTemplate ? { query: { view: "names" }, life: "catalog" } : null,
  );
  const [clientId, setClientId] = useState("");
  // Recent events come from the client the run will read: the agent's own, or the template's
  // chosen client (the Sandbox when none is chosen).
  const eventsClient = isTemplate
    ? clientId || (clients.data?.clients.find((c) => c.sandbox)?.id ?? null)
    : agent.tenantId;
  const recent = useRecentEvents(eventsClient, eventType);
  const firstSource: PayloadSource = hasSample ? "sample" : "manual";
  const [source, setSource] = useState<PayloadSource>(firstSource);
  const [text, setText] = useState(sampleText);
  const [runId, setRunId] = useState<string | null>(null);
  const parsed = parsePayload(text);
  return (
    <div data-testid="builder-test-panel" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="font-medium text-ink">Test run · {workflowName}</p>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="text-sm text-ink-muted">
        A test run reads real data and never changes the client's tools: changes are recorded as
        “would have done”.{" "}
        {isTemplate
          ? "A template runs as its test copy in the client you choose, on that client's data."
          : "It runs on this client's data."}{" "}
        Unsaved changes are saved as a draft first.
      </p>
      {approvalNote ? (
        <p className="text-sm text-ink" data-testid="builder-test-approval-note">
          {approvalNote}
        </p>
      ) : null}
      {isTemplate ? (
        <SmallSelect
          aria-label="Client"
          data-testid="builder-test-client"
          value={clientId}
          className="max-w-xs"
          onChange={(e) => {
            setClientId(e.target.value);
            // Another client's events are not this one's: back to the first source.
            if (source.startsWith("event:")) {
              setSource(firstSource);
              setText(sampleText);
            }
          }}
        >
          <option value="">The Sandbox client (fixture data)</option>
          {(clients.data?.clients ?? [])
            .filter((c) => !c.sandbox)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </SmallSelect>
      ) : null}
      <PayloadSourceSelect
        testId="builder-test-source"
        value={source}
        className="h-9 max-w-md text-sm"
        hasSample={hasSample}
        eventType={eventType}
        recent={recent}
        onChange={(v) => {
          setSource(v);
          const filled = payloadFor(v, sample, recent.data?.events ?? []);
          if (filled !== null) setText(filled);
        }}
      />
      <TextArea
        {...JSON_INPUT_PROPS}
        aria-label="Trigger payload (JSON)"
        data-testid="builder-test-payload"
        rows={6}
        value={text}
        readOnly={source === "sample"}
        invalid={!parsed.ok}
        className="font-mono text-xs"
        onChange={(e) => {
          setText(e.target.value);
          // Edited by hand, it is no longer the event's payload as emitted.
          if (source !== "manual") setSource("manual");
        }}
      />
      {parsed.ok ? null : (
        <p className="text-sm text-risk" data-testid="builder-test-payload-error">
          The payload isn't valid JSON.
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        {runId ? (
          <Link
            to={`/ops/runs/${runId}`}
            className="text-sm font-medium text-link underline"
            data-testid="builder-test-run-link"
          >
            Open the test run
          </Link>
        ) : (
          <span />
        )}
        <Button
          variant="primary"
          data-testid="builder-test-run-start"
          disabled={busy || !parsed.ok}
          onClick={async () => {
            if (!parsed.ok) return;
            const id = await run(parsed.value, clientId || null);
            if (id) setRunId(id);
          }}
        >
          {busy ? "Starting…" : `Test-run ${slug}`}
        </Button>
      </div>
    </div>
  );
}
