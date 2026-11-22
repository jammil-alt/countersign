// docs/plan.md §1.230 (Wave Y, Y1): a pack's configuration, the only thing the operator gives when
// they switch the pack on for a client from the client page's Areas tab (the Packs tab). Each field
// is declared in the pack's manifest (`PackManifest.config`) with its default; the values a client
// has are kept in `tenant.settings.packs.<pack id>` and read back through `packConfigOf`, which
// fills in the defaults, so a pack switched on before a field was added reads the field's default.
//
// How a pack reads its configuration (a tool, a report, a nightly pass): select the client's
// `tenant.settings` and call `packConfigOf(manifest.config, settings, PACK_ID)`. Nothing else
// reaches the values; no model sees them unless a tool hands them over in its result.
//
// A configuration field is plain data: a word, a number, a yes or no, or one of a few choices. It
// never holds a secret (a password, a key, a card number): those go to the client's vault through
// a connection (invariant 13), and a field whose label asks for one is refused here.

import { z } from "zod";
import { asksForSecret } from "../forms";
import { isPlainObject } from "../json";

/** `tenant.settings` key under which each pack's configuration is kept, by pack id. */
export const PACK_CONFIG_SETTING = "packs";

const FieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a field key (lower case, _)");

const base = {
  key: FieldKey,
  /** What the operator sees, in plain words ("Months of history to read"). */
  label: z.string().min(1).max(120),
  /** One more sentence when the label isn't enough. */
  help: z.string().max(300).optional(),
};

/**
 * One configuration field. `default` is what a client gets when the operator leaves it alone, and
 * what every client already on the pack reads until someone changes it.
 */
export const PackConfigField = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), default: z.string().max(500) }),
  z.object({
    ...base,
    type: z.literal("number"),
    default: z.number().finite(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }),
  z.object({ ...base, type: z.literal("boolean"), default: z.boolean() }),
  z.object({
    ...base,
    type: z.literal("choice"),
    options: z
      .array(z.object({ value: FieldKey, label: z.string().min(1).max(120) }))
      .min(2)
      .max(20),
    default: FieldKey,
  }),
]);
export type PackConfigField = z.infer<typeof PackConfigField>;

/** A client's values, by field key. */
export const PackConfigValues = z.record(FieldKey, z.union([z.string(), z.number(), z.boolean()]));
export type PackConfigValues = z.infer<typeof PackConfigValues>;

/** What is wrong with a pack's declared fields (empty when nothing is); the manifest checks it. */
export function packConfigProblems(fields: readonly PackConfigField[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.key)) out.push(`${f.key}: declared twice`);
    seen.add(f.key);
    if (asksForSecret(f.label, f.help)) {
      out.push(`${f.key}: a pack's configuration never holds a secret; that is a connection's`);
    }
    if (f.type === "number") {
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
        out.push(`${f.key}: min is above max`);
      }
      if (fieldProblem(f, f.default)) out.push(`${f.key}: the default is out of range`);
    }
    if (f.type === "choice") {
      const values = f.options.map((o) => o.value);
      if (new Set(values).size !== values.length) out.push(`${f.key}: an option is listed twice`);
      if (!values.includes(f.default)) out.push(`${f.key}: the default isn't one of the options`);
    }
  }
  return out;
}

/** Why `value` can't be this field's, or null when it can. */
function fieldProblem(f: PackConfigField, value: unknown): string | null {
  switch (f.type) {
    case "text":
      return typeof value === "string" && value.length <= 500 ? null : "must be text";
    case "boolean":
      return typeof value === "boolean" ? null : "must be yes or no";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (f.min !== undefined && value < f.min) return `must be at least ${f.min}`;
      if (f.max !== undefined && value > f.max) return `must be at most ${f.max}`;
      return null;
    case "choice":
      return typeof value === "string" && f.options.some((o) => o.value === value)
        ? null
        : `must be one of ${f.options.map((o) => o.value).join(", ")}`;
  }
}

/** Every field at its default. */
export function packConfigDefaults(fields: readonly PackConfigField[]): PackConfigValues {
  return Object.fromEntries(fields.map((f) => [f.key, f.default]));
}

/**
 * The values to keep for a client: `current` (what it has now, or nothing) with the operator's
 * `input` over it, every other field at its default. A key the pack doesn't declare, or a value
 * the field doesn't take, is a problem and nothing is kept.
 */
export function resolvePackConfig(
  fields: readonly PackConfigField[],
  input: Readonly<Record<string, unknown>>,
  current: PackConfigValues = {},
): { ok: true; values: PackConfigValues } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  for (const key of Object.keys(input)) {
    if (!fields.some((f) => f.key === key)) problems.push(`${key}: this pack has no such setting`);
  }
  const values: PackConfigValues = {};
  for (const f of fields) {
    const given = Object.hasOwn(input, f.key) ? input[f.key] : undefined;
    if (given !== undefined) {
      const problem = fieldProblem(f, given);
      if (problem) problems.push(`${f.key}: ${problem}`);
      else values[f.key] = given as string | number | boolean;
      continue;
    }
    const kept = current[f.key];
    values[f.key] = kept !== undefined && !fieldProblem(f, kept) ? kept : f.default;
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, values };
}

/**
 * A client's configuration of one pack, read from its `tenant.settings`: each declared field's
 * kept value, or its default when none is kept or the kept one no longer fits (a field changed
 * type). Keys the pack no longer declares are left out.
 */
export function packConfigOf(
  fields: readonly PackConfigField[],
  settings: Readonly<Record<string, unknown>> | null | undefined,
  packId: string,
): PackConfigValues {
  const all = settings?.[PACK_CONFIG_SETTING];
  const mine = isPlainObject(all) ? (all as Record<string, unknown>)[packId] : undefined;
  const kept = isPlainObject(mine) ? (mine as Record<string, unknown>) : {};
  return Object.fromEntries(
    fields.map((f) => {
      const v = kept[f.key];
      return [f.key, v !== undefined && !fieldProblem(f, v) ? v : f.default];
    }),
  ) as PackConfigValues;
}
