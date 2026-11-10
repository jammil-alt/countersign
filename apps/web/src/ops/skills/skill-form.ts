// The operator skill editor's form (ARCHITECTURE §9.2, plan §1.2 "Operator skills"): name,
// description, category, instructions, a tool picker, input and output fields that produce JSON
// Schema, and settings (with `clientSpecific`). Id `custom:<slug>`. Pure functions, so the form
// round-trips a stored definition without losing what it doesn't show.
//
// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14): two kinds only. An **AI** skill is a
// task on a model (`mode: "task"`): instructions, a recommended model, and tools that only read.
// A **deterministic** skill is rule rows (`mode: "tool"`, no handler: built-in code is the
// platform's only): when its conditions hold, a row sets its outputs. Both declare parameters,
// named typed values each agent sets. A stored agent-mode skill opens as AI and saves as one.
import {
  newSkillVersionProblems,
  parameterValueProblem,
  pickLocalized,
  type SkillDefinition,
  SkillDefinition as SkillDefinitionSchema,
  type SkillKind,
  type SkillParameter,
  type SkillRule,
  skillRuleProblems,
  type ToolSpec,
} from "@countersign/core";

export const FIELD_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  string: "Text",
  number: "Number",
  integer: "Whole number",
  boolean: "Yes or no",
  array: "List",
  object: "Record",
};

export interface FieldRow {
  key: string;
  type: FieldType;
  description: string;
  required: boolean;
  /** Whatever else the property's schema said (items, enum, format…), kept as it was. */
  extra: Record<string, unknown>;
}

export const SETTING_TYPES = ["number", "boolean", "string", "enum"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

export interface SettingRow {
  key: string;
  label: string;
  type: SettingType;
  /** As typed; parsed by type when the definition is built. */
  default: string;
  /** Comma-separated, for enum settings. */
  options: string;
  clientSpecific: boolean;
}

/** A parameter as the editor holds it; the default is a typed value, or undefined for none. */
export interface ParameterRow {
  name: string;
  label: string;
  type: SkillParameter["type"];
  description: string;
  default: unknown;
}

export interface SkillForm {
  /** Skill model (2026-11-10): AI (instructions and a model) or deterministic (rule rows). */
  kind: SkillKind;
  /** An AI skill's recommended model. */
  model: string;
  /** Named, typed values each agent sets for its use of the skill. */
  parameters: ParameterRow[];
  /** A deterministic skill's rule rows, as stored (typed conditions and outputs). */
  rules: SkillRule[];
  slug: string;
  name: string;
  description: string;
  category: string;
  instructions: string;
  tools: string[];
  input: FieldRow[];
  output: FieldRow[];
  settings: SettingRow[];
  summary: string;
  producesAlerts: boolean;
}

/** The library's categories (design screen 3); a skill may name another. */
export const CATEGORIES = [
  ["documents", "Documents"],
  ["data", "Data"],
  ["writing", "Writing"],
  ["actions", "Actions"],
  ["custom", "Custom"],
] as const;

export function categoryLabel(category: string): string {
  const known = CATEGORIES.find(([id]) => id === category);
  if (known) return known[1];
  return category ? category.charAt(0).toUpperCase() + category.slice(1) : "Other";
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const SETTING_KEY_RE = /^[a-z][a-z0-9_]*$/;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * The model a new AI skill recommends: the fast, cheap one, as the Builder drafts with
 * (packages/llm's `DEFAULT_MODELS.classification`; apps/web can't import packages/llm).
 */
// DECISION (skill model, web): a new AI skill recommends Haiku, the classification default; the
// operator picks another from the priced list, and each agent may override it per skill.
export const DEFAULT_SKILL_MODEL = "claude-haiku-5-5";

export const EMPTY_FORM: SkillForm = {
  kind: "ai",
  model: DEFAULT_SKILL_MODEL,
  parameters: [],
  rules: [],
  slug: "",
  name: "",
  description: "",
  category: "custom",
  instructions: "",
  tools: [],
  input: [],
  output: [{ key: "summary", type: "string", description: "", required: true, extra: {} }],
  settings: [],
  summary: "",
  producesAlerts: false,
};

export function fieldsFromSchema(schema: Record<string, unknown> | undefined): FieldRow[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema?.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([key, prop]) => {
    const { type, description, ...extra } = prop ?? {};
    const t = (FIELD_TYPES as readonly string[]).includes(String(type))
      ? (type as FieldType)
      : "string";
    return {
      key,
      type: t,
      description: typeof description === "string" ? description : "",
      required: required.has(key),
      extra,
    };
  });
}

export function schemaFromFields(rows: readonly FieldRow[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const r of rows) {
    const extra = { ...r.extra };
    // A list or record keeps its item shape; a field that changed type drops shapes it can't have.
    if (r.type !== "array") delete extra.items;
    if (r.type !== "object") {
      delete extra.properties;
      delete extra.required;
    }
    properties[r.key] = {
      type: r.type,
      ...(r.type === "array" && !extra.items ? { items: {} } : {}),
      ...extra,
      ...(r.description.trim() ? { description: r.description.trim() } : {}),
    };
  }
  const required = rows.filter((r) => r.required).map((r) => r.key);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function settingDefault(type: SettingType, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (type === "boolean") return value === true ? "true" : "false";
  return String(value);
}

export function formFromDefinition(def: SkillDefinition): SkillForm {
  return {
    kind: def.mode === "tool" ? "deterministic" : "ai",
    model: def.model?.id ?? DEFAULT_SKILL_MODEL,
    parameters: (def.parameters ?? []).map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      description: p.description ?? "",
      default: p.default,
    })),
    rules: [...(def.rules ?? [])],
    slug: def.id.startsWith("custom:") ? def.id.slice("custom:".length) : def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    instructions: def.instructions ?? "",
    tools: [...def.tools],
    input: fieldsFromSchema(def.input),
    output: fieldsFromSchema(def.output),
    settings: def.settings.map((s) => ({
      key: s.key,
      label: s.label,
      type: s.type,
      default: settingDefault(s.type, s.default),
      options: (s.options ?? []).join(", "),
      clientSpecific: s.clientSpecific,
    })),
    // DECISION: the editor edits the English summary (the source); a stored version per language
    // is kept as it was (see definitionFromForm). Editing the other languages here is open.
    summary: def.summary === undefined ? "" : pickLocalized(def.summary, "en"),
    producesAlerts: def.producesAlerts,
  };
}

