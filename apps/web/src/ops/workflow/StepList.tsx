// A read-only rendering of a workflow as the builder lays it out (docs/design/screens/
// 5-workflow-builder.png): the trigger and top-level steps numbered top to bottom, a fork's ordered
// paths side by side with "otherwise" last, and the paths joining after the fork. The drag-and-drop
// builder (ARCHITECTURE §10.5) replaces this view later and keeps its look.
// R8 (ARCHITECTURE §10.14): a v4 process too: its triggers (the first numbered, the others "or"),
// its steps in the builder's words (an `if` laid out as a fork), and each step's checks in a line
// each under its name ("Approval: client admin, then Dana, in turn · 2 days").
import type { processes, Rules, Trigger, Step as V3Step, Workflow } from "@countersign/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { cx, StepKindTag, Tag } from "../../ui/primitives";
import { checksLines } from "./checks";
import {
  KIND_LABEL,
  processKindLabel,
  processStepDetail,
  processStepNames,
  rulesText,
  type StepLabels,
  type StepNames,
  stepDetail,
  stepNames,
  stepSkillKindLabel,
  triggerDetail,
  triggerTitle,
} from "./describe";
import { forkGridColumns, forkMinWidth, stepMinWidth } from "./layout";

/** A v3 step or a v4 one. */
type Step = V3Step | processes.Step;
/** A v3 fork or a v4 if: paths side by side, otherwise last. */
interface Branching {
  id: string;
  kind: "fork" | "if";
  paths: { id: string; name: string; when: Rules; steps: Step[] }[];
  otherwise: { id: string; steps: Step[] };
}
interface Loop {
  id: string;
  kind: "for_each";
  concurrency: number;
  steps: Step[];
}

function isBranching(step: Step): step is Step & Branching {
  return step.kind === "fork" || step.kind === "if";
}

/** The workflow or process the list shows. */
type Shown = Workflow | processes.Process;

/** Which schema the list is showing, so nested steps read in its words. */
const IsProcess = createContext(false);

/** A step's kind in a word, its second line and its checks, v3 or v4. */
function stepWords(
  step: Step,
  v4: boolean,
  labels: StepLabels = {},
): { kind: string; detail: string | null; checks: string[]; skillKind?: string | null } {
  if (v4) {
    const s = step as processes.Step;
    // Skill model (2026-11-10): a write by where it writes, a skill step with its kind.
    return {
      kind: processKindLabel(s, labels),
      detail: processStepDetail(s, labels),
      checks: checksLines(s.checks),
      skillKind: stepSkillKindLabel(s, labels),
    };
  }
  const s = step as V3Step;
  return { kind: KIND_LABEL[s.kind], detail: stepDetail(s), checks: [] };
}

function triggersOf(w: Shown): Trigger[] {
  return w.schemaVersion === 4 ? w.triggers : [w.trigger];
}

/** The workflow's step names, for fork rules that cite an earlier step's output. */
const Names = createContext<StepNames | undefined>(undefined);

/**
 * What a screen adds to a step's card (the merge view's "added / changed / moved" per side and
 * its conflicts): badges under the name, and an outline for steps that wait on a decision.
 */
export interface StepMark {
  badges?: ReactNode;
  attention?: boolean;
}
const Marks = createContext<((id: string) => StepMark | undefined) | undefined>(undefined);
/** Skill model (2026-11-10): names and kinds from a catalog, when the screen has one. */
const Labels = createContext<StepLabels>({});

export function StepList({
  workflow,
  marks,
  labels = {},
}: {
  workflow: Shown;
  /** By step, fork path or trigger id. */
  marks?: (id: string) => StepMark | undefined;
  /** Names, skill kinds and write labels from a catalog, when the screen has one. */
  labels?: StepLabels;
}) {
  const names = useMemo(
    () => (workflow.schemaVersion === 4 ? processStepNames(workflow) : stepNames(workflow)),
    [workflow],
  );
  return (
    <IsProcess.Provider value={workflow.schemaVersion === 4}>
      <Names.Provider value={names}>
        <Marks.Provider value={marks}>
          <Labels.Provider value={labels}>
            <StepListItems workflow={workflow} />
          </Labels.Provider>
        </Marks.Provider>
      </Names.Provider>
    </IsProcess.Provider>
  );
}

