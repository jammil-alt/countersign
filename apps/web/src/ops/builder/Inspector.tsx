// The builder's inspector (ARCHITECTURE §10.5, §10.14): the selected step's or trigger's form. Inputs
// come from the skill's or tool's input schema; template fields offer the upstream outputs valid
// at the step (core's `processes.processPathsAt`, the scopes the validator types with); ifs edit
// their ordered paths as rule rows; a skill step customizes its Library skill (settings, added
// instructions, rule rows, the fields it passes on) against the skill's and the template's
// values; a conversation has its own form; every step can carry checks (a second opinion,
// approval, notices) and has its client timeline label and visibility.
import {
  type AnyAgentBundle,
  // P-4
  CONVERSE_SKILL,
  lookupSkill,
  type PathOption,
  type ProcessAgentBundle,
  parseSkillRef,
  pathOptions,
  processes,
  REACH_OUT_SKILL,
  SKILL_KIND_LABEL,
  type Trigger,
  type TriggerOn,
  type TypingContext,
  toolUsesModel,
  triggerOnSchema,
  writesToClientTool,
} from "@countersign/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../ui/icons";
import { Button, cx } from "../../ui/primitives";
import { actionKindLabel, PROCESS_KIND_LABEL } from "../workflow/describe";
import { toolLabel, whenEvent } from "../workflow/labels";
import { processClientVisible } from "./Canvas";
// P-4
import { ConversationFields, ConverseFields } from "./ConverseFields";
import {
  type BuilderData,
  type BuilderProblem,
  catalogSkillKind,
  connectorName,
  writeLabelOf,
} from "./catalog";
import { ChecksPanel, NotifyEditor } from "./checks";
import { CustomizeSection } from "./customize";
import { DeadlineEditor } from "./deadline";
import {
  EventOptions,
  type FieldErrors,
  JsonInput,
  ReferenceNames,
  Row,
  SchemaForm,
  SmallInput,
  SmallSelect,
  TemplateInput,
} from "./fields";
// Hand off (owner, 2026-11-11)
import { handoffChoices, handoffName } from "./handoff";
import {
  type ApprovalEnv,
  actionTarget,
  type IfPath,
  looseningBlocked,
  newPath,
  type Process,
  type Step,
} from "./model";
import {
  labelPaths,
  outcomeRules,
  ROUTE_STOP_SAYS,
  type RouteOption,
  routeOptions,
  takesOnError,
} from "./outcomes";
import { type People, PersonPicker } from "./people";
import { fieldLabel, stepNamer } from "./problems";
import { ReachOutFields } from "./ReachOutFields";
// Reshape data (2026-11-11)
import { inputsUnfilled, isReshape, type ReshapeOffer, reshapeOffers } from "./reshape";
import { ReshapeFields } from "./reshape-step";
import { RulesEditor } from "./rules";
import { RunsOnRow, type SkillMove, StepParameters, VersionSection } from "./skill-step";

export type { Member } from "./people";
export { parseRuleValue, ruleValueText } from "./rules";

export type Selection = { type: "step"; id: string } | { type: "trigger"; id: string };

export interface FocusRequest {
  node: string;
  field: string;
  nonce: number;
}

export interface InspectorProps {
  workflow: Process;
  bundle: ProcessAgentBundle;
  selection: Selection | null;
  data: BuilderData;
  ctx: TypingContext;
  env: ApprovalEnv;
  /** This process's validation errors. */
  errors: BuilderProblem[];
  /** A client agent's base template version, for "the template's value". */
  template: { bundle: AnyAgentBundle | ProcessAgentBundle; workflow: Process | undefined } | null;
  /** Who a step may ask or tell: roles, the client's team and its People list. */
  people: People;
  focus: FocusRequest | null;
  /** The connectors the agent may use: their events are the ones a trigger offers. */
  connectors?: ReadonlySet<string> | undefined;
  /** `key` groups typing in one field into one undo step. */
  onStep(id: string, fn: (step: Step) => Step, key: string): void;
  onTrigger(id: string, on: TriggerOn, key: string): void;
  onAddTrigger(on: TriggerOn): void;
  onRemoveTrigger(id: string): void;
  onDelete(id: string): void;
  /** Wave 5: put an `if` right after the step, routed on how it ended ("Add a route for this"). */
  onAddRoute?(stepId: string, option: RouteOption): void;
  /**
   * Skill model (2026-11-10): put the write a skill's output fits right after it ("Add: Create
   * bill"), its input pre-mapped from that output.
   */
  onAddAction?(stepId: string, fit: processes.ActionFit): void;
  // Reshape data (2026-11-11)
  /**
   * Put a Reshape step before a step whose inputs earlier steps can't fill, or after a skill whose
   * output fits a write only in part (then the write), its mapping proposed and the step wired.
   */
  onAddReshape?(at: { before: string } | { after: string; action: processes.WriteAction }): void;
  /** One edit across steps (a Reshape step and the step it feeds), one undo. */
  onProcess?(fn: (w: Process) => Process, key: string): void;
  // Skill model (2026-11-10): a skill step's version move.
  /** The agent being edited, for "what moves if this step goes to vN". */
  agentId?: string | undefined;
  /** Its client (null for a template): whose operator skills its references name. */
  tenantId?: string | null | undefined;
  /** Move a skill step to another version of its skill, with its references remapped. */
  onMoveSkill?(move: SkillMove): void;
  /** Opens the Fix dialog for one of the step's problems. */
  onFix?: ((e: BuilderProblem) => void) | undefined;
}

function errorsFor(errors: readonly BuilderProblem[], node: string): FieldErrors {
  const mine = errors.filter((e) => e.stepId === node);
  return {
    at: (field) => mine.filter((e) => e.field === field).map((e) => e.message),
  };
}

