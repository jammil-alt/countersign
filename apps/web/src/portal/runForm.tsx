// A hand-started workflow's form, as the portal draws it (`RunForm.input`, a JSON schema of plain
// fields): an agent's "Run now" and the sandbox (docs/plan.md §1.243) both use it, so a form looks
// and reads the same wherever it starts a run.
import { Field, Select, TextInput } from "../ui/forms";

export type FieldSpec = {
  key: string;
  label: string;
  kind: "text" | "number" | "boolean" | "choice";
  choices: string[];
  required: boolean;
};

/** What has been typed or picked, by field. */
export type FormValues = ReadonlyMap<string, string | boolean>;

/**
 * A run form's fields, when every field is plain (text, a number, yes or no, one of a list).
 * Null for a form we can't draw yet; it is left out (the Desk and the lead start those runs).
 */
export function formFields(input: Record<string, unknown>): FieldSpec[] | null {
  const props = input.properties;
  if (props === undefined) return [];
  if (typeof props !== "object" || props === null) return null;
  const required = Array.isArray(input.required) ? (input.required as unknown[]) : [];
  const out: FieldSpec[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (typeof raw !== "object" || raw === null) return null;
    const p = raw as Record<string, unknown>;
    const label = typeof p.title === "string" ? p.title : key;
    const base = { key, label, required: required.includes(key), choices: [] as string[] };
    if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string")) {
      out.push({ ...base, kind: "choice", choices: p.enum as string[] });
    } else if (p.type === "string") {
      out.push({ ...base, kind: "text" });
    } else if (p.type === "number" || p.type === "integer") {
      out.push({ ...base, kind: "number" });
    } else if (p.type === "boolean") {
      out.push({ ...base, kind: "boolean" });
    } else {
      return null;
    }
  }
  return out;
}

/** The run's input from what was typed: blanks left out, numbers as numbers, unticked as false. */
export function formInput(
  fields: readonly FieldSpec[],
  values: FormValues,
): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((f) => {
      const v = values.get(f.key);
      if (f.kind === "boolean") return [[f.key, v === true]];
      if (v === undefined || v === "") return [];
      return [[f.key, f.kind === "number" ? Number(v) : v]];
    }),
  );
}

/** The form's fields, each as its kind draws: a box, a number, a tick, or a list. */
export function RunFormFields({
  fields,
  values,
  onChange,
}: {
  fields: readonly FieldSpec[];
  values: FormValues;
  onChange: (key: string, value: string | boolean) => void;
}) {
  return (
    <>
      {fields.map((f) =>
        f.kind === "boolean" ? (
          <label key={f.key} className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="size-4 accent-slate"
              checked={values.get(f.key) === true}
              onChange={(e) => onChange(f.key, e.target.checked)}
            />
            {f.label}
          </label>
        ) : (
          <Field key={f.key} label={f.label}>
            {f.kind === "choice" ? (
              <Select
                required={f.required}
                value={String(values.get(f.key) ?? "")}
                onChange={(e) => onChange(f.key, e.target.value)}
              >
                <option value="" />
                {f.choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                type={f.kind === "number" ? "number" : "text"}
                required={f.required}
                value={String(values.get(f.key) ?? "")}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            )}
          </Field>
        ),
      )}
    </>
  );
}
