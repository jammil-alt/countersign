// Check the steps' screen parts (docs/builder-plan.md §12.5 F5; design: docs/design/builder.html
// `stepsHTML`, `rowsHTML`, `pathHTML`), shared by the v4 body (./CheckSteps) and the step model's
// (./CheckSteps5): the header, How it starts, a line, a loop's block, a decision's block and the
// buttons at the foot. They take what they show as plain views (`LineView`, `PathView`), so both
// models look and behave the same (owner, 2026-11-25: same screens, only the model underneath).

import type { AgentSummary, BuildDetail, Trigger } from "@countersign/core";
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode, useEffect, useState } from "react";
import { apiRoutes } from "../../api/routes";
import type { useApiClient } from "../../api/useApi";
import { Field, Select, TextInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Badge, Button, cx, StepKindTag } from "../../ui/primitives";
import type { NewId } from "../builder/model";
import { OPS_PATHS } from "../paths";
import { triggerTitle } from "../workflow/describe";
import {
  END_KINDS,
  ENDS,
  type EndKind,
  START_KINDS,
  STARTS,
  type StartKind,
  startKindOf,
  startKinds,
  startTitle,
  startWordsAll,
  TRIGGERS_MAX,
  toggleStart,
} from "./checkModel";
import { type DescribeAgainState, type DescribeKind, FlowStepper } from "./DescribeScreen";

// ── Views ────────────────────────────────────────────────────────────────────────────────────────

/** A line as the list shows it. */
export interface LineView {
  id: string;
  name: string;
  /** Typed here and not filled yet (v4 `missing`, v5 "Not built yet"). */
  typed: boolean;
  /** Its kind as a tag, for a line that isn't typed. */
  tag: { kind: string; label: string } | null;
  /** Collect reports' reports, under its line. */
  reports?: string[] | undefined;
}

/** A path of a decision as its block shows it. */
export interface PathView {
  key: string;
  container: string;
  /** The path's id; null for the otherwise. */
  pathId: string | null;
  condition: string;
  otherwise: boolean;
  /** Its lines, without the step that ends it. */
  lines: LineView[];
  ends: boolean;
  /** Shown under a path that ends here (v5: what its End delivers). */
  endSlot?: ReactNode;
}

export interface LineEvents {
  rename(id: string, words: string): void;
  /** Leaving a line typed with "If …": it becomes a decision. */
  commit(id: string): void;
  remove(id: string): void;
  /** Enter: a line typed with "If …" becomes a decision; any other adds the next line. */
  enter(id: string, container: string, index: number): void;
  /** Added here, not drafted. */
  isNew(id: string): boolean;
  /** Shown under a line (v5: matching a typed line to what it uses). */
  extra?: ((line: LineView) => ReactNode) | undefined;
}

// ── Small words ──────────────────────────────────────────────────────────────────────────────────

export const CSS_ESCAPE = (s: string) =>
  typeof globalThis.CSS?.escape === "function" ? globalThis.CSS.escape(s) : s;

/** “A”, “A” and “B”, or “A”, “B” and 2 more: step names in a sentence. */
export function quoted(names: readonly string[]): string {
  const q = names.slice(0, 2).map((n) => `“${n.trim() || "a step with no name"}”`);
  if (names.length > 2) return `${q.join(", ")} and ${names.length - 2} more`;
  return q.join(" and ");
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Puts the caret in the line or condition `focus` names once it is on the page. */
export function useFocusLine(): [string | null, (id: string | null) => void] {
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    const el = document.querySelector<HTMLInputElement>(`[data-line="${CSS_ESCAPE(focus)}"]`);
    if (el) {
      el.focus();
      setFocus(null);
    }
  }, [focus]);
  return [focus, setFocus];
}

// ── The header ───────────────────────────────────────────────────────────────────────────────────

export function CheckHeader({
  mine,
  counts,
  words,
  onEdit,
}: {
  mine: boolean;
  counts: { steps: number; decisions: number };
  words: string;
  onEdit(): void;
}) {
  return (
    <>
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
          <Button variant="link" size="sm" onClick={onEdit} data-testid="flow-check-edit">
            Edit the description
          </Button>
        </div>
      ) : null}
    </>
  );
}

// ── How it starts ────────────────────────────────────────────────────────────────────────────────

/**
 * How it starts, over anything with triggers (a v4 process, a v5 workflow: the triggers are the
 * same). The cards toggle triggers; "In your words" follows the first way in until it is written.
 */
