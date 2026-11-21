// Check the steps (docs/builder-plan.md §12.5 F5, docs/plan.md §1.170 "Check the steps"; design:
// docs/design/builder.html `stepsHTML`, `rowsHTML`, `pathHTML`): a new build's draft as a list of
// lines before the chart. The draft is made as today ("Draft it now", saved); this list is shown
// over that saved version and edits it with ./checkModel (ids made once, never regenerated). How
// it starts maps onto the first trigger; each top-level step is a line; a decision is a block with
// its paths. Build it saves the edited bundle as a new version and asks the Builder once to fill
// the lines typed by hand, then opens the agent's workflow. A build with no draft yet (List the
// steps myself) is drafted from the lines' words on Build it.

import {
  type AgentSummary,
  AnyAgentBundle,
  type BuildDetail,
  canonicalJson,
  type ProcessAgentBundle,
} from "@countersign/core";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, Select, TextInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Page } from "../../ui/page";
import { Badge, Button, cx, Loading, StepKindTag } from "../../ui/primitives";
import { editWorkflow, locate, type NewId, ROOT, readProcessBundle } from "../builder/model";
import { OPS_PATHS } from "../paths";
import { opsAgentHref } from "../screens/AgentRedirect";
import { processKindLabel, triggerTitle } from "../workflow/describe";
import {
  addDecision,
  addLine,
  addPath,
  afterPaths,
  blankProcess,
  countLines,
  decisionPaths,
  fillRequest,
  finishLines,
  handAdded,
  type IfStep,
  lineToDecision,
  listWords,
  moveLine,
  pathEnds,
  removeLine,
  removePath,
  renameLine,
  START_KINDS,
  STARTS,
  type StartKind,
  setAfterPaths,
  setCondition,
  setPathEnd,
  setStart,
  startKindOf,
} from "./checkModel";
import {
  type CheckStepsState,
  type DescribeAgainState,
  type DescribeKind,
  FlowStepper,
} from "./DescribeScreen";
import type { Process, Step } from "./types";

/** The route's screen: `/ops/builds/:id/check`, with the words Describe passed in its state. */
export function CheckStepsScreen() {
  const { id = "" } = useParams();
  const location = useLocation();
  const words = (location.state as Partial<CheckStepsState> | null)?.words;
  return (
    <Page width="narrow" testId="flow-check-page">
      <CheckSteps buildId={id} words={words} />
    </Page>
  );
}

export interface CheckStepsProps {
  buildId: string;
  /** The words the draft was made from; else the build's first message, else its goal. */
  words?: string | undefined;
  /** New ids (tests pass a counter); core's uuidv7 by default. */
  newId?: NewId | undefined;
}

/** Loads the build and its draft's latest version, then the list over it. */
export function CheckSteps({ buildId, words, newId }: CheckStepsProps) {
  const build = useApi(apiRoutes.opsBuild, { params: { id: buildId } });
  const agentId = build.data?.build.agentId ?? null;
  const agent = useApi(apiRoutes.opsAgent, agentId ? { params: { id: agentId } } : null);
  if (build.error) return <ErrorNotice error={build.error} onRetry={build.reload} />;
  if (!build.data) return <Loading />;
  if (agentId && agent.error) return <ErrorNotice error={agent.error} onRetry={agent.reload} />;
  if (agentId && !agent.data) return <Loading />;
  const detail = build.data;
  const said =
    words ??
    detail.messages.find((m) => m.role === "operator")?.text ??
    detail.build.brief.goal?.text ??
    "";
  return (
    <CheckBody
      // Read once: a refresh after Build it saves must not reset the lines under way.
      key={agentId ?? "none"}
      detail={detail}
      agent={agent.data ?? null}
      words={said}
      newId={newId}
    />
  );
}

interface AgentData {
  agent: AgentSummary;
  latest: { id: string; bundle: unknown } | null;
}

