// O6 Workflow builder (prototype `#O6-Builder`; ARCHITECTURE §10.5), one for templates and client
// agents: `/ops/templates/:slug/workflows/:workflow` and
// `/ops/clients/:id/agents/:slug/workflows/:workflow`. It edits the agent's latest version as a
// whole bundle (every workflow, so switching workflows keeps unsaved edits), validates on every
// change with core's validator (the server's own rules), and saves drafts, test-runs and publishes
// through the agent routes. Left: the steps to add; centre: the workflow's tabs and its steps;
// right: the Builder conversation (BuilderPanel) or the selected step. Steps picked with "Select
// steps" can be saved as an automation. Loaded lazily inside the /ops chunk, so its drag-and-drop
// code is fetched only when an operator opens a workflow.
// R8 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14): it edits v4 processes. A stored v3 version
// opens converted (`readProcessBundle`, every id kept) and the next save writes schemaVersion 4 as
// a new version; the stored one is never edited (invariant 3).
import {
  type AgentBundle,
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  agentSkillEntry,
  type BuilderCatalog,
  canonicalJson,
  effectiveModel,
  lookupSkill,
  type ProcessAgentBundle,
  parseSkillRef,
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
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { HeaderSwitcher } from "../../shell/HeaderSwitcher";
import { AgentBadge } from "../../ui/badges";
import { Icon } from "../../ui/icons";
import { Badge, Button, buttonClass, cx, ErrorNotice } from "../../ui/primitives";
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
import { useOpsClients } from "../OpsLayout";
import { PROCESS_KIND_LABEL, type StepLabels } from "../workflow/describe";
import { BuilderPanel, SaveAsAutomation, useBuilderSession } from "./BuilderPanel";
import {
  Canvas,
  collision,
  DragCard,
  type DragData,
  Palette,
  resolveDrop,
  triggerKey,
} from "./Canvas";
import {
  type BuilderData,
  type BuilderProblem,
  boundMatrices,
  catalogSkillKind,
  connectorName,
  filterSections,
  paletteConnectors,
  paletteSections,
  TESTKIT,
  toolConnector,
  typingContext,
  validateProcessesLikeServer,
  writeLabelOf,
} from "./catalog";
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
  type PaletteItem,
  type Process,
  ROOT,
  readProcessBundle,
  redo,
  removeStep,
  removeTrigger,
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
// Reshape data (2026-11-11)
import { addReshapeBefore, addReshapeThenAction, newReshapeStep } from "./reshape";
import { useClientScriptTools } from "./scripts";
import { applySkillMove } from "./skill-move";

type Connection = ResponseOf<typeof apiRoutes.opsClient>["connections"][number];

/** The side panel's tabs: the steps to add, the Builder conversation, the selected step. */
type Rail = "add" | "builder" | "step";

/** Whether the side panel is folded, per viewer (a convenience: open when unknown). */
const RAIL_KEY = "mezonas.builder.panel";

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
  /** What the agent page shows between its tabs and the canvas: which agent this is, its triggers. */
  above?: ReactNode;
  connections?: readonly Connection[];
  members?: readonly Member[];
  /** After a save or publish, so the agent page and sidebar follow. */
  onChanged(): void;
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
  const templateVersion = useApi(
    apiRoutes.opsAgentVersion,
    props.agent.kind === "client" && props.agent.templateId && props.from.basedOnTemplateVersionId
      ? { params: { id: props.agent.templateId, vid: props.from.basedOnTemplateVersionId } }
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
// browser (per agent and the version it was opened on), saved after 2 s of idle editing; it becomes
// a version only when the operator saves, test-runs or publishes. History gets one version per
// deliberate save instead of one per pause, and a reload or a crash loses nothing.
const DRAFT_PREFIX = "countersign:builder:";
const IDLE_MS = 2000;

interface StoredDraft {
  from: string;
  at: number;
  bundle: unknown;
}

function readDraft(agentId: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(`${DRAFT_PREFIX}${agentId}`);
    return raw ? (JSON.parse(raw) as StoredDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(agentId: string, draft: StoredDraft | null) {
  try {
    if (draft) window.localStorage.setItem(`${DRAFT_PREFIX}${agentId}`, JSON.stringify(draft));
    else window.localStorage.removeItem(`${DRAFT_PREFIX}${agentId}`);
  } catch {
    // Storage may be full or blocked; the builder works without it.
  }
}

/** The draft kept on this device, read as processes; null when it is the version it opened. */
function restoredDraft(
  agentId: string,
  from: VersionDetail,
  start: ProcessAgentBundle,
  ctx: TypingContext,
) {
  const stored = readDraft(agentId);
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
  const ctx = useMemo(() => typingContext(data), [data]);
  // The version as the builder edits it: v3 workflows read as processes, every id kept. It is the
  // starting point, not an edit: nothing is unsaved until the operator changes something.
  const [start] = useState(() => readProcessBundle(props.bundle, ctx));
  const opensV3 = holdsV3(props.bundle);
  const template = useMemo(
    () => (props.template ? readProcessBundle(props.template, ctx) : null),
    [props.template, ctx],
  );
  const [restored] = useState(() => restoredDraft(agent.id, from, start, ctx));
  const [history, setHistory] = useState<History>(() => startHistory(restored?.bundle ?? start));
  const bundle = history.present;
  const [saved, setSaved] = useState<Saved>(() => ({
    id: from.id,
    version: from.version,
    status: from.status,
    canon: canonicalJson(start),
  }));
  const canon = useMemo(() => canonicalJson(bundle), [bundle]);
  const dirty = canon !== saved.canon;
  const [draftAt, setDraftAt] = useState<number | null>(restored?.at ?? null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<{ title: string; kind: string } | null>(null);
  const [panel, setPanel] = useState<"test" | "add-workflow" | null>(null);
  // The side panel: the steps to add, the Builder conversation, or the selected step or trigger.
  const [rail, setRail] = useState<Rail>("builder");
  // What the panel showed before the palette opened, for Escape and Close.
  const [beforeAdd, setBeforeAdd] = useState<Exclude<Rail, "add">>("builder");
  // The list the palette adds to: the end of the workflow, or a fork path or loop.
  const [addTarget, setAddTarget] = useState<ContainerId>(ROOT);
  const [paletteFocus, setPaletteFocus] = useState(0);
  // A template's connectors the operator chose to build with in this session.
  const [extraConnectors, setExtraConnectors] = useState<string[]>([]);
  const railRef = useRef<HTMLElement>(null);
  // The side panel folds to a strip of icons, remembered per viewer in this browser; picking a
  // step, a tab or "Add a step" opens it again.
  const [railOpen, setRailOpenState] = useState(() => {
    try {
      return window.localStorage.getItem(RAIL_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const setRailOpen = (open: boolean) => {
    setRailOpenState(open);
    try {
      window.localStorage.setItem(RAIL_KEY, open ? "open" : "closed");
    } catch {
      // Storage blocked: it stays as chosen for this visit.
    }
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
            body: `v${from.version} is stored in the older workflow format. It opens here as a process with every step as it was; your next save makes a new version in the new format, and v${from.version} stays as it is.`,
          }
        : null,
  );
  const action = useAction();

  // Selecting a step or the trigger shows it in the rail, opening the rail if it was folded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setRailOpen only sets state.
  useEffect(() => {
    if (selection) {
      setRail("step");
      setRailOpen(true);
    }
  }, [selection]);

  const slug = props.workflow;
  const entry = bundle.workflows.find((w) => w.slug === slug);
  const workflow = entry?.workflow;

  // ── The side panel ──
  /**
   * Shows a tab of the side panel. Where the panel sits below the canvas (narrow screens), it is
   * scrolled into view and focused, so a click on a step or "add a step" visibly lands somewhere.
   */
  const showRail = (next: Rail) => {
    setRail(next);
    setRailOpen(true);
    const el = railRef.current;
    if (!el?.parentElement) return;
    const beside = el.getBoundingClientRect().left - el.parentElement.getBoundingClientRect().left;
    if (beside > 10) return;
    window.requestAnimationFrame(() => {
      el.scrollIntoView?.({ block: "start", behavior: "smooth" });
      // Not when focus is already in the panel (a field clicked before this frame): the field
      // keeps it, so what is typed there isn't lost.
      if (next === "step" && !el.contains(document.activeElement))
        el.querySelector<HTMLElement>("[data-testid='builder-inspector']")?.focus({
          preventScroll: true,
        });
    });
  };
  const openPalette = (container: ContainerId) => {
    if (rail !== "add") setBeforeAdd(rail);
    setAddTarget(container);
    setPaletteFocus((n) => n + 1);
    showRail("add");
  };
  const closePalette = () => {
    setRail(beforeAdd);
    setAddTarget(ROOT);
  };
  const targetText = useMemo(() => {
    if (!workflow || addTarget === ROOT) return "at the end";
    if (addTarget.startsWith("otherwise:")) {
      const branch = ifOfBranch(workflow, addTarget.slice("otherwise:".length));
      return branch ? `to “Otherwise” in ${branch.name || "the if"}` : "at the end";
    }
    if (addTarget.startsWith("path:")) {
      const id = addTarget.slice("path:".length);
      const branch = ifOfBranch(workflow, id);
      const path = branch?.kind === "if" ? branch.paths.find((p) => p.id === id) : undefined;
      return path ? `to “${path.name}”` : "at the end";
    }
    const loop = locate(workflow, addTarget.slice("loop:".length))?.step;
    return loop ? `inside “${loop.name || "For each"}”` : "at the end";
  }, [workflow, addTarget]);

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

  const addItem = (item: PaletteItem, target?: { container: string; index: number }) => {
    if (!workflow) return;
    if (item.type === "trigger") {
      // It replaces the trigger in the inspector, else the first: a trigger keeps its id.
      const id =
        selection?.type === "trigger" && workflow.triggers.some((t) => t.id === selection.id)
          ? selection.id
          : workflow.triggers[0]?.id;
      edit((w) => setTrigger(w, item.on, id));
      if (id) setSelection({ type: "trigger", id });
      setRail("step");
      return;
    }
    const step = createStep(item, ctx);
    // + adds at the end of the list the palette was opened for (the workflow's, by default).
    const container = rail === "add" ? addTarget : ROOT;
    const at = target ?? {
      container,
      index: getContainer(workflow, container)?.length ?? workflow.steps.length,
    };
    setAddTarget(ROOT);
    apply((b) =>
      allowStep(
        editWorkflow(b, slug, (w) => insertStep(w, at.container, at.index, step)),
        step,
        ctx,
      ),
    );
    setSelection({ type: "step", id: step.id });
    // Picking closes the palette: the new step opens in the inspector.
    setRail("step");
  };
  const remove = (id: string) => {
    edit((w) => removeStep(w, id));
    if (selection?.type === "step" && selection.id === id) setSelection(null);
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
  // In plain words for the step panel and its fields; the list below groups them too.
  const workflowErrors = useMemo(
    () =>
      readableErrors(
        result.errors.filter((e) => e.workflow === slug),
        bundle,
      ),
    [result.errors, slug, bundle],
  );
  const env: ApprovalEnv = {
    ctx,
    agentKind: agent.kind,
    mode: bundle.definition.permissions.mode,
    matrices,
    connectorName: (id) => connectorName(data, id),
  };
  const counts = workflow ? workflowCounts(workflow, env) : null;
  const templateWorkflow = template?.workflows.find((w) => w.slug === slug)?.workflow;
  const customized = useMemo(
    () => (workflow && template ? customizedSteps(workflow, templateWorkflow) : new Map()),
    [workflow, template, templateWorkflow],
  );

  // ── The rolling draft ──
  useEffect(() => {
    if (!dirty) return;
    const t = window.setTimeout(() => {
      const at = Date.now();
      writeDraft(agent.id, { from: saved.id, at, bundle });
      setDraftAt(at);
    }, IDLE_MS);
    return () => window.clearTimeout(t);
  }, [agent.id, bundle, dirty, saved.id]);

  // ── Undo / redo keys ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
    }
  };

  // ── Drag and drop ──
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const endDrag = () => {
    setActiveId(null);
    setOverId(null);
    setActiveLabel(null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    endDrag();
    if (!workflow || !e.over || e.over.id === e.active.id) return;
    const drop = resolveDrop(
      workflow,
      String(e.active.id),
      e.active.data.current as DragData | undefined,
      e.over.data.current as DragData | undefined,
    );
    if (!drop) return;
    if (drop.type === "move") edit((w) => moveStep(w, drop.id, drop.container, drop.index));
    else if (drop.type === "add") addItem(drop.item, drop);
    else addItem(drop.item);
  };

  // ── Selecting what an error names ──
  const showError = (e: BuilderProblem) => {
    if (e.workflow && e.workflow !== slug) {
      navigate(`${base}/workflows/${e.workflow}`);
      return;
    }
    if (!workflow || !e.stepId) return;
    const stepId = e.stepId;
    if (workflow.triggers.some((t) => t.id === stepId))
      setSelection({ type: "trigger", id: stepId });
    else {
      const owner = locate(workflow, e.stepId)?.step ?? ifOfBranch(workflow, e.stepId);
      if (!owner) return;
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
      writeDraft(agent.id, null);
      setDraftAt(null);
      props.onChanged();
      return next;
    }
    if (isCode(res.error, "no_op")) {
      const next = { ...saved, canon: snapshotCanon };
      setSaved(next);
      writeDraft(agent.id, null);
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

  const session = useBuilderSession({
    agent,
    bundle,
    read: (b) => readProcessBundle(b, ctx),
    ensureSaved: async () => (dirty ? await save() : saved),
    onDraft: (next) => apply(() => next),
  });
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

  const saveAutomation = async (name: string, automationSlug: string) => {
    if (!checked || !workflow) return false;
    // In the canvas's order, as the steps run.
    const ids = workflow.steps.map((s) => s.id).filter((id) => checked.has(id));
    const ok = await session.saveAutomation(ids, name, automationSlug);
    if (ok) {
      setChecked(null);
      setRail("builder");
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

  // ── Header ──
  const versionBadge = `${saved.status === "live" ? "Live" : "Draft"} · v${saved.version}`;
  const subtitle = [
    agent.role,
    counts
      ? [
          plural(counts.steps, "step"),
          `${counts.ifs} if${counts.ifs === 1 ? "" : "s"}`,
          `${counts.writes} ${counts.writes === 1 ? "changes a tool" : "change tools"}`,
          `${counts.needApproval} ${counts.needApproval === 1 ? "needs" : "need"} approval`,
        ].join(" · ")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+Z / Ctrl+Shift+Z anywhere in the builder.
    <div data-testid="builder" onKeyDown={onKeyDown}>
      <BuilderBar
        agent={agent}
        badge={
          <span className="flex gap-1.5">
            <Badge tone={saved.status === "live" ? "positive" : "neutral"} testId="builder-version">
              {versionBadge}
            </Badge>
            {dirty ? (
              <Badge tone="neutral" testId="builder-unsaved">
                Unsaved
              </Badge>
            ) : null}
            {agent.kind === "template" ? <Badge tone="accent">Template</Badge> : null}
          </span>
        }
        line={
          <>
            <span data-testid="builder-counts">{subtitle}</span>
            {" · "}
            <span className={result.valid ? "text-positive" : "text-risk"}>
              {result.valid ? "valid" : plural(problemCount, "problem")}
            </span>
          </>
        }
        actions={
          <>
            <Button
              variant="ghost"
              data-testid="builder-save"
              disabled={!dirty || action.busy}
              onClick={onSave}
            >
              Save draft
            </Button>
            <Button
              data-testid="builder-test-run"
              disabled={!workflow || invalidReason !== null}
              title={invalidReason ?? undefined}
              onClick={() => setPanel(panel === "test" ? null : "test")}
            >
              Test run
            </Button>
            {/* A live version with nothing new offers no publish: its badge says Live. */}
            {!dirty && saved.status === "live" ? null : (
              <Button
                variant="primary"
                data-testid="builder-publish"
                disabled={publishBlocked !== null || action.busy || publishing}
                title={publishBlocked ?? undefined}
                onClick={onPublish}
              >
                {publishing
                  ? "Publishing…"
                  : dirty
                    ? "Save and publish"
                    : `Publish v${saved.version}`}
              </Button>
            )}
          </>
        }
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
                      setHistory(startHistory(start));
                      writeDraft(agent.id, null);
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

      {panel === "test" && workflow?.triggers[0] && entry ? (
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
          onClose={() => setPanel(null)}
          run={async (payload, clientId) => {
            const v = dirty ? await save() : saved;
            if (!v) return null;
            const res = await action.call(apiRoutes.opsTestRun, {
              params: { id: agent.id, vid: v.id },
              body: { workflow: slug, payload, ...(clientId ? { clientId } : {}) },
            });
            return res.ok ? res.data.runId : null;
          }}
        />
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={(e) => {
          setActiveId(String(e.active.id));
          const d = e.active.data.current as DragData | undefined;
          if (d?.type === "palette") setActiveLabel({ title: d.item.title, kind: d.item.type });
          else if (workflow) {
            const s = locate(workflow, String(e.active.id))?.step;
            if (s) setActiveLabel({ title: s.name, kind: PROCESS_KIND_LABEL[s.kind] });
          }
        }}
        onDragOver={(e) => setOverId(e.over ? String(e.over.id) : null)}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        {/* UI cleanup: two columns, the canvas and a side panel beside it once the builder has
            room (a container query, so a browser side panel narrowing the page counts), the panel
            below the canvas on narrow screens. The palette is the panel's "Add a step" tab, so it
            never covers the Builder or the step. */}
        <div className="@container -mx-4 -mb-8 mt-4 border-t border-line md:-mx-10 md:-mb-12">
          <div
            className={cx(
              "grid grid-cols-1",
              railOpen
                ? "@3xl:grid-cols-[minmax(0,1fr)_340px]"
                : "@3xl:grid-cols-[minmax(0,1fr)_52px]",
            )}
          >
            <div className="min-w-0 bg-surface-subtle px-4 py-5 md:px-6">
              <WorkflowSwitcher
                bundle={bundle}
                current={slug}
                base={base}
                adding={panel === "add-workflow"}
                onAdd={() => setPanel(panel === "add-workflow" ? null : "add-workflow")}
              />
              {panel === "add-workflow" || bundle.workflows.length === 0 ? (
                <AddWorkflowForm
                  bundle={bundle}
                  events={data.events
                    .filter((e) => !e.connector || connectors.has(e.connector))
                    .map((e) => e.type)}
                  onCancel={() => setPanel(null)}
                  onCreate={(input) => {
                    apply((b) => addWorkflow(b, input));
                    setPanel(null);
                    setSelection(null);
                    navigate(`${base}/workflows/${input.slug}`);
                  }}
                />
              ) : null}

              <div className="my-4 flex flex-wrap items-center justify-between gap-3">
                {checked ? (
                  <SaveAsAutomation
                    count={checked.size}
                    busy={session.busy}
                    onSave={saveAutomation}
                    onClear={() => setChecked(null)}
                  />
                ) : (
                  <span className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="primary"
                      data-testid="builder-add-step"
                      aria-expanded={rail === "add"}
                      onClick={() => openPalette(ROOT)}
                    >
                      <Icon name="add" />
                      Add a step
                    </Button>
                    <span className="text-sm text-ink-muted">
                      Click a step to edit it. Drag it by its handle to move it.
                    </span>
                  </span>
                )}
                <span className="flex flex-wrap items-center gap-2">
                  {workflow && workflow.steps.length > 0 && !checked ? (
                    <Button
                      variant="ghost"
                      data-testid="builder-select-steps"
                      onClick={() => setChecked(new Set())}
                    >
                      Select steps
                    </Button>
                  ) : null}
                  {dirty ? (
                    <span className="text-xs text-ink-muted" data-testid="builder-draft-status">
                      {draftAt
                        ? `Draft kept on this device · ${clock(draftAt)}`
                        : "Unsaved changes"}
                    </span>
                  ) : null}
                  <Button
                    variant="ghost"
                    data-testid="builder-undo"
                    disabled={history.past.length === 0}
                    onClick={() => setHistory(undo)}
                  >
                    Undo
                  </Button>
                  <Button
                    variant="ghost"
                    data-testid="builder-redo"
                    disabled={history.future.length === 0}
                    onClick={() => setHistory(redo)}
                  >
                    Redo
                  </Button>
                </span>
              </div>

              <Problems
                errors={result.errors}
                bundle={bundle}
                slug={slug}
                onShow={showError}
                onFix={fixLine}
              />
              <Advice warnings={result.warnings.filter((w) => w.workflow === slug)} />

              {workflow ? (
                <Canvas
                  workflow={workflow}
                  selectedId={
                    selection?.type === "trigger"
                      ? triggerKey(selection.id)
                      : (selection?.id ?? null)
                  }
                  env={env}
                  errors={workflowErrors}
                  customized={customized}
                  activeId={activeId}
                  overId={overId}
                  onSelect={(id) => {
                    setSelection(
                      id.startsWith("trigger:")
                        ? { type: "trigger", id: id.slice("trigger:".length) }
                        : { type: "step", id },
                    );
                    showRail("step");
                  }}
                  labels={labels}
                  onAddAt={openPalette}
                  addTarget={rail === "add" ? addTarget : null}
                  checked={checked ?? undefined}
                  onCheck={(id, on) =>
                    setChecked((c) => {
                      const next = new Set(c ?? []);
                      if (on) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                />
              ) : bundle.workflows.length > 0 ? (
                <p className="text-ink-muted" data-testid="builder-no-workflow">
                  This agent has no workflow “{slug}”. Pick one above.
                </p>
              ) : null}
            </div>

            <aside
              ref={railRef}
              aria-label="Add a step, the Builder and the step"
              data-testid="builder-rail"
              data-open={railOpen ? "true" : "false"}
              className={cx(
                "flex scroll-mt-[var(--header-h)] flex-col border-t border-line bg-surface @3xl:sticky @3xl:top-header @3xl:h-[calc(100vh-var(--header-h))] @3xl:border-t-0 @3xl:border-l",
                railOpen ? "px-5 py-4" : "items-center gap-1 px-1.5 py-3 @max-3xl:flex-row",
              )}
            >
              {railOpen ? null : (
                // Folded: an expand button, then each tab as an icon that opens the panel on it.
                <>
                  <button
                    type="button"
                    aria-label="Expand the side panel"
                    aria-expanded="false"
                    title="Expand"
                    data-testid="builder-rail-expand"
                    onClick={() => setRailOpen(true)}
                    className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink"
                  >
                    <Icon name="sidebar" size={16} className="-scale-x-100" />
                  </button>
                  <span aria-hidden className="my-1 h-px w-6 bg-line @max-3xl:h-6 @max-3xl:w-px" />
                  {(
                    [
                      ["add", "Add a step", "add"],
                      ["builder", "Builder", "message"],
                      ["step", selection ? "Step" : "Inspector", "settings"],
                    ] as const
                  ).map(([key, label, icon]) => (
                    <button
                      key={key}
                      type="button"
                      aria-label={label}
                      title={label}
                      data-testid={`builder-rail-${key}-folded`}
                      onClick={() => (key === "add" ? openPalette(addTarget) : showRail(key))}
                      className={cx(
                        "ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm",
                        rail === key ? "text-slate" : "text-ink-muted hover:text-ink",
                      )}
                    >
                      <Icon name={icon} size={16} />
                    </button>
                  ))}
                </>
              )}
              <div
                className={cx(
                  "mb-4 flex items-end gap-1 border-b border-line",
                  !railOpen && "hidden",
                )}
                role="tablist"
                aria-label="Side panel"
              >
                {(
                  [
                    ["add", "Add a step"],
                    ["builder", "Builder"],
                    ["step", selection ? "Step" : "Inspector"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={rail === key}
                    data-testid={`builder-rail-${key}`}
                    onClick={() => (key === "add" ? openPalette(addTarget) : showRail(key))}
                    className={cx(
                      "-mb-px border-b-2 px-3 py-2 text-sm",
                      rail === key
                        ? "border-slate font-medium text-ink"
                        : "border-transparent text-ink-muted hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Collapse the side panel"
                  aria-expanded="true"
                  title="Collapse"
                  data-testid="builder-rail-collapse"
                  onClick={() => setRailOpen(false)}
                  className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm mb-1 ml-auto text-ink-muted hover:text-ink"
                >
                  <Icon name="sidebar" size={16} className="-scale-x-100" />
                </button>
              </div>
              {railOpen && rail === "add" ? (
                <div
                  className="min-h-0 flex-1 overflow-y-auto"
                  data-testid="builder-rail-add-panel"
                >
                  <Palette
                    sections={filterSections(paletteSections(bundle, data, connectors), search)}
                    search={search}
                    onSearch={setSearch}
                    onAdd={(item) => addItem(item)}
                    target={targetText}
                    onClose={closePalette}
                    focusKey={paletteFocus}
                    footer={
                      agent.kind === "template" ? (
                        <MoreConnectors
                          data={data}
                          shown={connectors}
                          onAdd={(id) => setExtraConnectors((x) => [...x, id])}
                        />
                      ) : (
                        <p
                          className="text-xs text-ink-muted"
                          data-testid="builder-palette-connected"
                        >
                          Only the tools this client has connected show here. Connect more on the
                          client's Setup page.
                        </p>
                      )
                    }
                  />
                </div>
              ) : null}
              <div
                className={cx(
                  "min-h-0 flex-1 overflow-y-auto",
                  (!railOpen || rail !== "builder") && "hidden",
                )}
              >
                <BuilderPanel session={session} />
              </div>
              {railOpen && workflow && rail === "step" ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <Inspector
                    workflow={workflow}
                    bundle={bundle}
                    selection={selection}
                    data={data}
                    ctx={ctx}
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
                      setSelection(null);
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
                    // inspector says what was set; the new if waits on the canvas for its steps.
                    onAddRoute={(id, option) =>
                      edit((w) => addRouteAfter(w, id, option)?.process ?? w)
                    }
                    // Skill model (2026-11-10): the write a skill's output fits, selected once
                    // added so its inspector shows the tool it will use.
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
                  />
                </div>
              ) : null}
            </aside>
          </div>
        </div>
        {fixing ? (
          <FixDialog
            fix={fixing}
            session={session}
            onClose={() => setFixing(null)}
            onShowStep={fixing.error.stepId ? () => showError(fixing.error) : undefined}
          />
        ) : null}
        <DragOverlay dropAnimation={null}>
          {activeId && activeLabel ? (
            <DragCard title={activeLabel.title} kind={activeLabel.kind} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// ── Problems ─────────────────────────────────────────────────────────────────────────────────────

function Problems({
  errors,
  bundle,
  slug,
  onShow,
  onFix,
}: {
  errors: BuilderProblem[];
  bundle: ProcessAgentBundle;
  slug: string;
  onShow(e: BuilderProblem): void;
  /** Opens the Fix dialog for a line: the Builder explains it and proposes a fix. */
  onFix(line: ProblemLine): void;
}) {
  const [open, setOpen] = useState(true);
  if (errors.length === 0) {
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

function WorkflowSwitcher({
  bundle,
  current,
  base,
  adding,
  onAdd,
}: {
  bundle: Pick<ProcessAgentBundle, "workflows">;
  current: string;
  base: string;
  adding: boolean;
  onAdd(): void;
}) {
  return (
    <nav
      aria-label="Workflows"
      className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-md border border-line bg-surface p-1"
    >
      {bundle.workflows.map((w) => (
        <Link
          key={w.slug}
          to={`${base}/workflows/${w.slug}`}
          data-testid={`builder-workflow-${w.slug}-select`}
          aria-current={w.slug === current ? "page" : undefined}
          className={cx(
            "rounded-sm px-3 py-1.5 text-sm",
            w.slug === current
              ? "bg-slate-tint font-medium text-ink"
              : "text-ink-muted hover:bg-surface-subtle hover:text-ink",
          )}
        >
          {w.name}
          {w.enabled ? "" : " · off"}
        </Link>
      ))}
      <button
        type="button"
        data-testid="builder-workflow-add"
        aria-label="Add a workflow"
        aria-expanded={adding}
        onClick={onAdd}
        className="ds-btn ds-btn--link px-3 text-sm"
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
  const [cron, setCron] = useState("0 7 * * 1-5");
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
        return { type, cron };
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
        <Field label="Cron">
          <SmallInput
            data-testid="builder-workflow-cron"
            value={cron}
            className="font-mono"
            onChange={(e) => setCron(e.target.value)}
          />
        </Field>
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
    <div
      data-testid="builder-test-panel"
      className="mt-4 flex flex-col gap-3 rounded-md border border-line bg-surface p-4"
    >
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
