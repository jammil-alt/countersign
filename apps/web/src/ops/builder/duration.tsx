// The time picker (owner, 2026-11-21; docs/plan.md §1.177): a wait is picked from the common
// times, or written under Custom as weeks, days, hours and minutes; reminders are how many times
// and how far apart. Both write the format's own values (./duration-parts), so a step saved here
// reads the same in the executor as one written by hand.
import { type ReactNode, useState } from "react";
import {
  DURATION_PRESETS,
  DURATION_UNITS,
  type DurationParts,
  durationOfParts,
  MAX_REMINDERS,
  minutesOf,
  partsOf,
  presetOf,
  type ReminderPlan,
  reminderPlan,
  remindersOf,
  reminderWords,
} from "./duration-parts";
import { type FieldErrors, NO_ERRORS, Row, SmallInput, SmallSelect } from "./fields";

const CUSTOM = "custom";
const UNIT_LABEL: Record<(typeof DURATION_UNITS)[number], string> = {
  week: "Weeks",
  day: "Days",
  hour: "Hours",
  minute: "Minutes",
};

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

export interface DurationPickerProps {
  label: ReactNode;
  value: string;
  onChange(value: string): void;
  field: string;
  testId: string;
  errors?: FieldErrors | undefined;
  /** Counted in business hours: a day is the next open day, so units are kept as written. */
  business?: boolean | undefined;
  /** A field to sit beside the picker on its line ("Counted in"). */
  beside?: ReactNode;
  hint?: ReactNode;
}

/** A wait: one of the common times, or Custom in weeks, days, hours and minutes. */
export function DurationPicker(props: DurationPickerProps) {
  const { value, onChange, field, testId } = props;
  const preset = presetOf(value);
  // Custom stays open once chosen, though what is typed may equal a preset ("1 day").
  const [custom, setCustom] = useState(preset === null);
  const showCustom = custom || preset === null;
  const stored = partsOf(value, !props.business);
  // What is being typed, kept while it still says the stored time (or nothing yet): a box can be
  // emptied to type another number, and an outside change (Undo) shows.
  const [draft, setDraft] = useState<DurationParts | null>(null);
  const typed = draft ? durationOfParts(draft) : null;
  const parts = draft && (typed === null || typed === value) ? draft : stored;
  const mixed = parts ? DURATION_UNITS.filter((u) => parts[u] > 0).length > 1 : false;
  const setPart = (unit: keyof DurationParts, text: string) => {
    const n = Math.max(0, Math.floor(Number(text) || 0));
    const next = { ...(parts ?? { week: 0, day: 0, hour: 0, minute: 0 }), [unit]: n };
    setDraft(next);
    const said = durationOfParts(next);
    if (said) onChange(said);
  };
  const select = (
    <Row label={props.label} field={field} errors={props.errors ?? NO_ERRORS} hint={props.hint}>
      <SmallSelect
        data-field={field}
        data-testid={testId}
        value={showCustom ? CUSTOM : (preset ?? CUSTOM)}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(e.target.value);
        }}
      >
        {DURATION_PRESETS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value={CUSTOM}>Custom</option>
      </SmallSelect>
    </Row>
  );
  return (
    <div className="flex flex-col gap-2">
      {props.beside ? (
        <div className="grid grid-cols-2 gap-3">
          {select}
          {props.beside}
        </div>
      ) : (
        select
      )}
      {showCustom ? (
        parts ? (
          <div className="flex flex-col gap-1" data-testid={`${testId}-custom`}>
            <div className="grid grid-cols-4 gap-2">
              {DURATION_UNITS.map((unit) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the input is the label's child.
                <label key={unit} className="flex flex-col gap-1 text-xs text-ink-muted">
                  {UNIT_LABEL[unit]}
                  <SmallInput
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    data-testid={`${testId}-${unit}s`}
                    value={parts[unit] === 0 ? "" : String(parts[unit])}
                    placeholder="0"
                    onChange={(e) => setPart(unit, e.target.value)}
                  />
                </label>
              ))}
            </div>
            {props.business ? (
              <p className="text-xs text-ink-muted" data-testid={`${testId}-business`}>
                {mixed
                  ? `Counted as ${value} of their working time. `
                  : "In business hours a day is the same time on their next working day. "}
                Fill one unit to keep it that way.
              </p>
            ) : null}
          </div>
        ) : (
          // Seconds, or text that is no time: shown as written, to be put right.
          <SmallInput
            data-testid={`${testId}-text`}
            aria-label="The time, as written"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      ) : null}
    </div>
  );
}