export function useStart<P extends { triggers: Trigger[] }>(
  process: P,
  setProcess: (p: P) => void,
  mine: boolean,
  newId: NewId | undefined,
) {
  const trigger = process.triggers[0];
  const [words, setWords] = useState(() => (trigger ? (mine ? "" : triggerTitle(trigger)) : ""));
  const [edited, setEdited] = useState(false);
  // Why a card didn't change, in words, until the next one does.
  const [refused, setRefused] = useState<"last" | "full" | null>(null);
  const now = trigger ? startKindOf(trigger.on) : null;

  const toggle = (k: StartKind) => {
    const out = toggleStart(process, k, newId);
    setRefused(out.refused ?? null);
    if (out.refused) return;
    setProcess(out.process);
    const first = out.process.triggers[0];
    const kindNow = first ? startKindOf(first.on) : null;
    if (!edited && first?.id !== trigger?.id) {
      setWords(kindNow ? startTitle(kindNow) : first ? triggerTitle(first) : "");
    }
  };

  const section = (
    <section className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5">
      <h2 className="text-lg font-medium text-ink">How it starts</h2>
      <p className="ds-help text-sm">
        Pick every way it can start. Each one you turn on is a trigger of its own.
      </p>
      <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="How it starts">
        {START_KINDS.map((k) => {
          const on = startKinds(process).includes(k);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              data-testid={`flow-check-start-${k}`}
              onClick={() => toggle(k)}
              className={cx(
                "flex flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm",
                on
                  ? "border-slate bg-slate-tint text-ink"
                  : "border-line text-ink hover:border-line-strong",
              )}
            >
              <span className="flex items-center justify-between gap-2 font-medium">
                {STARTS[k].title}
                {on ? <Icon name="check" size={14} className="shrink-0 text-slate" /> : null}
              </span>
              <span className="text-xs text-ink-muted">{STARTS[k].hint}</span>
            </button>
          );
        })}
      </fieldset>
      {refused ? (
        <p className="text-sm text-ink-muted" role="status" data-testid="flow-check-start-refused">
          {refused === "last"
            ? "It needs at least one way to start, so the last one stays on."
            : `A workflow starts at most ${TRIGGERS_MAX} ways. Turn one off first.`}
        </p>
      ) : null}
      {process.triggers.length > 1 ? (
        <p className="text-sm text-ink-muted" data-testid="flow-check-starts">
          It starts {process.triggers.length} ways: {startWordsAll(process.triggers).join("; ")}.
        </p>
      ) : null}
      <Field label={process.triggers.length > 1 ? "The first, in your words" : "In your words"}>
        <TextInput
          value={words}
          onChange={(e) => {
            setWords(e.target.value);
            setEdited(true);
          }}
          placeholder="When a vendor invoice arrives by email"
          maxLength={300}
          data-testid="flow-check-start-words"
        />
      </Field>
    </section>
  );

  return {
    section,
    words,
    edited,
    /** The first way in's words: the operator's, else the card's. */
    said: words.trim() || (now ? startTitle(now) : ""),
  };
}

// ── Lines ────────────────────────────────────────────────────────────────────────────────────────

