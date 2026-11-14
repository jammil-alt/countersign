// The checks panel (ARCHITECTURE §10.14 "Checks"): any step may carry checks, run in a fixed
// order: confer (advice from a second model with a fixed focus, or from up to three people, each
// with its own condition and deadline), then approval (approvers in turn, any or all, and what
// happens when nobody answers), then the step's write, then notices (to the client's team or
// ours; an urgent one needs a "Seen" in time). Conditions are rule rows over the run, never a
// model. Approval stays on by default (invariant 8): switching it off, limiting it to some runs
// and going ahead with no answer are loosening, offered only where the operator may loosen a
// write (a client agent, a connection that allows `auto`, an agent that acts), with the reason
// the Approval control has always given.
import { type PathOption, processes, type Rules } from "@countersign/core";
import type { ReactNode } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { TextArea } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Badge, Button } from "../../ui/primitives";
import { toolLabel } from "../workflow/labels";
import { type BuilderData, connectorName } from "./catalog";
import { DeadlineEditor, ThenSelect } from "./deadline";
import { type FieldErrors, Row, SmallInput, SmallSelect, TemplateInput } from "./fields";
import {
  type ApprovalCheck,
  type ApprovalEnv,
  approvalOption,
  defaultApproval,
  defaultDeadline,
  looseningBlocked,
  type Step,
} from "./model";
import { type People, PeopleList, PersonPicker } from "./people";
import { RulesEditor } from "./rules";

type Checks = processes.Checks;
type ConferCheck = processes.ConferCheck;
type Conferee = processes.Conferee;
type NotifyCheck = processes.NotifyCheck;

export type SetStep = (key: string, fn: (s: Step) => Step) => void;

/** A check's condition: absent means always; "Only when…" adds rule rows. */
export function ConditionBlock({
  rules,
  onChange,
  prefix,
  testPrefix,
  paths,
  errors,
  blocked,
  addLabel = "Only when…",
}: {
  rules: Rules | undefined;
  onChange(rules: Rules | undefined, key: string): void;
  prefix: string;
  testPrefix: string;
  paths: readonly PathOption[];
  errors: FieldErrors;
  /** Why a condition can't be added here (loosening a write); null when it can. */
  blocked?: string | null;
  addLabel?: string;
}) {
  if (!rules) {
    if (blocked) return null;
    return (
      <button
        type="button"
        data-field={prefix}
        data-testid={`${testPrefix}-add`}
        className="ds-btn ds-btn--link self-start text-sm"
        onClick={() =>
          onChange({ match: "all", rules: [{ field: "", op: "=", value: "" }] }, prefix)
        }
      >
        <Icon name="add" />
        {addLabel}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-line p-2" data-testid={testPrefix}>
      <div className="flex items-center justify-between">
        <span className="eyebrow text-ink-muted">Only when</span>
        <button
          type="button"
          data-testid={`${testPrefix}-always`}
          className="ds-btn ds-btn--link text-xs"
          onClick={() => onChange(undefined, prefix)}
        >
          Always
        </button>
      </div>
      <RulesEditor
        rules={rules}
        paths={paths}
        errors={errors}
        prefix={prefix}
        testPrefix={testPrefix}
        onChange={(next, key) => onChange(next.rules.length ? next : undefined, `${prefix}:${key}`)}
      />
    </div>
  );
}

// ── Notices ──────────────────────────────────────────────────────────────────────────────────────

const NOTIFY_CHANNELS: { value: NotifyCheck["channel"]; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "email", label: "Email" },
  { value: "sms", label: "Text message" },
];

export function newNotice(): NotifyCheck {
  return { to: ["client_admin"], channel: "inbox", message: "" };
}

/**
 * One notice: who (the client's team or ours, never anyone else: that is a write), where, the
 * message, an optional condition, and the urgent option with the time it must be seen in.
 */