const TIMES = ["none", "1", "2", "3", "4", "5", "set"] as const;

function timesLabel(t: (typeof TIMES)[number]): string {
  if (t === "none") return "Don't remind them";
  if (t === "set") return "At times I write";
  return t === "1" ? "Once" : `${t} times`;
}

/**
 * Reminders (owner, 2026-11-21: "how many times to remind them… once every 30 minutes or 5 times
 * every 30 min or 1 time 30 min after"): how many, and how far apart. Up to five, the format's
 * limit; times written by hand that aren't evenly apart stay as written.
 */
export function RemindersPicker({
  value,
  onChange,
  field,
  testId,
  errors,
  business,
  after,
}: {
  value: readonly string[] | undefined;
  onChange(remind: string[]): void;
  field: string;
  testId: string;
  errors?: FieldErrors | undefined;
  business?: boolean | undefined;
  /** How long the wait is, to say when a reminder would come after it ended. */
  after?: string | undefined;
}) {
  const plan = reminderPlan(value);
  // "At times I write" stays open while its box is empty.
  const [writing, setWriting] = useState(plan.kind === "set");
  // While times are being written they stay written, though "1 hour" alone would read as "once".
  const kind = writing ? "set" : plan.kind;
  const times = kind === "every" && plan.kind === "every" ? String(plan.times) : kind;
  const put = (next: ReminderPlan) => onChange(remindersOf(next));
  const last = remindersOf(plan).at(-1);
  const lastMin = last ? minutesOf(last) : null;
  const afterMin = after ? minutesOf(after) : null;
  const late = lastMin !== null && afterMin !== null && lastMin >= afterMin;
  return (
    <div className="flex flex-col gap-2" data-testid={`${testId}-plan`} data-kind={kind}>
      <Row label="Remind them" field={field} errors={errors ?? NO_ERRORS}>
        <SmallSelect
          data-field={field}
          data-testid={`${testId}-times`}
          value={times}
          onChange={(e) => {
            const t = e.target.value as (typeof TIMES)[number];
            setWriting(t === "set");
            if (t === "none") put({ kind: "none" });
            else if (t === "set") put({ kind: "set", at: [...(value ?? [])] });
            else {
              put({
                kind: "every",
                times: Number(t),
                every:
                  plan.kind === "every"
                    ? plan.every
                    : value?.[0] && minutesOf(value[0])
                      ? value[0]
                      : "30 minutes",
              });
            }
          }}
        >
          {TIMES.map((t) => (
            <option key={t} value={t}>
              {timesLabel(t)}
            </option>
          ))}
        </SmallSelect>
      </Row>
      {kind === "every" && plan.kind === "every" ? (
        <DurationPicker
          label={plan.times === 1 ? "After" : "Every"}
          field={`${field}.0`}
          testId={`${testId}-every`}
          value={plan.every}
          business={business}
          onChange={(every) => put({ kind: "every", times: plan.times, every })}
        />
      ) : null}
      {kind === "set" ? (
        <Row label="Times after asking" hint={`Up to ${MAX_REMINDERS}, e.g. "1 hour, 4 hours".`}>
          <ListInput
            field={field}
            testId={testId}
            value={value ?? []}
            onChange={(remind) => onChange(remind)}
          />
        </Row>
      ) : null}
      {plan.kind !== "none" ? (
        <p className="text-xs text-ink-muted" data-testid={`${testId}-words`}>
          {reminderWords(plan)}
          {late ? " The wait ends before the last one, so it is never sent." : ""}
        </p>
      ) : null}
    </div>
  );
}