export type SkillFormErrors = Record<string, string>;

const options = (s: SettingRow) =>
  s.options
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

export function validateSkillForm(form: SkillForm): SkillFormErrors {
  const errors: SkillFormErrors = {};
  if (!form.name.trim()) errors.name = "Give it a name.";
  if (!SLUG_RE.test(form.slug)) errors.slug = "Lowercase letters, digits and dashes.";
  if (!form.description.trim()) errors.description = "Say what it does in a sentence.";
  if (!form.category.trim()) errors.category = "Choose a category.";
  if (form.kind === "ai") {
    if (!form.instructions.trim()) errors.instructions = "Tell the model how to do it.";
    if (!form.model.trim()) errors.model = "Choose the model it recommends.";
  } else if (form.rules.length === 0) {
    errors.rules = "Add a rule row: when its conditions hold, it sets the outputs.";
  }
  const names = new Set<string>();
  form.parameters.forEach((p, i) => {
    if (!PARAM_NAME_RE.test(p.name)) {
      errors[`parameters.${i}.name`] = "lowercase_with_underscores, from a letter.";
    } else if (names.has(p.name)) errors[`parameters.${i}.name`] = "Used twice.";
    names.add(p.name);
    if (!p.label.trim()) errors[`parameters.${i}.label`] = "Give it a label.";
    if (p.default !== undefined) {
      const problem = parameterValueProblem({ name: p.label || p.name, type: p.type }, p.default);
      if (problem) errors[`parameters.${i}.default`] = problem;
    }
  });
  for (const [side, rows] of [
    ["input", form.input],
    ["output", form.output],
  ] as const) {
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      if (!KEY_RE.test(r.key))
        errors[`${side}.${i}`] = "Letters, digits and _, not starting with a digit.";
      else if (seen.has(r.key)) errors[`${side}.${i}`] = "Used twice.";
      seen.add(r.key);
    });
  }
  if (form.output.length === 0) errors.output = "It needs at least one output field.";
  if (form.producesAlerts && !form.output.some((r) => r.key === "sources")) {
    errors.output = "A skill that raises alerts outputs its sources: add a 'sources' list.";
  }
  const keys = new Set<string>();
  form.settings.forEach((s, i) => {
    if (!SETTING_KEY_RE.test(s.key)) errors[`settings.${i}.key`] = "lowercase_with_underscores.";
    else if (keys.has(s.key)) errors[`settings.${i}.key`] = "Used twice.";
    keys.add(s.key);
    if (!s.label.trim()) errors[`settings.${i}.label`] = "Give it a label.";
    if (s.type === "number" && s.default.trim() && Number.isNaN(Number(s.default))) {
      errors[`settings.${i}.default`] = "A number.";
    }
    if (s.type === "enum") {
      const o = options(s);
      if (o.length === 0)
        errors[`settings.${i}.options`] = "List the choices, separated by commas.";
      else if (s.default.trim() && !o.includes(s.default.trim())) {
        errors[`settings.${i}.default`] = "One of the choices.";
      }
    }
  });
  return errors;
}