interface Loaded {
  bundle: ProcessAgentBundle | null;
  slug: string | null;
  workflowName: string;
  process: Process;
}

function load(agent: AgentData | null, newId: NewId | undefined): Loaded {
  const parsed = agent?.latest ? AnyAgentBundle.safeParse(agent.latest.bundle) : null;
  const bundle = parsed?.success ? readProcessBundle(parsed.data, {}) : null;
  const first = bundle?.workflows[0];
  return {
    bundle,
    slug: first?.slug ?? null,
    workflowName: first?.name ?? agent?.agent.name ?? "",
    process: first?.workflow ?? blankProcess(newId),
  };
}

function CheckBody({
  detail,
  agent,
  words,
  newId,
}: {
  detail: BuildDetail;
  agent: AgentData | null;
  words: string;
  newId: NewId | undefined;
}) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [loaded] = useState(() => load(agent, newId));
  // No saved draft to check: the lines are the operator's own, drafted on Build it.
  const mine = !loaded.bundle || !loaded.slug || !agent;
  const [process, setProcess] = useState<Process>(() =>
    mine && loaded.process.steps.length === 0
      ? addLine(loaded.process, ROOT, 0, "", newId).process
      : loaded.process,
  );
  const trigger = process.triggers[0];
  const startNow = trigger ? startKindOf(trigger.on) : null;
  const [startWords, setStartWords] = useState(() =>
    trigger ? (mine ? "" : triggerTitle(trigger)) : "",
  );
  const [startEdited, setStartEdited] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState<"build" | "fill" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const kind: DescribeKind = detail.build.client ? "client" : "template";
  const counts = countLines(loaded.process);
  const lines = finishLines(process);
  const empty = lines.steps.length === 0;

  useEffect(() => {
    if (!focus) return;
    const el = document.querySelector<HTMLInputElement>(`[data-line="${CSS_ESCAPE(focus)}"]`);
    if (el) {
      el.focus();
      setFocus(null);
    }
  }, [focus]);

  const edit = (fn: (p: Process) => Process) => setProcess((p) => fn(p));
  const add = (container: string, index: number, words = "") => {
    const out = addLine(process, container, index, words, newId);
    setProcess(out.process);
    setFocus(out.stepId);
  };
  const workflowHref = () =>
    agent && loaded.slug ? `${opsAgentHref(agent.agent)}/workflows/${loaded.slug}` : null;

  function backToDescription() {
    navigate(OPS_PATHS.labNew(kind), {
      state: {
        describe: {
          name: detail.build.title,
          words,
          kind,
          clientId: detail.build.client?.id,
          // A build with no draft yet is drafted in place; one with a draft can't be again.
          buildId: mine ? detail.build.id : undefined,
        },
      } satisfies DescribeAgainState,
    });
  }

  async function buildIt() {
    setBusy("build");
    setError(null);
    try {
      if (mine) {
        // List the steps myself: the build has no draft, so it is drafted from the list's words.
        const out = await api.call(apiRoutes.opsDraftBuildNow, {
          params: { id: detail.build.id },
          body: {
            description: listWords(
              lines,
              startWords.trim() || (startNow ? startTitle(startNow) : ""),
            ),
          },
        });
        const made = out.draft?.agentId ?? out.build.agentId;
        navigate(made ? `/ops/agents/${made}/workflow` : OPS_PATHS.build(detail.build.id));
        return;
      }
      if (!agent?.latest || !loaded.bundle || !loaded.slug) return;
      const slug = loaded.slug;
      const next = editWorkflow(loaded.bundle, slug, () => lines);
      let from = agent.latest.id;
      if (canonicalJson(next) !== canonicalJson(loaded.bundle)) {
        const saved = await api.call(apiRoutes.opsSaveVersion, {
          params: { id: agent.agent.id },
          body: { bundle: next, parentVersionId: from, changeNote: "Checked the steps" },
        });
        from = saved.version.id;
      }
      const text = fillRequest({
        workflowName: loaded.workflowName,
        added: handAdded(loaded.process, lines),
        startWords: startEdited ? startWords : null,
      });
      if (text) {
        // Asked once; when it fails, the lines stay missing steps and show on the chart.
        setBusy("fill");
        try {
          const started = await api.call(apiRoutes.opsStartBuilderSession, {
            body: { kind: "agent", agentId: agent.agent.id, fromVersionId: from },
          });
          const session = started.session.id;
          await api.call(apiRoutes.opsBuilderTurn, { params: { id: session }, body: { text } });
          await api.call(apiRoutes.opsBuilderSave, {
            params: { id: session },
            body: { changeNote: "Filled the steps added by hand" },
          });
        } catch {
          // Carry on to the chart: the missing steps are its issues.
        }
      }
      navigate(workflowHref() ?? OPS_PATHS.build(detail.build.id));
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const to = e.over ? process.steps.findIndex((s) => s.id === e.over?.id) : -1;
    if (to < 0 || e.active.id === e.over?.id) return;
    edit((p) => moveLine(p, String(e.active.id), to));
  };

  const lineProps: LineEvents = {
    rename: (id, w) => edit((p) => renameLine(p, id, w)),
    commit: (id) => edit((p) => lineToDecision(p, id, newId)),
    remove: (id) => edit((p) => removeLine(p, id)),
    enter: (id, container, index) => {
      const turned = lineToDecision(process, id, newId);
      if (turned === process) return add(container, index + 1);
      setProcess(turned);
      const made = locate(turned, id)?.step;
      if (made?.kind === "if" && made.paths[0]) setFocus(`cond:${made.paths[0].id}`);
    },
    isNew: (id) => !loaded.bundle || !hadStep(loaded.process, id),
  };

  return (
    <div className="flex flex-col gap-6" data-testid="flow-check">
      <FlowStepper at={2} />
      <div className="flex max-w-[62ch] flex-col gap-2">
        <h1 className="text-2xl font-medium text-ink">Check the steps</h1>
        <p className="text-base text-ink-muted" data-testid="flow-check-summary">
          {mine
            ? "Say how it starts, then list what happens, a line a step. Nothing runs until you turn it on."
            : `The Builder read your description as ${plural(counts.steps, "step")}${counts.decisions ? ` and ${plural(counts.decisions, "decision")}` : ""}. Change, add, drag or remove any line. Nothing runs until you turn it on.`}
        </p>
      </div>
      {words.trim() ? (
        <div
          className="flex flex-wrap items-start justify-between gap-3 border-l-2 border-line-strong pl-3"
          data-testid="flow-check-quote"
        >
          <span className="min-w-0 flex-1 text-sm text-ink-muted">
            “{words.length > 190 ? `${words.slice(0, 190).trim()}…` : words}”
          </span>
          <Button
            variant="link"
            size="sm"
            onClick={backToDescription}
            data-testid="flow-check-edit"
          >
            Edit the description
          </Button>
        </div>
      ) : null}

      <section className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5">
        <h2 className="text-lg font-medium text-ink">How it starts</h2>
        <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="How it starts">
          {START_KINDS.map((k) => {
            const on = trigger ? startKindOf(trigger.on) === k : false;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                data-testid={`flow-check-start-${k}`}
                onClick={() => {
                  edit((p) => setStart(p, k));
                  if (!startEdited) setStartWords(startTitle(k));
                }}
                className={cx(
                  "flex flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm",
                  on
                    ? "border-slate bg-slate-tint text-ink"
                    : "border-line text-ink hover:border-line-strong",
                )}
              >
                <span className="font-medium">{STARTS[k].title}</span>
                <span className="text-xs text-ink-muted">{STARTS[k].hint}</span>
              </button>
            );
          })}
        </fieldset>
        <Field label="In your words">
          <TextInput
            value={startWords}
            onChange={(e) => {
              setStartWords(e.target.value);
              setStartEdited(true);
            }}
            placeholder="When a vendor invoice arrives by email"
            maxLength={300}
            data-testid="flow-check-start-words"
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5">
        <h2 className="text-lg font-medium text-ink">Then what happens</h2>
        <p className="ds-help text-sm">
          One step a line, in order. Enter adds the next one. Start a line with "If" and it becomes
          a decision. Each path has its own steps. Paths can come back together, or go separate ways
          and never meet.
        </p>
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <SortableContext
            items={process.steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol className="flex flex-col gap-2" data-testid="flow-check-lines">
              {process.steps.map((s, i) => (
                <TopLine key={s.id} step={s} number={i + 1}>
                  {s.kind === "if" ? (
                    <DecisionBlock
                      step={s}
                      below={process.steps.slice(i + 1).length}
                      events={lineProps}
                      onRemove={() => edit((p) => removeLine(p, s.id))}
                      onCondition={(pathId, w) => edit((p) => setCondition(p, s.id, pathId, w))}
                      onAddPath={() => {
                        const out = addPath(process, s.id, newId);
                        setProcess(out.process);
                        if (out.pathId) setFocus(`cond:${out.pathId}`);
                      }}
                      onRemovePath={(pathId) => edit((p) => removePath(p, s.id, pathId))}
                      onAddStep={(container, index) => add(container, index)}
                      onEnd={(container, end) => edit((p) => setPathEnd(p, container, end, newId))}
                      onAfter={(how) => edit((p) => setAfterPaths(p, s.id, how, newId))}
                    />
                  ) : (
                    <LineInput
                      step={s}
                      container={ROOT}
                      index={i}
                      label={`Step ${i + 1}`}
                      events={lineProps}
                    />
                  )}
                </TopLine>
              ))}
            </ol>
          </SortableContext>
        </DndContext>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => add(ROOT, process.steps.length)}
            data-testid="flow-check-add-step"
          >
            <Icon name="add" size={14} />
            Step
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const out = addDecision(process, ROOT, process.steps.length, "", newId);
              setProcess(out.process);
              const made = out.process.steps.find((x) => x.id === out.stepId);
              if (made?.kind === "if" && made.paths[0]) setFocus(`cond:${made.paths[0].id}`);
            }}
            data-testid="flow-check-add-decision"
          >
            <Icon name="add" size={14} />
            Decision
          </Button>
        </div>
      </section>

      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <span className="text-sm text-ink-muted" role="status" data-testid="flow-check-building">
            {busy === "fill" ? "Filling the steps you added" : "Building it"}
          </span>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={mine && empty}
              onClick={() => void buildIt()}
              data-testid="flow-check-build"
            >
              Build it
            </Button>
            <Button variant="ghost" onClick={backToDescription} data-testid="flow-check-back">
              Back to the description
            </Button>
            {mine ? (
              // DECISION (F5): with no draft yet there is no canvas to open, and making an agent
              // apart from the build would leave the build without its draft: today's build page
              // (its questions) is the other way in.
              <Button
                variant="ghost"
                onClick={() => navigate(OPS_PATHS.build(detail.build.id))}
                data-testid="flow-check-questions"
              >
                Start with the Builder's questions
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => navigate(workflowHref() ?? OPS_PATHS.build(detail.build.id))}
                data-testid="flow-check-blank"
              >
                Start with a blank canvas
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Lines ────────────────────────────────────────────────────────────────────────────────────────

const CSS_ESCAPE = (s: string) =>
  typeof globalThis.CSS?.escape === "function" ? globalThis.CSS.escape(s) : s;

function hadStep(process: Process, id: string): boolean {
  let found = false;
  const visit = (steps: readonly Step[]) => {
    for (const s of steps) {
      if (s.id === id) found = true;
      if (s.kind === "if") {
        for (const p of s.paths) visit(p.steps);
        visit(s.otherwise.steps);
      }
      if (s.kind === "for_each" || s.kind === "repeat") visit(s.steps);
    }
  };
  visit(process.steps);
  return found;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function startTitle(k: StartKind): string {
  return `When ${STARTS[k].title.charAt(0).toLowerCase()}${STARTS[k].title.slice(1)}`;
}

interface LineEvents {
  rename(id: string, words: string): void;
  /** Leaving a line typed with "If …": it becomes a decision. */
  commit(id: string): void;
  remove(id: string): void;
  /** Enter: a line typed with "If …" becomes a decision; any other adds the next line. */
  enter(id: string, container: string, index: number): void;
  /** Added here, not drafted. */
  isNew(id: string): boolean;
}

/** One top-level line: its handle to drag, its number, then the line or the decision. */
function TopLine({ step, number, children }: { step: Step; number: number; children: ReactNode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx("flex items-start gap-2", isDragging && "opacity-60")}
      data-testid="flow-check-line"
      data-step-id={step.id}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move ${step.name || `step ${number}`}`}
        data-testid="flow-check-line-handle"
        className="mt-2.5 flex w-4 shrink-0 cursor-grab touch-none justify-center text-ink-muted hover:text-ink"
      >
        <Icon name="more" size={14} className="rotate-90" />
      </button>
      <span className="mt-2.5 w-5 shrink-0 text-right text-xs text-ink-muted figures">
        {number}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** A step's line: its words, its kind as a tag, and remove. */
function LineInput({
  step,
  container,
  index,
  label,
  events,
}: {
  step: Step;
  container: string;
  index: number;
  label: string;
  events: LineEvents;
}) {
  const typed = step.kind === "missing";
  return (
    <div className="flex items-center gap-2">
      <TextInput
        value={step.name}
        aria-label={label}
        placeholder="What happens next"
        data-line={step.id}
        data-testid="flow-check-line-input"
        className="min-w-0 flex-1"
        onChange={(e) => events.rename(step.id, e.target.value)}
        onBlur={() => {
          if (typed) events.commit(step.id);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          events.enter(step.id, container, index);
        }}
      />
      <span data-testid="flow-check-line-kind" className="shrink-0">
        {typed ? (
          <Badge tone="warning">{events.isNew(step.id) ? "The Builder fills it" : "Missing"}</Badge>
        ) : (
          <StepKindTag kind={step.kind} label={processKindLabel(step)} />
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="ds-btn--icon shrink-0"
        aria-label={`Remove ${step.name || "this step"}`}
        onClick={() => events.remove(step.id)}
        data-testid="flow-check-line-remove"
      >
        <Icon name="close" size={14} />
      </Button>
    </div>
  );
}

const letter = (i: number) => String.fromCharCode(65 + (i % 26));

/** A decision: If / Or if / Otherwise, each path's lines, how each path ends, and after them. */
function DecisionBlock({
  step,
  below,
  events,
  onRemove,
  onCondition,
  onAddPath,
  onRemovePath,
  onAddStep,
  onEnd,
  onAfter,
}: {
  step: IfStep;
  /** Lines below the decision, which never run when every path ends. */
  below: number;
  events: LineEvents;
  onRemove(): void;
  onCondition(pathId: string, words: string): void;
  onAddPath(): void;
  onRemovePath(pathId: string): void;
  onAddStep(container: string, index: number): void;
  onEnd(container: string, end: "stop" | "on"): void;
  onAfter(how: "together" | "apart"): void;
}) {
  const paths = decisionPaths(step);
  const after = afterPaths(step);
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-line-strong bg-surface-subtle p-3"
      data-testid="flow-check-decision"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium text-ink">Decision</span>
          <span className="text-xs text-ink-muted">
            The first path that fits runs. Add as many paths as it needs.
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ds-btn--icon"
          aria-label="Remove this decision"
          onClick={onRemove}
          data-testid="flow-check-decision-remove"
        >
          <Icon name="close" size={14} />
        </Button>
      </div>
      {paths.map((p, i) => {
        const path = p.otherwise ? null : step.paths[i];
        const tag = p.otherwise ? "" : letter(i);
        // A path's Stop at its end is "ends here", not a line.
        const shown = pathEnds(p.steps) ? p.steps.slice(0, -1) : p.steps;
        const ends = pathEnds(p.steps);
        return (
          <div
            key={p.key}
            className="flex flex-col gap-2 border-l-2 border-line pl-3"
            data-testid="flow-check-path"
          >
            {p.otherwise ? (
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-ink">Otherwise</span>
                <span className="text-xs text-ink-muted">
                  {shown.length || ends
                    ? "none of the above"
                    : "none of the above: it goes on to the next step"}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="ds-pill ds-pill--accent shrink-0">{tag}</span>
                <span className="w-12 shrink-0 text-sm font-medium text-ink">
                  {i === 0 ? "If" : "Or if"}
                </span>
                <TextInput
                  value={path?.name ?? ""}
                  aria-label="Condition"
                  placeholder={i === 0 ? "a line doesn't match" : "another case"}
                  data-line={`cond:${path?.id ?? ""}`}
                  data-testid="flow-check-condition"
                  className="min-w-0 flex-1"
                  onChange={(e) => path && onCondition(path.id, e.target.value)}
                />
                {step.paths.length > 1 && path ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ds-btn--icon shrink-0"
                    aria-label="Remove this path"
                    onClick={() => onRemovePath(path.id)}
                    data-testid="flow-check-path-remove"
                  >
                    <Icon name="close" size={14} />
                  </Button>
                ) : null}
              </div>
            )}
            {shown.length > 0 ? (
              <ol className="flex flex-col gap-2">
                {shown.map((s, j) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className="w-6 shrink-0 text-right text-xs text-ink-muted figures">
                      {tag}
                      {j + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <LineInput
                        step={s}
                        container={p.container}
                        index={j}
                        label={`Step ${tag}${j + 1}`}
                        events={events}
                      />
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="link"
                size="sm"
                onClick={() => onAddStep(p.container, shown.length)}
                data-testid="flow-check-path-add-step"
              >
                + Step on this path
              </Button>
              <span className="flex items-center gap-2 text-xs text-ink-muted">
                then it
                <Select
                  value={ends ? "stop" : "on"}
                  aria-label="After this path"
                  className="w-48"
                  data-testid="flow-check-path-end"
                  onChange={(e) => onEnd(p.container, e.target.value === "stop" ? "stop" : "on")}
                >
                  <option value="on">rejoins the steps below</option>
                  <option value="stop">ends here</option>
                </Select>
              </span>
            </div>
            {p.otherwise ? null : i === step.paths.length - 1 ? (
              <Button
                size="sm"
                className="self-start"
                onClick={onAddPath}
                data-testid="flow-check-add-path"
              >
                <Icon name="add" size={14} />
                Add a path <span className="text-ink-muted">Or if …</span>
              </Button>
            ) : null}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-ink-muted">
        After the paths
        <fieldset className="ds-seg" aria-label="After the paths">
          <button
            type="button"
            aria-pressed={after === "together"}
            onClick={() => onAfter("together")}
            data-testid="flow-check-after-together"
          >
            they come back together
          </button>
          <button
            type="button"
            aria-pressed={after === "apart"}
            onClick={() => onAfter("apart")}
            data-testid="flow-check-after-apart"
          >
            they go separate ways
          </button>
        </fieldset>
      </div>
      {after === "apart" && below > 0 ? (
        <p className="text-sm text-signal-ink" data-testid="flow-check-never-runs">
          Every path here ends, so{" "}
          {below === 1 ? "the line below never runs" : `the ${below} lines below never run`}. Move{" "}
          {below === 1 ? "it" : "them"} onto a path, or let a path come back.
        </p>
      ) : null}
    </div>
  );
}
