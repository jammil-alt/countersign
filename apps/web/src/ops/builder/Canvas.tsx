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
//
// Process flow (owner, 2026-11-12; design canvas boards D and E): one line down the middle. A fork
// (an if) lists its paths on its card, each with a letter (A, B, C… otherwise last), then splits
// into a column per path joined by a bar; a path's steps are numbered by its letter (A1, A2), a
// path that ends with a stop says so, and the paths that carry on meet a bar back to the line.
// Three zoom levels drop detail rather than shrink text: Detail (everything, for editing), Steps
// (titles only, 80%) and Map (shapes only, 50%). Zoomed out, nothing moves; a click on a step
// zooms back in on it.

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
import { brief } from "../../ui/brief";
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

/** How far out the canvas is: everything, titles only, or shapes only. */
export type ZoomLevel = "detail" | "steps" | "map";

export const ZOOM_LEVELS: readonly { level: ZoomLevel; label: string; scale: number }[] = [
  { level: "map", label: "Map", scale: 0.5 },
  { level: "steps", label: "Steps", scale: 0.8 },
  { level: "detail", label: "Detail", scale: 1 },
];

const ZOOM_KEY = "mezonas.builder.zoom";

/** The zoom level, remembered in this browser (a convenience: Detail when unknown). */
function useZoom(): [ZoomLevel, (z: ZoomLevel) => void] {
  const [zoom, setZoom] = useState<ZoomLevel>(() => {
    try {
      const saved = window.localStorage.getItem(ZOOM_KEY);
      return ZOOM_LEVELS.some((z) => z.level === saved) ? (saved as ZoomLevel) : "detail";
    } catch {
      return "detail";
    }
  });
  const choose = (z: ZoomLevel) => {
    setZoom(z);
    try {
      window.localStorage.setItem(ZOOM_KEY, z);
    } catch {
      // Storage blocked: the level lasts for this visit.
    }
  };
  return [zoom, choose];
}

