// A read-only rendering of a workflow as the builder lays it out (docs/design/screens/
// 5-workflow-builder.png): the trigger and top-level steps numbered top to bottom, a fork's ordered
// paths side by side with "otherwise" last, and the paths joining after the fork. The drag-and-drop
// builder (ARCHITECTURE §10.5) replaces this view later and keeps its look.
import type { ForEachStep, ForkStep, Step, Workflow } from "@countersign/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { Badge, cx } from "../../ui/primitives";
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

export function StepList({ workflow }: { workflow: Workflow }) {
  const names = useMemo(() => stepNames(workflow), [workflow]);
  return (
    <Names.Provider value={names}>
      <StepListItems workflow={workflow} />
    </Names.Provider>
  );
}

function StepListItems({ workflow }: { workflow: Workflow }) {
  return (
    <ol data-testid="step-list" className="flex flex-col items-center">
      <Item>
        <StepCard
          testId={`step-${workflow.trigger.id}`}
          number={1}
          kind={KIND_LABEL.trigger}
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
      {connector ? <span aria-hidden className="h-6 border-l border-control" /> : null}
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
      tone={step.kind === "fork" ? "accent" : "neutral"}
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
  tone = "neutral",
  testId,
  compact,
}: {
  number?: number | undefined;
  kind: string;
  title: string;
  detail: string | null;
  tone?: "neutral" | "accent";
  testId: string;
  compact?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className={cx(
        "flex w-full items-center gap-3 rounded-md border border-edge bg-card elevation-xs",
        compact ? "px-3 py-2.5" : "max-w-[480px] px-4 py-3.5",
      )}
    >
      {number !== undefined ? (
        <span
          data-testid={`${testId}-number`}
          className="w-5 text-right font-mono text-sm text-secondary"
        >
          {number}
        </span>
      ) : null}
      <Badge tone={tone}>{kind}</Badge>
      <div className="min-w-0">
        <p className="font-medium text-primary">{title}</p>
        {detail ? <p className="truncate text-sm text-secondary">{detail}</p> : null}
      </div>
    </div>
  );
}

function Branch({ steps }: { steps: Step[] }) {
  if (steps.length === 0) {
    return (
      <p className="rounded-sm border border-dashed border-control px-3 py-3 text-center text-sm text-secondary">
        Nothing · continue
      </p>
    );
  }
  return (
    <ol className="flex flex-col items-stretch">
      {steps.map((s, i) => (
        <li key={s.id} className="flex flex-col items-center">
          {i > 0 ? <span aria-hidden className="h-4 border-l border-control" /> : null}
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
        tone={step.kind === "fork" ? "accent" : "neutral"}
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
      <span aria-hidden className="h-4 border-l border-control" />
      <div
        className="grid w-full gap-3 rounded-lg border border-dashed border-control p-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {step.paths.map((path, i) => (
          <section
            key={path.id}
            data-testid={`fork-${step.id}-path-${path.id}`}
            aria-label={`Path ${i + 1}: ${path.name}`}
            className="rounded-md border border-edge bg-subtle p-3"
          >
            <h3 className="font-medium text-primary">{path.name}</h3>
            <p className="mb-3 font-mono text-xs break-words text-secondary">
              if {rulesText(path.when, names)}
            </p>
            <Branch steps={path.steps} />
          </section>
        ))}
        <section
          data-testid={`fork-${step.id}-otherwise`}
          aria-label="Otherwise"
          className="rounded-md border border-edge bg-subtle p-3"
        >
          <h3 className="font-medium text-primary">Otherwise</h3>
          <p className="mb-3 font-mono text-xs text-secondary">none of the above</p>
          <Branch steps={step.otherwise.steps} />
        </section>
      </div>
      <p className="label-caps mt-2 text-secondary">Paths join here</p>
    </div>
  );
}

function Loop({ step }: { step: ForEachStep }) {
  return (
    <div
      data-testid={`loop-${step.id}`}
      className="flex w-full max-w-[560px] flex-col items-center"
    >
      <span aria-hidden className="h-4 border-l border-control" />
      <div className="w-full rounded-lg border border-dashed border-control p-3">
        <p className="mb-3 font-mono text-xs text-secondary">
          each item · up to {step.concurrency} at once
        </p>
        <Branch steps={step.steps} />
      </div>
    </div>
  );
}
