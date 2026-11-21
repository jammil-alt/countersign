// The step's side panel on the one-screen builder (docs/builder-plan.md §12.3: "the inspector
// becomes the step's side panel with the Builder underneath"). From the top: what kind of step and
// where it sits, its name, what is left to settle on it (issues red, questions gold, settled ones
// with Change), what the Builder decided for it, where it comes after and goes to, its setup (the
// inspector's fields, passed in), then the Builder on this step, folded to one line or in one of
// three sizes, and Remove.
// Props only: the host owns the process, the build's routes and the Builder session.
import { type ReactNode, useEffect, useState } from "react";
import { Icon } from "../../ui/icons";
import { Badge, Button, cx } from "../../ui/primitives";
import { isOpen, openItems, type SettleEntry, TRY_WORD } from "./status";
import type { DecidedNote, SettleItem, StepStatus } from "./types";

/**
 * How much of the panel the Builder takes: folded to its one line ("line"), half beside the
 * setup, or all of it.
 */
// DECISION (owner, 2026-11-21: "allow it to be collapsed into a single line… the buttons take 4
// lines", then "let's go to a collapse, half and full… find icons to make this not the tabs, make
// it smaller"): the Builder's head is one line. Its name folds and opens it; two small icons choose
// half or the whole panel; the previous and next step are beside them. The box-only size is gone:
// it had no room for an answer. Folded, the setup has the whole panel and what was typed is kept.
export type BuilderSize = "line" | "beside" | "max";
/** A size the Builder is drawn at: every one but folded. */
export type BuilderOpenSize = Exclude<BuilderSize, "line">;

const SIZES: { size: BuilderOpenSize; label: string }[] = [
  { size: "beside", label: "Half the panel: the setup above, the Builder below" },
  { size: "max", label: "The whole panel" },
];

/** How much of a panel, as a picture: a frame with its lower half, or all of it, filled. */
function SizeGlyph({ size }: { size: BuilderOpenSize }) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <rect x={2.5} y={2.5} width={11} height={11} rx={2} fill="none" stroke="currentColor" />
      <rect
        x={2.5}
        y={size === "max" ? 2.5 : 8}
        width={11}
        height={size === "max" ? 11 : 5.5}
        rx={size === "max" ? 2 : 0}
        fill="currentColor"
      />
    </svg>
  );
}

const HEAD_BUTTON =
  "ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink disabled:opacity-40";

export interface StepPanelProps {
  stepId: string;
  /** The step's kind in a word, for the eyebrow: "Decision", "Skill", "Starts when". */
  kind: string;
  /** Where it sits in its own list: step `n` of `of`. Absent for a trigger. */
  place?: { n: number; of: number } | null | undefined;
  title: string;
  /** Makes the title an input; each change is the host's (one undo per typing run). */
  onRename?: ((name: string) => void) | undefined;
  /** The line it came from in the operator's list ("From your list: …"). */
  from?: string | null | undefined;
  status?: StepStatus | undefined;
  /** How an open item is settled here (its answers, Fix, Draft it): the host's buttons. */
  itemActions?: ((item: SettleItem) => ReactNode) | undefined;
  /** Change on a settled item: opens it again. */
  onChangeItem?: ((item: SettleItem) => void) | undefined;
  /** Change on a default the Builder chose. */
  onChangeDecided?: ((note: DecidedNote) => void) | undefined;
  /** The next step with something open, offered once nothing is left on this one. */
  next?: { id: string; name: string } | null | undefined;
  onNext?: ((id: string) => void) | undefined;
  /** "Comes after" and "Goes to": today's ConnectionsSection. */
  connections?: ReactNode;
  /** The step's setup: the inspector with `layout="panel"`. */
  children?: ReactNode;
  /** The Builder on this step (today's StepChat), or a function of the size it is given. */
  builder?: ReactNode | ((size: BuilderOpenSize) => ReactNode);
  /** Controlled size; uncontrolled from `defaultBuilderSize` when absent. */
  builderSize?: BuilderSize | undefined;
  defaultBuilderSize?: BuilderSize | undefined;
  onBuilderSize?: ((size: BuilderSize) => void) | undefined;
  /** The step before and after this one, from the Builder's head; absent at the first or last. */
  onPreviousStep?: (() => void) | undefined;
  onNextStep?: (() => void) | undefined;
  /** "Remove this step" (or "Remove this decision" with `removeLabel`). Absent: not offered. */
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
  onClose(): void;
}