// DECISION: recipients are picked from the roles and the client's team, never directory contacts:
// a message to a vendor or a customer is a write, behind approval (§10.14 "Checks").
export function NotifyEditor({
  value,
  onChange,
  prefix,
  testId,
  errors,
  people,
  paths,
}: {
  value: NotifyCheck;
  onChange(value: NotifyCheck, key: string): void;
  /** "notify" for a notify step, "checks.notify.0" for a check. */
  prefix: string;
  testId: string;
  errors: FieldErrors;
  people: People;
  paths: readonly PathOption[];
}) {
  const set = (patch: Partial<NotifyCheck>, key: string) => onChange({ ...value, ...patch }, key);
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <Row label="To" field={`${prefix}.to`} errors={errors}>
        <PeopleList
          field={`${prefix}.to`}
          testId={`${testId}-to`}
          value={value.to}
          people={people}
          max={10}
          allowLead
          invalid={errors.at(`${prefix}.to`).length > 0}
          onChange={(to) => set({ to }, `${prefix}.to`)}
        />
      </Row>
      <Row label="Where" field={`${prefix}.channel`} errors={errors}>
        <SmallSelect
          data-field={`${prefix}.channel`}
          data-testid={`${testId}-channel`}
          value={value.channel}
          onChange={(e) =>
            set({ channel: e.target.value as NotifyCheck["channel"] }, `${prefix}.channel`)
          }
        >
          {NOTIFY_CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </SmallSelect>
      </Row>
      <Row label="Message" field={`${prefix}.message`} errors={errors}>
        <TemplateInput
          multiline
          field={`${prefix}.message`}
          testId={`${testId}-message`}
          value={value.message}
          paths={paths}
          invalid={errors.at(`${prefix}.message`).length > 0}
          onChange={(message) => set({ message }, `${prefix}.message`)}
        />
      </Row>
      <ConditionBlock
        rules={value.when}
        prefix={`${prefix}.when`}
        testPrefix={`${testId}-when`}
        paths={paths}
        errors={errors}
        onChange={(when, key) => {
          const { when: _w, ...rest } = value;
          onChange(when ? { ...rest, when } : rest, key);
        }}
      />
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="size-4 accent-slate"
          data-field={`${prefix}.urgent`}
          data-testid={`${testId}-urgent`}
          checked={value.urgent !== undefined}
          onChange={(e) => {
            const { urgent: _u, ...rest } = value;
            onChange(
              e.target.checked
                ? { ...rest, urgent: { ackWithin: "30 minutes", ifNoAnswer: "stop" } }
                : rest,
              `${prefix}.urgent`,
            );
          }}
        />
        Urgent
      </label>
      {value.urgent ? (
        <div
          className="flex flex-col gap-3 border-l-2 border-signal pl-3"
          data-testid={`${testId}-urgent-fields`}
        >
          <p className="text-xs text-ink-muted">
            Sent at once whatever the hours, by text too. Someone must mark it Seen in time.
          </p>
          <Row
            label="Must be seen within"
            field={`${prefix}.urgent.ackWithin`}
            errors={errors}
            hint='e.g. "30 minutes"'
          >
            <SmallInput
              data-field={`${prefix}.urgent.ackWithin`}
              data-testid={`${testId}-ack`}
              value={value.urgent.ackWithin}
              onChange={(e) =>
                value.urgent &&
                set(
                  { urgent: { ...value.urgent, ackWithin: e.target.value } },
                  `${prefix}.urgent.ackWithin`,
                )
              }
            />
          </Row>
          <ThenSelect
            label="If nobody marks it Seen"
            value={value.urgent.ifNoAnswer}
            field={`${prefix}.urgent.ifNoAnswer`}
            testId={`${testId}-urgent-then`}
            errors={errors}
            people={people}
            proceedBlocked={null}
            onChange={(ifNoAnswer, key) =>
              value.urgent && set({ urgent: { ...value.urgent, ifNoAnswer } }, key)
            }
          />
        </div>
      ) : null}
    </div>
  );
}

// ── The panel ────────────────────────────────────────────────────────────────────────────────────

/** A step's checks with empty parts dropped (a step with none carries no `checks`). */
function withChecks(step: Step, checks: Checks): Step {
  const out: Checks = {};
  if (checks.confer) out.confer = checks.confer;
  if (checks.approval) out.approval = checks.approval;
  if (checks.notify?.length) out.notify = checks.notify;
  const { checks: _old, ...rest } = step;
  return (Object.keys(out).length ? { ...rest, checks: out } : rest) as Step;
}

