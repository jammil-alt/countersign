// The setup of an automation's two ends, shown in the side panel when the chart's Takes in or
// Gives back box is clicked (docs/builder-plan.md §12.1, F7). Takes in: each field's name, what it
// holds, whether it is needed and a few words about it. Gives back: each field's name and where
// its value comes from, picked from what the automation takes in and what its steps give (the
// same picker a step's input has). Rows keep what is being typed (an empty or repeated name) and
// write the schema or the template out on every change.
import { canonicalJson, type JsonSchema, type PathOption } from "@countersign/core";
import { type ReactNode, useRef, useState } from "react";
import { Icon } from "../../../ui/icons";
import { Button } from "../../../ui/primitives";
import { Select, TextInput } from "../../agents/ui";
import { JsonInput, TemplateInput } from "../../builder/fields";
import {
  INPUT_TYPES,
  type InputField,
  type InputType,
  inputFields,
  inputProblems,
  inputSchema,
  newInputField,
  type OutputField,
  outputFields,
  outputProblems,
  outputTemplate,
  withInputType,
} from "./ends";

/**
 * Rows over a stored value: they follow the value when it changes from outside (an undo, a save)
 * and otherwise keep what is being typed, writing the value out on every change.
 */
function useRows<V, R extends { key: string }>(
  value: V,
  read: (value: V) => R[],
  write: (rows: R[]) => V,
  onChange: (value: V) => void,
): { rows: R[]; change(rows: R[]): void; newKey(): string } {
  const canon = canonicalJson(value);
  const [state, setState] = useState(() => ({ rows: read(value), canon }));
  const n = useRef(0);
  let rows = state.rows;
  if (state.canon !== canon) {
    rows = read(value);
    setState({ rows, canon });
  }
  return {
    rows,
    change(next) {
      const out = write(next);
      setState({ rows: next, canon: canonicalJson(out) });
      onChange(out);
    },
    newKey() {
      n.current += 1;
      return `new:${n.current}`;
    },
  };
}

function RowShell({
  index,
  what,
  problem,
  onRemove,
  children,
}: {
  index: number;
  what: "in" | "out";
  problem: string | undefined;
  onRemove(): void;
  children: ReactNode;
}) {
  return (
    <li className="flow-end-row" data-testid={`flow-${what}-row-${index}`}>
      <div className="flow-end-row__fields">{children}</div>
      <button
        type="button"
        aria-label="Remove this field"
        title="Remove this field"
        data-testid={`flow-${what}-remove-${index}`}
        onClick={onRemove}
        className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink"
      >
        <Icon name="close" />
      </button>
      {problem ? (
        <p className="flow-end-row__problem" data-testid={`flow-${what}-problem-${index}`}>
          {problem}
        </p>
      ) : null}
    </li>
  );
}