function parseDefault(s: SettingRow): unknown {
  const v = s.default.trim();
  switch (s.type) {
    case "number":
      return v === "" ? null : Number(v);
    case "boolean":
      return v === "true";
    case "enum":
      return v === "" ? (options(s)[0] ?? null) : v;
    default:
      return v;
  }
}

/**
 * The definition the form describes. Connectors it needs come from the tools it picks (each
 * tool's connector); everything the form doesn't show is taken from `base`.
 */
export function definitionFromForm(
  form: SkillForm,
  tools: readonly Pick<ToolSpec, "id" | "connector">[],
  base?: SkillDefinition,
): SkillDefinition {
  const ai = form.kind === "ai";
  // Skill model (2026-11-10): an AI skill only reads; a deterministic one calls no tool.
  const picked = ai ? form.tools.filter((id) => readsOnly(id, tools)) : [];
  const connectors = new Set<string>();
  for (const id of picked) {
    const t = tools.find((x) => x.id === id);
    if (t?.connector) connectors.add(t.connector);
  }
  const english = form.summary.trim();
  const other = typeof base?.summary === "object" ? base.summary : null;
  const summary = english && other ? { ...other, en: english } : english;
  // What the other kind had, and what a stored version of a retired kind had, is left behind:
  // the method (rules then AI), a handler, rule rows on an AI skill, browsing on a rules one.
  const {
    method: _method,
    handler: _handler,
    rules: _rules,
    model: _model,
    instructions: _instructions,
    parameters: _parameters,
    ...kept
  } = base ?? ({} as Partial<SkillDefinition>);
  if (!ai) {
    delete kept.browse;
    delete kept.reads;
  }
  const parameters = form.parameters.map(parameterFromRow);
  return {
    ...kept,
    schemaVersion: 1,
    id: `custom:${form.slug}`,
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category.trim(),
    ...(ai
      ? {
          mode: "task",
          model: { ...(base?.model ?? {}), id: form.model.trim() },
          instructions: form.instructions.trim(),
        }
      : { mode: "tool", rules: form.rules }),
    ...(parameters.length > 0 ? { parameters } : {}),
    tools: picked,
    input: schemaFromFields(form.input),
    output: schemaFromFields(form.output),
    settings: form.settings.map((s) => ({
      key: s.key,
      label: s.label.trim(),
      type: s.type,
      default: parseDefault(s),
      ...(s.type === "enum" ? { options: options(s) } : {}),
      clientSpecific: s.clientSpecific,
    })),
    ...(summary ? { summary } : { summary: undefined }),
    requiresConnectors: [...connectors].sort(),
    requiresPacks: base?.requiresPacks ?? [],
    producesAlerts: form.producesAlerts,
  } as SkillDefinition;
}

/** Whether a tool only reads (an AI skill may call only those). Unknown tools don't read. */
export function readsOnly(id: string, tools: readonly Pick<ToolSpec, "id">[]): boolean {
  const t = tools.find((x) => x.id === id) as Partial<Pick<ToolSpec, "sideEffect">> | undefined;
  // A tool list without side effects (an older test double) is taken as it is.
  return t !== undefined && (t.sideEffect === undefined || t.sideEffect === "none");
}

function parameterFromRow(p: ParameterRow): SkillParameter {
  return {
    name: p.name.trim(),
    label: p.label.trim(),
    type: p.type,
    ...(p.description.trim() ? { description: p.description.trim() } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  };
}

/**
 * Everything that would stop the server from saving the version, in plain words: the schema's
 * checks, the rule rows' (an input field the rows read that isn't there, an output they set that
 * isn't one) and the skill model's (no writing, no retired kind). Empty when it would save.
 */
export function definitionProblems(
  def: SkillDefinition,
  tools: readonly Pick<ToolSpec, "id" | "sideEffect">[],
): string[] {
  const parsed = SkillDefinitionSchema.safeParse(def);
  const out: string[] = parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join(".") || "skill"}: ${i.message}`);
  const lookup = (id: string) => tools.find((t) => t.id === id);
  out.push(...skillRuleProblems(def), ...newSkillVersionProblems(def, lookup));
  return [...new Set(out)];
}

/** Drops undefined keys (a JSON body would anyway; tests compare plain objects). */
export function clean<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
