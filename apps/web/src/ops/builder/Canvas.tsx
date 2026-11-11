// The builder's canvas (prototype `#O6-Builder`; ARCHITECTURE §10.14): the process's triggers on a
// tinted card, one row each, and numbered step cards, each one compact row (handle, number, the
// kind's icon, the name, a skill's kind (Deterministic or AI), small marks for invalid, its
// checks, approval, hidden and customized), with what the step does in a tooltip; a click opens it
// in the side panel, where all editing happens (the canvas only moves steps). Ifs as side-by-side
// paths with "Drop a step here, or add a step" and "Paths join here", for-each blocks (while steps
// are being selected for a process of their own, a check box); and the "Add a step" palette (shown
// in the side panel) whose items drag into a list or add with + to the list it was opened for. The
// selected card shows the design system's selection (slate). Drag and drop is @dnd-kit
// (docs/plan.md §1.2 "Builder"): every list is a sortable context keyed by its container, so a
// step moves within its list, into and out of if paths and for-each blocks, with the pointer or
// the keyboard (Space, arrows, Space).

import { SKILL_KIND_LABEL, toolUsesModel } from "@countersign/core";
import {
  type CollisionDetection,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  pointerWithin,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../ui/icons";
import { cx, Tag } from "../../ui/primitives";
import {
  processKindLabel,
  processStepDetail,
  processStepNames,
  rulesText,
  type StepLabels,
  stepSkillKindLabel,
  triggerDetail,
  triggerTitle,
} from "../workflow/describe";
import { forkGridColumns, forkMinWidth, stepMinWidth } from "../workflow/layout";
import type { BuilderProblem, PaletteSection } from "./catalog";
import {
  type ApprovalEnv,
  approvalOption,
  type ContainerId,
  getContainer,
  type PaletteItem,
  type Process,
  ROOT,
  type Step,
} from "./model";

// ── Drag data and drops ──────────────────────────────────────────────────────────────────────────

export type DragData =
  | { type: "step"; container: ContainerId; index: number }
  | { type: "container"; container: ContainerId }
  | { type: "palette"; item: PaletteItem };

export type Drop =
  | { type: "move"; id: string; container: ContainerId; index: number }
  | { type: "add"; item: PaletteItem; container: ContainerId; index: number }
  | { type: "trigger"; item: Extract<PaletteItem, { type: "trigger" }> };

/**
 * What a finished drag does. Over a step: within its own list the step takes that place (as
 * arrayMove does), from elsewhere it goes in before it. Over a "Drop a step here" zone: at the end
 * of that list. A trigger from the palette replaces how the process starts.
 */
export function resolveDrop(
  process: Pick<Process, "steps">,
  activeId: string,
  active: DragData | undefined,
  over: DragData | undefined,
): Drop | null {
  if (!active || !over) return null;
  if (active.type === "palette" && active.item.type === "trigger") {
    return { type: "trigger", item: active.item };
  }
  const target =
    over.type === "step"
      ? { container: over.container, index: over.index }
      : over.type === "container"
        ? {
            container: over.container,
            index: getContainer(process, over.container)?.length ?? 0,
          }
        : null;
  if (!target) return null;
  if (active.type === "palette") return { type: "add", item: active.item, ...target };
  if (active.type === "step") return { type: "move", id: activeId, ...target };
  return null;
}

/** The pointer's own droppable first (nested lists), else the closest one (keyboard drags). */
export const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCenter(args);
};

export interface DragHandlers {
  onDragStart(e: DragStartEvent): void;
  onDragOver(e: DragOverEvent): void;
  onDragEnd(e: DragEndEvent): void;
  onDragCancel(): void;
}

/** A canvas selection: a step by id, or one of the triggers as `trigger:<id>`. */
export function triggerKey(id: string): string {
  return `trigger:${id}`;
}

// ── Canvas ───────────────────────────────────────────────────────────────────────────────────────

