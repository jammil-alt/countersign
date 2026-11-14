// The definition editor's model (ARCHITECTURE §9.1): a bundle's definition as form fields (strings
// while typing), checked field by field, then written back into a copy of the bundle with its
// workflows untouched. Pure, so the checks are tested without rendering.
import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  DECIMAL_RE,
  MODEL_PROVIDER_NAMES,
  modelProvider,
  // v0.13 W2-I
  NEW_AGENT_OVERSIGHT,
  type OversightReview,
  OversightSettings,
  parameterValueProblem,
  parseSkillRef,
  providerModelName,
  type SkillOption,
  uuidv7,
} from "@countersign/core";

export type SettingValue = string | boolean;

export interface SkillEntry {
  /** The reference as the bundle names it (`custom:price-watch`, `docs.extract@2`). */
  skill: string;
  /** Overrides by key, as typed; a key left out takes the skill's default. */
  settings: Record<string, SettingValue>;
  // Skill model (2026-11-10): the agent's own use of the skill.
  /** The agent's parameter values by name, typed; a name left out takes the skill's default. */
  parameters?: Record<string, unknown>;
  /** The model this agent runs an AI skill on; "" = the skill's recommended model. */
  model?: string;
}

export interface DefinitionForm {
  name: string;
  role: string;
  mission: string;
  instructions: string;
  modelId: string;
  maxTokens: string;
  skills: SkillEntry[];
  mode: "suggest_only" | "act";
  /** "" = the client's setting; a role or a user id. */
  approver: string;
  maxSteps: string;
  maxCostUsd: string;
  memory: boolean;
  /** Wave 6: what the agent's owner reviews (`definition.oversight.review`); none set reads `off`. */
  ownerReview: OversightReview;
}

/** Field → message. Skill settings are keyed `skills.<i>.<key>`. */
export type FormErrors = Record<string, string>;

/**
 * The models offered by default.
 */
// DECISION: the editor offers the models packages/llm names (opus, the platform default; sonnet;
// haiku; OpenAI's GPT-5.5, xAI's Grok 4.7 and Google's Gemini 3.1 Pro and 3.5 Flash-Lite, each
// routed by its prefix) and keeps any other id a bundle already has; apps/web can't import
// packages/llm. Each is shown with its provider (`modelOptionLabel`).
export const MODEL_OPTIONS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "openai:gpt-5.5",
  "xai:grok-4.7",
  "google:gemini-3.1-pro",
  "google:gemini-3.5-flash-lite",
] as const;

/** A model as the pickers show it: its provider, then the provider's name for it. */
export function modelOptionLabel(id: string): string {
  return `${MODEL_PROVIDER_NAMES[modelProvider(id)]} · ${providerModelName(id)}`;
}
export const DEFAULT_MODEL = "claude-opus-5-5";

/** Approvers the editor offers besides a user id. */
export const APPROVER_ROLES = ["client_admin", "operator"] as const;

export function formFromBundle(bundle: Pick<AnyAgentBundle, "definition">): DefinitionForm {
  const d = bundle.definition;
  return {
    name: d.identity.name,
    role: d.identity.role,
    mission: d.identity.mission,
    instructions: d.instructions,
    modelId: d.model.id,
    maxTokens: String(d.model.maxTokens),
    skills: d.skills.map((s) => ({
      skill: s.skill,
      settings: Object.fromEntries(
        Object.entries(s.settings).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v)]),
      ),
      parameters: { ...(s.parameters ?? {}) },
      model: s.model?.id ?? "",
    })),
    mode: d.permissions.mode,
    approver: d.permissions.approver ?? "",
    maxSteps: String(d.budgets.maxSteps),
    maxCostUsd: d.budgets.maxCostUsd,
    memory: d.memory.enabled,
    ownerReview: d.oversight?.review ?? "off",
  };
}

/**
 * Wave 6: the definition's `oversight` with the form's review: kept as it was when unchanged
 * (an agent with none stays with none at `off`), else its other settings kept (model, limits),
 * or the schema's defaults when it had none.
 */
export function oversightWith(
  current: AnyAgentBundle["definition"]["oversight"],
  review: OversightReview,
): AnyAgentBundle["definition"]["oversight"] {
  if (review === (current?.review ?? "off")) return current;
  return current ? { ...current, review } : OversightSettings.parse({ review });
}

const POSITIVE_INT = /^[1-9]\d*$/;

/** The skill option a bundle reference points at (a pinned `@N` reference still matches). */
export function optionFor(ref: string, options: readonly SkillOption[]): SkillOption | undefined {
  const { id } = parseSkillRef(ref);
  return options.find((o) => o.id === id);
}

/**
 * What stops a form from being saved, by field. Unknown skills are not errors here: a draft may be
 * saved with them, and the API answers what would stop it from publishing.
 */
