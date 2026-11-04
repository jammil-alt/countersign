// The workflow builder (ARCHITECTURE §10.5, docs/design/screens/5-workflow-builder.png), one for
// templates and client agents: `/ops/templates/:slug/workflows/:workflow` and
// `/ops/clients/:id/agents/:slug/workflows/:workflow`. It edits the agent's latest version as a
// whole bundle (every workflow, so switching workflows keeps unsaved edits), validates on every
// change with core's validator (the server's own rules), and saves drafts, test-runs and publishes
// through the agent routes. Loaded lazily inside the /ops chunk, so its drag-and-drop code is
// fetched only when an operator opens a workflow.
import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  canonicalJson,
  Slug,
  type TriggerOn,
  type ValidationError,
  type Workflow,
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
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Icon } from "../../ui/icons";
import {
  AgentAvatar,
  Badge,
  Button,
  buttonClass,
  cx,
  ErrorNotice,
  Loading,
  PageHeader,
} from "../../ui/primitives";
import { slugify } from "../agents/definition-form";
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
import { KIND_LABEL } from "../workflow/describe";
import { Canvas, collision, DragCard, type DragData, Palette, resolveDrop } from "./Canvas";
import {
  type BuilderData,
  boundMatrices,
  connectorName,
  filterSections,
  paletteSections,
  typingContext,
  validateLikeServer,
} from "./catalog";
import { SmallInput, SmallSelect } from "./fields";
import { type FocusRequest, Inspector, type Member, type Selection } from "./Inspector";
import {
  type ApprovalEnv,
  addWorkflow,
  allowStep,
  commit,
  createStep,
  customizedSteps,
  editWorkflow,
  forkOfBranch,
  type History,
  insertStep,
  locate,
  moveStep,
  type PaletteItem,
  ROOT,
  redo,
  removeStep,
  setTrigger,
  startHistory,
  undo,
  updateStep,
  workflowCounts,
} from "./model";

type Connection = ResponseOf<typeof apiRoutes.opsClient>["connections"][number];

export interface WorkflowBuilderProps {
  agent: AgentSummary;
  /** The version the builder opens: the agent's latest, draft or live. */
  from: VersionDetail;
  bundle: AgentBundle;
  /** The workflow slug from the URL. */
  workflow: string;
  /** The agent page's URL. */
  base: string;
  tabs: ReactNode;
  connections?: readonly Connection[];
  members?: readonly Member[];
  /** After a save or publish, so the agent page and sidebar follow. */
  onChanged(): void;
}

export default function WorkflowBuilder(props: WorkflowBuilderProps) {
  const catalog = useApi(apiRoutes.opsBuilderCatalog, { params: { id: props.agent.id } });
  const events = useApi(apiRoutes.opsEventCatalog);
  const templateVersion = useApi(
    apiRoutes.opsAgentVersion,
    props.agent.kind === "client" && props.agent.templateId && props.from.basedOnTemplateVersionId
      ? { params: { id: props.agent.templateId, vid: props.from.basedOnTemplateVersionId } }
      : null,
  );
  const template = useMemo(() => {
    const raw = templateVersion.data?.version.bundle;
    const parsed = raw === undefined ? null : AgentBundleSchema.safeParse(raw);
    return parsed?.success ? parsed.data : null;
  }, [templateVersion.data]);

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
        <Loading label="Loading skills, tools and events…" />
      </Frame>
    );
  }
  return (
    <BuilderBody
      {...props}
      data={{ catalog: catalog.data, events: events.data.events }}
      template={template}
    />
  );
}

