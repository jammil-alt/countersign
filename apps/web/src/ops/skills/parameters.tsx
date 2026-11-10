// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14): a skill's parameters, named typed
// values each agent sets for its use of the skill (aging buckets, a threshold, a cut-off date).
// One input per type, shared by the skill editor (a parameter's default), the agent's Settings
// (the agent's value) and the step inspector (a step's own value over the agent's): a number, text,
// a date, an amount and its currency, or a list of buckets ("0–15 Current, 16–30 Due, 31+ Past
// due"). Values are typed as they are typed in; core's `parameterValueProblem` says what's wrong.
import {
  parameterValueProblem,
  SKILL_PARAMETER_TYPES,
  type SkillBucket,
  type SkillParameter,
} from "@countersign/core";
import { Select, TextInput } from "../../ui/forms";
import { Button, cx } from "../../ui/primitives";
import { Field } from "../agents/ui";
import type { ParameterRow, SkillFormErrors } from "./skill-form";

export const PARAMETER_TYPE_LABEL: Record<SkillParameter["type"], string> = {
  number: "Number",
  text: "Text",
  date: "Date",
  money: "Amount",
  buckets: "Buckets",
};

/** A number as typed: a number when it reads as one, else the text (its problem shows). */
export function numberFrom(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(t) ? n : t;
}

