// A list of fields a step hands on (§5 "Output"; §13a "A field"): name, type in words, whether it
// is always there, one line on what it means, and a list's or group's own fields underneath.

import { steps } from "@countersign/core";
import { Button } from "../../../ui/primitives";
import { SmallInput, SmallSelect } from "../fields";
import type { Field, FieldType } from "./types";

export const FIELD_TYPE_WORDS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  money: "Money",
  date: "Date",
  yes_no: "Yes or no",
  list: "List",
  group: "Group",
  record: "Link to a record",
};

/** A field of a type, with what that type needs to be valid. */
export function newField(type: FieldType = "text", name = ""): Field {
  const f: Field = { name, type, required: false };
  if (type === "list" || type === "group") f.of = [];
  if (type === "record") f.record = "vendor";
  return f;
}

/** The field as it is when its type changes: what the new type needs, nothing the old one had. */
export function withType(field: Field, type: FieldType): Field {
  const next: Field = { name: field.name, type, required: field.required };
  if (field.about !== undefined) next.about = field.about;
  if (type === "list" || type === "group") next.of = field.of ?? [];
  if (type === "record") next.record = field.record ?? "vendor";
  return next;
}

export interface FieldsEditorProps {
  fields: readonly Field[];
  onChange(next: Field[]): void;
  /** What the list is, for names a screen reader reads ("Output"). */
  label: string;
  depth?: number;
}

export function FieldsEditor({ fields, onChange, label, depth = 0 }: FieldsEditorProps) {
  const set = (i: number, next: Field) => onChange(fields.map((f, j) => (j === i ? next : f)));
  return (
    <div className="flex flex-col gap-2" data-testid={`fields-${label}-${depth}`}>
      {fields.map((f, i) => {
        const bad = f.name !== "" && !steps.FIELD_NAME.test(f.name);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fields have no ids; their order is it.
          <div key={i} className="flex flex-col gap-1 border-l border-line pl-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <SmallInput
                aria-label={`${label} field name`}
                className="w-40"
                value={f.name}
                invalid={bad}
                placeholder="Name"
                onChange={(e) => set(i, { ...f, name: e.target.value })}
              />
              <SmallSelect
                aria-label={`${label} field type`}
                className="w-40"
                value={f.type}
                onChange={(e) => set(i, withType(f, e.target.value as FieldType))}
              >
                {steps.FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_WORDS[t]}
                  </option>
                ))}
              </SmallSelect>
              {f.type === "record" ? (
                <SmallInput
                  aria-label={`${label} kind of record`}
                  className="w-32"
                  value={f.record ?? ""}
                  placeholder="vendor"
                  onChange={(e) => set(i, { ...f, record: e.target.value })}
                />
              ) : null}
              <label className="flex items-center gap-1 text-sm text-ink-muted">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => set(i, { ...f, required: e.target.checked })}
                />
                Always there
              </label>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${f.name || "field"}`}
                onClick={() => onChange(fields.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
            <SmallInput
              aria-label={`${label} field meaning`}
              value={f.about ?? ""}
              maxLength={200}
              placeholder="What it means, in a line"
              onChange={(e) => {
                const { about: _a, ...rest } = f;
                set(i, e.target.value ? { ...rest, about: e.target.value } : rest);
              }}
            />
            {bad ? (
              <span className="text-xs text-risk">
                Letters, digits and _, starting with a letter.
              </span>
            ) : null}
            {f.of ? (
              <FieldsEditor
                fields={f.of}
                label={`${f.name || "inner"}`}
                depth={depth + 1}
                onChange={(of) => set(i, { ...f, of })}
              />
            ) : null}
          </div>
        );
      })}
      <Button size="sm" className="self-start" onClick={() => onChange([...fields, newField()])}>
        Add a field
      </Button>
    </div>
  );
}