function MarkBadges({ id }: { id: string }) {
  const mark = useContext(Marks)?.(id);
  return mark?.badges ? (
    <div className="mt-1 flex flex-wrap gap-1" data-testid={`step-${id}-marks`}>
      {mark.badges}
    </div>
  ) : null;
}

function StepListItems({ workflow }: { workflow: Shown }) {
  const steps: readonly Step[] = workflow.steps;
  // A fork wider than the list scrolls sideways in its own box, never the page.
  return (
    <div className="min-w-0">
      <ol data-testid="step-list" className="flex flex-col items-center">
        {triggersOf(workflow).map((trigger, i) => (
          <Item key={trigger.id} connector={i > 0}>
            {i > 0 ? <span className="eyebrow mb-1 text-ink-muted">or</span> : null}
            <StepCard
              testId={`step-${trigger.id}`}
              {...(i === 0 ? { number: 1 } : {})}
              kind={KIND_LABEL.trigger}
              kindId="trigger"
              title={triggerTitle(trigger)}
              detail={triggerDetail(trigger)}
            />
          </Item>
        ))}
        {steps.map((step, i) => (
          <Item key={step.id} connector>
            <StepNode step={step} number={i + 2} />
          </Item>
        ))}
      </ol>
    </div>
  );
}

function Item({ children, connector }: { children: ReactNode; connector?: boolean }) {
  return (
    <li className="flex w-full flex-col items-center">
      {connector ? <span aria-hidden className="h-6 border-l border-line-strong" /> : null}
      {children}
    </li>
  );
}

function StepNode({ step, number }: { step: Step; number?: number }) {
  const words = stepWords(step, useContext(IsProcess), useContext(Labels));
  const card = (
    <StepCard
      testId={`step-${step.id}`}
      number={number}
      kind={words.kind}
      skillKind={words.skillKind ?? null}
      kindId={step.kind}
      title={step.name}
      detail={words.detail}
      checks={words.checks}
    />
  );
  const inner = isBranching(step) ? (
    <Fork step={step} />
  ) : step.kind === "for_each" ? (
    <LoopBlock step={step as Step & Loop} />
  ) : null;
  if (!inner) return card;
  return (
    <>
      {card}
      <div
        data-testid={`step-${step.id}-scroll`}
        className="flex w-full justify-center-safe overflow-x-auto pb-1"
      >
        {inner}
      </div>
    </>
  );
}