export function validateForm(form: DefinitionForm, options: readonly SkillOption[]): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = "Give the agent a name.";
  if (!form.modelId.trim()) errors.modelId = "Choose a model.";
  if (!POSITIVE_INT.test(form.maxTokens.trim())) {
    errors.maxTokens = "A whole number of tokens, more than 0.";
  }
  if (!POSITIVE_INT.test(form.maxSteps.trim())) errors.maxSteps = "A whole number, more than 0.";
  const cost = form.maxCostUsd.trim();
  if (!DECIMAL_RE.test(cost) || cost.startsWith("-")) {
    errors.maxCostUsd = "An amount in dollars, like 0.50 (at most 4 decimals).";
  }
  if (form.approver !== form.approver.trim()) {
    errors.approver = "No spaces around the approver.";
  }

  const seen = new Set<string>();
  form.skills.forEach((entry, i) => {
    const { id } = parseSkillRef(entry.skill);
    if (seen.has(id)) errors[`skills.${i}`] = "This skill is listed twice.";
    seen.add(id);
    const option = optionFor(entry.skill, options);
    if (!option) return;
    for (const s of option.settings) {
      const raw = entry.settings[s.key];
      if (raw === undefined || raw === "") continue;
      const field = `skills.${i}.${s.key}`;
      if (s.type === "number" && (typeof raw !== "string" || !Number.isFinite(Number(raw)))) {
        errors[field] = `${s.label} must be a number.`;
      }
      if (s.type === "enum" && !(s.options ?? []).includes(String(raw))) {
        errors[field] = `${s.label} must be one of ${(s.options ?? []).join(", ")}.`;
      }
    }
    // Skill model (2026-11-10): each value fits its parameter, and a parameter the skill gives
    // no default must be set (publish refuses it otherwise).
    for (const p of option.parameters ?? []) {
      const value = entry.parameters?.[p.name];
      const field = `skills.${i}.parameters.${p.name}`;
      if (value === undefined) {
        if (p.default === undefined) errors[field] = `Set ${p.label}: the skill has no default.`;
        continue;
      }
      const problem = parameterValueProblem({ name: p.label, type: p.type }, value);
      if (problem) errors[field] = problem;
    }
  });
  return errors;
}

/** An override typed in the form, as the bundle stores it (by the setting's type). */
function settingValue(
  raw: SettingValue,
  type: SkillOption["settings"][number]["type"] | undefined,
): unknown {
  if (type === "number" && typeof raw === "string") return Number(raw);
  if (type === "boolean" && typeof raw === "string") return raw === "true";
  return raw;
}

/**
 * The bundle with this form's definition; workflows and every field the form does not show
 * (extra tools, agents it may ask, avatar) are kept as they were. Overrides left empty are
 * dropped, so the skill's default applies.
 */
export function applyForm<B extends AnyAgentBundle>(
  bundle: B,
  form: DefinitionForm,
  options: readonly SkillOption[],
): B {
  const d = bundle.definition;
  const skills = form.skills.map((entry) => {
    const option = optionFor(entry.skill, options);
    const settings: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(entry.settings)) {
      if (raw === "") continue;
      const type = option?.settings.find((s) => s.key === key)?.type;
      settings[key] = settingValue(raw, type);
    }
    // Skill model (2026-11-10): the agent's values and model, only when it sets any, so an entry
    // the editor didn't change stays as stored.
    const parameters = Object.fromEntries(
      Object.entries(entry.parameters ?? {}).filter(([, v]) => v !== undefined),
    );
    const was = d.skills.find((s) => s.skill === entry.skill);
    const model = entry.model?.trim()
      ? {
          ...(was?.model?.id === entry.model.trim() ? was.model : {}),
          id: entry.model.trim(),
        }
      : undefined;
    return {
      skill: entry.skill,
      settings,
      ...(Object.keys(parameters).length ? { parameters } : {}),
      ...(model ? { model } : {}),
    };
  });
  const permissions: AgentBundle["definition"]["permissions"] = { mode: form.mode };
  if (form.approver) permissions.approver = form.approver;
  const identity: AgentBundle["definition"]["identity"] = {
    name: form.name.trim(),
    role: form.role.trim(),
    mission: form.mission.trim(),
  };
  if (d.identity.avatar !== undefined) identity.avatar = d.identity.avatar;
  const oversight = oversightWith(d.oversight, form.ownerReview);
  const { oversight: _was, ...rest } = d;
  return {
    ...bundle,
    definition: {
      ...rest,
      ...(oversight ? { oversight } : {}),
      identity,
      model: { id: form.modelId.trim(), maxTokens: Number(form.maxTokens) },
      instructions: form.instructions,
      skills,
      permissions,
      budgets: { maxSteps: Number(form.maxSteps), maxCostUsd: form.maxCostUsd.trim() },
      memory: { enabled: form.memory },
    },
  };
}

/** The applied bundle checked against core's schema (the last guard before saving). */
export function checkBundle(bundle: AnyAgentBundle): string | null {
  const parsed = AnyAgentBundleSchema.safeParse(bundle);
  if (parsed.success) return null;
  const first = parsed.error.issues[0];
  return first ? `${first.path.join(".") || "bundle"}: ${first.message}` : "invalid bundle";
}

export interface NewAgentFields {
  name: string;
  role: string;
  mission: string;
  instructions: string;
  modelId: string;
}

/**
 * A new agent's v1 from scratch: the definition with the schema's defaults (suggest only, so every
 * write waits for a person), and one blank workflow started by hand that the builder fills in.
 */
// DECISION: "blank workflow" is one workflow, `main`, with a manual trigger and no steps. Its
// trigger id is a fresh uuid v7, generated once and never regenerated (CLAUDE.md invariant 3).
export function blankBundle(fields: NewAgentFields, newId: () => string = () => uuidv7()) {
  const input: AgentBundleInput = {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: {
        name: fields.name.trim(),
        role: fields.role.trim(),
        mission: fields.mission.trim(),
      },
      kind: "functional",
      model: { id: fields.modelId.trim() || DEFAULT_MODEL },
      instructions: fields.instructions,
      skills: [],
      permissions: { mode: "suggest_only" },
      // v0.13 W2-I: a new agent reviews its failed steps (ARCHITECTURE §10.11).
      oversight: NEW_AGENT_OVERSIGHT,
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 3,
          trigger: { id: newId(), on: { type: "manual", input: { type: "object" } } },
          steps: [],
        },
      },
    ],
  };
  return AgentBundleSchema.parse(input);
}

/** `Material costs` → `material-costs` (the slug schema: lowercase letters, digits, dashes). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