/** Focus the control a validation error names, or its nearest enclosing field. */
function useFocus(root: React.RefObject<HTMLElement | null>, focus: FocusRequest | null) {
  useEffect(() => {
    if (!focus || !root.current) return;
    const scope =
      root.current.querySelector<HTMLElement>(`[data-node="${CSS.escape(focus.node)}"]`) ??
      root.current;
    let field = focus.field;
    for (;;) {
      const el = scope.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`);
      if (el) {
        el.focus();
        return;
      }
      const cut = field.lastIndexOf(".");
      if (cut === -1) break;
      field = field.slice(0, cut);
    }
    scope.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }, [focus, root]);
}

export function Inspector(props: InspectorProps) {
  const { selection, workflow } = props;
  const root = useRef<HTMLDivElement>(null);
  useFocus(root, props.focus);
  const step =
    selection?.type === "step" ? processes.findStep(workflow, selection.id)?.step : undefined;
  const trigger =
    selection?.type === "trigger"
      ? workflow.triggers.find((t) => t.id === selection.id)
      : undefined;
  const names = useMemo(() => stepNamer(workflow, props.bundle), [workflow, props.bundle]);

  let body: ReactNode;
  if (trigger) {
    body = <TriggerInspector {...props} trigger={trigger} />;
  } else if (step) {
    // Keyed by the step: fields that keep text while it is typed start afresh for another step.
    body = <StepInspector key={step.id} {...props} step={step} />;
  } else {
    body = (
      <div className="flex flex-col gap-2 text-sm text-ink-muted">
        <p className="eyebrow">Inspector</p>
        <p>Click a step or a trigger to edit it. Drag steps by their handle to reorder them.</p>
      </div>
    );
  }
  return (
    <div
      ref={root}
      data-testid="builder-inspector"
      data-node={trigger?.id ?? step?.id}
      // Focused when a step is picked and the panel sits below the canvas (narrow screens).
      tabIndex={-1}
      className="outline-none"
    >
      <ReferenceNames.Provider value={names}>{body}</ReferenceNames.Provider>
    </div>
  );
}

function Heading({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string;
  title: string;
  intro?: string | undefined;
}) {
  return (
    <div className="mb-4">
      <p className="eyebrow text-ink-muted">{eyebrow}</p>
      <h2 className="mt-1 type-heading text-ink">{title}</h2>
      {intro ? <p className="mt-2 text-sm text-ink">{intro}</p> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="eyebrow text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

function NodeErrors({
  errors,
  node,
  onFix,
}: {
  errors: readonly BuilderProblem[];
  node: string;
  onFix?: ((e: BuilderProblem) => void) | undefined;
}) {
  const mine = errors.filter((e) => e.stepId === node);
  if (mine.length === 0) return null;
  return (
    <ul className="ds-banner mb-4 flex-col gap-2 text-sm" data-testid="builder-inspector-errors">
      {mine.map((e, i) => (
        <li
          key={`${e.field}:${e.code}:${e.message}`}
          className="flex items-start justify-between gap-3"
        >
          <span className="min-w-0">
            {fieldLabel(e.field) ? (
              <span className="font-medium">{fieldLabel(e.field)}: </span>
            ) : null}
            {e.message}
          </span>
          {onFix ? (
            <button
              type="button"
              data-testid={`builder-inspector-error-${i}-fix`}
              onClick={() => onFix(e)}
              className="ds-btn ds-btn--secondary ds-btn--sm shrink-0"
            >
              Fix
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────────────────────────

const STEP_INTRO: Partial<Record<Step["kind"], string>> = {
  read: "Reads from a tool. It never changes anything.",
  write: "Changes something through a tool, behind its checks.",
  if: "Paths are checked top to bottom. A run takes the first path whose rules match, then continues after the if.",
  for_each: "Runs the steps inside once for each item of a list.",
  process: "Runs a saved process as one step. Its steps are edited in that process, not here.",
  person: "Waits for a person in the inbox before the run goes on.",
  conversation: "Talks with someone until it has what it needs, within the limits below.",
  notify: "Tells the client's team or ours that something happened.",
};

/** Logic steps carry no checks in the builder: they do no work to check. */
const LOGIC = new Set<Step["kind"]>(["if", "for_each", "wait", "stop"]);

function stepNumber(workflow: Process, id: string): string {
  const i = workflow.steps.findIndex((s) => s.id === id);
  return i === -1 ? "Step" : `Step ${i + 1}`;
}

type SetStep = (key: string, fn: (s: Step) => Step) => void;

function StepInspector(props: InspectorProps & { step: Step }) {
  const { step, workflow, errors, onStep, onDelete, ctx } = props;
  const fieldErrors = errorsFor(errors, step.id);
  // Wave 5: earlier steps' outcomes come with their words ("Approve the bill: how it ended").
  const paths = useMemo(
    () => labelPaths(workflow, processes.processPathsAt(workflow, step.id, ctx)),
    [workflow, step.id, ctx],
  );
  const set: SetStep = (key, fn) => onStep(step.id, fn, `${step.id}:${key}`);
  // Skill model (2026-11-10): a write by where it writes, a skill step with its kind.
  const label =
    step.kind === "write"
      ? step.action !== undefined
        ? actionKindLabel(
            step.action,
            step.via
              ? props.data.catalog.connectors.find((c) => c.id === step.via)?.name
              : undefined,
          )
        : writeLabelOf(props.data, step.tool as string)
      : PROCESS_KIND_LABEL[step.kind];
  // Review: a read or a write on a tool that calls a model inside reads AI too.
  const kind =
    step.kind === "skill"
      ? catalogSkillKind(props.data, step.skill)
      : (step.kind === "read" || step.kind === "write") &&
          step.tool !== undefined &&
          toolUsesModel(ctx.tools?.[step.tool])
        ? ("ai" as const)
        : undefined;
  const skill = step.kind === "skill" ? lookupSkill(step.skill, ctx) : undefined;
  const intro =
    step.kind === "write"
      ? step.action !== undefined || writesToClientTool(ctx.tools?.[step.tool as string])
        ? `${label}: it changes the client's tool behind its checks. Approval is on by default.`
        : "Saves to our own records. Approval is off by default; add one below if someone should say yes first."
      : STEP_INTRO[step.kind];

  return (
    <div className="flex flex-col gap-4">
      <Heading
        eyebrow={`${stepNumber(workflow, step.id)} · ${label}${kind ? ` · ${SKILL_KIND_LABEL[kind]}` : ""}`}
        title={step.name || label}
        intro={intro}
      />
      <NodeErrors errors={errors} node={step.id} onFix={props.onFix} />
      <Row label="Name" field="name" errors={fieldErrors}>
        <SmallInput
          data-field="name"
          data-testid="builder-inspector-name"
          value={step.name}
          onChange={(e) => set("name", (s) => ({ ...s, name: e.target.value }))}
        />
      </Row>

      <KindFields {...props} paths={paths} fieldErrors={fieldErrors} set={set} />

      {step.kind === "skill" && skill ? (
        <>
          <RunsOnRow
            step={step}
            skill={skill}
            bundle={props.bundle}
            ctx={ctx}
            fieldErrors={fieldErrors}
            set={set}
          />
          <StepParameters step={step} skill={skill} bundle={props.bundle} set={set} />
          {props.agentId && props.onMoveSkill ? (
            <VersionSection
              step={step}
              skill={skill}
              agentId={props.agentId}
              tenantId={props.tenantId ?? null}
              workflow={workflow}
              onMove={props.onMoveSkill}
            />
          ) : null}
          {isReshape(step) ? null : (
            <CustomizeSection
              step={step}
              ctx={ctx}
              bundle={props.bundle}
              template={props.template}
              errors={fieldErrors}
              set={set}
            />
          )}
        </>
      ) : null}
      {LOGIC.has(step.kind) ? null : (
        <ChecksPanel
          step={step}
          set={set}
          env={props.env}
          people={props.people}
          data={props.data}
          errors={fieldErrors}
          pathsBefore={(confer) =>
            labelPaths(
              workflow,
              processes.processPathsAt(workflow, step.id, ctx, {
                own: processes.outputBeforeChecks(step, ctx),
                confer,
              }),
            )
          }
          pathsAfter={labelPaths(
            workflow,
            processes.processPathsAt(workflow, step.id, ctx, {
              own: true,
              confer: step.checks?.confer?.with.length ?? 0,
            }),
          )}
        />
      )}
      {takesOnError(step) ? <OnErrorSection step={step} set={set} /> : null}
      {props.onAddRoute ? (
        <RoutesSection step={step} onAdd={(option) => props.onAddRoute?.(step.id, option)} />
      ) : null}
      {step.kind === "skill" && props.onAddAction && !isReshape(step) ? (
        <ActionOffers
          step={step}
          ctx={props.ctx}
          onAdd={(fit) => props.onAddAction?.(step.id, fit)}
          {...(props.onAddReshape
            ? {
                onReshape: (action: processes.WriteAction) =>
                  props.onAddReshape?.({ after: step.id, action }),
              }
            : {})}
        />
      ) : null}
      {props.onAddReshape && inputsUnfilled(step, errors) ? (
        <Section title="Inputs">
          <p className="text-sm text-ink-muted">
            Some of this step's inputs can't be filled from what earlier steps give. A Reshape step
            before it can turn their results into what it takes.
          </p>
          <div>
            <Button
              variant="ghost"
              data-testid="builder-offer-reshape-before"
              onClick={() => props.onAddReshape?.({ before: step.id })}
            >
              <Icon name="add" />
              Add a Reshape step before this
            </Button>
          </div>
        </Section>
      ) : null}
      {/* DECISION (wave 5, web): an if is hidden from the client by default, as before; the operator
          may show it, and its row then says the route it took and why, naming only steps the
          client sees. */}
      {LOGIC.has(step.kind) && step.kind !== "if" ? null : (
        <TimelineSection step={step} set={set} />
      )}

      <div className="flex justify-end border-t border-line pt-4">
        {step.kind === "if" ? null : (
          <Button
            variant="ghost"
            data-testid="builder-inspector-delete"
            onClick={() => onDelete(step.id)}
          >
            Delete step
          </Button>
        )}
      </div>
    </div>
  );
}

/** A read or write step's tool: what it does, through which connector, and its undo. */
function ToolFields(
  props: InspectorProps & {
    step: Extract<Step, { kind: "read" | "write" }>;
    paths: PathOption[];
    fieldErrors: FieldErrors;
    set: SetStep;
  },
) {
  const { step, paths, fieldErrors, set, ctx, data } = props;
  if (step.kind === "write" && step.action !== undefined) {
    return <ActionFields {...props} step={step} />;
  }
  const toolId = step.tool as string;
  const tool = ctx.tools?.[toolId];
  const connector = tool ? (tool.connector ?? tool.source) : null;
  const undo = step.kind === "write" && tool ? processes.describeUndo(tool) : null;
  return (
    <>
      <Row label={step.kind === "read" ? "Reads" : "Changes"} field="tool" errors={fieldErrors}>
        <p className="text-sm text-ink" data-field="tool" tabIndex={-1}>
          {toolLabel(toolId)}
          {connector && connector !== "platform" ? (
            <span className="text-ink-muted"> · {connectorName(data, connector)}</span>
          ) : null}
        </p>
      </Row>
      {tool?.description ? <p className="text-sm text-ink-muted">{tool.description}</p> : null}
      {undo ? (
        <p className="text-sm text-ink-muted" data-testid="builder-write-undo">
          {undo.text}
        </p>
      ) : null}
      <Section title="Input">
        <SchemaForm
          schema={tool?.input}
          value={step.input}
          onChange={(input) => set("input", (s) => ({ ...s, input }) as Step)}
          paths={paths}
          prefix="input"
          errors={fieldErrors}
          testPrefix="builder-input"
        />
      </Section>
    </>
  );
}

/**
 * Skill model (2026-11-10): an action write step. What it does, the tool it will use for this
 * agent (a client agent's accounting connection, `via` among two; a message's channel), and its
 * provider-neutral input.
 */
function ActionFields(
  props: InspectorProps & {
    step: Extract<Step, { kind: "write" }>;
    paths: PathOption[];
    fieldErrors: FieldErrors;
    set: SetStep;
  },
) {
  const { step, paths, fieldErrors, set, env } = props;
  const action = step.action as processes.WriteAction;
  const spec = processes.ACTION_SPECS[action];
  const target = actionTarget(step, env);
  const accounting = processes.isAccountingAction(action);
  const bound = Object.keys(env.matrices).filter((c) =>
    (processes.ACCOUNTING_CONNECTORS as readonly string[]).includes(c),
  );
  return (
    <>
      <Row label="Does" field="action" errors={fieldErrors}>
        <p className="text-sm text-ink" data-field="action" tabIndex={-1}>
          {spec.label}
        </p>
      </Row>
      <p className="text-sm text-ink-muted">{spec.description}</p>
      {target ? (
        <p
          className={cx("text-sm", target.problem ? "text-risk" : "text-ink")}
          data-testid="builder-action-target"
        >
          {target.text}
        </p>
      ) : null}
      {accounting && (bound.length > 1 || step.via !== undefined) ? (
        <Row label="In" field="via" errors={fieldErrors}>
          <select
            className="ds-input"
            data-field="via"
            data-testid="builder-action-via"
            value={step.via ?? ""}
            onChange={(e) => {
              const via = e.target.value;
              set("via", (s) => {
                if (s.kind !== "write") return s;
                const { via: _old, ...rest } = s;
                return (via ? { ...rest, via } : rest) as Step;
              });
            }}
          >
            <option value="">Choose a system</option>
            {processes.ACCOUNTING_CONNECTORS.map((c) => (
              <option key={c} value={c}>
                {processes.ACTION_CONNECTOR_NAMES[c] ?? c}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
      <Section title="Input">
        <SchemaForm
          schema={processes.actionInputSchema(action)}
          value={step.input}
          onChange={(input) => set("input", (s) => ({ ...s, input }) as Step)}
          paths={paths}
          prefix="input"
          errors={fieldErrors}
          testPrefix="builder-input"
        />
      </Section>
    </>
  );
}

/**
 * Skill model (2026-11-10): after a skill whose output fits an action's input (the same field
 * names and types, or the skill says so), the builder offers that write with its fields mapped.
 */
function ActionOffers({
  step,
  ctx,
  onAdd,
  onReshape,
}: {
  step: Extract<Step, { kind: "skill" }>;
  ctx: TypingContext;
  onAdd(fit: processes.ActionFit): void;
  /** Reshape data (2026-11-11): a write the output fits only in part, through a Reshape step. */
  onReshape?(action: processes.WriteAction): void;
}) {
  const output = processes.stepOutputSchema(step, ctx);
  const fits = processes.actionFits(step.id, output);
  const partial: ReshapeOffer[] = onReshape ? reshapeOffers(step.id, output) : [];
  if (fits.length === 0 && partial.length === 0) return null;
  return (
    <Section title="Next step">
      {partial.length > 0 ? (
        <>
          <p className="text-sm text-ink-muted">
            This skill's result has part of what these need. A Reshape step turns it into the rest
            of their fields; each is added after it, with approval on.
          </p>
          <ul className="flex flex-col gap-1.5">
            {partial.map((o) => (
              <li key={o.action} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-ink">
                  {processes.ACTION_SPECS[o.action].label}: {o.mapped} of {o.of} fields
                </span>
                <Button
                  variant="ghost"
                  data-testid={`builder-offer-reshape-${o.action}`}
                  onClick={() => onReshape?.(o.action)}
                >
                  <Icon name="add" />
                  Add a Reshape step
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {fits.length === 0 ? null : (
        <>
          <p className="text-sm text-ink-muted">
            This skill's result has what these need. Each is added after it, its fields filled from
            the result, with approval on.
          </p>
          <ul className="flex flex-col gap-1.5">
            {fits.map((fit) => (
              <li key={fit.action} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">
                  {Object.keys(fit.input).length} fields filled
                </span>
                <Button
                  variant="ghost"
                  data-testid={`builder-offer-${fit.action}`}
                  onClick={() => onAdd(fit)}
                >
                  <Icon name="add" />
                  Add: {processes.ACTION_SPECS[fit.action].label}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function KindFields(
  props: InspectorProps & {
    step: Step;
    paths: PathOption[];
    fieldErrors: FieldErrors;
    set: SetStep;
  },
) {
  const { step, paths, fieldErrors, set, ctx } = props;
  switch (step.kind) {
    case "skill": {
      const skill = lookupSkill(step.skill, ctx);
      const id = parseSkillRef(step.skill).id;
      const setInput = (key: string, fn: <T extends object>(s: T) => T) =>
        set(key, (s) => (s.kind === "skill" ? fn(s) : s));
      return (
        <>
          <Row label="Skill" field="skill" errors={fieldErrors}>
            <p className="text-sm text-ink" data-field="skill" tabIndex={-1}>
              {skill?.name ?? "A skill this agent can't find"}
              {skill?.category ? (
                <span className="text-ink-muted"> · {skillCategory(skill.category)}</span>
              ) : null}
            </p>
          </Row>
          {skill?.description ? (
            <p className="text-sm text-ink-muted">{skill.description}</p>
          ) : null}
          {isReshape(step) ? (
            <ReshapeFields
              step={step}
              workflow={props.workflow}
              ctx={ctx}
              agentId={props.agentId}
              errors={props.errors.filter((e) => e.stepId === step.id)}
              onProcess={(fn, key) => props.onProcess?.(fn, key)}
            />
          ) : (
            <Section title="Input">
              {id === REACH_OUT_SKILL ? (
                <ReachOutFields
                  step={step}
                  bundle={props.bundle}
                  paths={paths}
                  fieldErrors={fieldErrors}
                  set={setInput}
                />
              ) : // P-4: a stored conversation keeps its own form (it still runs as a skill step).
              id === CONVERSE_SKILL ? (
                <ConverseFields
                  step={step}
                  bundle={props.bundle}
                  paths={paths}
                  fieldErrors={fieldErrors}
                  set={setInput}
                />
              ) : (
                <SchemaForm
                  schema={skill?.input}
                  value={step.input}
                  onChange={(input) => set("input", (s) => ({ ...s, input }) as Step)}
                  paths={paths}
                  prefix="input"
                  errors={fieldErrors}
                  testPrefix="builder-input"
                />
              )}
            </Section>
          )}
        </>
      );
    }
    case "read":
    case "write":
      return <ToolFields {...props} step={step} />;
    case "person":
      return (
        <>
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
            <Row label="Asks to" field="mode" errors={fieldErrors}>
              <SmallSelect
                data-field="mode"
                data-testid="builder-person-mode"
                value={step.mode}
                onChange={(e) =>
                  set("mode", (s) => ({ ...s, mode: e.target.value as "approve" | "ask" }) as Step)
                }
              >
                <option value="approve">Approve</option>
                <option value="ask">Answer</option>
              </SmallSelect>
            </Row>
            <Row label="Who" field="assignee" errors={fieldErrors}>
              <PersonPicker
                field="assignee"
                testId="builder-person-assignee"
                allowLead
                value={step.assignee}
                people={props.people}
                onChange={(v) =>
                  set("assignee", (s) => ({ ...s, assignee: v ?? "client_admin" }) as Step)
                }
              />
            </Row>
          </div>
          <Row label="Title" field="title" errors={fieldErrors}>
            <TemplateInput
              field="title"
              testId="builder-person-title"
              value={step.title}
              paths={paths}
              onChange={(title) => set("title", (s) => ({ ...s, title }) as Step)}
            />
          </Row>
          <Row label="Where" field="channel" errors={fieldErrors}>
            <SmallSelect
              data-field="channel"
              data-testid="builder-person-channel"
              value={step.channel}
              onChange={(e) =>
                set(
                  "channel",
                  (s) => ({ ...s, channel: e.target.value as "inbox" | "email" }) as Step,
                )
              }
            >
              <option value="inbox">The inbox</option>
              <option value="email">Email</option>
            </SmallSelect>
          </Row>
          <DeadlineEditor
            value={step.deadline}
            prefix="deadline"
            testId="builder-person-deadline"
            errors={fieldErrors}
            people={props.people}
            proceedBlocked={null}
            onChange={(deadline, key) => set(key, (s) => ({ ...s, deadline }) as Step)}
          />
          {step.mode === "approve" ? (
            <Row label="If rejected" field="onReject" errors={fieldErrors}>
              <SmallSelect
                data-field="onReject"
                value={step.onReject}
                onChange={(e) =>
                  set(
                    "onReject",
                    (s) => ({ ...s, onReject: e.target.value as "stop" | "continue" }) as Step,
                  )
                }
              >
                <option value="stop">Stop the run</option>
                <option value="continue">Go on</option>
              </SmallSelect>
            </Row>
          ) : null}
          <Row label="Shows them (JSON)" field="payload" errors={fieldErrors}>
            <JsonInput
              field="payload"
              testId="builder-person-payload"
              value={step.payload}
              rows={3}
              onChange={(v) =>
                set("payload", (s) => ({ ...s, payload: isRecord(v) ? v : {} }) as Step)
              }
            />
          </Row>
        </>
      );
    case "conversation":
      return (
        <ConversationFields
          step={step}
          bundle={props.bundle}
          paths={paths}
          fieldErrors={fieldErrors}
          people={props.people}
          messagesBlocked={looseningBlocked([], props.env)}
          set={(key, fn) => set(key, (s) => (s.kind === "conversation" ? fn(s) : s))}
        />
      );
    case "notify":
      return (
        <NotifyEditor
          value={step.notify}
          prefix="notify"
          testId="builder-notify-step"
          errors={fieldErrors}
          people={props.people}
          paths={paths}
          onChange={(notify, key) => set(key, (s) => (s.kind === "notify" ? { ...s, notify } : s))}
        />
      );
    case "if":
      return <IfEditor {...props} step={step} />;
    case "for_each":
      return (
        <>
          <Row label="Over the list" field="over" errors={fieldErrors}>
            <TemplateInput
              field="over"
              testId="builder-loop-over"
              value={step.over}
              paths={paths.filter((p) => !p.schema || p.schema.type === "array" || !p.schema.type)}
              placeholder="{{steps.<id>.output.lines}}"
              onChange={(over) => set("over", (s) => ({ ...s, over }) as Step)}
            />
          </Row>
          <Row label="Up to at once" field="concurrency" errors={fieldErrors}>
            <SmallInput
              data-field="concurrency"
              data-testid="builder-loop-concurrency"
              type="number"
              min={1}
              max={50}
              value={step.concurrency}
              onChange={(e) =>
                set(
                  "concurrency",
                  (s) => ({ ...s, concurrency: Number(e.target.value) || 1 }) as Step,
                )
              }
            />
          </Row>
        </>
      );
    case "wait":
      return (
        <Row label="Wait for" field="for" errors={fieldErrors} hint='e.g. "2 hours" or "3 days"'>
          <SmallInput
            data-field="for"
            data-testid="builder-wait-for"
            value={step.for}
            onChange={(e) => set("for", (s) => ({ ...s, for: e.target.value }) as Step)}
          />
        </Row>
      );
    // A read-only card for the process, and its input as a form from its schema (docs/plan.md
    // §1.45). The process's own steps are not in the bundle.
    case "process": {
      const used = props.data.catalog.automations?.find((a) => a.ref === step.process);
      return (
        <>
          <Row label="Process" field="process" errors={fieldErrors}>
            <p
              className="reference text-ink"
              data-field="process"
              data-testid="builder-automation"
              tabIndex={-1}
            >
              {used ? used.name : step.process}
              <span className="font-sans text-ink-muted">
                {" "}
                · v{used ? used.version : (step.process.split("@")[1] ?? "?")}
              </span>
            </p>
          </Row>
          {used?.description ? <p className="text-sm text-ink-muted">{used.description}</p> : null}
          {used ? (
            <p className="text-sm text-ink-muted">
              {used.definition.steps.length} {used.definition.steps.length === 1 ? "step" : "steps"}
            </p>
          ) : null}
          <Section title="Input">
            <SchemaForm
              schema={used?.definition.input}
              value={step.input}
              onChange={(input) => set("input", (s) => ({ ...s, input }) as Step)}
              paths={paths}
              prefix="input"
              errors={fieldErrors}
              testPrefix="builder-input"
            />
          </Section>
        </>
      );
    }
    case "handoff":
      return <HandoffFields {...props} step={step} />;
    case "stop":
      return (
        <Row label="End the run as" field="status" errors={fieldErrors}>
          <SmallSelect
            data-field="status"
            value={step.status}
            onChange={(e) =>
              set("status", (s) => ({ ...s, status: e.target.value as typeof step.status }) as Step)
            }
          >
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </SmallSelect>
        </Row>
      );
  }
}

// ── Hand off (owner, 2026-11-11; docs/plan.md §1.95) ─────────────────────────────────────────────

/**
 * A hand-off step: the client's other agent, the top-level step of its live version where its run
 * starts (numbered and named; its earlier steps are skipped), then that step's input, mapped from
 * this run with the same fields and references as any step's input.
 */
function HandoffFields(
  props: InspectorProps & {
    step: Extract<Step, { kind: "handoff" }>;
    paths: PathOption[];
    fieldErrors: FieldErrors;
    set: SetStep;
  },
) {
  const { step, paths, fieldErrors, set } = props;
  const agents = handoffChoices(props.data);
  const target = agents.find((a) => a.slug === step.to.agent);
  const entry = target?.steps.find((s) => s.id === step.to.step);
  const setTo = (key: string, to: { agent: string; step: string }) =>
    // A new agent or step takes a new input: the old one was mapped for another step. A name the
    // builder gave follows the pick ("Hand off to Price checker at 5 · Itemize the invoice").
    set(key, (s) =>
      s.kind === "handoff" ? { ...s, to, input: {}, name: handoffName(props.data, s.name, to) } : s,
    );
  return (
    <>
      <Row label="Agent" field="to.agent" errors={fieldErrors}>
        <SmallSelect
          data-field="to.agent"
          data-testid="builder-handoff-agent"
          value={step.to.agent}
          onChange={(e) => setTo("to.agent", { agent: e.target.value, step: "" })}
        >
          <option value="">Choose an agent…</option>
          {agents.map((a) => (
            <option key={a.slug} value={a.slug} disabled={a.workflow === null}>
              {a.workflow === null ? `${a.name} (no live version)` : a.name}
            </option>
          ))}
        </SmallSelect>
      </Row>
      <Row
        label="Starts at"
        field="to.step"
        errors={fieldErrors}
        hint="Its steps before this one are skipped. This run goes on without waiting."
      >
        <SmallSelect
          data-field="to.step"
          data-testid="builder-handoff-step"
          value={step.to.step}
          disabled={!target}
          onChange={(e) => setTo("to.step", { agent: step.to.agent, step: e.target.value })}
        >
          <option value="">Choose a step…</option>
          {(target?.steps ?? []).map((s, i) => (
            <option key={s.id} value={s.id} disabled={!processes.HANDOFF_ENTRY_KINDS.has(s.kind)}>
              {i + 1} · {s.name}
            </option>
          ))}
        </SmallSelect>
      </Row>
      {entry ? (
        <Section title="Input">
          <SchemaForm
            schema={entry.input}
            value={step.input}
            onChange={(input) => set("input", (s) => ({ ...s, input }) as Step)}
            paths={paths}
            prefix="input"
            errors={fieldErrors}
            testPrefix="builder-input"
          />
        </Section>
      ) : null}
    </>
  );
}

/** A skill's category as a heading word: "documents" → "Documents". */
function skillCategory(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Forks on how a step ended (wave 5) ───────────────────────────────────────────────────────────

/** "If this step fails": stop the run (the default, the field left out) or carry on. */
function OnErrorSection({ step, set }: { step: Step; set: SetStep }) {
  return (
    <Section title="If this step fails">
      <SmallSelect
        aria-label="If this step fails"
        data-field="onError"
        data-testid="builder-on-error"
        value={step.onError === "continue" ? "continue" : "fail"}
        onChange={(e) =>
          set("onError", (s) => {
            // DECISION (wave 5, web): "Stop the run" removes the field (absent is `fail`), so a step
            // set back to the default saves as it was stored, with nothing new in diffs and merges.
            const { onError: _old, ...rest } = s;
            return (
              e.target.value === "continue" ? { ...rest, onError: "continue" } : rest
            ) as Step;
          })
        }
      >
        <option value="fail">Stop the run (default)</option>
        <option value="continue">Carry on</option>
      </SmallSelect>
      <p className="text-xs text-ink-muted">
        {step.onError === "continue"
          ? "The run goes on and a later if can route on “failed”. A change that didn't go through is never tried again on its own, and approvals stay as they are."
          : "A failure ends the run here, as always."}
      </p>
    </Section>
  );
}

/**
 * The outcomes later steps can route on, each with "Add a route for this": an `if` right after the
 * step. A route that needs the step to go on (an approval's "if rejected", "if nobody answers",
 * "if this step fails") sets that, and the inspector says so; approval stays on.
 */
function RoutesSection({ step, onAdd }: { step: Step; onAdd(option: RouteOption): void }) {
  const options = routeOptions(step);
  const [added, setAdded] = useState<{
    name: string;
    change: RouteOption["change"];
    stop: RouteOption["stop"];
  } | null>(null);
  if (options.length === 0) return null;
  const now = options.filter((o) => o.change === null);
  return (
    <Section title="Routes after this step">
      <p className="text-sm text-ink" data-testid="builder-routes-now">
        {now.length > 0
          ? `Later steps can route on: ${now.map((o) => o.label).join(", ")}.`
          : "As set up, the run stops before a later step could see how this one ended. Each route below sets what it needs."}
      </p>
      {added ? (
        <div className="ds-banner flex-col gap-1 text-sm" data-testid="builder-route-added">
          <p>Added “If {added.name.toLowerCase()}” right after this step. Add its steps there.</p>
          {added.change ? (
            <p data-testid="builder-route-added-change">
              {added.change.setting}: {added.change.says}
            </p>
          ) : null}
          {added.stop ? <p data-testid="builder-route-added-stop">{ROUTE_STOP_SAYS}</p> : null}
        </div>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {options.map((o) => (
          <li
            key={o.key}
            className="flex items-start justify-between gap-2"
            data-testid={`builder-route-${o.key}`}
          >
            <span className="flex min-w-0 flex-col text-sm">
              <span className="text-ink">{o.label}</span>
              {o.change ? (
                <span className="text-xs text-ink-muted">
                  Sets {o.change.setting.toLowerCase()}
                  {o.stop ? "; the route ends the run" : ""}
                </span>
              ) : null}
            </span>
            <Button
              variant="ghost"
              data-testid={`builder-route-${o.key}-add`}
              onClick={() => {
                onAdd(o);
                setAdded({ name: o.pathName, change: o.change, stop: o.stop });
              }}
            >
              <Icon name="add" />
              Add a route for this
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ── Client timeline ──────────────────────────────────────────────────────────────────────────────

function TimelineSection({ step, set }: { step: Step; set: SetStep }) {
  const visible = processClientVisible(step);
  return (
    <Section title="Client timeline">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          className="size-4 accent-slate"
          type="checkbox"
          data-field="client.visible"
          data-testid="builder-timeline-visible"
          checked={visible}
          onChange={(e) =>
            set("client", (s) => ({
              ...s,
              client: { ...(s.client ?? {}), visible: e.target.checked },
            }))
          }
        />
        Show this step in the client's run timeline
      </label>
      {visible ? (
        <Row label="Label the client sees">
          <SmallInput
            data-field="client.label"
            data-testid="builder-timeline-label"
            value={step.client?.label ?? ""}
            placeholder={step.name}
            onChange={(e) =>
              set("client", (s) => {
                const label = e.target.value;
                const { label: _old, ...rest } = s.client ?? { visible: true };
                return { ...s, client: label ? { ...rest, label } : rest };
              })
            }
          />
        </Row>
      ) : null}
    </Section>
  );
}

// ── Ifs ──────────────────────────────────────────────────────────────────────────────────────────

function IfEditor(
  props: InspectorProps & {
    step: Extract<Step, { kind: "if" }>;
    paths: PathOption[];
    set: SetStep;
  },
) {
  const { step, paths, set, errors, onDelete } = props;
  // Wave 5: "Approve the bill: was rejected" in one pick.
  const quick = useMemo(() => outcomeRules(paths), [paths]);
  const setPaths = (key: string, fn: (paths: IfPath[]) => IfPath[]) =>
    set(key, (s) => (s.kind === "if" ? { ...s, paths: fn(s.paths) } : s));
  const setPath = (id: string, key: string, fn: (p: IfPath) => IfPath) =>
    setPaths(`path:${id}:${key}`, (ps) => ps.map((p) => (p.id === id ? fn(p) : p)));
  const move = (i: number, by: number) =>
    setPaths("order", (ps) => {
      const next = [...ps];
      const [p] = next.splice(i, 1);
      if (p) next.splice(i + by, 0, p);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      {errorsFor(errors, step.id)
        .at("paths")
        .map((m) => (
          <span key={m} className="text-sm text-risk">
            {m}
          </span>
        ))}
      {step.paths.map((p, i) => {
        const pathErrors = errorsFor(errors, p.id);
        const invalid = errors.some((e) => e.stepId === p.id);
        return (
          <section
            key={p.id}
            data-node={p.id}
            data-testid={`builder-path-${p.id}`}
            className={cx(
              "flex flex-col gap-2 rounded-md border bg-surface-subtle p-3",
              invalid ? "border-risk" : "border-line",
            )}
          >
            <div className="flex items-center gap-2">
              <SmallInput
                aria-label="Path name"
                data-field="name"
                data-testid={`builder-path-${p.id}-name`}
                value={p.name}
                className="min-w-0 flex-1 font-medium"
                onChange={(e) => setPath(p.id, "name", (x) => ({ ...x, name: e.target.value }))}
              />
              <span className="shrink-0 text-sm text-ink-muted figures">
                {p.steps.length} {p.steps.length === 1 ? "step" : "steps"}
              </span>
            </div>
            <RulesEditor
              rules={p.when}
              paths={paths}
              quick={quick}
              errors={pathErrors}
              prefix="when"
              testPrefix={`builder-path-${p.id}`}
              onChange={(when, key) => setPath(p.id, key, (x) => ({ ...x, when }))}
            />
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                disabled={i === 0}
                data-testid={`builder-path-${p.id}-up`}
                onClick={() => move(i, -1)}
                className="text-ink-muted hover:text-ink disabled:opacity-40"
              >
                Move up
              </button>
              <button
                type="button"
                disabled={i === step.paths.length - 1}
                data-testid={`builder-path-${p.id}-down`}
                onClick={() => move(i, 1)}
                className="text-ink-muted hover:text-ink disabled:opacity-40"
              >
                Move down
              </button>
              <button
                type="button"
                data-testid={`builder-path-${p.id}-remove`}
                onClick={() => setPaths("remove", (ps) => ps.filter((x) => x.id !== p.id))}
                className="ml-auto text-ink-muted hover:text-ink"
              >
                Remove path
              </button>
            </div>
          </section>
        );
      })}
      <section className="rounded-md border border-line bg-surface-subtle p-3">
        <div className="flex items-center justify-between">
          <span className="font-medium text-ink">Otherwise</span>
          <span className="text-sm text-ink-muted figures">
            {step.otherwise.steps.length} {step.otherwise.steps.length === 1 ? "step" : "steps"}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-muted">When none of the paths above match</p>
      </section>
      <div className="flex items-center gap-3">
        <Button
          data-testid="builder-fork-add-path"
          onClick={() => setPaths("add", (ps) => [...ps, newPath(ps.length + 1)])}
        >
          <Icon name="add" />
          Add path
        </Button>
        <Button variant="ghost" data-testid="builder-fork-remove" onClick={() => onDelete(step.id)}>
          Remove if
        </Button>
      </div>
      <p className="text-xs text-ink-muted">
        Fields come from earlier steps' outputs and the trigger, such as a total, a vendor or a
        person's answer, and from how earlier steps ended: rejected, nobody answered, found nothing,
        failed.
      </p>
    </div>
  );
}

// ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

// v0.12 W2-E: the builder offers the first four kinds; webhook, message and handoff triggers are
// written in the bundle for now (backend first, docs/plan.md §1.48).
const DEFAULT_ON: Record<"event" | "schedule" | "manual" | "command", TriggerOn> = {
  event: { type: "event", event: "document.received" },
  schedule: { type: "schedule", cron: "0 7 * * 1-5" },
  manual: { type: "manual", input: { type: "object", properties: {} } },
  command: { type: "command", command: "run" },
};

function TriggerInspector(props: InspectorProps & { trigger: Trigger }) {
  const { trigger, workflow, ctx, data, errors, onTrigger } = props;
  const on = trigger.on;
  const fieldErrors = errorsFor(errors, trigger.id);
  // A trigger's filter reads that trigger's own payload.
  const paths = useMemo(() => pathOptions(triggerOnSchema(on, ctx), "trigger"), [on, ctx]);
  const set = (next: TriggerOn, key: string) => onTrigger(trigger.id, next, key);
  // Events of connectors the agent may use (as the palette offers them); the platform's always.
  const events = data.events.filter(
    (e) => !e.connector || !props.connectors || props.connectors.has(e.connector),
  );
  const many = workflow.triggers.length > 1;
  return (
    <div className="flex flex-col gap-4">
      <Heading
        eyebrow="Trigger"
        title="How it starts"
        intro={
          many
            ? "Any of this process's triggers starts a run."
            : "This trigger starts each run of this process."
        }
      />
      <NodeErrors errors={errors} node={trigger.id} onFix={props.onFix} />
      <Row label="Starts" field="on.type" errors={fieldErrors}>
        <SmallSelect
          data-field="on.type"
          data-testid="builder-trigger-type"
          value={on.type}
          onChange={(e) => {
            const type = e.target.value as TriggerOn["type"];
            const first = events[0]?.type;
            const next =
              type === "event" && first
                ? { type, event: first }
                : DEFAULT_ON[type as keyof typeof DEFAULT_ON];
            set(next as TriggerOn, "trigger:type");
          }}
        >
          <option value="event">When something happens</option>
          <option value="schedule">On a schedule</option>
          <option value="manual">By hand</option>
          <option value="command">From a thread command</option>
          {/* v0.12 W2-E: shown when the bundle has one; set in the bundle for now. */}
          <option value="webhook" disabled>
            When a webhook arrives
          </option>
          <option value="message" disabled>
            When someone sends a message
          </option>
          <option value="handoff" disabled>
            When another agent finishes
          </option>
        </SmallSelect>
      </Row>
      {on.type === "event" ? (
        <>
          <Row label="Event" field="on.event" errors={fieldErrors}>
            <SmallSelect
              data-field="on.event"
              data-testid="builder-trigger-event"
              value={on.event}
              onChange={(e) => set({ ...on, event: e.target.value }, "trigger:event")}
            >
              {events.some((e) => e.type === on.event) ? null : (
                <option value={on.event}>{whenEvent(on.event)}</option>
              )}
              <EventOptions events={events.map((e) => e.type)} />
            </SmallSelect>
          </Row>
          <p className="text-sm text-ink-muted">
            {events.find((e) => e.type === on.event)?.description}
          </p>
          <Section title="Only when">
            <RulesEditor
              rules={on.filter ?? { match: "all", rules: [] }}
              paths={paths}
              errors={fieldErrors}
              prefix="on.filter"
              testPrefix="builder-trigger-filter"
              onChange={(filter, key) => {
                const { filter: _f, ...rest } = on;
                set(filter.rules.length ? { ...rest, filter } : rest, `trigger:filter:${key}`);
              }}
            />
          </Section>
        </>
      ) : null}
      {on.type === "schedule" ? (
        <div className="grid grid-cols-2 gap-3">
          <Row label="Cron" field="on.cron" errors={fieldErrors} hint="e.g. 0 7 * * 1-5">
            <SmallInput
              data-field="on.cron"
              data-testid="builder-trigger-cron"
              value={on.cron}
              className="font-mono"
              onChange={(e) => set({ ...on, cron: e.target.value }, "trigger:cron")}
            />
          </Row>
          <Row label="Time zone" field="on.tz" errors={fieldErrors} hint="Empty: the client's">
            <SmallInput
              data-field="on.tz"
              value={on.tz ?? ""}
              onChange={(e) => {
                const { tz: _tz, ...rest } = on;
                set(e.target.value ? { ...rest, tz: e.target.value } : rest, "trigger:tz");
              }}
            />
          </Row>
        </div>
      ) : null}
      {on.type === "manual" ? (
        <Row label="Input (JSON Schema)" field="on.input" errors={fieldErrors}>
          <JsonInput
            field="on.input"
            testId="builder-trigger-input"
            value={on.input}
            rows={6}
            onChange={(v) => set({ ...on, input: isRecord(v) ? v : {} }, "trigger:input")}
          />
        </Row>
      ) : null}
      {on.type === "command" ? (
        <Row label="Command" field="on.command" errors={fieldErrors}>
          <SmallInput
            data-field="on.command"
            data-testid="builder-trigger-command"
            value={on.command}
            className="font-mono"
            onChange={(e) => set({ ...on, command: e.target.value }, "trigger:command")}
          />
        </Row>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {workflow.triggers.length < 10 ? (
          <Button
            variant="ghost"
            data-testid="builder-trigger-add"
            onClick={() => props.onAddTrigger(DEFAULT_ON.manual)}
          >
            <Icon name="add" />
            Another way to start
          </Button>
        ) : null}
        {many ? (
          <Button
            variant="ghost"
            data-testid="builder-trigger-remove"
            onClick={() => props.onRemoveTrigger(trigger.id)}
          >
            Remove this trigger
          </Button>
        ) : null}
      </div>
    </div>
  );
}