function Part({
  title,
  aside,
  children,
  testId,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-ink">{title}</h4>
        {aside}
      </div>
      {children}
    </div>
  );
}

export interface ChecksPanelProps {
  step: Step;
  set: SetStep;
  env: ApprovalEnv;
  people: People;
  data: BuilderData;
  errors: FieldErrors;
  /** What a confer or approval condition reads: before a write, not the step's own output. */
  pathsBefore(confer: number): PathOption[];
  /** What a notice reads: the step's output too (notices run after it). */
  pathsAfter: PathOption[];
}

/** Confer, approval and notices, in the order they run. */
export function ChecksPanel(props: ChecksPanelProps) {
  const { step, set } = props;
  const checks = step.checks ?? {};
  const setChecks = (key: string, fn: (c: Checks) => Checks) =>
    set(`checks:${key}`, (s) => withChecks(s, fn(s.checks ?? {})));
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4" data-testid="builder-checks">
      <div>
        <h3 className="eyebrow text-ink-muted">Checks</h3>
        <p className="mt-1 text-xs text-ink-muted">
          In this order: a second opinion, then approval, then the step, then notices.
        </p>
      </div>
      <ConferPart {...props} confer={checks.confer} setChecks={setChecks} />
      <ApprovalPart {...props} approval={checks.approval} setChecks={setChecks} />
      <NoticesPart {...props} notify={checks.notify ?? []} setChecks={setChecks} />
    </section>
  );
}

type SetChecks = (key: string, fn: (c: Checks) => Checks) => void;

/**
 * Models: xAI and Gemini. The AI reviewer's model, from GET /api/ops/models (each with its
 * provider in its label), over the default: a model other than the step's.
 */
function ReviewerModel({
  field,
  testId,
  errors,
  value,
  onChange,
}: {
  field: string;
  testId: string;
  errors: FieldErrors;
  value: string;
  onChange(id: string): void;
}) {
  const models = useApi(apiRoutes.opsModels, { life: "catalog" });
  const options = models.data?.models ?? [];
  return (
    <Row
      label="Model"
      field={`${field}.id`}
      errors={errors}
      hint={
        models.error
          ? "Couldn't load the models; the reviewer keeps its own."
          : "Price per million tokens, in and out."
      }
    >
      <SmallSelect
        data-field={`${field}.id`}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">A different model from the step's</option>
        {value && !options.some((m) => m.id === value) ? (
          <option value={value}>A model no longer offered</option>
        ) : null}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} · ${m.inputPerMtok} / ${m.outputPerMtok}
          </option>
        ))}
      </SmallSelect>
    </Row>
  );
}