function StepCard({
  number,
  kind,
  title,
  detail,
  kindId,
  testId,
  compact,
  checks,
  skillKind,
}: {
  number?: number | undefined;
  kind: string;
  /** Skill model (2026-11-10): a skill step's kind, "Deterministic" or "AI". */
  skillKind?: string | null;
  title: string;
  detail: string | null;
  /** R8: a v4 step's checks, one line each. */
  checks?: readonly string[];
  /** The step's kind id ("person"), for its tag's colour. */
  kindId: string;
  testId: string;
  compact?: boolean;
}) {
  const id = testId.slice("step-".length);
  const attention = useContext(Marks)?.(id)?.attention;
  return (
    <div
      data-testid={testId}
      className={cx(
        "flex w-full items-center gap-3 rounded-md border bg-surface",
        attention ? "border-signal" : "border-line",
        compact ? "px-3 py-2.5" : "max-w-[480px] px-4 py-3.5",
      )}
    >
      {number !== undefined ? (
        <span
          data-testid={`${testId}-number`}
          className="w-5 text-right text-sm text-ink-muted figures"
        >
          {number}
        </span>
      ) : null}
      <span className="flex shrink-0 flex-col items-start gap-1">
        <StepKindTag kind={kindId} label={kind} />
        {skillKind ? <Tag testId={`${testId}-skill-kind`}>{skillKind}</Tag> : null}
      </span>
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        {detail ? <p className="truncate text-sm text-ink-muted">{detail}</p> : null}
        {checks && checks.length > 0 ? (
          <ul className="text-sm text-ink-muted" data-testid={`${testId}-checks`}>
            {checks.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <MarkBadges id={id} />
      </div>
    </div>
  );
}

function Branch({ steps }: { steps: Step[] }) {
  if (steps.length === 0) {
    return (
      <p className="rounded-sm border border-dashed border-line-strong px-3 py-3 text-center text-sm text-ink-muted">
        Nothing · continue
      </p>
    );
  }
  return (
    <ol className="flex flex-col items-stretch">
      {steps.map((s, i) => (
        <li key={s.id} className="flex flex-col items-center">
          {i > 0 ? <span aria-hidden className="h-4 border-l border-line-strong" /> : null}
          <NestedNode step={s} />
        </li>
      ))}
    </ol>
  );
}

/** Steps inside a path or loop carry no number, as in the design. */
function NestedNode({ step }: { step: Step }) {
  const words = stepWords(step, useContext(IsProcess), useContext(Labels));
  return (
    <div className="flex w-full flex-col items-center">
      <StepCard
        compact
        testId={`step-${step.id}`}
        kind={words.kind}
        skillKind={words.skillKind ?? null}
        kindId={step.kind}
        title={step.name}
        detail={words.detail}
        checks={words.checks}
      />
      {isBranching(step) ? <Fork step={step} /> : null}
      {step.kind === "for_each" ? <LoopBlock step={step as Step & Loop} /> : null}
    </div>
  );
}

function Fork({ step }: { step: Branching }) {
  const names = useContext(Names);
  return (
    <div
      data-testid={`fork-${step.id}`}
      className="flex w-full flex-col items-center"
      style={{ minWidth: forkMinWidth(step) }}
    >
      <span aria-hidden className="h-4 border-l border-line-strong" />
      <div
        className="grid w-full gap-3 rounded-lg border border-dashed border-line-strong p-3"
        style={{ gridTemplateColumns: forkGridColumns(step) }}
      >
        {step.paths.map((path, i) => (
          <section
            key={path.id}
            data-testid={`fork-${step.id}-path-${path.id}`}
            aria-label={`Path ${i + 1}: ${path.name}`}
            className="rounded-md border border-line bg-surface-subtle p-3"
          >
            <h3 className="font-medium text-ink">{path.name}</h3>
            <MarkBadges id={path.id} />
            <p className="mb-3 reference break-words text-ink-muted">
              if {rulesText(path.when, names)}
            </p>
            <Branch steps={path.steps} />
          </section>
        ))}
        <section
          data-testid={`fork-${step.id}-otherwise`}
          aria-label="Otherwise"
          className="rounded-md border border-line bg-surface-subtle p-3"
        >
          <h3 className="font-medium text-ink">Otherwise</h3>
          <p className="mb-3 text-sm text-ink-muted">None of the above</p>
          <Branch steps={step.otherwise.steps} />
        </section>
      </div>
      <p className="eyebrow mt-2 text-ink-muted">Paths join here</p>
    </div>
  );
}

function LoopBlock({ step }: { step: Loop }) {
  return (
    <div
      data-testid={`loop-${step.id}`}
      className="flex w-full max-w-[560px] flex-col items-center"
      style={{ minWidth: stepMinWidth(step) }}
    >
      <span aria-hidden className="h-4 border-l border-line-strong" />
      <div className="w-full rounded-lg border border-dashed border-line-strong p-3">
        <p className="mb-3 text-sm text-ink-muted">each item · up to {step.concurrency} at once</p>
        <Branch steps={step.steps} />
      </div>
    </div>
  );
}
