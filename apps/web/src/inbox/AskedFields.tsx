// What a person step asks for (owner, 2026-11-28): the fields it lists (`payload.fields`), each a
// box on the card, handed on to the steps after it by its name. With quick answers, the first field
// is the button pressed and the rest are boxes above the buttons.

import { type PersonField, readAnswerFields } from "@countersign/core";
import { useI18n } from "../i18n/i18n";

export type FieldValues = Readonly<Record<string, string>>;

/** The fields a request asks for, or null when it asks for one plain answer. */
export function askedFields(payload: Record<string, unknown>): PersonField[] | null {
  return readAnswerFields(payload.fields);
}

/** "paid_with" → "Paid with"; "vendorName" → "Vendor name". */
function fieldWords(name: string): string {
  const w = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** A field's label: what it is about, else its name in words. */
export function fieldLabelOf(field: PersonField): string {
  return field.about ?? fieldWords(field.name);
}

/** The answer the card sends: each field given, as its type (a choice fills the first). */
export function answerOf(
  fields: readonly PersonField[],
  values: FieldValues,
  choice?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  fields.forEach((f, i) => {
    if (i === 0 && choice !== undefined) {
      out[f.name] = choice;
      return;
    }
    const raw = (values[f.name] ?? "").trim();
    if (raw === "") return;
    if (f.type === "number") out[f.name] = Number(raw);
    else if (f.type === "yes_no") out[f.name] = raw === "yes";
    else out[f.name] = raw;
  });
  return out;
}

/** Whether a field it needs is still empty (the first is left to the buttons when there are some). */
export function missingRequired(
  fields: readonly PersonField[],
  values: FieldValues,
  choices: boolean,
): boolean {
  return fields.some(
    (f, i) => f.required && !(choices && i === 0) && (values[f.name] ?? "").trim() === "",
  );
}

export function AskedFieldsForm({
  id,
  fields,
  choices,
  values,
  onChange,
}: {
  id: string;
  fields: readonly PersonField[];
  /** The first field is the quick answer pressed: no box for it. */
  choices: boolean;
  values: FieldValues;
  onChange: (values: FieldValues) => void;
}) {
  const { t } = useI18n();
  const shown = choices ? fields.slice(1) : fields;
  if (shown.length === 0) return null;
  const set = (name: string, value: string) => onChange({ ...values, [name]: value });
  return (
    <div className="flex flex-col gap-3" data-testid="inbox-item-fields">
      {shown.map((f) => {
        const key = `field-${id}-${f.name}`;
        const label = (
          <span className="text-sm font-medium text-ink">
            {fieldLabelOf(f)}
            {f.required ? null : (
              <span className="font-normal text-ink-muted"> · {t("common.optional")}</span>
            )}
          </span>
        );
        const value = values[f.name] ?? "";
        return (
          <label key={f.name} className="ds-field" htmlFor={key}>
            {label}
            {f.type === "yes_no" ? (
              <select
                id={key}
                data-testid={`inbox-item-field-${f.name}`}
                className="ds-select text-base"
                value={value}
                onChange={(e) => set(f.name, e.target.value)}
              >
                <option value="" />
                <option value="yes">{t("common.yes")}</option>
                <option value="no">{t("common.no")}</option>
              </select>
            ) : f.type === "text" ? (
              <textarea
                id={key}
                data-testid={`inbox-item-field-${f.name}`}
                className="ds-textarea text-base"
                rows={2}
                value={value}
                onChange={(e) => set(f.name, e.target.value)}
              />
            ) : (
              <input
                id={key}
                data-testid={`inbox-item-field-${f.name}`}
                className="ds-input text-base"
                type={f.type === "date" ? "date" : "text"}
                inputMode={f.type === "number" || f.type === "money" ? "decimal" : undefined}
                value={value}
                onChange={(e) => set(f.name, e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