function ConferPart(
  props: ChecksPanelProps & { confer: ConferCheck | undefined; setChecks: SetChecks },
) {
  const { confer, setChecks, errors, people } = props;
  const setConfer = (key: string, next: ConferCheck | undefined) =>
    setChecks(`confer:${key}`, (c) => {
      const { confer: _c, ...rest } = c;
      return next ? { ...rest, confer: next } : rest;
    });
  if (!confer) {
    return (
      <Part title="Second opinion" testId="builder-confer">
        <p className="text-xs text-ink-muted">
          Ask a second model with a fixed focus, or someone on the client's People list, for advice
          on the result. Advice only: it never changes the result or approves a change.
        </p>
        <Button
          size="sm"
          className="self-start"
          data-testid="builder-confer-add"
          onClick={() => setConfer("add", { with: [{ ai: { focus: "" } }] })}
        >
          <Icon name="add" />
          Add a second opinion
        </Button>
      </Part>
    );
  }
  const setWith = (key: string, fn: (w: Conferee[]) => Conferee[]) =>
    setConfer(key, { ...confer, with: fn(confer.with) });
  const setOne = (i: number, key: string, c: Conferee) =>
    setWith(`${i}:${key}`, (w) => w.map((x, j) => (j === i ? c : x)));
  return (
    <Part
      title="Second opinion"
      testId="builder-confer"
      aside={
        <button
          type="button"
          data-testid="builder-confer-remove"
          className="ds-btn ds-btn--link text-xs"
          onClick={() => setConfer("remove", undefined)}
        >
          Remove
        </button>
      }
    >
      <p className="text-xs text-ink-muted">
        Advice only. The client's timeline shows it as its own step, never its model or prompt.
      </p>
      <ConditionBlock
        rules={confer.when}
        prefix="checks.confer.when"
        testPrefix="builder-confer-when"
        paths={props.pathsBefore(0)}
        errors={errors}
        onChange={(when, key) => {
          const { when: _w, ...rest } = confer;
          setConfer(key, when ? { ...rest, when } : rest);
        }}
      />
      <ol className="flex flex-col gap-3">
        {confer.with.map((c, i) => {
          const at = `checks.confer.with.${i}`;
          const t = `builder-confer-${i}`;
          const isAi = "ai" in c;
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: reviewers have no ids; their place is their identity (confer.<n>).
              key={i}
              className="flex flex-col gap-3 rounded-sm border border-line p-2"
              data-testid={t}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink-muted figures">{i + 1}.</span>
                <SmallSelect
                  aria-label="Who gives the advice"
                  data-testid={`${t}-type`}
                  value={isAi ? "ai" : "person"}
                  className="flex-1"
                  onChange={(e) =>
                    setOne(
                      i,
                      "type",
                      e.target.value === "ai"
                        ? { ai: { focus: "" } }
                        : { person: "client_admin", deadline: defaultDeadline("1 day") },
                    )
                  }
                >
                  <option value="ai">A second model</option>
                  <option value="person">A person</option>
                </SmallSelect>
                {isAi ? null : <Badge tone="person">Person</Badge>}
                <button
                  type="button"
                  aria-label="Remove this reviewer"
                  data-testid={`${t}-remove`}
                  disabled={confer.with.length === 1}
                  className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink disabled:opacity-40"
                  onClick={() => setWith(`${i}:remove`, (w) => w.filter((_, j) => j !== i))}
                >
                  <Icon name="close" />
                </button>
              </div>
              {"ai" in c ? (
                <>
                  <Row
                    label="What it checks"
                    field={`${at}.ai.focus`}
                    errors={errors}
                    hint="Written here, not from a template: it becomes the reviewer's instructions."
                  >
                    <TextArea
                      rows={2}
                      data-field={`${at}.ai.focus`}
                      data-testid={`${t}-focus`}
                      value={c.ai.focus}
                      placeholder="Do these lines add up to the bill's total?"
                      invalid={errors.at(`${at}.ai.focus`).length > 0}
                      onChange={(e) =>
                        setOne(i, "focus", { ...c, ai: { ...c.ai, focus: e.target.value } })
                      }
                    />
                  </Row>
                  <ReviewerModel
                    field={`${at}.ai.model`}
                    testId={`${t}-model`}
                    errors={errors}
                    value={c.ai.model?.id ?? ""}
                    onChange={(id) => {
                      const { model: _m, ...ai } = c.ai;
                      setOne(i, "model", { ...c, ai: id ? { ...ai, model: { id } } : ai });
                    }}
                  />
                </>
              ) : (
                <>
                  <Row label="Person" field={`${at}.person`} errors={errors}>
                    <PersonPicker
                      field={`${at}.person`}
                      testId={`${t}-person`}
                      value={c.person}
                      people={people}
                      allowLead
                      onChange={(v) => setOne(i, "person", { ...c, person: v ?? "client_admin" })}
                    />
                  </Row>
                  <DeadlineEditor
                    value={c.deadline}
                    prefix={`${at}.deadline`}
                    testId={`${t}-deadline`}
                    errors={errors}
                    people={people}
                    proceedBlocked={null}
                    afterLabel="Gives them"
                    onChange={(deadline, key) => setOne(i, key, { ...c, deadline })}
                  />
                </>
              )}
              {i > 0 || c.when ? (
                <ConditionBlock
                  rules={c.when}
                  prefix={`${at}.when`}
                  testPrefix={`${t}-when`}
                  paths={props.pathsBefore(i)}
                  errors={errors}
                  addLabel="Only when… (e.g. the one before disagreed)"
                  onChange={(when, key) => {
                    const { when: _w, ...rest } = c;
                    setOne(i, key, (when ? { ...rest, when } : rest) as Conferee);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {confer.with.length < 3 ? (
        <Button
          size="sm"
          className="self-start"
          data-testid="builder-confer-add-person"
          onClick={() =>
            setWith("add", (w) => [
              ...w,
              { person: "client_admin", deadline: defaultDeadline("1 day") },
            ])
          }
        >
          <Icon name="add" />
          Ask a person too
        </Button>
      ) : null}
    </Part>
  );
}

const MODES: { value: ApprovalCheck["mode"]; label: string }[] = [
  { value: "in_turn", label: "One at a time, in order" },
  { value: "any", label: "All at once: the first answer decides" },
  { value: "all", label: "All at once: everyone must approve" },
];

function ApprovalPart(
  props: ChecksPanelProps & { approval: ApprovalCheck | undefined; setChecks: SetChecks },
) {
  const { step, env, approval, setChecks, errors, people, data } = props;
  const option = approvalOption(step, env);
  const writes = option !== null;
  // A skill that contacts people (a reach-out) is held to approval as a write is (invariant 8).
  // Core's rule (`stepReaches`), as the validator holds it. A conversation's messages are signed
  // under its own message settings, so it is not offered an approval here.
  const reaches = !writes && step.kind === "skill" && processes.stepReaches(step, env.ctx);
  const guarded = writes || reaches;
  // A write with no approval check waits for the default approver (invariant 8).
  const current: ApprovalCheck | undefined = approval ?? (guarded ? defaultApproval() : undefined);
  const setApproval = (key: string, next: ApprovalCheck | undefined) =>
    setChecks(`approval:${key}`, (c) => {
      const { approval: _a, ...rest } = c;
      return next ? { ...rest, approval: next } : rest;
    });
  // Loosening a write (off, some runs only, go ahead with no answer) needs the operator's
  // conditions; on a step that writes nothing it isn't loosening, but "off" means no check at all.
  const blocked = writes ? option.reason : reaches ? looseningBlocked([], env) : null;
  const undo = writes
    ? option.writes.map((t) => processes.describeUndo(t)).find((d) => d?.warning)?.warning
    : null;

  if (!current) {
    // DECISION (web, wave 3b): the empty state says what this kind of step changes. A process
    // step's writes are approved inside its process; a conversation's messages are signed under
    // its message settings, which already do approval's job, so it isn't offered one here.
    if (step.kind === "conversation") {
      return (
        <Part title="Approval" testId="builder-approval">
          <p className="text-xs text-ink-muted" data-testid="builder-approval-conversation">
            This conversation's messages are signed under its message settings above: who says yes
            to the first message, and to the ones after it.
          </p>
        </Part>
      );
    }
    return (
      <Part title="Approval" testId="builder-approval">
        <p className="text-xs text-ink-muted" data-testid="builder-approval-none">
          {step.kind === "process"
            ? "This step runs another process. Its changes to the client's tools are approved inside that process, by its own steps' approvals. Add an approval if someone should say yes before it starts."
            : step.kind === "write"
              ? // Skill model (2026-11-10): "Save to records" starts with approval off.
                "This step saves to our records, not the client's tools, so approval is off by default. Add one if someone should say yes first."
              : "This step changes nothing in the client's tools. Add an approval if someone should say yes before the run goes on."}
        </p>
        <Button
          size="sm"
          className="self-start"
          data-testid="builder-approval-add"
          onClick={() => setApproval("add", defaultApproval())}
        >
          <Icon name="add" />
          Add an approval
        </Button>
      </Part>
    );
  }

  const required = current.required !== "not_required";
  const locked = guarded && required && blocked !== null;
  const tools = writes
    ? [
        ...new Set(
          option.writes.map((t) =>
            [t.connector ? connectorName(data, t.connector) : null, toolLabel(t.id)]
              .filter(Boolean)
              .join(": "),
          ),
        ),
      ].join(", ")
    : "";
  const approvers = current.approvers;
  const setField = <K extends keyof ApprovalCheck>(k: K, v: ApprovalCheck[K], key: string = k) =>
    setApproval(key, { ...current, [k]: v });

  return (
    <Part
      title="Approval"
      testId="builder-approval"
      aside={
        guarded ? null : (
          <button
            type="button"
            data-testid="builder-approval-remove"
            className="ds-btn ds-btn--link text-xs"
            onClick={() => setApproval("remove", undefined)}
          >
            Remove
          </button>
        )
      }
    >
      {writes ? (
        <p className="text-sm text-ink">
          This step changes the client's tools ({tools}). It waits for someone to approve unless you
          switch approval off.
        </p>
      ) : reaches ? (
        <p className="text-sm text-ink">
          This step contacts people outside the client's team. It waits for someone to approve
          unless you switch approval off.
        </p>
      ) : null}
      {guarded ? (
        <Row label="" field="checks.approval.required" errors={errors}>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              className="size-4 accent-slate"
              type="checkbox"
              data-field="checks.approval.required"
              data-testid="builder-approval-toggle"
              checked={required}
              disabled={locked}
              onChange={(e) => setField("required", e.target.checked ? "required" : "not_required")}
            />
            Needs approval
            {!required && blocked === null ? <Badge tone="accent">On its own</Badge> : null}
          </label>
        </Row>
      ) : null}
      {blocked ? (
        <p className="text-xs text-ink-muted" data-testid="builder-approval-reason">
          {required ? "Run without approval isn't available: " : "Not allowed here: "}
          {blocked}
        </p>
      ) : null}
      {required ? (
        <>
          <Row label="Who approves" field="checks.approval.mode" errors={errors}>
            <SmallSelect
              data-field="checks.approval.mode"
              data-testid="builder-approval-mode"
              value={current.mode}
              onChange={(e) => setField("mode", e.target.value as ApprovalCheck["mode"])}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </SmallSelect>
          </Row>
          {approvers ? (
            <ol className="flex flex-col gap-2" data-testid="builder-approvers">
              {approvers.map((a, i) => {
                const at = `checks.approval.approvers.${i}`;
                const t = `builder-approver-${i}`;
                const setApprover = (key: string, next: (typeof approvers)[number]) =>
                  setField(
                    "approvers",
                    approvers.map((x, j) => (j === i ? next : x)),
                    `approvers.${i}.${key}`,
                  );
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: approvers are asked in this order; it is their identity.
                    key={i}
                    className="flex flex-col gap-2 rounded-sm border border-line p-2"
                    data-testid={t}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-muted figures">{i + 1}.</span>
                      <PersonPicker
                        label={`Approver ${i + 1}`}
                        field={`${at}.who`}
                        testId={`${t}-who`}
                        value={a.who}
                        people={people}
                        allowLead
                        allowDefault="The default approver"
                        className="flex-1"
                        onChange={(who) => {
                          const { who: _w, ...rest } = a;
                          setApprover("who", who ? { ...rest, who } : rest);
                        }}
                      />
                      <button
                        type="button"
                        aria-label="Remove this approver"
                        data-testid={`${t}-remove`}
                        className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink"
                        onClick={() => {
                          const left = approvers.filter((_, j) => j !== i);
                          const { approvers: _a, ...rest } = current;
                          setApproval(
                            `approvers.${i}.remove`,
                            left.length ? { ...rest, approvers: left } : rest,
                          );
                        }}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-ink">
                      <input
                        type="checkbox"
                        className="size-4 accent-slate"
                        data-testid={`${t}-has-deadline`}
                        checked={a.deadline !== undefined}
                        onChange={(e) => {
                          const { deadline: _d, ...rest } = a;
                          setApprover(
                            "deadline",
                            e.target.checked
                              ? { ...rest, deadline: defaultDeadline("1 day") }
                              : rest,
                          );
                        }}
                      />
                      {current.mode === "in_turn"
                        ? "Give them a deadline, then ask the next"
                        : "Give them a deadline"}
                    </label>
                    {a.deadline ? (
                      <DeadlineEditor
                        value={a.deadline}
                        prefix={`${at}.deadline`}
                        testId={`${t}-deadline`}
                        errors={errors}
                        people={people}
                        proceedBlocked={blocked}
                        proceedWarning={undo}
                        afterLabel="Gives them"
                        onChange={(deadline, key) => setApprover(key, { ...a, deadline })}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-xs text-ink-muted" data-testid="builder-approval-default">
              The default approver: the step's, then the agent's, then the client's.
            </p>
          )}
          {(approvers?.length ?? 0) < 5 ? (
            <Button
              size="sm"
              className="self-start"
              data-testid="builder-approval-add-approver"
              onClick={() => setField("approvers", [...(approvers ?? []), { who: "client_admin" }])}
            >
              <Icon name="add" />
              {approvers ? "Add an approver" : "Name the approvers"}
            </Button>
          ) : null}
          <ThenSelect
            label="If nobody answers"
            value={current.ifNoAnswer}
            field="checks.approval.ifNoAnswer"
            testId="builder-approval-then"
            errors={errors}
            people={people}
            proceedBlocked={blocked}
            proceedWarning={undo}
            onChange={(ifNoAnswer, key) => setField("ifNoAnswer", ifNoAnswer, key)}
          />
          <Row label="If rejected" field="checks.approval.onReject" errors={errors}>
            <SmallSelect
              data-field="checks.approval.onReject"
              data-testid="builder-approval-reject"
              value={current.onReject}
              onChange={(e) => setField("onReject", e.target.value as "stop" | "continue")}
            >
              <option value="stop">Stop the run</option>
              <option value="continue">Go on</option>
            </SmallSelect>
          </Row>
          <ConditionBlock
            rules={current.when}
            prefix="checks.approval.when"
            testPrefix="builder-approval-when"
            paths={props.pathsBefore(step.checks?.confer?.with.length ?? 0)}
            errors={errors}
            blocked={blocked}
            addLabel="Only on some runs…"
            onChange={(when, key) => {
              const { when: _w, ...rest } = current;
              setApproval(key, when ? { ...rest, when } : rest);
            }}
          />
        </>
      ) : (
        <p className="text-xs text-ink-muted">It runs without waiting for anyone.</p>
      )}
    </Part>
  );
}

function NoticesPart(props: ChecksPanelProps & { notify: NotifyCheck[]; setChecks: SetChecks }) {
  const { notify, setChecks, errors, people } = props;
  const setNotify = (key: string, next: NotifyCheck[]) =>
    setChecks(`notify:${key}`, (c) => ({ ...c, notify: next }));
  return (
    <Part title="Notices" testId="builder-notices">
      {notify.length === 0 ? (
        <p className="text-xs text-ink-muted">
          Tell the client's team or ours when this step has run. Anyone else is a write, behind
          approval.
        </p>
      ) : null}
      {notify.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: notices have no ids; their place is their identity.
        <div key={i} className="flex flex-col gap-2 rounded-sm border border-line p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-muted">Notice {i + 1}</span>
            <button
              type="button"
              data-testid={`builder-notify-${i}-remove`}
              className="ds-btn ds-btn--link text-xs"
              onClick={() =>
                setNotify(
                  `${i}:remove`,
                  notify.filter((_, j) => j !== i),
                )
              }
            >
              Remove
            </button>
          </div>
          <NotifyEditor
            value={n}
            prefix={`checks.notify.${i}`}
            testId={`builder-notify-${i}`}
            errors={errors}
            people={people}
            paths={props.pathsAfter}
            onChange={(next, key) =>
              setNotify(
                key,
                notify.map((x, j) => (j === i ? next : x)),
              )
            }
          />
        </div>
      ))}
      {notify.length < 5 ? (
        <Button
          size="sm"
          className="self-start"
          data-testid="builder-notify-add"
          onClick={() => setNotify("add", [...notify, newNotice()])}
        >
          <Icon name="add" />
          Add a notice
        </Button>
      ) : null}
    </Part>
  );
}
