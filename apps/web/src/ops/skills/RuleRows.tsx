// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14): the rule rows editor of a
// deterministic skill. Rows are tried top to bottom; the first whose conditions all hold sets the
// outputs. A condition compares an input field, a parameter, today or a value (=, is not, less,
// more, between, one of), or the days between two dates; an output is a fixed value, a copied
// value, a sum, a difference, a percent change, or the label of the bucket a value falls in by a
// buckets parameter ("days overdue into the agent's aging buckets"). Anything more is built-in
// code, the platform's own. Design-system classes only; it wraps at phone width.
import type {
  SkillCompute,
  SkillCondition,
  SkillOperand,
  SkillRule,
  SkillValue,
} from "@countersign/core";
import { Select, TextInput } from "../../ui/forms";
import { Button, Card, cx } from "../../ui/primitives";
import {
  blankOutput,
  blankValue,
  CONDITION_OPS,
  type ConditionOp,
  listFrom,
  literalFrom,
  literalText,
  newCondition,
  newRowId,
  OP_LABEL,
  OUTPUT_HOW_LABEL,
  type OutputHow,
  type RuleOutput,
  type RuleScope,
  ruleOutputs,
  VALUE_KIND_LABEL,
  type ValueKind,
  valueKind,
  withOp,
  withOutputs,
} from "./rule-rows";

const SMALL = "h-9 text-sm";

/** A value: what it reads (a field, a parameter, today, a value, days between two dates). */
function ValueInput({
  value,
  scope,
  testId,
  list,
  kinds,
  onChange,
}: {
  value: SkillValue;
  scope: RuleScope;
  testId: string;
  /** A literal here is a list ("one of"), typed with commas. */
  list?: boolean;
  /** The kinds offered (days between offers no days between inside it). */
  kinds?: readonly ValueKind[];
  onChange(next: SkillValue): void;
}) {
  const kind = valueKind(value);
  const offered = kinds ?? (["input", "parameter", "today", "value", "days"] as const);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid={testId}>
      <Select
        aria-label="Reads"
        className={cx(SMALL, "w-36")}
        data-testid={`${testId}-kind`}
        value={kind}
        onChange={(e) => {
          const next = e.target.value as ValueKind;
          onChange(next === "value" && list ? { value: [] } : blankValue(next, scope));
        }}
      >
        {offered.map((k) => (
          <option key={k} value={k}>
            {VALUE_KIND_LABEL[k]}
          </option>
        ))}
      </Select>
      {"input" in value ? (
        <FieldPicker
          testId={`${testId}-input`}
          fields={scope.inputs}
          value={value.input}
          onChange={(input) => onChange({ input })}
        />
      ) : null}
      {"parameter" in value ? (
        <Select
          aria-label="Parameter"
          className={cx(SMALL, "w-40")}
          data-testid={`${testId}-parameter`}
          value={value.parameter}
          onChange={(e) => onChange({ parameter: e.target.value })}
        >
          {scope.parameters.some((p) => p.name === value.parameter) ? null : (
            <option value={value.parameter}>{value.parameter}</option>
          )}
          {scope.parameters.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label || p.name}
            </option>
          ))}
        </Select>
      ) : null}
      {"value" in value ? (
        <TextInput
          aria-label={list ? "Values, separated by commas" : "Value"}
          className={cx(SMALL, "w-40")}
          data-testid={`${testId}-value`}
          placeholder={list ? "paid, void" : ""}
          value={literalText(value.value)}
          onChange={(e) =>
            onChange({ value: list ? listFrom(e.target.value) : literalFrom(e.target.value) })
          }
        />
      ) : null}
      {"daysBetween" in value ? (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm text-ink-muted">from</span>
          <ValueInput
            value={value.daysBetween.from}
            scope={scope}
            testId={`${testId}-from`}
            kinds={["input", "parameter", "today", "value"]}
            onChange={(from) =>
              onChange({ daysBetween: { ...value.daysBetween, from: from as SkillOperand } })
            }
          />
          <span className="text-sm text-ink-muted">to</span>
          <ValueInput
            value={value.daysBetween.to}
            scope={scope}
            testId={`${testId}-to`}
            kinds={["input", "parameter", "today", "value"]}
            onChange={(to) =>
              onChange({ daysBetween: { ...value.daysBetween, to: to as SkillOperand } })
            }
          />
        </span>
      ) : null}
    </div>
  );
}

