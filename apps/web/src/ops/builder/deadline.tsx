// The deadline editor (ARCHITECTURE §10.14 "Deadlines"): everything that waits (a person step, a
// conversation, an approver, a person conferee, an urgent notice's "Seen") has one shape: how long,
// on the clock or in the business hours of the person asked, reminders, what happens when nobody
// answers (stop, the default; go ahead; skip the step; ask someone else, with their own deadline)
// and who is told when it passes. Going ahead on a write's approval is loosening (invariant 8):
// it is offered only where the operator may loosen, with the reason when not.
import type { processes } from "@countersign/core";
import { useState } from "react";
import { type FieldErrors, Row, SmallInput, SmallSelect } from "./fields";
import { type People, PeopleList, PersonPicker } from "./people";

type Deadline = processes.Deadline;
type DeadlineThen = processes.DeadlineThen;

/** How deep "ask someone else" may nest in the builder (the schema has no limit). */
// DECISION: the builder offers two levels of escalation (ask someone, then someone else); a
// longer chain can still be written in the bundle and is shown, never cut.
const MAX_ESCALATION = 2;

const THEN_LABEL: Record<"stop" | "proceed" | "skip" | "escalate", string> = {
  stop: "Stop the run",
  proceed: "Go ahead as if they said yes",
  skip: "Skip this step and go on",
  escalate: "Ask someone else",
};

function thenKind(then: DeadlineThen): keyof typeof THEN_LABEL {
  return typeof then === "object" ? "escalate" : then;
}

/** A list typed as "1 day, 2 days". */
function listOf(text: string): string[] {
  return text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * A comma-separated list as it is typed: the text is kept while it is written ("1 hour, " is on
 * its way to a second item) and the list goes on at every change; an outside change (undo) shows.
 */
export function ListInput({
  value,
  onChange,
  field,
  testId,
}: {
  value: readonly string[];
  onChange(value: string[]): void;
  field: string;
  testId: string;
}) {
  const shown = value.join(", ");
  const [text, setText] = useState(shown);
  const [last, setLast] = useState(shown);
  if (shown !== last) {
    setLast(shown);
    if (listOf(text).join(", ") !== shown) setText(shown);
  }
  return (
    <SmallInput
      data-field={field}
      data-testid={testId}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = listOf(e.target.value);
        setLast(next.join(", "));
        onChange(next);
      }}
    />
  );
}

export interface ThenProps {
  value: DeadlineThen;
  onChange(value: DeadlineThen, key: string): void;
  /** The field path of this `ifNoAnswer`, e.g. "deadline.ifNoAnswer". */
  field: string;
  testId: string;
  errors: FieldErrors;
  people: People;
  /**
   * Null: going ahead is allowed. Text: why not (a write whose approval can't be loosened here);
   * the choice is shown but can't be picked.
   */
  proceedBlocked: string | null;
  /** The write's warning when it can't be taken back ("it sends at once"); null otherwise. */
  proceedWarning?: string | null | undefined;
  depth?: number;
  label?: string | undefined;
}

/** What happens when nobody answers in time. */
export function ThenSelect(props: ThenProps) {
  const { value, onChange, field, testId, errors, people, proceedBlocked } = props;
  const depth = props.depth ?? 0;
  const kind = thenKind(value);
  const canEscalate = depth < MAX_ESCALATION || kind === "escalate";
  return (
    <div className="flex flex-col gap-2">
      <Row label={props.label ?? "If nobody answers"} field={field} errors={errors}>
        <SmallSelect
          data-field={field}
          data-testid={testId}
          value={kind}
          onChange={(e) => {
            const next = e.target.value as keyof typeof THEN_LABEL;
            onChange(
              next === "escalate"
                ? {
                    escalate: {
                      to: "client_admin",
                      deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
                    },
                  }
                : next,
              field,
            );
          }}
        >
          <option value="stop">{THEN_LABEL.stop}</option>
          <option value="proceed" disabled={proceedBlocked !== null && kind !== "proceed"}>
            {THEN_LABEL.proceed}
          </option>
          <option value="skip">{THEN_LABEL.skip}</option>
          {canEscalate ? <option value="escalate">{THEN_LABEL.escalate}</option> : null}
        </SmallSelect>
      </Row>
      {proceedBlocked !== null ? (
        <p className="text-xs text-ink-muted" data-testid={`${testId}-proceed-reason`}>
          {kind === "proceed"
            ? "Not allowed here: "
            : "Going ahead without an answer isn't available: "}
          {proceedBlocked}
        </p>
      ) : kind === "proceed" && props.proceedWarning ? (
        <p className="text-xs text-ink-muted" data-testid={`${testId}-proceed-warning`}>
          {props.proceedWarning}
        </p>
      ) : null}
      {typeof value === "object" ? (
        <div
          className="flex flex-col gap-3 border-l-2 border-copper-tint pl-3"
          data-testid={`${testId}-escalate`}
        >
          <Row label="Ask" field={`${field}.escalate.to`} errors={errors}>
            <PersonPicker
              field={`${field}.escalate.to`}
              testId={`${testId}-escalate-to`}
              value={value.escalate.to}
              people={people}
              allowLead
              onChange={(to) =>
                onChange(
                  { escalate: { ...value.escalate, to: to ?? "client_admin" } },
                  `${field}.escalate.to`,
                )
              }
            />
          </Row>
          <DeadlineEditor
            value={value.escalate.deadline}
            onChange={(deadline, key) =>
              onChange({ escalate: { ...value.escalate, deadline } }, key)
            }
            prefix={`${field}.escalate.deadline`}
            testId={`${testId}-escalate-deadline`}
            errors={errors}
            people={people}
            proceedBlocked={proceedBlocked}
            proceedWarning={props.proceedWarning}
            depth={depth + 1}
          />
        </div>
      ) : null}
    </div>
  );
}

