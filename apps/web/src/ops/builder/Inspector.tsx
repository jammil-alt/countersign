// The builder's inspector (ARCHITECTURE §10.5): the selected step's form. Inputs come from the
// skill's or tool's input schema; template fields offer the upstream outputs valid at the step;
// forks edit their ordered paths as rule rows; skills show their settings with defaults (and, on
// a client agent, the template's value beside a customized one); every step has its client
// timeline label and visibility; steps that change a client's tool have the Approval control.
import {
  type AgentBundle,
  clientLabel,
  type ForkPath,
  type ForkStep,
  isClientVisible,
  lookupSkill,
  type PathOption,
  parseSkillRef,
  pathsAt,
  REACH_OUT_SKILL,
  type Rule,
  type RuleOp,
  type Rules,
  type SkillSetting,
  type Step,
  type Trigger,
  type TriggerOn,
  type TypingContext,
  type ValidationError,
  type Workflow,
} from "@countersign/core";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { Icon } from "../../ui/icons";
import { Badge, Button, cx } from "../../ui/primitives";
import { KIND_LABEL } from "../workflow/describe";
import { type BuilderData, connectorName } from "./catalog";
import {
  type FieldErrors,
  JsonInput,
  parseNumberText,
  Row,
  SchemaForm,
  SmallInput,
  SmallSelect,
  TemplateInput,
} from "./fields";
import { type ApprovalEnv, approvalOption, findTemplateStep, newPath } from "./model";
import { ReachOutFields } from "./ReachOutFields";

export type Selection = { type: "step"; id: string } | { type: "trigger" };

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

export interface FocusRequest {
  node: string;
  field: string;
  nonce: number;
}

export interface InspectorProps {
  workflow: Workflow;
  bundle: AgentBundle;
  selection: Selection | null;
  data: BuilderData;
  ctx: TypingContext;
  env: ApprovalEnv;
  /** This workflow's validation errors. */
  errors: ValidationError[];
  /** A client agent's base template version, for "the template's value". */
  template: { bundle: AgentBundle; workflow: Workflow | undefined } | null;
  members: readonly Member[];
  focus: FocusRequest | null;
  /** `key` groups typing in one field into one undo step. */
  onStep(id: string, fn: (step: Step) => Step, key: string): void;
  onTrigger(on: TriggerOn, key: string): void;
  onDelete(id: string): void;
}

function errorsFor(errors: readonly ValidationError[], node: string): FieldErrors {
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
  const step = selection?.type === "step" ? findStep(workflow, selection.id) : undefined;

  let body: ReactNode;
  if (selection?.type === "trigger") {
    body = <TriggerInspector {...props} trigger={workflow.trigger} />;
  } else if (step) {
    body = <StepInspector {...props} step={step} />;
  } else {
    body = (
      <div className="flex flex-col gap-2 text-sm text-ink-muted">
        <p className="eyebrow">Inspector</p>
        <p>Click a step or the trigger to edit it. Drag steps by their handle to reorder them.</p>
      </div>
    );
  }
  return (
    <div
      ref={root}
      data-testid="builder-inspector"
      data-node={selection?.type === "trigger" ? workflow.trigger.id : step?.id}
    >
      {body}
    </div>
  );
}

