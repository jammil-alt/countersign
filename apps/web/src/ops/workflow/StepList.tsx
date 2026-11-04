// A read-only rendering of a workflow as the builder lays it out (docs/design/screens/
// 5-workflow-builder.png): the trigger and top-level steps numbered top to bottom, a fork's ordered
// paths side by side with "otherwise" last, and the paths joining after the fork. The drag-and-drop
// builder (ARCHITECTURE §10.5) replaces this view later and keeps its look.
import type { ForEachStep, ForkStep, Step, Workflow } from "@countersign/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { cx, StepKindTag } from "../../ui/primitives";
import {
  KIND_LABEL,
  rulesText,
  type StepNames,
  stepDetail,
  stepNames,
  triggerDetail,
  triggerTitle,
} from "./describe";

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

export function StepList({
  workflow,
  marks,
}: {
  workflow: Workflow;
  /** By step, fork path or trigger id. */
  marks?: (id: string) => StepMark | undefined;
}) {
  const names = useMemo(() => stepNames(workflow), [workflow]);
  return (
    <Names.Provider value={names}>
      <Marks.Provider value={marks}>
        <StepListItems workflow={workflow} />
      </Marks.Provider>
    </Names.Provider>
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

function StepListItems({ workflow }: { workflow: Workflow }) {
  return (
    <ol data-testid="step-list" className="flex flex-col items-center">
      <Item>
        <StepCard
          testId={`step-${workflow.trigger.id}`}
          number={1}
          kind={KIND_LABEL.trigger}
          kindId="trigger"
          title={triggerTitle(workflow.trigger)}
          detail={triggerDetail(workflow.trigger)}
        />
      </Item>
      {workflow.steps.map((step, i) => (
        <Item key={step.id} connector>
          <StepNode step={step} number={i + 2} />
        </Item>
      ))}
    </ol>
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
  const card = (
    <StepCard
      testId={`step-${step.id}`}
      number={number}
      kind={KIND_LABEL[step.kind]}
      kindId={step.kind}
      title={step.name}
      detail={stepDetail(step)}
    />
  );
  if (step.kind === "fork") {
    return (
      <>
        {card}
        <Fork step={step} />
      </>
    );
  }
  if (step.kind === "for_each") {
    return (
      <>
        {card}
        <Loop step={step} />
      </>
    );
  }
  return card;
}

function StepCard({
  number,
  kind,
  title,
  detail,
  kindId,
  testId,
  compact,
}: {
  number?: number | undefined;
  kind: string;
  title: string;
  detail: string | null;
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
      <StepKindTag kind={kindId} label={kind} />
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        {detail ? <p className="truncate text-sm text-ink-muted">{detail}</p> : null}
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
  return (
    <div className="flex w-full flex-col items-center">
      <StepCard
        compact
        testId={`step-${step.id}`}
        kind={KIND_LABEL[step.kind]}
        kindId={step.kind}
        title={step.name}
        detail={stepDetail(step)}
      />
      {step.kind === "fork" ? <Fork step={step} /> : null}
      {step.kind === "for_each" ? <Loop step={step} /> : null}
    </div>
  );
}

function Fork({ step }: { step: ForkStep }) {
  const names = useContext(Names);
  const columns = step.paths.length + 1;
  return (
    <div data-testid={`fork-${step.id}`} className="flex w-full flex-col items-center">
      <span aria-hidden className="h-4 border-l border-line-strong" />
      <div
        className="grid w-full gap-3 rounded-lg border border-dashed border-line-strong p-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
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

function Loop({ step }: { step: ForEachStep }) {
  return (
    <div
      data-testid={`loop-${step.id}`}
      className="flex w-full max-w-[560px] flex-col items-center"
    >
      <span aria-hidden className="h-4 border-l border-line-strong" />
      <div className="w-full rounded-lg border border-dashed border-line-strong p-3">
        <p className="mb-3 text-sm text-ink-muted">each item · up to {step.concurrency} at once</p>
        <Branch steps={step.steps} />
      </div>
    </div>
  );
}