/** An input field: chosen from the skill's input, or typed (a nested field, `invoice.dueDate`). */
function FieldPicker({
  fields,
  value,
  testId,
  onChange,
}: {
  fields: readonly string[];
  value: string;
  testId: string;
  onChange(next: string): void;
}) {
  if (fields.length === 0 || (value && !fields.includes(value) && value !== "field")) {
    return (
      <TextInput
        aria-label="Input field"
        className={cx(SMALL, "w-40")}
        data-testid={testId}
        placeholder="invoice.dueDate"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <Select
      aria-label="Input field"
      className={cx(SMALL, "w-40")}
      data-testid={testId}
      value={fields.includes(value) ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    >
      {fields.includes(value) ? null : <option value="">Choose a field</option>}
      {fields.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </Select>
  );
}

function ConditionInput({
  condition: c,
  scope,
  testId,
  onChange,
  onRemove,
}: {
  condition: SkillCondition;
  scope: RuleScope;
  testId: string;
  onChange(next: SkillCondition): void;
  onRemove(): void;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-sm border border-line p-2" data-testid={testId}>
      <ValueInput
        value={c.left}
        scope={scope}
        testId={`${testId}-left`}
        onChange={(left) => onChange({ ...c, left })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Compare"
          className={cx(SMALL, "w-36")}
          data-testid={`${testId}-op`}
          value={c.op}
          onChange={(e) => onChange(withOp(c, e.target.value as ConditionOp))}
        >
          {CONDITION_OPS.map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op]}
            </option>
          ))}
        </Select>
        {"right" in c ? (
          <ValueInput
            value={c.right}
            scope={scope}
            testId={`${testId}-right`}
            onChange={(right) => onChange({ ...c, right })}
          />
        ) : null}
        {"from" in c ? (
          <>
            <ValueInput
              value={c.from}
              scope={scope}
              testId={`${testId}-from`}
              onChange={(from) => onChange({ ...c, from })}
            />
            <span className="text-sm text-ink-muted">and</span>
            <ValueInput
              value={c.to}
              scope={scope}
              testId={`${testId}-to`}
              onChange={(to) => onChange({ ...c, to })}
            />
          </>
        ) : null}
        {"list" in c ? (
          <ValueInput
            value={c.list}
            scope={scope}
            list
            testId={`${testId}-list`}
            onChange={(list) => onChange({ ...c, list })}
          />
        ) : null}
        <button
          type="button"
          className="ds-btn ds-btn--link text-xs"
          data-testid={`${testId}-remove`}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function OutputInput({
  output: o,
  outputs,
  scope,
  testId,
  onChange,
  onRemove,
}: {
  output: RuleOutput;
  /** The skill's output fields. */
  outputs: readonly string[];
  scope: RuleScope;
  testId: string;
  onChange(next: RuleOutput): void;
  onRemove(): void;
}) {
  const buckets = scope.parameters.filter((p) => p.type === "buckets");
  return (
    <li className="flex flex-col gap-2 rounded-sm border border-line p-2" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Output field"
          className={cx(SMALL, "w-40")}
          data-testid={`${testId}-field`}
          value={o.field}
          onChange={(e) => onChange({ ...o, field: e.target.value })}
        >
          {outputs.includes(o.field) ? null : (
            <option value={o.field}>{o.field || "Choose"}</option>
          )}
          {outputs.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
        <span className="text-sm text-ink-muted">is</span>
        <Select
          aria-label="Worked out as"
          className={cx(SMALL, "w-48")}
          data-testid={`${testId}-how`}
          value={o.how}
          onChange={(e) => onChange(blankOutput(o.field, e.target.value as OutputHow, scope))}
        >
          {(Object.keys(OUTPUT_HOW_LABEL) as OutputHow[]).map((h) => (
            <option key={h} value={h} disabled={h === "bucket" && buckets.length === 0}>
              {OUTPUT_HOW_LABEL[h]}
            </option>
          ))}
        </Select>
        <button
          type="button"
          className="ds-btn ds-btn--link text-xs"
          data-testid={`${testId}-remove`}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
      {o.how === "fixed" ? (
        <TextInput
          aria-label="Value"
          className={cx(SMALL, "w-48")}
          data-testid={`${testId}-value`}
          value={typeof o.value === "string" || typeof o.value === "number" ? String(o.value) : ""}
          onChange={(e) => onChange({ ...o, value: literalFrom(e.target.value) })}
        />
      ) : null}
      {o.how !== "fixed" ? (
        <ComputeInput
          compute={o.compute}
          scope={scope}
          testId={testId}
          onChange={(compute) => onChange({ ...o, compute })}
        />
      ) : null}
    </li>
  );
}

/** A calculation's operands: a copied value, terms of a sum, two values, a bucketed value. */
function ComputeInput({
  compute: c,
  scope,
  testId,
  onChange,
}: {
  compute: SkillCompute;
  scope: RuleScope;
  testId: string;
  onChange(next: SkillCompute): void;
}) {
  if ("sum" in c) {
    return (
      <SumInput
        values={c.sum}
        scope={scope}
        testId={`${testId}-sum`}
        onChange={(sum) => onChange({ sum })}
      />
    );
  }
  if ("difference" in c) {
    const [a, b] = c.difference;
    return (
      <div className="flex flex-col gap-2">
        <ValueInput
          value={a}
          scope={scope}
          testId={`${testId}-a`}
          onChange={(next) => onChange({ difference: [next, b] })}
        />
        <span className="text-sm text-ink-muted">minus</span>
        <ValueInput
          value={b}
          scope={scope}
          testId={`${testId}-b`}
          onChange={(next) => onChange({ difference: [a, next] })}
        />
      </div>
    );
  }
  if ("percentChange" in c) {
    const { from, to } = c.percentChange;
    return (
      <div className="flex flex-col gap-2">
        <span className="text-sm text-ink-muted">from</span>
        <ValueInput
          value={from}
          scope={scope}
          testId={`${testId}-from`}
          onChange={(next) => onChange({ percentChange: { from: next, to } })}
        />
        <span className="text-sm text-ink-muted">to</span>
        <ValueInput
          value={to}
          scope={scope}
          testId={`${testId}-to`}
          onChange={(next) => onChange({ percentChange: { from, to: next } })}
        />
      </div>
    );
  }
  if ("bucket" in c) {
    const { value, by } = c.bucket;
    const buckets = scope.parameters.filter((p) => p.type === "buckets");
    return (
      <div className="flex flex-col gap-2">
        <ValueInput
          value={value}
          scope={scope}
          testId={`${testId}-bucket-value`}
          onChange={(next) => onChange({ bucket: { value: next, by } })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-muted">in the buckets of</span>
          <Select
            aria-label="Buckets parameter"
            className={cx(SMALL, "w-40")}
            data-testid={`${testId}-bucket-by`}
            value={by}
            onChange={(e) => onChange({ bucket: { value, by: e.target.value } })}
          >
            {buckets.some((p) => p.name === by) ? null : <option value={by}>{by}</option>}
            {buckets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label || p.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
    );
  }
  return (
    <ValueInput
      value={c}
      scope={scope}
      testId={`${testId}-copy`}
      onChange={(next) => onChange(next)}
    />
  );
}

function SumInput({
  values,
  scope,
  testId,
  onChange,
}: {
  values: SkillValue[];
  scope: RuleScope;
  testId: string;
  onChange(next: SkillValue[]): void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {values.map((v, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the terms of a sum have no id.
          key={i}
          className="flex flex-wrap items-center gap-2"
        >
          {i > 0 ? <span className="text-sm text-ink-muted">plus</span> : null}
          <ValueInput
            value={v}
            scope={scope}
            testId={`${testId}-${i}`}
            onChange={(next) => onChange(values.map((x, j) => (j === i ? next : x)))}
          />
          {values.length > 1 ? (
            <button
              type="button"
              className="ds-btn ds-btn--link text-xs"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <div>
        <Button
          size="sm"
          data-testid={`${testId}-add`}
          onClick={() => onChange([...values, blankValue("input", scope)])}
        >
          Add a term
        </Button>
      </div>
    </div>
  );
}

/** Every rule row of a deterministic skill, in order. */
// DECISION (skill model, web): a row the editor adds gets the id `row-<n>` (the first free n). A
// skill version replaces its rows whole, so its ids only need to be unique in the version; a
// step's own added rows keep their uuid ids (customize.tsx), which merges line up.
export function RuleRowsEditor({
  rows,
  scope,
  outputs,
  error,
  onChange,
}: {
  rows: SkillRule[];
  scope: RuleScope;
  /** The skill's output fields. */
  outputs: readonly string[];
  error?: string | undefined;
  onChange(rows: SkillRule[]): void;
}) {
  const set = (i: number, next: SkillRule) => onChange(rows.map((r, j) => (j === i ? next : r)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j] as SkillRule, next[i] as SkillRule];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="skill-rules">
      <p className="text-sm text-ink-muted">
        Tried top to bottom: the first row whose conditions all hold sets the outputs. A row with no
        conditions always holds. If none holds, the step fails and says so.
      </p>
      {rows.map((row, i) => {
        const outs = ruleOutputs(row, outputs);
        const conditions = row.conditions ?? [];
        const setOutputs = (next: RuleOutput[]) => set(i, withOutputs(row, next));
        const setConditions = (next: SkillCondition[]) => {
          const { conditions: _c, ...rest } = row;
          set(i, next.length ? { ...rest, conditions: next } : rest);
        };
        return (
          <Card key={row.id} className="flex flex-col gap-3 p-3" testId={`skill-rule-${i}`}>
            <div className="flex flex-wrap items-center gap-2">
              <TextInput
                aria-label="Row name"
                className={cx(SMALL, "min-w-0 flex-1")}
                data-testid={`skill-rule-${i}-name`}
                placeholder={`Row ${i + 1}`}
                value={row.name ?? ""}
                onChange={(e) => {
                  const { name: _n, ...rest } = row;
                  set(i, e.target.value ? { ...rest, name: e.target.value } : rest);
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                Up
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Move down"
                disabled={i === rows.length - 1}
                onClick={() => move(i, 1)}
              >
                Down
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`skill-rule-${i}-remove`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              <p className="eyebrow text-ink-muted">When</p>
              {conditions.length === 0 ? (
                <p className="text-sm text-ink-muted">Always.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {conditions.map((c, k) => (
                    <ConditionInput
                      // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id.
                      key={k}
                      condition={c}
                      scope={scope}
                      testId={`skill-rule-${i}-condition-${k}`}
                      onChange={(next) =>
                        setConditions(conditions.map((x, j) => (j === k ? next : x)))
                      }
                      onRemove={() => setConditions(conditions.filter((_, j) => j !== k))}
                    />
                  ))}
                </ul>
              )}
              <div>
                <Button
                  size="sm"
                  data-testid={`skill-rule-${i}-condition-add`}
                  onClick={() => setConditions([...conditions, newCondition(scope)])}
                >
                  Add a condition
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="eyebrow text-ink-muted">Then</p>
              <ul className="flex flex-col gap-2">
                {outs.map((o, k) => (
                  <OutputInput
                    key={o.field || k}
                    output={o}
                    outputs={outputs}
                    scope={scope}
                    testId={`skill-rule-${i}-output-${k}`}
                    onChange={(next) => setOutputs(outs.map((x, j) => (j === k ? next : x)))}
                    onRemove={() => setOutputs(outs.filter((_, j) => j !== k))}
                  />
                ))}
              </ul>
              <div>
                <Button
                  size="sm"
                  data-testid={`skill-rule-${i}-output-add`}
                  disabled={outputs.every((f) => outs.some((o) => o.field === f))}
                  onClick={() => {
                    const field = outputs.find((f) => !outs.some((o) => o.field === f)) ?? "";
                    setOutputs([...outs, blankOutput(field, "fixed", scope)]);
                  }}
                >
                  Add an output
                </Button>
              </div>
            </div>
          </Card>
        );
      })}
      {error ? <p className="ds-error text-sm">{error}</p> : null}
      <div>
        <Button
          size="sm"
          data-testid="skill-rule-add"
          onClick={() => {
            const field = outputs[0] ?? "";
            onChange([
              ...rows,
              withOutputs(
                { id: newRowId(rows), when: { match: "all", rules: [] } } as SkillRule,
                field ? [blankOutput(field, "fixed", scope)] : [],
              ),
            ]);
          }}
        >
          Add a rule row
        </Button>
      </div>
    </div>
  );
}