export interface DeadlineProps {
  value: Deadline;
  onChange(value: Deadline, key: string): void;
  /** The deadline's field path, e.g. "deadline" or "checks.approval.approvers.0.deadline". */
  prefix: string;
  testId: string;
  errors: FieldErrors;
  people: People;
  proceedBlocked: string | null;
  proceedWarning?: string | null | undefined;
  depth?: number;
  /** "Waits up to" by default. */
  afterLabel?: string;
}

/** How long, on whose clock, reminders, what happens with no answer, and who is told. */
export function DeadlineEditor(props: DeadlineProps) {
  const { value, onChange, prefix, testId, errors, people } = props;
  const set = (patch: Partial<Deadline>, key: string) => onChange({ ...value, ...patch }, key);
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <div className="grid grid-cols-2 gap-3">
        <Row
          label={props.afterLabel ?? "Waits up to"}
          field={`${prefix}.after`}
          errors={errors}
          hint='e.g. "30 minutes" or "2 days"'
        >
          <SmallInput
            data-field={`${prefix}.after`}
            data-testid={`${testId}-after`}
            value={value.after}
            onChange={(e) => set({ after: e.target.value }, `${prefix}.after`)}
          />
        </Row>
        <Row label="Counted in" field={`${prefix}.hours`} errors={errors}>
          <SmallSelect
            data-field={`${prefix}.hours`}
            data-testid={`${testId}-hours`}
            value={value.hours}
            onChange={(e) => set({ hours: e.target.value as Deadline["hours"] }, `${prefix}.hours`)}
          >
            <option value="clock">Clock time</option>
            <option value="business">Their business hours</option>
          </SmallSelect>
        </Row>
      </div>
      {value.hours === "business" ? (
        <p className="text-xs text-ink-muted" data-testid={`${testId}-business`}>
          Counts only while the person asked is working: their own hours, else the client's. Someone
          away is skipped at once.
        </p>
      ) : null}
      <Row
        label="Remind them after"
        field={`${prefix}.remind`}
        errors={errors}
        hint='Up to five, e.g. "1 hour, 4 hours". Empty: no reminders.'
      >
        <ListInput
          field={`${prefix}.remind`}
          testId={`${testId}-remind`}
          value={value.remind ?? []}
          onChange={(remind) => {
            const { remind: _r, ...rest } = value;
            onChange(remind.length ? { ...rest, remind } : rest, `${prefix}.remind`);
          }}
        />
      </Row>
      <ThenSelect
        value={value.ifNoAnswer}
        onChange={(ifNoAnswer, key) => set({ ifNoAnswer }, key)}
        field={`${prefix}.ifNoAnswer`}
        testId={`${testId}-then`}
        errors={errors}
        people={people}
        proceedBlocked={props.proceedBlocked}
        proceedWarning={props.proceedWarning}
        depth={props.depth ?? 0}
      />
      <Row
        label="Also tell, when it passes"
        field={`${prefix}.tell`}
        errors={errors}
        hint="Told whatever happens next."
      >
        <PeopleList
          field={`${prefix}.tell`}
          testId={`${testId}-tell`}
          value={value.tell ?? []}
          people={people}
          max={10}
          allowLead
          onChange={(tell) => {
            const { tell: _t, ...rest } = value;
            onChange(tell.length ? { ...rest, tell } : rest, `${prefix}.tell`);
          }}
        />
      </Row>
    </div>
  );
}