export interface CanvasProps {
  workflow: Process;
  selectedId: string | null;
  env: ApprovalEnv;
  errors: readonly BuilderProblem[];
  customized: ReadonlyMap<string, "added" | "changed">;
  activeId: string | null;
  overId: string | null;
  /** A step id, or `trigger:<id>`. */
  onSelect(id: string): void;
  /** Top-level steps picked for "Save as a process"; check boxes show while this is set. */
  checked?: ReadonlySet<string> | undefined;
  onCheck?: ((id: string, on: boolean) => void) | undefined;
  /** Names for steps' second lines (skills, tools' connectors, people), from the catalog. */
  labels?: StepLabels | undefined;
  /** "Add a step" at the end of a list: opens the palette for that list. */
  onAddAt?: ((container: ContainerId) => void) | undefined;
  /** The list the palette adds to while it is open. */
  addTarget?: ContainerId | null | undefined;
  /** Set by the canvas: shows a step's tooltip beside its card, or hides it (null). */
  onTip?: ((tip: StepTip | null) => void) | undefined;
}

/** What a step's tooltip says, and where its card is. */
interface StepTip {
  id: string;
  rect: DOMRect;
  title: string;
  lines: string[];
}

/** Each kind's icon on its card: what kind of step it is at a glance (named in the tooltip). */
const KIND_ICON: Record<Step["kind"], IconName> = {
  read: "search",
  skill: "worksheet",
  write: "upload",
  person: "customer",
  conversation: "message",
  notify: "notifications",
  if: "filter",
  for_each: "copy",
  wait: "calendar",
  stop: "close",
  process: "table",
};

/** The state a selected card shows: the design system's selection (slate). */
const SELECTED = "border-slate bg-slate-tint outline outline-1 outline-slate";

/** Errors on a step, counting an if's paths as the if's. */
function errorCount(step: Step, errors: readonly BuilderProblem[]): number {
  const ids = new Set([step.id]);
  if (step.kind === "if") {
    for (const p of step.paths) ids.add(p.id);
    ids.add(step.otherwise.id);
  }
  return errors.filter((e) => e.stepId !== null && ids.has(e.stepId)).length;
}

/** Whether the client's run timeline shows the step: work does by default, logic never. */
// DECISION: v4's work kinds (read, skill, write, person, conversation, notify, process) show on the
// client's timeline by default, as v3's skill, action, person, notify and use steps did; logic
// (if, for each, wait, stop) never does. A step's own `client.visible` wins.
export function processClientVisible(step: Step): boolean {
  if (step.client) return step.client.visible;
  return !["if", "for_each", "wait", "stop"].includes(step.kind);
}

