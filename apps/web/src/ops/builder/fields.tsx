// The inspector's controls (ARCHITECTURE §10.5): forms generated from a skill's or tool's input
// JSON Schema (string, number, boolean, enum and object fields; anything else as JSON checked as
// it is typed), and template fields with a picker of the upstream outputs valid at the step
// (core's typer). Every control carries `data-field` with the validation error path it answers,
// so a click on an error can focus it.
import { isPlainObject, type PathOption } from "@countersign/core";
import { type ReactNode, useId, useState } from "react";
import { cx } from "../../ui/primitives";
import { Select, TextArea, TextInput } from "../agents/ui";

type Schema = Record<string, unknown>;

/** Errors by field path, with a lookup for one field. */
export interface FieldErrors {
  at(field: string): string[];
}

export const NO_ERRORS: FieldErrors = { at: () => [] };

export function Row({
  label,
  field,
  errors,
  hint,
  children,
  aside,
}: {
  label: ReactNode;
  field?: string;
  errors?: FieldErrors;
  hint?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const messages = field && errors ? errors.at(field) : [];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-primary">{label}</span>
        {aside}
      </div>
      {children}
      {messages.map((m) => (
        <span key={m} className="text-xs text-tone-warning-ink" data-testid="builder-field-error">
          {m}
        </span>
      ))}
      {messages.length === 0 && hint ? (
        <span className="text-xs text-secondary">{hint}</span>
      ) : null}
    </div>
  );
}