/** "Takes in": the automation's input fields, written to `definition.input`. */
export function TakesInFields({
  schema,
  onChange,
}: {
  schema: JsonSchema;
  onChange(schema: JsonSchema): void;
}) {
  const { rows, change, newKey } = useRows<JsonSchema, InputField>(
    schema,
    inputFields,
    (next) => inputSchema(next, schema),
    onChange,
  );
  const problems = inputProblems(rows);
  const set = (key: string, fn: (f: InputField) => InputField) =>
    change(rows.map((r) => (r.key === key ? fn(r) : r)));
  return (
    <div className="flex flex-col gap-3" data-testid="flow-in-fields">
      <p className="text-sm text-ink-muted">
        What a step that uses this automation must give it. Its steps read each field by name.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink" data-testid="flow-in-none">
          It takes nothing in yet.
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {rows.map((f, i) => (
          <RowShell
            key={f.key}
            index={i}
            what="in"
            problem={problems.get(f.key)}
            onRemove={() => change(rows.filter((r) => r.key !== f.key))}
          >
            <div className="flow-end-row__pair">
              <TextInput
                aria-label="Field name"
                placeholder="Name, like invoiceNumber"
                data-testid={`flow-in-name-${i}`}
                value={f.name}
                invalid={problems.has(f.key)}
                onChange={(e) => set(f.key, (r) => ({ ...r, name: e.target.value }))}
                className="h-9 text-sm"
              />
              <Select
                aria-label="What it holds"
                data-testid={`flow-in-type-${i}`}
                value={f.type}
                onChange={(e) => set(f.key, (r) => withInputType(r, e.target.value as InputType))}
                className="h-9 text-sm"
              >
                {INPUT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>
            <TextInput
              aria-label="What it is, in a few words"
              placeholder="What it is, in a few words"
              data-testid={`flow-in-about-${i}`}
              value={f.description}
              onChange={(e) => set(f.key, (r) => ({ ...r, description: e.target.value }))}
              className="h-9 text-sm"
            />
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                data-testid={`flow-in-required-${i}`}
                checked={f.required}
                onChange={(e) => set(f.key, (r) => ({ ...r, required: e.target.checked }))}
              />
              Needed every time
            </label>
          </RowShell>
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          data-testid="flow-in-add"
          onClick={() => change([...rows, newInputField(newKey())])}
        >
          <Icon name="add" />
          Add a field
        </Button>
      </div>
    </div>
  );
}

/** "Gives back": the automation's output fields, written to `definition.output`. */
export function GivesBackFields({
  output,
  paths,
  errorsAt,
  onChange,
}: {
  output: Record<string, unknown>;
  /** What a value may read: the input and the top-level steps' outputs (`outputPaths`). */
  paths: readonly PathOption[];
  /** The validator's words on one field of the output, by its name. */
  errorsAt(name: string): string[];
  onChange(output: Record<string, unknown>): void;
}) {
  const { rows, change, newKey } = useRows<Record<string, unknown>, OutputField>(
    output,
    outputFields,
    outputTemplate,
    onChange,
  );
  const problems = outputProblems(rows);
  const set = (key: string, fn: (f: OutputField) => OutputField) =>
    change(rows.map((r) => (r.key === key ? fn(r) : r)));
  return (
    <div className="flex flex-col gap-3" data-testid="flow-out-fields">
      <p className="text-sm text-ink-muted">
        What the step that uses this automation gets when it ends, for the steps after it. Pick each
        value from what it takes in or from what its steps give.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink" data-testid="flow-out-none">
          It gives nothing back yet.
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {rows.map((f, i) => {
          const said = errorsAt(f.name.trim());
          return (
            <RowShell
              key={f.key}
              index={i}
              what="out"
              problem={problems.get(f.key) ?? said[0]}
              onRemove={() => change(rows.filter((r) => r.key !== f.key))}
            >
              <TextInput
                aria-label="Field name"
                placeholder="Name, like billId"
                data-testid={`flow-out-name-${i}`}
                value={f.name}
                invalid={problems.has(f.key)}
                onChange={(e) => set(f.key, (r) => ({ ...r, name: e.target.value }))}
                className="h-9 text-sm"
              />
              {typeof f.value === "string" || f.value === undefined ? (
                <TemplateInput
                  value={typeof f.value === "string" ? f.value : ""}
                  onChange={(value) => set(f.key, (r) => ({ ...r, value }))}
                  paths={paths}
                  field={`output.${f.name}`}
                  invalid={said.length > 0}
                  placeholder="Pick a value with { }"
                  testId={`flow-out-value-${i}`}
                />
              ) : (
                // A value that isn't text (a record of several values, a fixed number): as stored.
                <JsonInput
                  value={f.value}
                  onChange={(value) => set(f.key, (r) => ({ ...r, value }))}
                  field={`output.${f.name}`}
                  invalid={said.length > 0}
                  testId={`flow-out-value-${i}`}
                />
              )}
            </RowShell>
          );
        })}
      </ul>
      <div>
        <Button
          size="sm"
          data-testid="flow-out-add"
          onClick={() => change([...rows, { key: newKey(), name: "", value: "" }])}
        >
          <Icon name="add" />
          Add a field
        </Button>
      </div>
    </div>
  );
}