function findStep(workflow: Workflow, id: string): Step | undefined {
  let found: Step | undefined;
  const visit = (steps: Step[]) => {
    for (const s of steps) {
      if (found) return;
      if (s.id === id) found = s;
      else if (s.kind === "fork") {
        for (const p of s.paths) visit(p.steps);
        visit(s.otherwise.steps);
      } else if (s.kind === "for_each") visit(s.steps);
    }
  };
  visit(workflow.steps);
  return found;
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

function NodeErrors({ errors, node }: { errors: readonly ValidationError[]; node: string }) {
  const mine = errors.filter((e) => e.stepId === node);
  if (mine.length === 0) return null;
  return (
    <ul className="ds-banner mb-4 flex-col gap-1 text-sm" data-testid="builder-inspector-errors">
      {mine.map((e) => (
        <li key={`${e.field}:${e.code}:${e.message}`}>
          {e.field ? <span className="reference">{e.field}: </span> : null}
          {e.message}
        </li>
      ))}
    </ul>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────────────────────────

const STEP_INTRO: Partial<Record<Step["kind"], string>> = {
  fork: "Paths are checked top to bottom. A run takes the first path whose rules match, then continues after the fork.",
  for_each: "Runs the steps inside once for each item of a list.",
  person: "Waits for a person in the inbox before the run goes on.",
};

function stepNumber(workflow: Workflow, id: string): string {
  const i = workflow.steps.findIndex((s) => s.id === id);
  return i === -1 ? "Step" : `Step ${i + 2}`;
}

function StepInspector(props: InspectorProps & { step: Step }) {
  const { step, workflow, errors, onStep, onDelete } = props;
  const fieldErrors = errorsFor(errors, step.id);
  const paths = useMemo(
    () => pathsAt(workflow, step.id, props.ctx),
    [workflow, step.id, props.ctx],
  );
  const set = (key: string, fn: (s: Step) => Step) => onStep(step.id, fn, `${step.id}:${key}`);

  return (
    <div className="flex flex-col gap-4">
      <Heading
        eyebrow={`${stepNumber(workflow, step.id)} · ${KIND_LABEL[step.kind]}`}
        title={step.name || KIND_LABEL[step.kind]}
        intro={STEP_INTRO[step.kind]}
      />
      <NodeErrors errors={errors} node={step.id} />
      <Row label="Name" field="name" errors={fieldErrors}>
        <SmallInput
          data-field="name"
          data-testid="builder-inspector-name"
          value={step.name}
          onChange={(e) => set("name", (s) => ({ ...s, name: e.target.value }))}
        />
      </Row>

      <KindFields {...props} paths={paths} fieldErrors={fieldErrors} set={set} />

      {step.kind === "skill" || step.kind === "action" ? (
        <ApprovalSection {...props} set={set} />
      ) : null}
      {step.kind === "skill" ? <SettingsSection {...props} set={set} /> : null}
      <TimelineSection step={step} set={set} />

      <div className="flex justify-end border-t border-line pt-4">
        {step.kind === "fork" ? null : (
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

type SetStep = (key: string, fn: (s: Step) => Step) => void;

function KindFields(
  props: InspectorProps & {
    step: Step;
    paths: PathOption[];
    fieldErrors: FieldErrors;
    set: SetStep;
  },
) {
  const { step, paths, fieldErrors, set, ctx, data } = props;
  switch (step.kind) {
    case "skill": {
      const skill = lookupSkill(step.skill, ctx);
      return (
        <>
          <Row label="Skill" field="skill" errors={fieldErrors}>
            <p className="reference text-ink" data-field="skill" tabIndex={-1}>
              {step.skill}
              {skill ? <span className="font-sans text-ink-muted"> · {skill.name}</span> : null}
            </p>
          </Row>
          {skill?.description ? (
            <p className="text-sm text-ink-muted">{skill.description}</p>
          ) : null}
          <Section title="Input">
            {parseSkillRef(step.skill).id === REACH_OUT_SKILL ? (
              <ReachOutFields
                step={step}
                bundle={props.bundle}
                paths={paths}
                fieldErrors={fieldErrors}
                set={set}
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
        </>
      );
    }
    case "action": {
      const tool = ctx.tools?.[step.tool];
      return (
        <>
          <Row label="Changes" field="tool" errors={fieldErrors}>
            <p className="reference text-ink" data-field="tool" tabIndex={-1}>
              {step.tool}
              {tool?.connector ? (
                <span className="font-sans text-ink-muted">
                  {" "}
                  · {connectorName(data, tool.connector)}
                </span>
              ) : null}
            </p>
          </Row>
          {tool?.description ? <p className="text-sm text-ink-muted">{tool.description}</p> : null}
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
                members={props.members}
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
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
            <Row label="Waits up to" field="timeout" errors={fieldErrors}>
              <SmallInput
                data-field="timeout"
                data-testid="builder-person-timeout"
                value={step.timeout}
                onChange={(e) => set("timeout", (s) => ({ ...s, timeout: e.target.value }) as Step)}
              />
            </Row>
            <Row label="Then" field="onTimeout" errors={fieldErrors}>
              <SmallSelect
                data-field="onTimeout"
                value={step.onTimeout}
                onChange={(e) =>
                  set(
                    "onTimeout",
                    (s) => ({ ...s, onTimeout: e.target.value as typeof step.onTimeout }) as Step,
                  )
                }
              >
                <option value="notify_operator">Tell the operator</option>
                <option value="stop">Stop the run</option>
                <option value="continue">Go on</option>
              </SmallSelect>
            </Row>
          </div>
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
    case "fork":
      return <ForkEditor {...props} step={step} />;
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
    case "notify":
      return (
        <>
          <Row label="Where" field="channel" errors={fieldErrors}>
            <SmallSelect
              data-field="channel"
              value={step.channel}
              onChange={(e) =>
                set(
                  "channel",
                  (s) => ({ ...s, channel: e.target.value as typeof step.channel }) as Step,
                )
              }
            >
              <option value="thread">The run's thread</option>
              <option value="email">Email</option>
              <option value="digest">The daily digest</option>
            </SmallSelect>
          </Row>
          {step.channel === "thread" ? null : (
            <Row label="To" field="to" errors={fieldErrors}>
              <TemplateInput
                field="to"
                testId="builder-notify-to"
                value={step.to ?? ""}
                paths={paths}
                onChange={(to) =>
                  set("to", (s) => {
                    const { to: _old, ...rest } = s as Extract<Step, { kind: "notify" }>;
                    return (to ? { ...rest, to } : rest) as Step;
                  })
                }
              />
            </Row>
          )}
          <Row label="Message" field="message" errors={fieldErrors}>
            <TemplateInput
              multiline
              field="message"
              testId="builder-notify-message"
              value={step.message}
              paths={paths}
              onChange={(message) => set("message", (s) => ({ ...s, message }) as Step)}
            />
          </Row>
        </>
      );
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A role or one of the client's people. */
function PersonPicker({
  value,
  onChange,
  members,
  field,
  testId,
  allowDefault,
  allowLead,
}: {
  value: string | undefined;
  onChange(value: string | undefined): void;
  members: readonly Member[];
  field: string;
  testId: string;
  allowDefault?: string;
  /** v0.12 W1-C: a person step may be a lead check, for the client's lead. */
  allowLead?: boolean;
}) {
  const known =
    value === undefined ||
    ["client_admin", "client_user", "operator"].includes(value) ||
    (allowLead === true && value === "lead") ||
    members.some((m) => m.userId === value);
  return (
    <SmallSelect
      data-field={field}
      data-testid={testId}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    >
      {allowDefault ? <option value="">{allowDefault}</option> : null}
      <option value="client_admin">Client admin</option>
      <option value="client_user">Client user</option>
      <option value="operator">Operator</option>
      {allowLead ? <option value="lead">The client's lead</option> : null}
      {members.map((m) => (
        <option key={m.userId} value={m.userId}>
          {m.name ?? m.email}
        </option>
      ))}
      {known ? null : <option value={value}>{value}</option>}
    </SmallSelect>
  );
}

// ── Approval ─────────────────────────────────────────────────────────────────────────────────────

function ApprovalSection(props: InspectorProps & { step: Step; set: SetStep }) {
  const { step, env, set, members, errors } = props;
  const option = approvalOption(step, env);
  if (!option || (step.kind !== "skill" && step.kind !== "action")) return null;
  const approval = step.approval ?? { required: "required" as const, onReject: "stop" as const };
  const fieldErrors = errorsFor(errors, step.id);
  // Switching approval back on is always allowed; switching it off only where it may be skipped.
  const locked = option.required && !option.canSkip;
  const tools = option.writes.map((t) => t.id).join(", ");
  return (
    <Section title="Approval">
      <p className="text-sm text-ink">
        This step changes the client's tools ({tools}). It waits for a person unless you switch
        approval off.
      </p>
      <Row label="" field="approval.required" errors={fieldErrors}>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            className="size-4 accent-slate"
            type="checkbox"
            data-field="approval.required"
            data-testid="builder-approval-toggle"
            checked={option.required}
            disabled={locked}
            onChange={(e) =>
              set(
                "approval",
                (s) =>
                  ({
                    ...s,
                    approval: {
                      ...approval,
                      required: e.target.checked ? "required" : "not_required",
                    },
                  }) as Step,
              )
            }
          />
          Needs approval
          {option.automatic ? <Badge tone="accent">Runs automatically</Badge> : null}
        </label>
      </Row>
      {option.reason ? (
        <p className="text-xs text-ink-muted" data-testid="builder-approval-reason">
          {option.required ? "Run without approval isn't available: " : "Not allowed here: "}
          {option.reason}
        </p>
      ) : null}
      {option.required ? (
        <div className="grid grid-cols-1 gap-3">
          <Row label="Approver" field="approval.approver" errors={fieldErrors}>
            <PersonPicker
              field="approval.approver"
              testId="builder-approval-approver"
              value={approval.approver}
              members={members}
              allowDefault="Agent default"
              onChange={(v) =>
                set("approval", (s) => {
                  const { approver: _old, ...rest } = approval;
                  return { ...s, approval: v ? { ...rest, approver: v } : rest } as Step;
                })
              }
            />
          </Row>
          <Row label="If rejected" field="approval.onReject" errors={fieldErrors}>
            <SmallSelect
              data-field="approval.onReject"
              value={approval.onReject}
              onChange={(e) =>
                set(
                  "approval",
                  (s) =>
                    ({
                      ...s,
                      approval: { ...approval, onReject: e.target.value as "stop" | "continue" },
                    }) as Step,
                )
              }
            >
              <option value="stop">Stop the run</option>
              <option value="continue">Go on</option>
            </SmallSelect>
          </Row>
        </div>
      ) : null}
    </Section>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

function settingText(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function SettingsSection(props: InspectorProps & { step: Step; set: SetStep }) {
  const { step, ctx, bundle, template, set } = props;
  if (step.kind !== "skill") return null;
  const skill = lookupSkill(step.skill, ctx);
  if (!skill || skill.settings.length === 0) return null;
  const agentOverrides =
    bundle.definition.skills.find((s) => s.skill === step.skill)?.settings ?? {};
  const templateStep = template ? findTemplateStep(template.workflow, step.id) : undefined;
  const templateAgent =
    template?.bundle.definition.skills.find((s) => s.skill === step.skill)?.settings ?? {};

  const setValue = (key: string, value: unknown) =>
    set(`setting:${key}`, (s) => {
      if (s.kind !== "skill") return s;
      const next = { ...(s.settings ?? {}) };
      if (value === undefined) delete next[key];
      else next[key] = value;
      const { settings: _old, ...rest } = s;
      return Object.keys(next).length ? { ...rest, settings: next } : rest;
    });

  return (
    <Section title="Settings">
      <p className="text-xs text-ink-muted">
        Empty means the agent's setting, else the skill's default.
      </p>
      {skill.settings.map((setting) => {
        const own = step.settings?.[setting.key];
        const fallback = agentOverrides[setting.key] ?? setting.default;
        const templateValue = template
          ? ((templateStep?.kind === "skill" ? templateStep.settings?.[setting.key] : undefined) ??
            templateAgent[setting.key] ??
            setting.default)
          : undefined;
        const effective = own ?? fallback;
        const customized =
          template !== null && JSON.stringify(effective) !== JSON.stringify(templateValue);
        return (
          <Row
            key={setting.key}
            label={setting.label}
            field={`settings.${setting.key}`}
            errors={errorsFor(props.errors, step.id)}
            aside={
              customized ? (
                <Badge tone="accent" testId={`builder-setting-${setting.key}-customized`}>
                  Customized
                </Badge>
              ) : null
            }
            hint={
              template ? (
                <span data-testid={`builder-setting-${setting.key}-template`}>
                  Template: {settingText(templateValue)}
                </span>
              ) : undefined
            }
          >
            <SettingControl
              setting={setting}
              value={own}
              placeholder={settingText(fallback)}
              onChange={(v) => setValue(setting.key, v)}
            />
          </Row>
        );
      })}
    </Section>
  );
}

function SettingControl({
  setting,
  value,
  placeholder,
  onChange,
}: {
  setting: SkillSetting;
  value: unknown;
  placeholder: string;
  onChange(v: unknown): void;
}) {
  const field = `settings.${setting.key}`;
  const testId = `builder-setting-${setting.key}`;
  if (setting.type === "boolean" || setting.type === "enum") {
    const options = setting.type === "boolean" ? ["true", "false"] : (setting.options ?? []);
    return (
      <SmallSelect
        data-field={field}
        data-testid={testId}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : setting.type === "boolean" ? v === "true" : v);
        }}
      >
        <option value="">Default ({placeholder})</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {setting.type === "boolean" ? (o === "true" ? "Yes" : "No") : o}
          </option>
        ))}
      </SmallSelect>
    );
  }
  return (
    <SmallInput
      data-field={field}
      data-testid={testId}
      value={value === undefined ? "" : String(value)}
      placeholder={placeholder}
      onChange={(e) => {
        const text = e.target.value;
        if (text === "") onChange(undefined);
        else onChange(setting.type === "number" ? parseNumberText(text) : text);
      }}
    />
  );
}

// ── Client timeline ──────────────────────────────────────────────────────────────────────────────

function TimelineSection({ step, set }: { step: Step; set: SetStep }) {
  const visible = isClientVisible(step);
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
            placeholder={clientLabel({ ...step, client: undefined })}
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

// ── Forks ────────────────────────────────────────────────────────────────────────────────────────

const OPS: { op: RuleOp; label: string }[] = [
  { op: ">", label: ">" },
  { op: ">=", label: "≥" },
  { op: "<", label: "<" },
  { op: "<=", label: "≤" },
  { op: "=", label: "=" },
  { op: "!=", label: "≠" },
  { op: "contains", label: "contains" },
  { op: "in", label: "in" },
  { op: "is", label: "is" },
  { op: "exists", label: "exists" },
];

/** What a rule's value box holds: numbers and true/false/null as such, lists for `in`. */
export function parseRuleValue(text: string, op: RuleOp): unknown {
  const one = (t: string): unknown => {
    const s = t.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null") return null;
    return t;
  };
  if (op === "in") {
    return text
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(one);
  }
  return text === "" ? undefined : one(text);
}

export function ruleValueText(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Rule rows for one path or a trigger filter: IF field op value, AND/OR, + Add condition. */
function RulesEditor({
  rules,
  onChange,
  paths,
  errors,
  prefix,
  testPrefix,
}: {
  rules: Rules;
  onChange(rules: Rules, key: string): void;
  paths: readonly PathOption[];
  errors: FieldErrors;
  /** "when" for a path, "on.filter" for a trigger. */
  prefix: string;
  testPrefix: string;
}) {
  const setRule = (i: number, rule: Rule, key: string) =>
    onChange({ ...rules, rules: rules.rules.map((r, j) => (j === i ? rule : r)) }, key);
  return (
    <div className="flex flex-col gap-2">
      {rules.rules.map((rule, i) => {
        const at = `${prefix}.rules.${i}`;
        const messages = [
          ...errors.at(`${at}.field`),
          ...errors.at(`${at}.op`),
          ...errors.at(`${at}.value`),
        ];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids; their order is their identity.
          <div key={i} className="flex flex-col gap-1" data-testid={`${testPrefix}-rule-${i}`}>
            <div className="flex items-center gap-1.5">
              <span className="w-7 shrink-0 eyebrow text-ink-muted">
                {i === 0 ? "IF" : rules.match === "any" ? "OR" : "AND"}
              </span>
              <div className="min-w-0 flex-1">
                <TemplateInput
                  field={`${at}.field`}
                  testId={`${testPrefix}-rule-${i}-field`}
                  value={rule.field}
                  paths={paths}
                  placeholder="{{steps.…}}"
                  invalid={errors.at(`${at}.field`).length > 0}
                  onChange={(field) => setRule(i, { ...rule, field }, `${at}.field`)}
                />
              </div>
            </div>
            <div className="flex items-center gap-1.5 pl-8">
              <SmallSelect
                aria-label="Operator"
                data-field={`${at}.op`}
                data-testid={`${testPrefix}-rule-${i}-op`}
                value={rule.op}
                className="w-28 shrink-0"
                onChange={(e) => {
                  const op = e.target.value as RuleOp;
                  const { value: _v, ...rest } = rule;
                  setRule(i, op === "exists" ? { ...rest, op } : { ...rule, op }, `${at}.op`);
                }}
              >
                {OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </SmallSelect>
              {rule.op === "exists" ? (
                <span className="flex-1" />
              ) : (
                <SmallInput
                  aria-label="Value"
                  data-field={`${at}.value`}
                  data-testid={`${testPrefix}-rule-${i}-value`}
                  value={ruleValueText(rule.value)}
                  invalid={errors.at(`${at}.value`).length > 0}
                  className="min-w-0 flex-1 font-mono"
                  onChange={(e) => {
                    const value = parseRuleValue(e.target.value, rule.op);
                    const { value: _v, ...rest } = rule;
                    setRule(i, value === undefined ? rest : { ...rule, value }, `${at}.value`);
                  }}
                />
              )}
              <button
                type="button"
                aria-label="Remove condition"
                data-testid={`${testPrefix}-rule-${i}-remove`}
                onClick={() =>
                  onChange({ ...rules, rules: rules.rules.filter((_, j) => j !== i) }, "rules")
                }
                className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm shrink-0 text-ink-muted hover:text-ink"
              >
                <Icon name="close" />
              </button>
            </div>
            {messages.map((m) => (
              <span key={m} className="pl-8 text-xs text-risk">
                {m}
              </span>
            ))}
          </div>
        );
      })}
      {errors.at(`${prefix}.rules`).map((m) => (
        <span key={m} className="text-xs text-risk">
          {m}
        </span>
      ))}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-field={`${prefix}.rules`}
          data-testid={`${testPrefix}-add-condition`}
          onClick={() =>
            onChange(
              { ...rules, rules: [...rules.rules, { field: "", op: "=", value: "" }] },
              "rules",
            )
          }
          className="ds-btn ds-btn--link text-sm"
        >
          <Icon name="add" />
          Add condition
        </button>
        {rules.rules.length > 1 ? (
          <SmallSelect
            aria-label="Match"
            data-testid={`${testPrefix}-match`}
            value={rules.match}
            className="w-36"
            onChange={(e) =>
              onChange({ ...rules, match: e.target.value as "all" | "any" }, "match")
            }
          >
            <option value="all">Match all</option>
            <option value="any">Match any</option>
          </SmallSelect>
        ) : null}
      </div>
    </div>
  );
}

function ForkEditor(props: InspectorProps & { step: ForkStep; paths: PathOption[]; set: SetStep }) {
  const { step, paths, set, errors, onDelete } = props;
  const setPaths = (key: string, fn: (paths: ForkPath[]) => ForkPath[]) =>
    set(key, (s) => (s.kind === "fork" ? { ...s, paths: fn(s.paths) } : s));
  const setPath = (id: string, key: string, fn: (p: ForkPath) => ForkPath) =>
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
          Remove fork
        </Button>
      </div>
      <p className="text-xs text-ink-muted">
        Fields come from earlier steps' outputs and the trigger, such as a total, a vendor or a
        person's answer.
      </p>
    </div>
  );
}

// ── Trigger ──────────────────────────────────────────────────────────────────────────────────────

function triggerPaths(workflow: Workflow, ctx: TypingContext): PathOption[] {
  // The scope at a step placed first is exactly the trigger's payload: what a filter can test.
  const probe: Workflow = {
    ...workflow,
    steps: [{ id: "trigger-probe", kind: "stop", name: "", status: "succeeded" }],
  };
  return pathsAt(probe, "trigger-probe", ctx);
}

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
  const paths = useMemo(() => triggerPaths(workflow, ctx), [workflow, ctx]);
  const events = data.events;
  return (
    <div className="flex flex-col gap-4">
      <Heading
        eyebrow="Step 1 · Trigger"
        title="How it starts"
        intro="One trigger starts each run of this workflow."
      />
      <NodeErrors errors={errors} node={trigger.id} />
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
            onTrigger(next as TriggerOn, "trigger:type");
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
              onChange={(e) => onTrigger({ ...on, event: e.target.value }, "trigger:event")}
            >
              {events.some((e) => e.type === on.event) ? null : (
                <option value={on.event}>{on.event}</option>
              )}
              {events.map((e) => (
                <option key={e.type} value={e.type}>
                  {e.type}
                </option>
              ))}
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
                onTrigger(
                  filter.rules.length ? { ...rest, filter } : rest,
                  `trigger:filter:${key}`,
                );
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
              onChange={(e) => onTrigger({ ...on, cron: e.target.value }, "trigger:cron")}
            />
          </Row>
          <Row label="Time zone" field="on.tz" errors={fieldErrors} hint="Empty: the client's">
            <SmallInput
              data-field="on.tz"
              value={on.tz ?? ""}
              onChange={(e) => {
                const { tz: _tz, ...rest } = on;
                onTrigger(e.target.value ? { ...rest, tz: e.target.value } : rest, "trigger:tz");
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
            onChange={(v) => onTrigger({ ...on, input: isRecord(v) ? v : {} }, "trigger:input")}
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
            onChange={(e) => onTrigger({ ...on, command: e.target.value }, "trigger:command")}
          />
        </Row>
      ) : null}
    </div>
  );
}