export function Canvas(props: CanvasProps) {
  const { workflow } = props;
  const [tip, setTip] = useState<StepTip | null>(null);
  // A scroll moves the cards out from under a fixed tooltip: hide it.
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tip]);
  const shown = props.activeId ? null : tip;
  const inner: CanvasProps = { ...props, onTip: setTip };
  // The triggers and the top-level steps always fit the canvas; an if wider than it scrolls
  // sideways in its own box (each path keeping a readable width, workflow/layout.ts), never the
  // page.
  return (
    <div data-testid="builder-canvas" className="flex min-w-0 flex-col items-center">
      <TriggerCard {...inner} />
      <List {...inner} id={ROOT} steps={workflow.steps} numbered />
      <span aria-hidden className="h-3 border-l border-line-strong" />
      <DropZone
        id={ROOT}
        label="Drop a step here, or"
        className="w-full max-w-[360px]"
        onAdd={props.onAddAt}
        active={props.addTarget === ROOT}
      />
      {shown ? (
        // Fixed, so an if's scrolling box doesn't clip it; beside the card, or under it when
        // there is no room on the right.
        <div
          role="tooltip"
          id={`builder-tip-${shown.id}`}
          data-testid="builder-step-tip"
          className="ds-tooltip ui-steptip"
          style={
            window.innerWidth - shown.rect.right > 300
              ? { top: shown.rect.top, left: shown.rect.right + 8 }
              : { top: shown.rect.bottom + 6, left: Math.max(8, shown.rect.left) }
          }
        >
          <span className="font-medium">{shown.title}</span>
          {shown.lines.map((l) => (
            <span key={l} className="ui-steptip__line">
              {l}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The process's triggers, one row each: any of them starts a run. */
function TriggerCard(props: CanvasProps) {
  const { workflow, selectedId, onSelect, errors } = props;
  const anySelected = workflow.triggers.some((t) => selectedId === triggerKey(t.id));
  return (
    <div
      data-testid="builder-trigger"
      data-selected={anySelected ? "true" : undefined}
      className={cx(
        "flex w-full max-w-[360px] flex-col rounded-md border bg-slate-tint",
        anySelected ? "border-slate" : "border-line",
      )}
    >
      {workflow.triggers.map((trigger, i) => {
        const selected = selectedId === triggerKey(trigger.id);
        const invalid = errors.filter((e) => e.stepId === trigger.id).length;
        const title = triggerTitle(trigger);
        const detail = triggerDetail(trigger);
        const tipId = `trigger-${trigger.id}`;
        const tip = (el: HTMLElement | null) =>
          el &&
          props.onTip?.({
            id: tipId,
            rect: el.getBoundingClientRect(),
            title: `Trigger · ${title}`,
            lines: [detail, invalid > 0 ? "Invalid: see the problems above" : null].filter(
              (l): l is string => Boolean(l),
            ),
          });
        return (
          <div
            key={trigger.id}
            data-testid={`builder-trigger-${trigger.id}`}
            data-selected={selected ? "true" : undefined}
            onPointerEnter={(e) => tip(e.currentTarget)}
            onPointerLeave={() => props.onTip?.(null)}
            className={cx(
              "flex items-center gap-2 px-2.5 py-1.5",
              i > 0 && "border-t border-line",
              selected && "outline outline-1 outline-slate",
            )}
          >
            <Icon name="arrow" size={16} className="shrink-0 text-slate" />
            <button
              type="button"
              data-testid={`builder-trigger-${trigger.id}-select`}
              aria-current={selected ? "true" : undefined}
              aria-describedby={detail ? `builder-tip-${tipId}` : undefined}
              onClick={() => onSelect(triggerKey(trigger.id))}
              onFocus={(e) => tip(e.currentTarget.parentElement)}
              onBlur={() => props.onTip?.(null)}
              className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink"
            >
              {i > 0 ? "Or " : ""}
              {i > 0 ? lowerFirst(title) : title}
            </button>
            {invalid > 0 ? (
              <Mark
                tone="risk"
                icon="alert"
                label="Invalid"
                testId={`builder-trigger-${trigger.id}-invalid`}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A small mark on a card: an icon with its word for screen readers and the tooltip (the card
 * stays one line). Risk for invalid, copper for a person's sign-off.
 */
function Mark({
  tone,
  icon,
  label,
  testId,
}: {
  tone: "risk" | "person" | "accent" | "neutral";
  icon: IconName;
  label: string;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      title={label}
      className={cx(
        "flex size-5 shrink-0 items-center justify-center rounded-sm",
        tone === "risk" && "bg-risk-tint text-risk",
        tone === "person" && "bg-copper-tint text-copper",
        tone === "accent" && "bg-slate-tint text-slate",
        tone === "neutral" && "text-ink-muted",
      )}
    >
      <Icon name={icon} size={14} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function List(props: CanvasProps & { id: ContainerId; steps: Step[]; numbered?: boolean }) {
  const { id, steps, numbered } = props;
  return (
    <SortableContext id={id} items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
      <ol
        data-testid={`builder-list-${id}`}
        className={cx("flex w-full flex-col items-center", !numbered && "items-stretch")}
      >
        {steps.map((step, index) => (
          <li key={step.id} className="flex w-full flex-col items-center">
            {numbered || index > 0 ? (
              <span
                aria-hidden
                className={cx("border-l border-line-strong", numbered ? "h-3" : "h-1.5")}
              />
            ) : null}
            <StepNode
              {...props}
              step={step}
              container={id}
              index={index}
              number={numbered ? index + 1 : undefined}
            />
          </li>
        ))}
      </ol>
    </SortableContext>
  );
}

function StepNode(
  props: CanvasProps & {
    step: Step;
    container: ContainerId;
    index: number;
    number: number | undefined;
  },
) {
  const { step } = props;
  const inner =
    step.kind === "if" ? (
      <IfBlock {...props} step={step} />
    ) : step.kind === "for_each" ? (
      <Loop {...props} step={step} />
    ) : null;
  return (
    <>
      <StepCard {...props} />
      {inner && props.container === ROOT ? (
        // A top-level if or loop wider than the canvas scrolls sideways in its own box; what
        // is nested in it scrolls with it.
        <div
          data-testid={`builder-${step.kind === "if" ? "fork" : "loop"}-${step.id}-scroll`}
          className="flex w-full justify-center-safe overflow-x-auto pb-1"
        >
          {inner}
        </div>
      ) : (
        inner
      )}
    </>
  );
}

/** What the step's checks add, in words: a second check, notices (approval has its own). */
function checkWords(step: Step): { confer: string | null; notify: string | null; person: boolean } {
  const confer = step.checks?.confer?.with ?? [];
  const person = confer.some((c) => "person" in c);
  const notify = step.checks?.notify ?? [];
  return {
    confer: confer.length > 0 ? (person ? "Checked with a person" : "Second check") : null,
    notify:
      notify.length > 0 ? (notify.some((n) => n.urgent) ? "Urgent notice" : "Tells people") : null,
    person,
  };
}

// DECISION: a step is one compact row; what it does is in its tooltip, and every edit (delete
// included) happens in the side panel, the canvas only moving steps (2026-11-10, the owner's call).
// Merged with the skill model: the kind's words (a write by where it writes, "Save to records",
// "Change in QuickBooks Online") name the icon and lead the tooltip, and a skill's kind
// (Deterministic or AI) stays on the row as a tag, so the hidden AI is never unlabelled.
function StepCard(
  props: CanvasProps & {
    step: Step;
    container: ContainerId;
    index: number;
    number: number | undefined;
  },
) {
  const { step, container, index, number, selectedId, env, errors, customized } = props;
  const data: DragData = { type: "step", container, index };
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
    id: step.id,
    data,
  });
  const card = useRef<HTMLDivElement | null>(null);
  const invalid = errorCount(step, errors);
  const approval = approvalOption(step, env);
  const hidden =
    !processClientVisible(step) && !["if", "for_each", "wait", "stop"].includes(step.kind);
  const custom = customized.get(step.id);
  const isOver = props.overId === step.id && props.activeId !== step.id;
  const selected = selectedId === step.id;
  const testId = `builder-step-${step.id}`;
  const label = processKindLabel(step, props.labels);
  const name = step.name || label;
  const skillKind = stepSkillKindLabel(step, props.labels);
  const detail = processStepDetail(step, props.labels);
  const description = props.labels?.description?.(step);
  const checks = checkWords(step);
  const approvalWords = approval ? (approval.automatic ? "On its own" : "Needs approval") : null;
  const customWords = custom ? (custom === "added" ? "Added here" : "Customized") : null;
  const people = step.kind === "person" || step.kind === "conversation";
  // The tooltip: what kind of step, what it does, its second line, and what its marks mean.
  const tipLines = [
    description,
    detail,
    [
      invalid > 0 ? "Invalid" : null,
      checks.confer,
      checks.notify,
      approvalWords,
      hidden ? "Not shown to the client" : null,
      customWords,
    ]
      .filter(Boolean)
      .join(" · "),
  ].filter((l): l is string => Boolean(l));
  const showTip = () =>
    card.current &&
    props.onTip?.({
      id: step.id,
      rect: card.current.getBoundingClientRect(),
      title: `${skillKind ? `${label} · ${skillKind}` : label} · ${name}`,
      lines: tipLines,
    });
  const hideTip = () => props.onTip?.(null);
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        card.current = el;
      }}
      data-dnd-node=""
      data-testid={testId}
      data-container={container}
      data-selected={selected ? "true" : undefined}
      onPointerEnter={showTip}
      onPointerLeave={hideTip}
      className={cx(
        "relative flex w-full items-center gap-2 rounded-md border py-1.5 pr-2 pl-1",
        number === undefined ? "" : "max-w-[360px]",
        selected ? SELECTED : invalid ? "border-risk bg-surface" : "border-line bg-surface",
        isDragging && "opacity-40",
      )}
    >
      {isOver ? (
        <span aria-hidden className="absolute -top-1.5 right-2 left-2 h-0.5 rounded-sm bg-slate" />
      ) : null}
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move ${name}`}
        data-testid={`${testId}-handle`}
        className="flex w-4 shrink-0 cursor-grab touch-none justify-center text-ink-muted hover:text-ink"
      >
        <Icon name="more" size={14} className="rotate-90" />
      </button>
      {number !== undefined && props.checked && props.onCheck ? (
        <input
          type="checkbox"
          aria-label={`Select ${name}`}
          data-testid={`${testId}-check`}
          className="size-4 shrink-0 accent-slate"
          checked={props.checked.has(step.id)}
          onChange={(e) => props.onCheck?.(step.id, e.target.checked)}
        />
      ) : null}
      {number !== undefined ? (
        <span
          data-testid={`${testId}-number`}
          className="w-4 shrink-0 text-center text-xs text-ink-muted figures"
        >
          {number}
        </span>
      ) : null}
      <span
        aria-hidden
        title={label}
        className={cx(
          "flex size-5 shrink-0 items-center justify-center rounded-sm",
          people ? "bg-copper-tint text-copper" : "bg-surface-subtle text-ink-muted",
        )}
      >
        <Icon name={KIND_ICON[step.kind]} size={14} />
      </span>
      <button
        type="button"
        data-testid={`${testId}-select`}
        aria-current={selected ? "true" : undefined}
        aria-describedby={`builder-tip-${step.id}`}
        onClick={() => props.onSelect(step.id)}
        onFocus={showTip}
        onBlur={hideTip}
        className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink outline-none focus-visible:underline"
      >
        <span className="sr-only" data-testid={`${testId}-kind`}>
          {label}:{" "}
        </span>
        {name}
      </button>
      <span className="flex shrink-0 items-center gap-1">
        {skillKind ? <Tag testId={`${testId}-skill-kind`}>{skillKind}</Tag> : null}
        {invalid > 0 ? (
          <Mark tone="risk" icon="alert" label="Invalid" testId={`${testId}-invalid`} />
        ) : null}
        {checks.confer ? (
          // A person's advice is people's work (copper); a second model's is the agents' (ink).
          <Mark
            tone={checks.person ? "person" : "neutral"}
            icon={checks.person ? "customer" : "check"}
            label={checks.confer}
            testId={`${testId}-confer`}
          />
        ) : null}
        {checks.notify ? (
          <Mark
            tone="neutral"
            icon="notifications"
            label={checks.notify}
            testId={`${testId}-notify`}
          />
        ) : null}
        {approval && approvalWords ? (
          // Approval is a person's sign-off (copper); a step the operator let run on its own is
          // the team's work (slate). The words are the settings' own (UI cleanup, decision 2).
          <Mark
            tone={approval.automatic ? "accent" : "person"}
            icon={approval.automatic ? "check" : "sign"}
            label={approvalWords}
            testId={`${testId}-approval`}
          />
        ) : null}
        {hidden ? (
          <Mark
            tone="neutral"
            icon="info"
            label="Not shown to the client"
            testId={`${testId}-hidden`}
          />
        ) : null}
        {custom && customWords ? (
          <Mark tone="accent" icon="add" label={customWords} testId={`${testId}-customized`} />
        ) : null}
      </span>
    </div>
  );
}

/**
 * "Drop a step here, or add a step": the end of a list, and the only target in an empty one. Its
 * button opens the palette to add to this list.
 */
function DropZone({
  id,
  label = "Drop a step here, or",
  className,
  onAdd,
  active,
}: {
  id: ContainerId;
  label?: string;
  className?: string;
  onAdd?: ((container: ContainerId) => void) | undefined;
  /** The palette is open for this list. */
  active?: boolean | undefined;
}) {
  const data: DragData = { type: "container", container: id };
  const { setNodeRef, isOver } = useDroppable({ id: `drop:${id}`, data });
  return (
    <div
      ref={setNodeRef}
      data-dnd-node=""
      data-testid={`builder-drop-${id}`}
      className={cx(
        "flex flex-wrap items-center justify-center gap-x-1 rounded-sm border border-dashed px-2 py-1 text-center text-xs",
        isOver || active
          ? "border-slate bg-slate-tint text-slate"
          : "border-line-strong text-ink-muted",
        className,
      )}
    >
      {onAdd ? (
        <>
          <span>{label}</span>
          <button
            type="button"
            data-testid={`builder-add-${id}`}
            aria-expanded={active ? "true" : "false"}
            onClick={() => onAdd(id)}
            className="ds-btn ds-btn--link text-xs"
          >
            <Icon name="add" size={14} />
            add a step
          </button>
        </>
      ) : (
        "Drop a step here"
      )}
    </div>
  );
}

function Branch(props: CanvasProps & { id: ContainerId; steps: Step[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {props.steps.length > 0 ? <List {...props} numbered={false} /> : null}
      <DropZone id={props.id} onAdd={props.onAddAt} active={props.addTarget === props.id} />
    </div>
  );
}

function IfBlock(props: CanvasProps & { step: Extract<Step, { kind: "if" }> }) {
  const { step } = props;
  const names = processStepNames(props.workflow);
  return (
    <div
      data-testid={`builder-fork-${step.id}`}
      className="flex w-full flex-col items-center"
      style={{ minWidth: forkMinWidth(step) }}
    >
      <span aria-hidden className="h-3 border-l border-line-strong" />
      <div
        className="grid w-full gap-2 rounded-lg border border-dashed border-line-strong p-2"
        style={{ gridTemplateColumns: forkGridColumns(step) }}
      >
        {step.paths.map((path, i) => (
          <section
            key={path.id}
            data-testid={`builder-fork-${step.id}-path-${path.id}`}
            aria-label={`Path ${i + 1}: ${path.name}`}
            className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-subtle p-2"
          >
            <div>
              <h3 className="text-sm font-medium text-ink">{path.name}</h3>
              <p
                className="truncate text-xs text-ink-muted"
                title={`if ${rulesText(path.when, names)}`}
              >
                if {rulesText(path.when, names)}
              </p>
            </div>
            <Branch {...props} id={`path:${path.id}`} steps={path.steps} />
          </section>
        ))}
        <section
          data-testid={`builder-fork-${step.id}-otherwise`}
          aria-label="Otherwise"
          className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-subtle p-2"
        >
          <div>
            <h3 className="text-sm font-medium text-ink">Otherwise</h3>
            <p className="text-xs text-ink-muted">None of the above</p>
          </div>
          <Branch {...props} id={`otherwise:${step.otherwise.id}`} steps={step.otherwise.steps} />
        </section>
      </div>
      <p className="eyebrow mt-1.5 text-ink-muted">Paths join here</p>
    </div>
  );
}

function Loop(props: CanvasProps & { step: Extract<Step, { kind: "for_each" }> }) {
  const { step } = props;
  return (
    <div
      data-testid={`builder-loop-${step.id}`}
      className="flex w-full max-w-[360px] flex-col items-center"
      style={{ minWidth: stepMinWidth(step) }}
    >
      <span aria-hidden className="h-3 border-l border-line-strong" />
      <div className="flex w-full flex-col gap-1.5 rounded-lg border border-dashed border-line-strong p-2">
        <p className="text-xs text-ink-muted">each item · up to {step.concurrency} at once</p>
        <Branch {...props} id={`loop:${step.id}`} steps={step.steps} />
      </div>
    </div>
  );
}

// ── Palette ──────────────────────────────────────────────────────────────────────────────────────

export function Palette({
  sections,
  search,
  onSearch,
  onAdd,
  target,
  onClose,
  focusKey,
  footer,
}: {
  sections: PaletteSection[];
  search: string;
  onSearch(value: string): void;
  onAdd(item: PaletteItem): void;
  /** Where + adds a step, in words: "at the end", "to Big change". */
  target: string;
  /** Escape, or Close: back to what the side panel showed before. */
  onClose?: (() => void) | undefined;
  /** Changes whenever the palette is opened from an add point, to put focus in its search. */
  focusKey?: number | undefined;
  /** Below the sections: a template's "Build with another connector". */
  footer?: ReactNode;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusKey) searchRef.current?.focus({ preventScroll: true });
  }, [focusKey]);
  const searching = search.trim().length > 0;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere in the palette closes it.
    <div
      data-testid="builder-palette"
      className="flex flex-col gap-4"
      onKeyDown={(e) => {
        if (e.key === "Escape" && onClose) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="type-subheading text-ink">Add a step</h2>
          <p className="mt-1 text-sm text-ink-muted" data-testid="builder-palette-target">
            Press + to add it {target}, or drag it onto the process.
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            aria-label="Close the steps"
            data-testid="builder-palette-close"
            onClick={onClose}
            className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm shrink-0 text-ink-muted hover:text-ink"
          >
            <Icon name="close" />
          </button>
        ) : null}
      </div>
      <span className="relative">
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-muted"
        />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search steps"
          data-testid="builder-palette-search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search steps"
          className="ds-input pl-9 text-sm"
        />
      </span>
      {sections.length === 0 ? <p className="text-sm text-ink-muted">Nothing matches.</p> : null}
      {sections.map((s) => (
        <section key={s.key} data-testid={`builder-palette-${s.key}`}>
          <h3 className="eyebrow mb-2 text-ink-muted">{s.label}</h3>
          {s.groups ? (
            <div className="flex flex-col gap-1">
              {s.groups.map((g) => (
                <details
                  key={g.key}
                  data-testid={`builder-palette-${s.key}-${g.key}`}
                  open={searching || undefined}
                  className="rounded-md border border-line bg-surface"
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-2 text-sm font-medium text-ink">
                    {g.label}
                    <span className="text-xs font-normal text-ink-muted figures">
                      {g.items.length}
                    </span>
                  </summary>
                  <ul className="flex flex-col gap-2 border-t border-line p-2">
                    {g.items.map((item) => (
                      <PaletteCard key={item.key} item={item} onAdd={onAdd} target={target} />
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          ) : s.items.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {s.key === "skills" ? "No skills yet." : "None yet."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {s.items.map((item) => (
                <PaletteCard key={item.key} item={item} onAdd={onAdd} target={target} />
              ))}
            </ul>
          )}
        </section>
      ))}
      {footer}
    </div>
  );
}

const ITEM_KIND: Partial<Record<PaletteItem["type"], string>> = {
  read: "Read",
  write: "Write",
  // Skill model (2026-11-10): an action is a write too.
  action: "Write",
};

function PaletteCard({
  item,
  onAdd,
  target,
}: {
  item: PaletteItem;
  onAdd(item: PaletteItem): void;
  target: string;
}) {
  const data: DragData = { type: "palette", item };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${item.key}`,
    data,
  });
  const own = item.type === "skill" && item.own;
  // Skill model (2026-11-10): a skill says its kind, Deterministic or AI; a read or a write whose
  // tool calls a model inside (web search, translate) says AI too, never passing as plain code.
  const kind =
    item.type === "skill" && item.kind
      ? SKILL_KIND_LABEL[item.kind]
      : (item.type === "read" || item.type === "write") && toolUsesModel(item.tool)
        ? `${ITEM_KIND[item.type]} · ${SKILL_KIND_LABEL.ai}`
        : ITEM_KIND[item.type];
  return (
    <li
      ref={setNodeRef}
      data-testid={`builder-palette-item-${item.key}`}
      className={cx(
        "flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2",
        isDragging && "opacity-40",
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="flex min-w-0 flex-1 cursor-grab touch-none items-start gap-2"
      >
        <span aria-hidden className="pt-0.5 text-ink-muted">
          <Icon name="more" className="rotate-90" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium [overflow-wrap:anywhere] text-ink">
            <span>{item.title}</span>
            {kind ? <Tag testId={`builder-palette-item-${item.key}-kind`}>{kind}</Tag> : null}
          </span>
          <span className="line-clamp-2 text-xs text-ink-muted" title={item.detail}>
            {own ? "This agent's · " : ""}
            {item.detail}
          </span>
        </span>
      </div>
      <button
        type="button"
        aria-label={
          item.type === "trigger" ? `Start with ${item.title}` : `Add ${item.title} ${target}`
        }
        data-testid={`builder-palette-item-${item.key}-add`}
        onClick={() => onAdd(item)}
        className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm shrink-0 text-ink-muted hover:text-ink"
      >
        <Icon name="add" />
      </button>
    </li>
  );
}

/** What the drag overlay shows while something is being dragged. */
export function DragCard({ title, kind }: { title: string; kind: string }): ReactNode {
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