/** A parameter value in a line: "500.00 USD", "0–15 Current, 16–30 Due, 31+ Past due". */
export function parameterText(type: SkillParameter["type"], value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (type === "money" && typeof value === "object") {
    const m = value as { amount?: unknown; currency?: unknown };
    return `${String(m.amount ?? "")} ${String(m.currency ?? "")}`.trim();
  }
  if (type === "buckets" && Array.isArray(value)) {
    return (value as SkillBucket[])
      .map((b) => `${b.from}${b.to === undefined ? "+" : `–${b.to}`} ${b.label}`)
      .join(", ");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Why a value doesn't fit its parameter, in plain words; null when it does or is unset. */
export function valueProblem(
  param: Pick<SkillParameter, "name" | "label" | "type">,
  value: unknown,
): string | null {
  if (value === undefined) return null;
  return parameterValueProblem({ name: param.label || param.name, type: param.type }, value);
}

const SMALL = "h-9 text-sm";

/** A list of buckets: from, to (empty for "and above", the last only) and label. */
function BucketsInput({
  value,
  testId,
  onChange,
}: {
  value: unknown;
  testId: string;
  onChange(next: unknown): void;
}) {
  const rows = Array.isArray(value) ? (value as Partial<SkillBucket>[]) : [];
  const set = (i: number, patch: Partial<SkillBucket>) =>
    onChange(
      rows.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        if (next.to === undefined) delete next.to;
        return next;
      }),
    );
  const num = (text: string) => {
    const n = numberFrom(text);
    return typeof n === "number" ? n : undefined;
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {rows.map((b, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: buckets have no id; their order is the list.
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-2"
        >
          <TextInput
            aria-label="From"
            className={SMALL}
            inputMode="decimal"
            data-testid={`${testId}-${i}-from`}
            value={b.from === undefined ? "" : String(b.from)}
            onChange={(e) => set(i, { from: num(e.target.value) as number })}
          />
          <TextInput
            aria-label="To"
            className={SMALL}
            inputMode="decimal"
            placeholder="and up"
            data-testid={`${testId}-${i}-to`}
            value={b.to === undefined ? "" : String(b.to)}
            onChange={(e) => set(i, { to: num(e.target.value) as number })}
          />
          <TextInput
            aria-label="Label"
            className={SMALL}
            data-testid={`${testId}-${i}-label`}
            value={b.label ?? ""}
            onChange={(e) => set(i, { label: e.target.value })}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove bucket ${i + 1}`}
            onClick={() => {
              const next = rows.filter((_, j) => j !== i);
              onChange(next.length ? next : undefined);
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          data-testid={`${testId}-add`}
          onClick={() => {
            const last = rows.at(-1);
            const from = typeof last?.to === "number" ? last.to + 1 : 0;
            onChange([...rows, { from, label: "" }]);
          }}
        >
          Add a bucket
        </Button>
      </div>
    </div>
  );
}

/**
 * A parameter's value. Empty means unset (`undefined`): the next layer down applies (the step's
 * falls back to the agent's, the agent's to the skill's default).
 */
export function ParameterValueInput({
  param,
  value,
  testId,
  placeholder,
  invalid,
  onChange,
}: {
  param: Pick<SkillParameter, "name" | "label" | "type">;
  value: unknown;
  testId: string;
  placeholder?: string | undefined;
  invalid?: boolean | undefined;
  onChange(next: unknown): void;
}) {
  switch (param.type) {
    case "number":
      return (
        <TextInput
          className={SMALL}
          inputMode="decimal"
          data-testid={testId}
          invalid={invalid === true}
          placeholder={placeholder}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(numberFrom(e.target.value))}
        />
      );
    case "text":
      return (
        <TextInput
          className={SMALL}
          data-testid={testId}
          invalid={invalid === true}
          placeholder={placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      );
    case "date":
      return (
        <TextInput
          type="date"
          className={SMALL}
          data-testid={testId}
          invalid={invalid === true}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      );
    case "money": {
      const m = (value ?? {}) as { amount?: string; currency?: string };
      const set = (patch: { amount?: string; currency?: string }) => {
        const next = { amount: m.amount ?? "", currency: m.currency ?? "USD", ...patch };
        onChange(next.amount === "" ? undefined : next);
      };
      return (
        <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
          <TextInput
            aria-label={`${param.label}: amount`}
            className={SMALL}
            inputMode="decimal"
            data-testid={`${testId}-amount`}
            invalid={invalid === true}
            placeholder={placeholder}
            value={m.amount ?? ""}
            onChange={(e) => set({ amount: e.target.value.trim() })}
          />
          <TextInput
            aria-label={`${param.label}: currency`}
            className={SMALL}
            maxLength={3}
            data-testid={`${testId}-currency`}
            value={m.currency ?? (value === undefined ? "" : "USD")}
            onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
          />
        </div>
      );
    }
    case "buckets":
      return <BucketsInput value={value} testId={testId} onChange={onChange} />;
  }
}

/** The skill editor's parameters: name, label, type, meaning and default, each. */
export function ParametersEditor({
  rows,
  errors,
  onChange,
}: {
  rows: ParameterRow[];
  errors: SkillFormErrors;
  onChange(rows: ParameterRow[]): void;
}) {
  const set = (i: number, patch: Partial<ParameterRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-4" data-testid="skill-parameters">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No parameters. Add one for a value each agent sets, like aging buckets or a threshold,
          rather than making a near copy of the skill.
        </p>
      ) : null}
      {rows.map((p, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until named.
          key={i}
          className="grid grid-cols-1 items-start gap-2 border-b border-line pb-4 md:grid-cols-3"
          data-testid={`skill-parameter-${i}`}
        >
          <Field label="Name" error={errors[`parameters.${i}.name`]} hint="Rules name it by this.">
            <TextInput
              data-testid={`skill-parameter-${i}-name`}
              value={p.name}
              invalid={Boolean(errors[`parameters.${i}.name`])}
              onChange={(e) => set(i, { name: e.target.value })}
            />
          </Field>
          <Field label="Label" error={errors[`parameters.${i}.label`]}>
            <TextInput
              data-testid={`skill-parameter-${i}-label`}
              value={p.label}
              invalid={Boolean(errors[`parameters.${i}.label`])}
              onChange={(e) => set(i, { label: e.target.value })}
            />
          </Field>
          <Field label="Type">
            <Select
              data-testid={`skill-parameter-${i}-type`}
              value={p.type}
              onChange={(e) =>
                // Another type's default doesn't carry over.
                set(i, { type: e.target.value as ParameterRow["type"], default: undefined })
              }
            >
              {SKILL_PARAMETER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PARAMETER_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Default"
            className={cx(p.type === "buckets" ? "md:col-span-3" : "md:col-span-2")}
            error={errors[`parameters.${i}.default`]}
            hint="Empty: every agent that uses the skill must set it."
          >
            <ParameterValueInput
              param={p}
              value={p.default}
              testId={`skill-parameter-${i}-default`}
              invalid={Boolean(errors[`parameters.${i}.default`])}
              onChange={(v) => set(i, { default: v })}
            />
          </Field>
          <div className="flex items-end gap-2 md:col-span-1">
            <Field label="Meaning" className="flex-1">
              <TextInput
                value={p.description}
                onChange={(e) => set(i, { description: e.target.value })}
              />
            </Field>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${p.name || "parameter"}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          data-testid="skill-parameter-add"
          onClick={() =>
            onChange([
              ...rows,
              { name: "", label: "", type: "number", description: "", default: undefined },
            ])
          }
        >
          Add a parameter
        </Button>
      </div>
    </div>
  );
}