/** A text field that may hold `{{…}}` references, with a picker of what is in scope. */
export function TemplateInput({
  value,
  onChange,
  paths,
  field,
  invalid,
  multiline,
  placeholder,
  testId,
}: {
  value: string;
  onChange(value: string): void;
  paths: readonly PathOption[];
  field: string;
  invalid?: boolean | undefined;
  multiline?: boolean | undefined;
  placeholder?: string | undefined;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const listId = useId();
  const shown = paths.filter((p) => p.path.toLowerCase().includes(filter.toLowerCase()));
  const insert = (path: string) => {
    onChange(`${value}{{${path}}}`);
    setOpen(false);
    setFilter("");
  };
  const control = multiline ? (
    <TextArea
      data-field={field}
      data-testid={testId}
      rows={3}
      value={value}
      invalid={Boolean(invalid)}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono text-sm"
    />
  ) : (
    <TextInput
      data-field={field}
      data-testid={testId}
      value={value}
      invalid={Boolean(invalid)}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 font-mono text-sm"
    />
  );
  return (
    <div className="relative">
      <div className="flex gap-1.5">
        <div className="min-w-0 flex-1">{control}</div>
        <button
          type="button"
          aria-label="Insert a field from an earlier step"
          aria-expanded={open}
          aria-controls={listId}
          data-testid={`${testId}-pick`}
          onClick={() => setOpen((o) => !o)}
          className="h-9 shrink-0 rounded-md border border-control bg-card px-2 font-mono text-xs text-secondary hover:bg-hover"
        >
          {"{ }"}
        </button>
      </div>
      {open ? (
        <div
          id={listId}
          className="absolute right-0 left-0 z-30 mt-1 rounded-md border border-edge bg-card p-2 elevation-md"
        >
          <TextInput
            autoFocus
            aria-label="Filter fields"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter fields"
            className="h-8 text-sm"
          />
          {shown.length === 0 ? (
            <p className="px-1 pt-2 text-xs text-secondary">
              Nothing earlier on this path to reference.
            </p>
          ) : (
            <ul className="mt-1 max-h-56 overflow-y-auto" data-testid={`${testId}-paths`}>
              {shown.map((p) => (
                <li key={p.path}>
                  <button
                    type="button"
                    data-testid={`${testId}-path-${p.path}`}
                    onClick={() => insert(p.path)}
                    className="flex w-full items-baseline justify-between gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-subtle"
                  >
                    <span className="truncate font-mono text-xs text-primary">{p.path}</span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">
                      {typeLabel(p.schema)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function typeLabel(schema: Schema | undefined): string {
  if (!schema) return "";
  const t = schema.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.join("|");
  if (isPlainObject(schema.properties)) return "object";
  return "";
}

function schemaType(schema: Schema): string | undefined {
  const t = schema.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.find((x) => x !== "null") as string | undefined;
  if (isPlainObject(schema.properties)) return "object";
  return undefined;
}

/** "15" → 15, "{{…}}" stays text, "" → undefined. */
export function parseNumberText(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return text;
}

/** A JSON value as it is typed: shown as JSON, sent on only when it parses (or is one reference). */
export function JsonInput({
  value,
  onChange,
  field,
  invalid,
  testId,
  rows = 4,
}: {
  value: unknown;
  onChange(value: unknown): void;
  field: string;
  invalid?: boolean | undefined;
  testId: string;
  rows?: number;
}) {
  const shown = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  // Follow outside changes (undo) unless the text being typed is mid-edit and unparsed.
  const [last, setLast] = useState(shown);
  if (shown !== last) {
    setLast(shown);
    if (error === null) setText(shown);
  }
  return (
    <div className="flex flex-col gap-1">
      <TextArea
        data-field={field}
        data-testid={testId}
        rows={rows}
        value={text}
        invalid={Boolean(invalid) || error !== null}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next.trim() === "") {
            setError(null);
            onChange(undefined);
            return;
          }
          if (/^\s*\{\{[^}]*\}\}\s*$/.test(next)) {
            setError(null);
            onChange(next.trim());
            return;
          }
          try {
            const parsed = JSON.parse(next) as unknown;
            setError(null);
            onChange(parsed);
          } catch {
            setError("Not valid JSON yet: it is kept here until it is.");
          }
        }}
        className="font-mono text-xs"
      />
      {error ? (
        <span className="text-xs text-tone-warning-ink" data-testid={`${testId}-json-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A form for an object JSON Schema, one control per property. Values are template-aware: a text
 * or number field can hold a `{{…}}` reference instead.
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  paths,
  prefix,
  errors,
  testPrefix,
}: {
  schema: Schema | undefined;
  value: Record<string, unknown>;
  onChange(value: Record<string, unknown>): void;
  paths: readonly PathOption[];
  /** The field path of this object, e.g. "input". */
  prefix: string;
  errors: FieldErrors;
  testPrefix: string;
}) {
  const props = schema && isPlainObject(schema.properties) ? schema.properties : null;
  if (!props || Object.keys(props).length === 0) {
    return (
      <Row label="Input (JSON)" field={prefix} errors={errors}>
        <JsonInput
          value={value}
          field={prefix}
          testId={`${testPrefix}-json`}
          onChange={(v) => onChange(isPlainObject(v) ? v : {})}
        />
      </Row>
    );
  }
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : []);
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const extra = Object.keys(value).filter((k) => !(k in props));
  return (
    <div className="flex flex-col gap-3">
      {Object.entries(props).map(([key, raw]) => {
        const prop = isPlainObject(raw) ? (raw as Schema) : {};
        const field = `${prefix}.${key}`;
        const label = (
          <>
            {typeof prop.title === "string" ? prop.title : key}
            {required.has(key) ? <span className="text-tone-warning-ink"> *</span> : null}
          </>
        );
        return (
          <Row
            key={key}
            label={label}
            field={field}
            errors={errors}
            hint={typeof prop.description === "string" ? prop.description : undefined}
          >
            <PropertyControl
              schema={prop}
              value={value[key]}
              onChange={(v) => set(key, v)}
              paths={paths}
              field={field}
              errors={errors}
              testId={`${testPrefix}-${key}`}
            />
          </Row>
        );
      })}
      {extra.length > 0 ? (
        <p className="text-xs text-secondary">
          Also set, not in this input's schema: {extra.join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

function PropertyControl({
  schema,
  value,
  onChange,
  paths,
  field,
  errors,
  testId,
}: {
  schema: Schema;
  value: unknown;
  onChange(value: unknown): void;
  paths: readonly PathOption[];
  field: string;
  errors: FieldErrors;
  testId: string;
}) {
  const invalid = errors.at(field).length > 0;
  if (Array.isArray(schema.enum)) {
    const options = schema.enum as unknown[];
    const index = options.findIndex((o) => JSON.stringify(o) === JSON.stringify(value));
    return (
      <Select
        data-field={field}
        data-testid={testId}
        invalid={invalid}
        value={index === -1 ? "" : String(index)}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : options[Number(e.target.value)])
        }
        className="h-9 text-sm"
      >
        <option value="">Not set</option>
        {options.map((o, i) => (
          <option key={JSON.stringify(o)} value={String(i)}>
            {typeof o === "string" ? o : JSON.stringify(o)}
          </option>
        ))}
      </Select>
    );
  }
  const type = schemaType(schema);
  if (type === "boolean") {
    return (
      <Select
        data-field={field}
        data-testid={testId}
        invalid={invalid}
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}
        className="h-9 text-sm"
      >
        <option value="">Not set</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (type === "string" || type === "number" || type === "integer") {
    const numeric = type !== "string";
    return (
      <TemplateInput
        value={value === undefined ? "" : String(value)}
        onChange={(text) =>
          onChange(numeric ? parseNumberText(text) : text === "" ? undefined : text)
        }
        paths={paths}
        field={field}
        invalid={invalid}
        testId={testId}
      />
    );
  }
  if (type === "object" && isPlainObject(schema.properties)) {
    return (
      <div className={cx("rounded-md border border-edge bg-subtle p-3")}>
        <SchemaForm
          schema={schema}
          value={isPlainObject(value) ? value : {}}
          onChange={(v) => onChange(Object.keys(v).length ? v : undefined)}
          paths={paths}
          prefix={field}
          errors={errors}
          testPrefix={testId}
        />
      </div>
    );
  }
  return (
    <JsonInput value={value} onChange={onChange} field={field} invalid={invalid} testId={testId} />
  );
}

/** A plain text control on the builder's dense scale. */
export function SmallInput(props: Parameters<typeof TextInput>[0]) {
  return <TextInput {...props} className={cx("h-9 text-sm", props.className)} />;
}

export function SmallSelect(props: Parameters<typeof Select>[0]) {
  return <Select {...props} className={cx("h-9 text-sm", props.className)} />;
}