function Frame(props: WorkflowBuilderProps & { children: ReactNode }) {
  const { agent } = props;
  return (
    <div>
      <PageHeader
        leading={<AgentAvatar name={agent.name} seed={agent.slug} size="lg" />}
        title={agent.serviceName ?? agent.name}
      />
      {props.tabs}
      <div className="pt-6">{props.children}</div>
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

function restoredDraft(agentId: string, from: VersionDetail, bundle: AgentBundle) {
  const stored = readDraft(agentId);
  if (!stored || stored.from !== from.id) return null;
  const parsed = AgentBundleSchema.safeParse(stored.bundle);
  if (!parsed.success || canonicalJson(parsed.data) === canonicalJson(bundle)) return null;
  return { bundle: parsed.data, at: stored.at };
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

function samplePayload(workflow: Workflow, data: BuilderData): unknown {
  const on = workflow.trigger.on;
  switch (on.type) {
    case "event":
      return data.events.find((e) => e.type === on.event)?.sample ?? {};
    case "schedule":
      return { scheduledAt: new Date().toISOString() };
    case "command":
      return { args: "" };
    case "manual": {
      const props = (on.input.properties ?? {}) as Record<string, { type?: unknown }>;
      return Object.fromEntries(
        Object.entries(props).map(([k, p]) => [
          k,
          p.type === "number" || p.type === "integer" ? 0 : p.type === "boolean" ? false : "",
        ]),
      );
    }
  }
}

function BuilderBody(
  props: WorkflowBuilderProps & { data: BuilderData; template: AgentBundle | null },
) {
  const { agent, from, data, base, template } = props;
  const navigate = useNavigate();
  const ctx = useMemo(() => typingContext(data), [data]);
  const [restored] = useState(() => restoredDraft(agent.id, from, props.bundle));
  const [history, setHistory] = useState<History>(() =>
    startHistory(restored?.bundle ?? props.bundle),
  );
  const bundle = history.present;
  const [saved, setSaved] = useState<Saved>(() => ({
    id: from.id,
    version: from.version,
    status: from.status,
    canon: canonicalJson(props.bundle),
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
  const [notice, setNotice] = useState<{
    tone: "positive" | "warning" | "neutral";
    body: ReactNode;
  } | null>(
    restored
      ? {
          tone: "neutral",
          body: `Restored your unsaved changes from ${clock(restored.at)}.`,
        }
      : null,
  );
  const action = useAction();

  const slug = props.workflow;
  const entry = bundle.workflows.find((w) => w.slug === slug);
  const workflow = entry?.workflow;

  // ── Edits ──
  const apply = useCallback(
    (fn: (b: AgentBundle) => AgentBundle, key: string | null = null) =>
      setHistory((h) => commit(h, fn(h.present), key)),
    [],
  );
  const edit = useCallback(
    (fn: (w: Workflow) => Workflow, key: string | null = null) =>
      apply((b) => editWorkflow(b, slug, fn), key),
    [apply, slug],
  );

  const addItem = (item: PaletteItem, target?: { container: string; index: number }) => {
    if (!workflow) return;
    if (item.type === "trigger") {
      edit((w) => setTrigger(w, item.on));
      setSelection({ type: "trigger" });
      return;
    }
    const step = createStep(item, ctx);
    const at = target ?? { container: ROOT, index: workflow.steps.length };
    apply((b) =>
      allowStep(
        editWorkflow(b, slug, (w) => insertStep(w, at.container, at.index, step)),
        step,
        ctx,
      ),
    );
    setSelection({ type: "step", id: step.id });
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
  const result = useMemo(
    () => validateLikeServer(bundle, ctx, agent.kind === "client" ? { matrices } : undefined),
    [bundle, ctx, matrices, agent.kind],
  );
  const workflowErrors = result.errors.filter((e) => e.workflow === slug);
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
  const showError = (e: ValidationError) => {
    if (e.workflow && e.workflow !== slug) {
      navigate(`${base}/workflows/${e.workflow}`);
      return;
    }
    if (!workflow || !e.stepId) return;
    if (e.stepId === workflow.trigger.id) setSelection({ type: "trigger" });
    else {
      const owner = locate(workflow, e.stepId)?.step ?? forkOfBranch(workflow, e.stepId);
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

  const onPublish = async () => {
    setNotice(null);
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

  const invalidReason = result.valid
    ? null
    : `Fix ${plural(result.errors.length, "problem")} first: only a valid workflow can be test-run or published.`;
  const publishBlocked =
    invalidReason ?? (!dirty && saved.status === "live" ? "Nothing new to publish." : null);

  // ── Header ──
  const versionBadge = `${saved.status === "live" ? "Live" : "Draft"} · v${saved.version}`;
  const subtitle = [
    agent.role,
    counts
      ? [
          plural(counts.steps, "step"),
          plural(counts.forks, "fork"),
          `${counts.writes} change your tools`,
          `${counts.needApproval} need approval`,
        ].join(" · ")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+Z / Ctrl+Shift+Z anywhere in the builder.
    <div data-testid="builder" onKeyDown={onKeyDown}>
      <PageHeader
        leading={<AgentAvatar name={agent.name} seed={agent.slug} size="lg" />}
        title={agent.serviceName ?? agent.name}
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
        subtitle={<span data-testid="builder-counts">{subtitle}</span>}
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
            <Button
              variant="primary"
              data-testid="builder-publish"
              disabled={publishBlocked !== null || action.busy}
              title={publishBlocked ?? undefined}
              onClick={onPublish}
            >
              {dirty ? "Save and publish" : `Publish v${saved.version}`}
            </Button>
          </>
        }
      />
      {props.tabs}

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
                      setHistory(startHistory(props.bundle));
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

      {panel === "test" && workflow && entry ? (
        <TestRunPanel
          agent={agent}
          workflowName={entry.name}
          slug={slug}
          sample={samplePayload(workflow, data)}
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
            if (s) setActiveLabel({ title: s.name, kind: KIND_LABEL[s.kind] });
          }
        }}
        onDragOver={(e) => setOverId(e.over ? String(e.over.id) : null)}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <div className="-mx-10 -mb-8 grid grid-cols-[260px_minmax(0,1fr)_340px]">
          <aside
            aria-label="Add a step"
            className="sticky top-header h-[calc(100vh-var(--header-h))] overflow-y-auto border-r border-line bg-surface px-4 py-5"
          >
            <Palette
              sections={filterSections(paletteSections(bundle, data), search)}
              search={search}
              onSearch={setSearch}
              onAdd={(item) => addItem(item)}
            />
          </aside>

          <div
            className="min-w-0 px-6 py-5"
            style={{
              backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)",
              backgroundSize: "16px 16px",
            }}
          >
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
                events={data.events.map((e) => e.type)}
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
              <p className="text-sm text-ink-muted">
                Drag steps by their handle to reorder or move them between fork paths. Click a step
                or fork to edit it.
              </p>
              <span className="flex items-center gap-2">
                {dirty ? (
                  <span className="text-xs text-ink-muted" data-testid="builder-draft-status">
                    {draftAt ? `Draft kept on this device · ${clock(draftAt)}` : "Unsaved changes"}
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

            <Problems errors={result.errors} bundle={bundle} slug={slug} onShow={showError} />

            {workflow ? (
              <Canvas
                workflow={workflow}
                selectedId={selection?.type === "trigger" ? "trigger" : (selection?.id ?? null)}
                env={env}
                errors={workflowErrors}
                customized={customized}
                activeId={activeId}
                overId={overId}
                onSelect={(id) =>
                  setSelection(id === "trigger" ? { type: "trigger" } : { type: "step", id })
                }
                onDelete={remove}
              />
            ) : bundle.workflows.length > 0 ? (
              <p className="text-ink-muted" data-testid="builder-no-workflow">
                This agent has no workflow “{slug}”. Pick one above.
              </p>
            ) : null}
          </div>

          <aside
            aria-label="Inspector"
            className="sticky top-header h-[calc(100vh-var(--header-h))] overflow-y-auto border-l border-line bg-surface px-5 py-5"
          >
            {workflow ? (
              <Inspector
                workflow={workflow}
                bundle={bundle}
                selection={selection}
                data={data}
                ctx={ctx}
                env={env}
                errors={workflowErrors}
                template={template ? { bundle: template, workflow: templateWorkflow } : null}
                members={props.members ?? []}
                focus={focus}
                onStep={(id, fn, key) => edit((w) => updateStep(w, id, fn), key)}
                onTrigger={(on: TriggerOn, key) => edit((w) => setTrigger(w, on), key)}
                onDelete={remove}
              />
            ) : null}
          </aside>
        </div>
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
}: {
  errors: ValidationError[];
  bundle: AgentBundle;
  slug: string;
  onShow(e: ValidationError): void;
}) {
  const [open, setOpen] = useState(true);
  if (errors.length === 0) {
    return (
      <p className="mb-4 text-sm text-ink-muted" data-testid="builder-valid">
        Valid: ready to test-run and publish.
      </p>
    );
  }
  const name = (e: ValidationError) => {
    if (!e.workflow) return "Agent";
    const w = bundle.workflows.find((x) => x.slug === e.workflow);
    if (!w) return e.workflow;
    if (e.stepId === w.workflow.trigger.id) return `${w.name} · Trigger`;
    const owner = e.stepId
      ? (locate(w.workflow, e.stepId)?.step ?? forkOfBranch(w.workflow, e.stepId))
      : null;
    return owner ? `${w.name} · ${owner.name}` : w.name;
  };
  return (
    <div data-testid="builder-problems" className="ds-banner mb-4 block">
      <button
        type="button"
        aria-expanded={open}
        data-testid="builder-problems-toggle"
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium"
      >
        {plural(errors.length, "problem")} before this can be test-run or published
        {errors.some((e) => e.workflow && e.workflow !== slug) ? " (some in other workflows)" : ""}
      </button>
      {open ? (
        <ul className="mt-2 flex flex-col gap-1">
          {errors.map((e, i) => (
            <li key={`${e.workflow}:${e.stepId}:${e.field}:${e.code}:${e.message}`}>
              <button
                type="button"
                data-testid={`builder-problem-${i}`}
                onClick={() => onShow(e)}
                className="text-left text-sm hover:underline"
              >
                <span className="font-medium">{name(e)}</span>: {e.message}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
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
  bundle: AgentBundle;
  current: string;
  base: string;
  adding: boolean;
  onAdd(): void;
}) {
  return (
    <nav aria-label="Workflows" className="flex flex-wrap items-center gap-2">
      <span className="eyebrow mr-1 text-ink-muted">Workflows</span>
      {bundle.workflows.map((w) => (
        <Link
          key={w.slug}
          to={`${base}/workflows/${w.slug}`}
          data-testid={`builder-workflow-${w.slug}-select`}
          aria-current={w.slug === current ? "page" : undefined}
          className={cx(
            "rounded-sm border px-2.5 py-1 text-sm",
            w.slug === current
              ? "border-slate bg-slate-tint font-medium text-slate"
              : "border-line bg-surface text-ink hover:bg-surface-subtle",
          )}
        >
          {w.name}
          {w.enabled ? "" : " · off"}
        </Link>
      ))}
      <button
        type="button"
        data-testid="builder-workflow-add"
        aria-expanded={adding}
        onClick={onAdd}
        className="ds-btn ds-btn--link text-sm"
      >
        <Icon name="add" />
        Add workflow
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
  bundle: AgentBundle;
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
      case "manual":
        return { type, input: { type: "object", properties: {} } };
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
            {events.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
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
  busy,
  run,
  onClose,
}: {
  agent: AgentSummary;
  workflowName: string;
  slug: string;
  sample: unknown;
  busy: boolean;
  /** `clientId`: a template's chosen client (none: the Sandbox). */
  run(payload: unknown, clientId: string | null): Promise<string | null>;
  onClose(): void;
}) {
  const sampleText = JSON.stringify(sample, null, 2);
  const isTemplate = agent.kind === "template";
  // A template can run on the Sandbox's fixture data or on a client the operator serves.
  const clients = useApi(apiRoutes.opsClients, isTemplate ? {} : null);
  const [clientId, setClientId] = useState("");
  const [source, setSource] = useState<"sample" | "manual">("sample");
  const [text, setText] = useState(sampleText);
  const [problem, setProblem] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
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
      {isTemplate ? (
        <SmallSelect
          aria-label="Client"
          data-testid="builder-test-client"
          value={clientId}
          className="max-w-xs"
          onChange={(e) => setClientId(e.target.value)}
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
      <SmallSelect
        aria-label="Payload"
        data-testid="builder-test-source"
        value={source}
        className="max-w-xs"
        onChange={(e) => {
          const v = e.target.value as "sample" | "manual";
          setSource(v);
          if (v === "sample") setText(sampleText);
        }}
      >
        <option value="sample">Sample trigger payload</option>
        <option value="manual">Manual input</option>
      </SmallSelect>
      <TextArea
        aria-label="Trigger payload (JSON)"
        data-testid="builder-test-payload"
        rows={6}
        value={text}
        readOnly={source === "sample"}
        className="font-mono text-xs"
        onChange={(e) => setText(e.target.value)}
      />
      {problem ? <p className="text-sm text-risk">{problem}</p> : null}
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
          disabled={busy}
          onClick={async () => {
            let payload: unknown;
            try {
              payload = text.trim() ? JSON.parse(text) : {};
            } catch {
              setProblem("The payload isn't valid JSON.");
              return;
            }
            setProblem(null);
            const id = await run(payload, clientId || null);
            if (id) setRunId(id);
          }}
        >
          {busy ? "Starting…" : `Test-run ${slug}`}
        </Button>
      </div>
    </div>
  );
}