/** A fork path's letter: A, B, … Z, then AA, AB. */
export function pathLetter(index: number): string {
  const n = Math.floor(index / 26);
  return (n > 0 ? pathLetter(n - 1) : "") + String.fromCharCode(65 + (index % 26));
}

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
  /** Set by the canvas: how far out it is. */
  zoom?: ZoomLevel | undefined;
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
  const [zoom, setZoom] = useZoom();
  // A step clicked while zoomed out: zoom back in, then bring it into view.
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId || zoom !== "detail") return;
    const key = focusId.startsWith("trigger:")
      ? `builder-trigger-${focusId.slice("trigger:".length)}`
      : `builder-step-${focusId}`;
    document
      .querySelector(`[data-testid="${key}"]`)
      ?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setFocusId(null);
  }, [focusId, zoom]);
  // A scroll moves the cards out from under a fixed tooltip: hide it.
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tip]);
  const shown = props.activeId ? null : tip;
  const inner: CanvasProps = {
    ...props,
    onTip: setTip,
    zoom,
    onSelect: (id) => {
      if (zoom !== "detail") {
        setTip(null);
        setZoom("detail");
        setFocusId(id);
      }
      props.onSelect(id);
    },
  };
  const scale = ZOOM_LEVELS.find((z) => z.level === zoom)?.scale ?? 1;
  // The triggers and the top-level steps always fit the canvas; an if wider than it scrolls
  // sideways in its own box (each path keeping a readable width, workflow/layout.ts), never the
  // page.
  return (
    <div data-testid="builder-canvas" data-zoom={zoom} className="flex min-w-0 flex-col">
      <ZoomControl zoom={zoom} onZoom={setZoom} />
      {/* CSS zoom lays the canvas out smaller (a transform would leave its full size behind). */}
      <div
        className="flex min-w-0 flex-col items-center"
        style={scale === 1 ? undefined : { zoom: scale }}
      >
        <TriggerCard {...inner} />
        <List {...inner} id={ROOT} steps={workflow.steps} numbered />
        {zoom === "detail" ? (
          <>
            <span aria-hidden className="h-3 border-l border-line-strong" />
            <DropZone
              id={ROOT}
              label="Drop a step here, or"
              className="w-full max-w-[360px]"
              onAdd={props.onAddAt}
              active={props.addTarget === ROOT}
            />
          </>
        ) : (
          <EndDot zoom={zoom} />
        )}
      </div>
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

/** − and +, and the three levels: Map, Steps, Detail. */
function ZoomControl({ zoom, onZoom }: { zoom: ZoomLevel; onZoom(z: ZoomLevel): void }) {
  const at = ZOOM_LEVELS.findIndex((z) => z.level === zoom);
  const out = ZOOM_LEVELS[at - 1];
  const inward = ZOOM_LEVELS[at + 1];
  return (
    <fieldset
      data-testid="builder-zoom"
      className="m-0 mb-3 flex items-center gap-1 self-end rounded-md border border-line bg-surface p-0.5"
    >
      <legend className="sr-only">Zoom</legend>
      <button
        type="button"
        aria-label="Zoom out"
        data-testid="builder-zoom-out"
        disabled={!out}
        onClick={() => out && onZoom(out.level)}
        className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink disabled:text-ink-faint"
      >
        <span aria-hidden className="text-base leading-none">
          −
        </span>
      </button>
      <div className="ds-seg">
        {ZOOM_LEVELS.map((z) => (
          <button
            key={z.level}
            type="button"
            aria-pressed={zoom === z.level}
            data-testid={`builder-zoom-${z.level}`}
            title={
              z.level === "map"
                ? "The whole workflow, as shapes"
                : z.level === "steps"
                  ? "Step titles only"
                  : "Everything, for editing"
            }
            onClick={() => onZoom(z.level)}
          >
            {z.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="Zoom in"
        data-testid="builder-zoom-in"
        disabled={!inward}
        onClick={() => inward && onZoom(inward.level)}
        className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink disabled:text-ink-faint"
      >
        <span aria-hidden className="text-base leading-none">
          +
        </span>
      </button>
    </fieldset>
  );
}

/** Zoomed out, the line ends on a "Done" dot. */
function EndDot({ zoom }: { zoom: ZoomLevel }) {
  return (
    <>
      <span aria-hidden className="h-3 border-l border-line-strong" />
      <span
        aria-hidden
        className={cx("rounded-full bg-positive", zoom === "map" ? "size-5" : "size-3")}
      />
    </>
  );
}

/** A path's letter in its slate circle. */
function Letter({ letter, size = "md" }: { letter: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden
      className={cx(
        "flex shrink-0 items-center justify-center rounded-full bg-slate font-medium text-on-slate figures",
        size === "sm" && "size-4 text-[10px]",
        size === "md" && "size-5 text-xs",
        size === "lg" && "size-10 text-xl",
      )}
    >
      {letter}
    </span>
  );
}

/** The process's triggers, one row each: any of them starts a run. */
function TriggerCard(props: CanvasProps) {
  const { workflow, selectedId, onSelect, errors } = props;
  const anySelected = workflow.triggers.some((t) => selectedId === triggerKey(t.id));
  if (props.zoom === "map") {
    const first = workflow.triggers[0];
    return (
      <div data-testid="builder-trigger" className="flex w-full max-w-[360px] flex-col">
        {first ? (
          <button
            type="button"
            data-testid={`builder-trigger-${first.id}-select`}
            aria-label={`Trigger: ${triggerTitle(first)}`}
            title={triggerTitle(first)}
            onClick={() => onSelect(triggerKey(first.id))}
            className="h-8 w-full rounded-md border border-slate bg-slate-tint"
          />
        ) : null}
      </div>
    );
  }
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

function List(
  props: CanvasProps & {
    id: ContainerId;
    steps: Step[];
    numbered?: boolean;
    /** In a fork path: its letter, numbering the steps A1, A2. */
    prefix?: string | undefined;
  },
) {
  const { id, steps, numbered, prefix } = props;
  return (
    <SortableContext id={id} items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
      <ol
        data-testid={`builder-list-${id}`}
        className={cx("flex w-full flex-col items-center", !numbered && "items-stretch")}
      >
        {steps.map((step, index) => (
          <li key={step.id} className="flex w-full flex-col items-center">
            {numbered || index > 0 ? (
              <span aria-hidden className="h-3 border-l border-line-strong" />
            ) : null}
            <StepNode
              {...props}
              step={step}
              container={id}
              index={index}
              number={numbered ? index + 1 : undefined}
              pathNumber={prefix ? `${prefix}${index + 1}` : undefined}
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
    pathNumber?: string | undefined;
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
    pathNumber?: string | undefined;
  },
) {
  const { step, container, index, number, selectedId, env, errors, customized } = props;
  const zoom = props.zoom ?? "detail";
  const data: DragData = { type: "step", container, index };
  // Zoomed out the canvas is for looking: steps move only at Detail.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
    id: step.id,
    data,
    disabled: zoom !== "detail",
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
  const fork = step.kind === "if";
  if (zoom === "map") {
    // Shapes only: a fork is a diamond, a person copper, a change to a client's tool solid slate.
    const shape = fork
      ? "size-7 rotate-45 rounded-sm border-[3px] border-ink bg-surface"
      : step.kind === "stop"
        ? "size-6 border-[3px] border-dashed border-line-strong"
        : cx(
            // At most a card's width, in a path too: the map shows shape, not width.
            "h-8 w-full max-w-[360px] rounded-md border",
            people
              ? "border-copper bg-copper-tint"
              : step.kind === "write"
                ? "border-slate bg-slate"
                : "border-line-strong bg-surface",
          );
    return (
      <div
        ref={(el) => {
          setNodeRef(el);
          card.current = el;
        }}
        data-testid={testId}
        data-container={container}
        data-selected={selected ? "true" : undefined}
        onPointerEnter={showTip}
        onPointerLeave={hideTip}
        className={cx("flex w-full justify-center", fork && "py-1.5")}
      >
        <button
          type="button"
          data-testid={`${testId}-select`}
          aria-label={`${label}: ${name}`}
          aria-current={selected ? "true" : undefined}
          onClick={() => props.onSelect(step.id)}
          onFocus={showTip}
          onBlur={hideTip}
          className={cx(
            shape,
            invalid > 0 && "border-risk",
            selected && "outline outline-[3px] outline-offset-2 outline-slate",
          )}
        />
      </div>
    );
  }
  const detailed = zoom === "detail";
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
        "relative flex w-full flex-wrap items-center gap-2 rounded-md py-1.5 pr-2 pl-1",
        // A fork stands out on the line: a heavier ink border.
        fork ? "border-2" : "border",
        number === undefined ? "" : "max-w-[360px]",
        selected
          ? SELECTED
          : invalid
            ? "border-risk bg-surface"
            : fork
              ? "border-ink bg-surface"
              : "border-line bg-surface",
        isDragging && "opacity-40",
      )}
    >
      {isOver ? (
        <span aria-hidden className="absolute -top-1.5 right-2 left-2 h-0.5 rounded-sm bg-slate" />
      ) : null}
      {detailed ? (
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
      ) : (
        <span aria-hidden className="w-1 shrink-0" />
      )}
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
      ) : props.pathNumber ? (
        <span
          data-testid={`${testId}-path-number`}
          className="shrink-0 text-center text-xs text-ink-muted figures"
        >
          {props.pathNumber}
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
      <span className={cx("flex shrink-0 items-center gap-1", !detailed && "hidden")}>
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
      {step.kind === "if" ? <ForkPaths step={step} testId={testId} /> : null}
    </div>
  );
}

/** On a fork's card: its paths by letter, so you see the choices before the lines split. */
function ForkPaths({ step, testId }: { step: Extract<Step, { kind: "if" }>; testId: string }) {
  const names = [
    ...step.paths.map((p) => ({ id: p.id, name: p.name })),
    { id: step.otherwise.id, name: "Otherwise" },
  ];
  return (
    <ol
      data-testid={`${testId}-paths`}
      aria-label={`${names.length} paths`}
      className="flex basis-full flex-col gap-1 pb-0.5 pl-7"
    >
      {names.map((n, i) => (
        <li key={n.id} className="flex min-w-0 items-center gap-1.5 text-xs text-ink">
          <Letter letter={pathLetter(i)} size="sm" />
          <span className="truncate">{n.name}</span>
        </li>
      ))}
    </ol>
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

function Branch(
  props: CanvasProps & { id: ContainerId; steps: Step[]; prefix?: string | undefined },
) {
  return (
    <div className="flex flex-col gap-1.5">
      {props.steps.length > 0 ? <List {...props} numbered={false} /> : null}
      {(props.zoom ?? "detail") === "detail" ? (
        <DropZone id={props.id} onAdd={props.onAddAt} active={props.addTarget === props.id} />
      ) : null}
    </div>
  );
}

/**
 * Each column's share of a bar from `from` to `to`, measured in columns (0 is the left edge, a
 * column's line is at i + 0.5): its left and right insets, or null where the bar doesn't reach.
 */
// DECISION: the bars assume equal columns, which the grid gives whenever the fork is wider than
// its paths' least widths; squeezed to those, a bar can miss a line by a few pixels.
export function barShares(
  n: number,
  from: number,
  to: number,
): ({ left: string; right: string } | null)[] {
  return Array.from({ length: n }, (_, i) => {
    const start = Math.max(from, i);
    const end = Math.min(to, i + 1);
    if (end <= start) return null;
    return { left: `${(start - i) * 100}%`, right: `${(i + 1 - end) * 100}%` };
  });
}

/** Whether a path ends rather than rejoining the line: its last step stops the run. */
function pathEnds(steps: readonly Step[]): boolean {
  return steps.at(-1)?.kind === "stop";
}

/**
 * A fork as a process flow: a bar splits the line into a column per path (its letter, name and
 * condition, then its steps numbered A1, A2), and a bar under the paths that carry on joins them
 * back to the line. A path that stops ends on its own marker. Each column draws its share of both
 * bars, so columns of any width meet.
 */
function IfBlock(props: CanvasProps & { step: Extract<Step, { kind: "if" }> }) {
  const { step } = props;
  const zoom = props.zoom ?? "detail";
  const names = processStepNames(props.workflow);
  const columns = [
    ...step.paths.map((path) => ({
      key: path.id,
      testId: `builder-fork-${step.id}-path-${path.id}`,
      container: `path:${path.id}`,
      name: path.name,
      when: `if ${rulesText(path.when, names)}`,
      steps: path.steps,
    })),
    {
      key: step.otherwise.id,
      testId: `builder-fork-${step.id}-otherwise`,
      container: `otherwise:${step.otherwise.id}`,
      name: "Otherwise",
      when: "None of the above",
      steps: step.otherwise.steps,
    },
  ];
  const n = columns.length;
  const joining = columns.flatMap((c, i) => (pathEnds(c.steps) ? [] : [i]));
  const allEnd = joining.length === 0;
  // The split runs from the first path's line to the last's; the join from the first path that
  // carries on to the last, and always through the middle, where the line goes on.
  const split = barShares(n, 0.5, n - 0.5);
  const join = allEnd
    ? []
    : barShares(
        n,
        Math.min((joining[0] ?? 0) + 0.5, n / 2),
        Math.max((joining.at(-1) ?? 0) + 0.5, n / 2),
      );
  return (
    <div
      data-testid={`builder-fork-${step.id}`}
      className="flex w-full flex-col items-center"
      style={{ minWidth: forkMinWidth(step) }}
    >
      <span aria-hidden className="h-3 border-l border-line-strong" />
      <div className="grid w-full" style={{ gridTemplateColumns: forkGridColumns(step) }}>
        {columns.map((c, i) => {
          const letter = pathLetter(i);
          const ends = pathEnds(c.steps);
          return (
            <section
              key={c.key}
              data-testid={c.testId}
              aria-label={`Path ${letter}: ${c.name}`}
              className="relative flex min-w-0 flex-col items-center px-2"
            >
              {split[i] ? (
                <span
                  aria-hidden
                  className="absolute top-0 border-t border-line-strong"
                  style={split[i]}
                />
              ) : null}
              <span aria-hidden className="h-3 border-l border-line-strong" />
              {zoom === "map" ? (
                <Letter letter={letter} size="lg" />
              ) : (
                <div className="flex max-w-full flex-col items-center gap-0.5 text-center">
                  <h3 className="flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pr-2.5 pl-0.5 text-sm font-medium text-ink">
                    <Letter letter={letter} />
                    <span className="truncate">{c.name}</span>
                  </h3>
                  {zoom === "detail" ? (
                    <p className="max-w-full truncate text-xs text-ink-muted" title={c.when}>
                      {c.when}
                    </p>
                  ) : null}
                </div>
              )}
              <span aria-hidden className="h-3 border-l border-line-strong" />
              <div className="w-full">
                <Branch {...props} id={c.container} steps={c.steps} prefix={letter} />
              </div>
              {ends && zoom === "map" ? (
                <span aria-hidden className="min-h-3 flex-1" />
              ) : ends ? (
                <>
                  <span aria-hidden className="h-3 border-l border-line-strong" />
                  <span
                    data-testid={`${c.testId}-ends`}
                    className="flex items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 py-0.5 text-xs text-ink-muted"
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-[2px] border-2 border-ink-muted"
                    />
                    Ends here
                  </span>
                  <span aria-hidden className="min-h-3 flex-1" />
                </>
              ) : (
                <span aria-hidden className="min-h-3 flex-1 border-l border-line-strong" />
              )}
              {join[i] ? (
                <span
                  aria-hidden
                  className="absolute bottom-0 border-t border-line-strong"
                  style={join[i]}
                />
              ) : null}
            </section>
          );
        })}
      </div>
      {allEnd || zoom === "map" ? null : (
        <p className="eyebrow mt-1.5 text-ink-muted">Paths join here</p>
      )}
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
            {/* Plain words (2026-11-12): the headline here, the whole text on hover and in the inspector. */}
            {brief(item.detail, 90)}
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