/** One top-level line: its handle to drag, its number, then the line or the decision. */
export function TopLine({
  id,
  name,
  number,
  children,
}: {
  id: string;
  name: string;
  number: number;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx("flex items-start gap-2", isDragging && "opacity-60")}
      data-testid="flow-check-line"
      data-step-id={id}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move ${name || `step ${number}`}`}
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

/** A step's line: its words, its kind as a tag, and remove; what the host adds under it. */
export function LineInput({
  line,
  container,
  index,
  label,
  events,
}: {
  line: LineView;
  container: string;
  index: number;
  label: string;
  events: LineEvents;
}) {
  const extra = events.extra?.(line);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <TextInput
          value={line.name}
          aria-label={label}
          placeholder="What happens next"
          data-line={line.id}
          data-testid="flow-check-line-input"
          className="min-w-0 flex-1"
          onChange={(e) => events.rename(line.id, e.target.value)}
          onBlur={() => {
            if (line.typed) events.commit(line.id);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            events.enter(line.id, container, index);
          }}
        />
        <span data-testid="flow-check-line-kind" className="max-w-[16rem] shrink-0 truncate">
          {line.typed ? (
            <Badge tone="warning">
              {events.isNew(line.id) ? "The Builder fills it" : "Missing"}
            </Badge>
          ) : line.tag ? (
            <StepKindTag kind={line.tag.kind} label={line.tag.label} />
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ds-btn--icon shrink-0"
          aria-label={`Remove ${line.name || "this step"}`}
          onClick={() => events.remove(line.id)}
          data-testid="flow-check-line-remove"
        >
          <Icon name="close" size={14} />
        </Button>
      </div>
      {extra}
      {line.reports ? <CollectReports reports={line.reports} /> : null}
    </div>
  );
}

// Owner (2026-11-24, "they really don't match"): a For each's or a repeat's own steps were not on
// this list, so the work it does per item couldn't be checked. They show under it, numbered 8.1,
// 8.2…, each editable, with a step added inside; a step nested deeper shows by name.
/** A loop (For each, repeat): its own line, then the steps it runs for each item or pass. */
export function LoopBlock({
  line,
  each,
  inner,
  number,
  index,
  events,
  onAddStep,
}: {
  line: LineView;
  /** For each item, or each time round. */
  each: boolean;
  inner: LineView[];
  number: number;
  index: number;
  events: LineEvents;
  onAddStep(container: string, index: number): void;
}) {
  const container = `loop:${line.id}`;
  return (
    <div className="flex flex-col gap-2" data-testid="flow-check-loop">
      <LineInput
        line={line}
        container="root"
        index={index}
        label={`Step ${number}`}
        events={events}
      />
      <div className="ml-2 flex flex-col gap-2 border-l border-line pl-4">
        <span className="text-xs text-ink-muted">
          {each ? "For each item, it does:" : "Each time round, it does:"}
        </span>
        {inner.length > 0 ? (
          <ol className="flex flex-col gap-2" data-testid="flow-check-loop-lines">
            {inner.map((s, j) => (
              <li key={s.id} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-right text-xs text-ink-muted figures">
                  {number}.{j + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <LineInput
                    line={s}
                    container={container}
                    index={j}
                    label={`Step ${number}.${j + 1}`}
                    events={events}
                  />
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        <div>
          <Button
            variant="link"
            size="sm"
            onClick={() => onAddStep(container, inner.length)}
            data-testid="flow-check-loop-add-step"
          >
            + Step inside
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Collect reports: the reports it waits for and who sends each, under its line. */
function CollectReports({ reports }: { reports: readonly string[] }) {
  return (
    <ul
      className="mt-2 ml-2 flex flex-col gap-1 border-l border-line pl-4 text-sm text-ink-muted"
      data-testid="flow-check-collect"
    >
      {reports.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: reports in their order, read only.
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

const letter = (i: number) => String.fromCharCode(65 + (i % 26));

/** A decision: If / Or if / Otherwise, each path's lines, how each path ends, and after them. */
export function DecisionBlock({
  paths,
  after,
  below,
  events,
  onRemove,
  onCondition,
  onAddPath,
  onRemovePath,
  onAddStep,
  onEnd,
  onAfter,
  onMoveBelow,
}: {
  paths: PathView[];
  after: "together" | "apart" | "mixed";
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
  /** The path's steps become the lines right after the decision. */
  onMoveBelow(container: string): void;
}) {
  const conditions = paths.filter((p) => !p.otherwise).length;
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
        const tag = p.otherwise ? "" : letter(i);
        const shown = p.lines;
        const ends = p.ends;
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
                  value={p.condition}
                  aria-label="Condition"
                  placeholder={i === 0 ? "a line doesn't match" : "another case"}
                  data-line={`cond:${p.pathId ?? ""}`}
                  data-testid="flow-check-condition"
                  className="min-w-0 flex-1"
                  onChange={(e) => p.pathId && onCondition(p.pathId, e.target.value)}
                />
                {conditions > 1 && p.pathId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ds-btn--icon shrink-0"
                    aria-label="Remove this path"
                    onClick={() => p.pathId && onRemovePath(p.pathId)}
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
                    <span className="w-6 shrink-0 self-start pt-2.5 text-right text-xs text-ink-muted figures">
                      {tag}
                      {j + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <LineInput
                        line={s}
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
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => onAddStep(p.container, shown.length)}
                  data-testid="flow-check-path-add-step"
                >
                  + Step on this path
                </Button>
                {/* The rest of the process drafted into the otherwise: out of the decision in one move. */}
                {p.otherwise && !ends && shown.length > 0 ? (
                  <Button
                    variant="link"
                    size="sm"
                    title="They run after the decision, whichever path was taken."
                    onClick={() => onMoveBelow(p.container)}
                    data-testid="flow-check-path-move-below"
                  >
                    Move these below the decision
                  </Button>
                ) : null}
              </span>
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
            {ends && p.endSlot ? p.endSlot : null}
            {p.otherwise ? null : i === conditions - 1 ? (
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

// ── The foot ─────────────────────────────────────────────────────────────────────────────────────

export function CheckFoot({
  busy,
  disabled,
  mine,
  onBuild,
  onBack,
  onQuestions,
  onBlank,
}: {
  busy: "build" | "fill" | null;
  disabled: boolean;
  mine: boolean;
  onBuild(): void;
  onBack(): void;
  onQuestions(): void;
  onBlank(): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {busy ? (
        <span className="text-sm text-ink-muted" role="status" data-testid="flow-check-building">
          {busy === "fill" ? "Filling the steps you added" : "Building it"}
        </span>
      ) : (
        <>
          <Button
            variant="primary"
            disabled={disabled}
            onClick={onBuild}
            data-testid="flow-check-build"
          >
            Build it
          </Button>
          <Button variant="ghost" onClick={onBack} data-testid="flow-check-back">
            Back to the description
          </Button>
          {mine ? (
            // DECISION (F5): with no draft yet there is no canvas to open, and making an agent
            // apart from the build would leave the build without its draft: today's build page
            // (its questions) is the other way in.
            <Button variant="ghost" onClick={onQuestions} data-testid="flow-check-questions">
              Start with the Builder's questions
            </Button>
          ) : (
            <Button variant="ghost" onClick={onBlank} data-testid="flow-check-blank">
              Start with a blank canvas
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** "Then what happens"'s heading and help. */
export function LinesHelp() {
  return (
    <>
      <h2 className="text-lg font-medium text-ink">Then what happens</h2>
      <p className="ds-help text-sm">
        One step a line, in order. Enter adds the next one. Start a line with "If" and it becomes a
        decision. Each path has its own steps. Paths can come back together, or go separate ways and
        never meet.
      </p>
    </>
  );
}

/** The Step and Decision buttons under the lines. */
export function AddButtons({ onStep, onDecision }: { onStep(): void; onDecision(): void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={onStep} data-testid="flow-check-add-step">
        <Icon name="add" size={14} />
        Step
      </Button>
      <Button size="sm" onClick={onDecision} data-testid="flow-check-add-decision">
        <Icon name="add" size={14} />
        Decision
      </Button>
    </div>
  );
}

// ── Shared by both bodies ────────────────────────────────────────────────────────────────────────

export interface AgentData {
  agent: AgentSummary;
  latest: { id: string; bundle: unknown } | null;
}

export interface CheckBodyProps {
  detail: BuildDetail;
  agent: AgentData | null;
  words: string;
  newId: NewId | undefined;
}

/** Where the operator goes back to describe it again, with their words. */
export function describeAgain(detail: BuildDetail, words: string, mine: boolean) {
  const kind: DescribeKind = detail.build.client ? "client" : "template";
  return {
    to: OPS_PATHS.labNew(kind),
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
  };
}

/** The four ways out as cards; clicking one that is on takes it back. */
export function EndCards({
  on,
  onPick,
  onRemove,
}: {
  on: readonly EndKind[];
  onPick(kind: EndKind): void;
  onRemove(kind: EndKind): void;
}) {
  return (
    <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="How it ends">
      {END_KINDS.map((k) => {
        const pressed = on.includes(k);
        return (
          <button
            key={k}
            type="button"
            aria-pressed={pressed}
            data-testid={`flow-check-end-${k}`}
            title={pressed ? "Click again to take it back" : undefined}
            onClick={() => (pressed ? onRemove(k) : onPick(k))}
            className={cx(
              "flex flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm",
              pressed
                ? "border-slate bg-slate-tint text-ink"
                : "border-line text-ink hover:border-line-strong",
            )}
          >
            <span className="font-medium">{ENDS[k].title}</span>
            <span className="text-xs text-ink-muted">{ENDS[k].hint}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

export function useCheckSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * Asks the Builder once to fill what was added by hand, from version `from`, and saves what it
 * made. When it fails the lines stay as they are ("Not built yet") and the chart shows them.
 */
export async function askBuilderToFill(
  api: ReturnType<typeof useApiClient>,
  agentId: string,
  from: string,
  text: string,
): Promise<void> {
  try {
    const started = await api.call(apiRoutes.opsStartBuilderSession, {
      body: { kind: "agent", agentId, fromVersionId: from },
    });
    const session = started.session.id;
    await api.call(apiRoutes.opsBuilderTurn, { params: { id: session }, body: { text } });
    await api.call(apiRoutes.opsBuilderSave, {
      params: { id: session },
      body: { changeNote: "Filled the steps added by hand" },
    });
  } catch {
    // Carry on to the chart: what is still missing is its issues.
  }
}