export function StepPanel(props: StepPanelProps) {
  const { status } = props;
  const [ownSize, setOwnSize] = useState<BuilderSize>(props.defaultBuilderSize ?? "beside");
  const size = props.builderSize ?? ownSize;
  const setSize = (s: BuilderSize) => {
    setOwnSize(s);
    props.onBuilderSize?.(s);
  };
  // Folded, the Builder stays mounted at the size it opens back to, so its words are kept.
  const [lastOpen, setLastOpen] = useState<BuilderOpenSize>(size === "line" ? "beside" : size);
  if (size !== "line" && size !== lastOpen) setLastOpen(size);
  const folded = size === "line";
  const openSize: BuilderOpenSize = size === "line" ? lastOpen : size;
  const builder = typeof props.builder === "function" ? props.builder(openSize) : props.builder;
  const hasBuilder = props.builder !== undefined && props.builder !== null;
  const showBody = !hasBuilder || size !== "max";

  return (
    <aside
      aria-label="Step setup"
      data-testid="flow-panel"
      data-step={props.stepId}
      data-builder-size={hasBuilder ? size : undefined}
      className="flex h-full min-h-0 flex-col border-l border-line bg-surface"
    >
      <Header {...props} />
      {showBody ? (
        <div
          data-testid="flow-panel-body"
          className={cx(
            // Positioned: a field hidden for screen readers only (position absolute) then scrolls
            // with the panel and is clipped by it, where it would otherwise lengthen the page.
            "relative flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4",
            hasBuilder && size === "beside" ? "flex-1 basis-1/2" : "flex-1",
          )}
        >
          {status?.tried ? <Tried status={status} /> : null}
          <Settle {...props} />
          <Decided {...props} />
          {props.connections ? (
            <section className="flex flex-col gap-3" data-testid="flow-panel-connections">
              {props.connections}
            </section>
          ) : null}
          {props.children ? (
            <section className="flex flex-col gap-4" data-testid="flow-panel-setup">
              {props.children}
            </section>
          ) : null}
          {props.onRemove ? (
            <div className="border-t border-line pt-4">
              <Button
                variant="ghost"
                size="sm"
                className="text-risk-ink"
                data-testid="flow-panel-remove"
                onClick={props.onRemove}
              >
                {props.removeLabel ?? "Remove this step"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {hasBuilder ? (
        <section
          aria-label="The Builder on this step"
          data-testid="flow-panel-builder"
          className={cx(
            "flex min-h-0 flex-col border-t border-line px-5",
            folded ? "shrink-0 py-1" : "gap-2 pt-1 pb-3",
            size === "beside" && "flex-1 basis-1/2",
            size === "max" && "flex-1",
          )}
        >
          <div className="flex h-8 shrink-0 items-center justify-between gap-2">
            <button
              type="button"
              aria-expanded={!folded}
              title={folded ? "Open the Builder" : "Fold the Builder to this line"}
              data-testid="flow-panel-builder-fold"
              onClick={() => setSize(folded ? lastOpen : "line")}
              className="eyebrow -ml-1 flex min-w-0 items-center gap-1 rounded-sm px-1 py-1 whitespace-nowrap text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-slate"
            >
              <Icon name={folded ? "chevron-right" : "chevron-down"} size={14} />
              Builder
            </button>
            {folded ? null : (
              <span className="flex shrink-0 items-center gap-0.5">
                {props.onPreviousStep || props.onNextStep ? (
                  <>
                    <button
                      type="button"
                      className={HEAD_BUTTON}
                      aria-label="Previous step"
                      title="Previous step"
                      data-testid="flow-panel-builder-previous"
                      disabled={!props.onPreviousStep}
                      onClick={() => props.onPreviousStep?.()}
                    >
                      <Icon name="chevron-right" size={14} className="rotate-180" />
                    </button>
                    <button
                      type="button"
                      className={HEAD_BUTTON}
                      aria-label="Next step"
                      title="Next step"
                      data-testid="flow-panel-builder-next"
                      disabled={!props.onNextStep}
                      onClick={() => props.onNextStep?.()}
                    >
                      <Icon name="chevron-right" size={14} />
                    </button>
                    <span aria-hidden className="mx-1 h-4 w-px bg-line" />
                  </>
                ) : null}
                {SIZES.map((s) => (
                  <button
                    key={s.size}
                    type="button"
                    className={cx(HEAD_BUTTON, size === s.size && "bg-surface-subtle text-ink")}
                    aria-label={s.label}
                    title={s.label}
                    aria-pressed={size === s.size}
                    data-testid={`flow-panel-builder-${s.size}`}
                    onClick={() => setSize(s.size)}
                  >
                    <SizeGlyph size={s.size} />
                  </button>
                ))}
              </span>
            )}
          </div>
          {/* The Builder lays itself out in what is left: its conversation scrolls, nothing else. */}
          <div className={cx("flex min-h-0 min-w-0 flex-1 flex-col", folded && "hidden")}>
            {builder}
          </div>
        </section>
      ) : null}
    </aside>
  );
}

function Header(props: StepPanelProps) {
  const { status } = props;
  // Typing keeps its own text, so the caret stays put while the host's name catches up.
  const [name, setName] = useState(props.title);
  useEffect(() => setName(props.title), [props.title]);
  const eyebrow = [props.kind, props.place ? `step ${props.place.n} of ${props.place.of}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-col gap-1 border-b border-line px-5 pt-4 pb-3">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow text-ink-muted" data-testid="flow-panel-eyebrow">
          {eyebrow}
        </span>
        <span className="flex items-center gap-2">
          {status?.customized ? (
            <Badge tone="accent" testId="flow-panel-customized">
              {status.customized === "added" ? "Added for this client" : "Changed for this client"}
            </Badge>
          ) : null}
          <button
            type="button"
            aria-label="Close"
            title="Close"
            data-testid="flow-panel-close"
            onClick={props.onClose}
            className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink"
          >
            <Icon name="close" />
          </button>
        </span>
      </div>
      {props.onRename ? (
        <input
          aria-label="Step name"
          data-testid="flow-panel-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            props.onRename?.(e.target.value);
          }}
          className="-mx-1 rounded-sm border border-transparent bg-transparent px-1 text-lg font-medium text-ink hover:border-line focus:border-line-strong focus:outline-none"
        />
      ) : (
        <h2 className="text-lg font-medium text-ink" data-testid="flow-panel-title">
          {props.title}
        </h2>
      )}
      {props.from ? (
        <p className="text-sm text-ink-muted" data-testid="flow-panel-from">
          From your list: “{props.from}”
        </p>
      ) : null}
    </div>
  );
}

function Tried({ status }: { status: StepStatus }) {
  const t = status.tried;
  if (!t) return null;
  const w = TRY_WORD[t.status];
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-subtle p-3"
      data-testid="flow-panel-tried"
    >
      <span className="eyebrow text-ink-muted">In the last try</span>
      <span className="flex items-baseline gap-2 text-sm text-ink">
        <Badge tone={w.tone}>{w.word}</Badge>
        {t.summary ? <span>{t.summary}</span> : null}
      </span>
    </div>
  );
}

function Settle(props: StepPanelProps) {
  const items = (props.status?.items ?? []) as SettleEntry[];
  if (items.length === 0) return null;
  const open = openItems(props.status);
  const risk = open.some((i) => i.level === "issue");
  // Open ones first, issues before questions; settled ones after.
  const shown: SettleEntry[] = [...open, ...items.filter((i) => !isOpen(i))];
  return (
    <section
      data-testid="flow-panel-settle"
      data-tone={risk ? "issue" : open.length ? "question" : "done"}
      className={cx(
        "flex flex-col gap-3 rounded-md border p-3",
        risk
          ? "border-risk-line bg-risk-tint"
          : open.length
            ? "border-line bg-signal-tint"
            : "border-line bg-surface-subtle",
      )}
    >
      <span className="eyebrow text-ink-muted">
        {open.length ? "To settle on this step" : "Settled on this step"}
      </span>
      {shown.map((item) =>
        isOpen(item) ? (
          <div
            key={item.key}
            className="flex flex-col gap-1.5"
            data-testid={`flow-panel-item-${item.key}`}
          >
            <span>
              <Badge tone={item.level === "issue" ? "risk" : "warning"}>
                {item.level === "issue" ? "Issue" : "Question"}
              </Badge>
            </span>
            <span className={cx("text-sm", item.level === "issue" ? "text-risk-ink" : "text-ink")}>
              {item.title}
            </span>
            {item.detail ? <span className="text-sm text-ink-muted">{item.detail}</span> : null}
            {props.itemActions ? (
              <div className="flex flex-wrap gap-2">{props.itemActions(item)}</div>
            ) : null}
          </div>
        ) : (
          <div
            key={item.key}
            className="flex items-baseline justify-between gap-3 text-sm"
            data-testid={`flow-panel-item-${item.key}`}
          >
            <span className="flex min-w-0 items-baseline gap-1.5 text-ink">
              <Icon name="check" className="self-center text-positive" />
              <span>
                {item.title} <span className="font-medium">{item.settled}</span>
              </span>
            </span>
            {props.onChangeItem ? (
              <button
                type="button"
                className="ds-btn ds-btn--link shrink-0"
                data-testid={`flow-panel-item-${item.key}-change`}
                onClick={() => props.onChangeItem?.(item)}
              >
                Change
              </button>
            ) : null}
          </div>
        ),
      )}
      {open.length === 0 && props.next && props.next.id !== props.stepId && props.onNext ? (
        <div>
          <Button
            size="sm"
            data-testid="flow-panel-next"
            onClick={() => props.next && props.onNext?.(props.next.id)}
          >
            Next: “{props.next.name}”
            <Icon name="arrow" />
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function Decided(props: StepPanelProps) {
  const notes = props.status?.decided ?? [];
  if (notes.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2.5 rounded-md border border-line p-3"
      data-testid="flow-panel-decided"
    >
      <span className="eyebrow text-ink-muted">Decided for you</span>
      {notes.map((d) => (
        <div
          key={d.key}
          className="flex flex-col gap-0.5"
          data-testid={`flow-panel-decided-${d.key}`}
        >
          <span className="flex items-baseline justify-between gap-3 text-sm text-ink">
            <span className="flex items-baseline gap-2">
              {d.what}
              {d.risk === "high" ? <Badge tone="warning">High risk</Badge> : null}
            </span>
            {props.onChangeDecided ? (
              <button
                type="button"
                className="ds-btn ds-btn--link shrink-0"
                data-testid={`flow-panel-decided-${d.key}-change`}
                onClick={() => props.onChangeDecided?.(d)}
              >
                Change
              </button>
            ) : null}
          </span>
          {d.why ? <span className="text-xs text-ink-muted">{d.why}</span> : null}
        </div>
      ))}
    </section>
  );
}
