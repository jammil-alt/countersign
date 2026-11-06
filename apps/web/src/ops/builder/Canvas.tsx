// The builder's centre and left columns (prototype `#O6-Builder`): the trigger on a tinted card,
// numbered step cards with drag handles and their kind tag on the right (and, while steps are being
// selected for an automation, a check box), forks as side-by-side paths with "Drop a step here"
// and "Paths join here", for-each blocks, and the "Add a step" palette whose items drag into the
// list or append with +. Drag and drop is @dnd-kit (docs/plan.md §1.2 "Builder"): every list is a
// sortable context keyed by its container, so a step moves within its list, into and out of fork
// paths and for-each blocks, with the pointer or the keyboard (Space, arrows, Space).

import {
  type ForEachStep,
  type ForkStep,
  isClientVisible,
  type Step,
  type ValidationError,
  type Workflow,
} from "@countersign/core";
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
import type { ReactNode } from "react";
import { Icon } from "../../ui/icons";
import { Badge, cx, StepKindTag, Tag } from "../../ui/primitives";
import {
  KIND_LABEL,
  rulesText,
  stepDetail,
  stepNames,
  triggerDetail,
  triggerTitle,
} from "../workflow/describe";
import type { PaletteSection } from "./catalog";
import {
  type ApprovalEnv,
  approvalOption,
  type ContainerId,
  getContainer,
  type PaletteItem,
  ROOT,
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
 * of that list. A trigger from the palette replaces how the workflow starts.
 */
export function resolveDrop(
  workflow: Workflow,
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
            index: getContainer(workflow, over.container)?.length ?? 0,
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

// ── Canvas ───────────────────────────────────────────────────────────────────────────────────────

export interface CanvasProps {
  workflow: Workflow;
  selectedId: string | null;
  env: ApprovalEnv;
  errors: readonly ValidationError[];
  customized: ReadonlyMap<string, "added" | "changed">;
  activeId: string | null;
  overId: string | null;
  onSelect(id: string | "trigger"): void;
  onDelete(id: string): void;
  /** Top-level steps picked for "Save as automation"; check boxes show while this is set. */
  checked?: ReadonlySet<string> | undefined;
  onCheck?: ((id: string, on: boolean) => void) | undefined;
}

/** Errors on a step, counting a fork's paths as the fork's. */
function errorCount(step: Step, errors: readonly ValidationError[]): number {
  const ids = new Set([step.id]);
  if (step.kind === "fork") {
    for (const p of step.paths) ids.add(p.id);
    ids.add(step.otherwise.id);
  }
  return errors.filter((e) => e.stepId !== null && ids.has(e.stepId)).length;
}

export function Canvas(props: CanvasProps) {
  const { workflow } = props;
  const triggerErrors = props.errors.filter((e) => e.stepId === workflow.trigger.id).length;
  return (
    <div data-testid="builder-canvas" className="flex flex-col items-center">
      <TriggerCard {...props} invalid={triggerErrors} />
      <List {...props} id={ROOT} steps={workflow.steps} numbered />
      <span aria-hidden className="h-4 border-l border-line-strong" />
      <DropZone
        id={ROOT}
        label="Drop a step here, or press + in the palette"
        className="w-full max-w-[640px]"
      />
    </div>
  );
}

function TriggerCard(props: CanvasProps & { invalid: number }) {
  const { workflow, selectedId, onSelect, invalid } = props;
  const selected = selectedId === "trigger";
  return (
    <div
      data-testid="builder-trigger"
      className={cx(
        "flex w-full max-w-[640px] items-center gap-3 rounded-md border bg-slate-tint px-4 py-3",
        selected ? "border-slate" : "border-line",
      )}
    >
      <Icon name="arrow" className="shrink-0 text-slate" />
      <button
        type="button"
        data-testid="builder-trigger-select"
        onClick={() => onSelect("trigger")}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block font-medium text-ink">{triggerTitle(workflow.trigger)}</span>
        <span className="block truncate text-sm text-ink-muted">
          {triggerDetail(workflow.trigger)}
        </span>
      </button>
      {invalid > 0 ? (
        <Badge tone="risk" testId="builder-trigger-invalid">
          Invalid
        </Badge>
      ) : null}
      <StepKindTag kind="trigger" label={KIND_LABEL.trigger} />
    </div>
  );
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
                className={cx("border-l border-line-strong", numbered ? "h-6" : "h-3")}
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
  return (
    <>
      <StepCard {...props} />
      {step.kind === "fork" ? <Fork {...props} step={step} /> : null}
      {step.kind === "for_each" ? <Loop {...props} step={step} /> : null}
    </>
  );
}

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
  const invalid = errorCount(step, errors);
  const approval = approvalOption(step, env);
  const hidden =
    !isClientVisible(step) &&
    (step.kind === "skill" ||
      step.kind === "action" ||
      step.kind === "person" ||
      step.kind === "notify");
  const custom = customized.get(step.id);
  const isOver = props.overId === step.id && props.activeId !== step.id;
  const selected = selectedId === step.id;
  const testId = `builder-step-${step.id}`;
  const nested = number === undefined;
  const kindTag = <StepKindTag kind={step.kind} label={KIND_LABEL[step.kind]} />;
  const hasBadges = invalid > 0 || approval !== null || hidden || Boolean(custom);
  const badges = (
    <>
      {invalid > 0 ? (
        <Badge tone="risk" testId={`${testId}-invalid`}>
          Invalid
        </Badge>
      ) : null}
      {approval ? (
        // Approval is a person's sign-off (copper); a step the operator let run on its own is the
        // team's work (accent).
        <Badge tone={approval.automatic ? "accent" : "person"} testId={`${testId}-approval`}>
          {approval.automatic ? "Runs automatically" : "Approval"}
        </Badge>
      ) : null}
      {hidden ? <Badge testId={`${testId}-hidden`}>Hidden</Badge> : null}
      {custom ? (
        <Badge tone="accent" testId={`${testId}-customized`}>
          {custom === "added" ? "Added here" : "Customized"}
        </Badge>
      ) : null}
    </>
  );
  return (
    <div
      ref={setNodeRef}
      data-dnd-node=""
      data-testid={testId}
      data-container={container}
      className={cx(
        "relative flex w-full items-center gap-3 rounded-md border bg-surface",
        nested ? "px-3 py-2.5" : "max-w-[640px] px-4 py-3",
        selected ? "border-slate" : invalid ? "border-risk" : "border-line",
        isDragging && "opacity-40",
      )}
    >
      {isOver ? (
        <span aria-hidden className="absolute -top-2 right-2 left-2 h-0.5 rounded-sm bg-slate" />
      ) : null}
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move ${step.name || KIND_LABEL[step.kind]}`}
        data-testid={`${testId}-handle`}
        className="flex w-4 cursor-grab touch-none justify-center text-ink-muted hover:text-ink"
      >
        <Icon name="more" className="rotate-90" />
      </button>
      {number !== undefined && props.checked && props.onCheck ? (
        <input
          type="checkbox"
          aria-label={`Select ${step.name || KIND_LABEL[step.kind]}`}
          data-testid={`${testId}-check`}
          className="size-4 shrink-0 accent-slate"
          checked={props.checked.has(step.id)}
          onChange={(e) => props.onCheck?.(step.id, e.target.checked)}
        />
      ) : null}
      {number !== undefined ? (
        <span
          data-testid={`${testId}-number`}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-line text-xs text-ink-muted figures"
        >
          {number}
        </span>
      ) : null}
      <button
        type="button"
        data-testid={`${testId}-select`}
        onClick={() => props.onSelect(step.id)}
        className="min-w-0 flex-1 text-left"
      >
        {nested ? (
          // In a fork path or loop the card is narrow: the tag and badges go above the name, as
          // in the design's "PERSON / Ask Jammil" card, so the name keeps the width.
          <span className="mb-1 flex flex-wrap items-center gap-1">
            {kindTag}
            {badges}
          </span>
        ) : null}
        <span className="block truncate font-medium text-ink">
          {step.name || KIND_LABEL[step.kind]}
        </span>
        <span className="block truncate text-sm text-ink-muted">{stepDetail(step)}</span>
        {!nested && hasBadges ? (
          // Under the name, never beside it: three badges beside it left the name "Upd…".
          <span className="mt-1.5 flex flex-wrap items-center gap-1">{badges}</span>
        ) : null}
      </button>
      {nested ? null : <span className="shrink-0 self-start pt-0.5">{kindTag}</span>}
      <button
        type="button"
        aria-label={`Delete ${step.name || KIND_LABEL[step.kind]}`}
        data-testid={`${testId}-delete`}
        onClick={() => props.onDelete(step.id)}
        className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink"
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

/** "Drop a step here": the end of a list, and the only target in an empty one. */
function DropZone({
  id,
  label = "Drop a step here",
  className,
}: {
  id: ContainerId;
  label?: string;
  className?: string;
}) {
  const data: DragData = { type: "container", container: id };
  const { setNodeRef, isOver } = useDroppable({ id: `drop:${id}`, data });
  return (
    <div
      ref={setNodeRef}
      data-dnd-node=""
      data-testid={`builder-drop-${id}`}
      className={cx(
        "rounded-sm border border-dashed px-3 py-2.5 text-center text-sm",
        isOver ? "border-slate bg-slate-tint text-slate" : "border-line-strong text-ink-muted",
        className,
      )}
    >
      {label}
    </div>
  );
}

function Branch(props: CanvasProps & { id: ContainerId; steps: Step[] }) {
  return (
    <div className="flex flex-col gap-3">
      {props.steps.length > 0 ? <List {...props} numbered={false} /> : null}
      <DropZone id={props.id} />
    </div>
  );
}

function Fork(props: CanvasProps & { step: ForkStep }) {
  const { step } = props;
  const columns = step.paths.length + 1;
  const names = stepNames(props.workflow);
  return (
    <div data-testid={`builder-fork-${step.id}`} className="flex w-full flex-col items-center">
      <span aria-hidden className="h-4 border-l border-line-strong" />
      <div
        className="grid w-full gap-3 rounded-lg border border-dashed border-line-strong p-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {step.paths.map((path, i) => (
          <section
            key={path.id}
            data-testid={`builder-fork-${step.id}-path-${path.id}`}
            aria-label={`Path ${i + 1}: ${path.name}`}
            className="flex flex-col gap-2 rounded-md border border-line bg-surface-subtle p-3"
          >
            <div>
              <h3 className="font-medium text-ink">{path.name}</h3>
              <p className="reference break-words text-ink-muted">
                if {rulesText(path.when, names)}
              </p>
            </div>
            <Branch {...props} id={`path:${path.id}`} steps={path.steps} />
          </section>
        ))}
        <section
          data-testid={`builder-fork-${step.id}-otherwise`}
          aria-label="Otherwise"
          className="flex flex-col gap-2 rounded-md border border-line bg-surface-subtle p-3"
        >
          <div>
            <h3 className="font-medium text-ink">Otherwise</h3>
            <p className="text-sm text-ink-muted">None of the above</p>
          </div>
          <Branch {...props} id={`otherwise:${step.otherwise.id}`} steps={step.otherwise.steps} />
        </section>
      </div>
      <p className="eyebrow mt-2 text-ink-muted">Paths join here</p>
    </div>
  );
}

function Loop(props: CanvasProps & { step: ForEachStep }) {
  const { step } = props;
  return (
    <div
      data-testid={`builder-loop-${step.id}`}
      className="flex w-full max-w-[640px] flex-col items-center"
    >
      <span aria-hidden className="h-4 border-l border-line-strong" />
      <div className="flex w-full flex-col gap-2 rounded-lg border border-dashed border-line-strong p-3">
        <p className="text-sm text-ink-muted">each item · up to {step.concurrency} at once</p>
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
}: {
  sections: PaletteSection[];
  search: string;
  onSearch(value: string): void;
  onAdd(item: PaletteItem): void;
}) {
  return (
    <div data-testid="builder-palette" className="flex flex-col gap-4">
      <div>
        <h2 className="type-subheading text-ink">Add a step</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Drag onto the workflow or into a fork path, or press + to add at the end.
        </p>
      </div>
      <span className="relative">
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-muted"
        />
        <input
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
          {s.items.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {s.key === "skills" ? "No skills yet." : "None yet."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {s.items.map((item) => (
                <PaletteCard key={item.key} item={item} onAdd={onAdd} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function PaletteCard({ item, onAdd }: { item: PaletteItem; onAdd(item: PaletteItem): void }) {
  const data: DragData = { type: "palette", item };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${item.key}`,
    data,
  });
  const own = item.type === "skill" && item.own;
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
          <span className="block text-sm font-medium [overflow-wrap:anywhere] text-ink">
            {item.title}
          </span>
          <span className="block text-xs text-ink-muted">
            {item.detail}
            {own ? " · this agent's" : ""}
          </span>
        </span>
      </div>
      <button
        type="button"
        aria-label={
          item.type === "trigger" ? `Start with ${item.title}` : `Add ${item.title} at the end`
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
