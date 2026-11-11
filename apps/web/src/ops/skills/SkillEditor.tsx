// The operator skill editor (ARCHITECTURE §9.2, design screen 3): what it does, how (instructions),
// the tools it may use, what goes in and comes out (fields that make the JSON Schema), and its
// settings. Saving makes a new draft version; nothing changes for agents until it is published.
//
// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14): first, which kind. An AI skill has
// instructions, a recommended model and tools that only read; a deterministic skill has rule rows.
// Both have parameters, named typed values each agent sets. A skill never writes: a write step
// after it makes the change. What would stop the server from saving the version shows as it is
// typed.
import { SKILL_KIND_LABEL, SKILL_KINDS, type SkillKind, type ToolSpec } from "@countersign/core";
import { useMemo, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Button, Card, SectionLabel } from "../../ui/primitives";
import { modelOptionLabel } from "../agents/definition-form";
import { Field, Select, TextArea, TextInput } from "../agents/ui";
import { toolTitle } from "../builder/model";
import { ParametersEditor } from "./parameters";
import { RuleRowsEditor } from "./RuleRows";
import {
  CATEGORIES,
  categoryLabel,
  definitionFromForm,
  definitionProblems,
  FIELD_TYPE_LABEL,
  FIELD_TYPES,
  type FieldRow,
  type FieldType,
  SETTING_TYPES,
  type SettingRow,
  type SettingType,
  type SkillForm,
  type SkillFormErrors,
  SLUG_RE as SLUG_OK,
  slugify,
} from "./skill-form";

const KIND_HINT: Record<SkillKind, string> = {
  ai: "Instructions and a model. Its answer is JSON, checked against what comes out.",
  deterministic: "Rule rows: the same answer every time, no model.",
};

/** AI or deterministic, and for an AI skill the model it recommends (each agent may override). */
function KindCard({
  form,
  errors,
  onChange,
}: {
  form: SkillForm;
  errors: SkillFormErrors;
  onChange(next: SkillForm): void;
}) {
  const models = useApi(apiRoutes.opsModels, form.kind === "ai" ? {} : null);
  const options = models.data?.models ?? [];
  return (
    <Card className="p-5">
      <SectionLabel>What kind of skill</SectionLabel>
      <div className="ds-seg" data-testid="skill-kind">
        {SKILL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={form.kind === k}
            data-testid={`skill-kind-${k}`}
            onClick={() => onChange({ ...form, kind: k })}
          >
            {SKILL_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-ink-muted" data-testid="skill-kind-hint">
        {KIND_HINT[form.kind]} A skill never changes anything: put a write step after it.
      </p>
      {form.kind === "ai" ? (
        <div className="mt-4 max-w-md">
          <Field
            label="Recommended model"
            error={errors.model}
            hint="Each agent may run it on another, in its Settings. Priced per million tokens."
          >
            <Select
              data-testid="skill-model-select"
              value={form.model}
              onChange={(e) => onChange({ ...form, model: e.target.value })}
            >
              {form.model && !options.some((m) => m.id === form.model) ? (
                <option value={form.model}>{modelOptionLabel(form.model)}</option>
              ) : null}
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · ${m.inputPerMtok} / ${m.outputPerMtok}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
    </Card>
  );
}

function Check({
  checked,
  onChange,
  children,
  testId,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        className="size-4 accent-slate"
        data-testid={testId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

function FieldsEditor({
  side,
  rows,
  errors,
  onChange,
}: {
  side: "input" | "output";
  rows: FieldRow[];
  errors: SkillFormErrors;
  onChange(rows: FieldRow[]): void;
}) {
  const set = (i: number, patch: Partial<FieldRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2" data-testid={`skill-${side}-fields`}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {side === "input" ? "Takes nothing in." : "Gives nothing back."}
        </p>
      ) : null}
      {rows.map((r, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until named.
          key={i}
          className="grid grid-cols-1 items-start gap-2 md:grid-cols-[minmax(0,1fr)_150px_minmax(0,1.4fr)_auto_auto]"
        >
          <Field label="Field" error={errors[`${side}.${i}`]}>
            <TextInput
              data-testid={`skill-${side}-${i}-key`}
              value={r.key}
              invalid={Boolean(errors[`${side}.${i}`])}
              onChange={(e) => set(i, { key: e.target.value })}
            />
          </Field>
          <Field label="Type">
            <Select
              data-testid={`skill-${side}-${i}-type`}
              value={r.type}
              onChange={(e) => set(i, { type: e.target.value as FieldType })}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Meaning">
            <TextInput
              value={r.description}
              onChange={(e) => set(i, { description: e.target.value })}
            />
          </Field>
          <div className="pt-7">
            <Check checked={r.required} onChange={(required) => set(i, { required })}>
              Required
            </Check>
          </div>
          <div className="pt-6">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${r.key || "field"}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      {errors[side] ? <p className="ds-error text-sm">{errors[side]}</p> : null}
      <div>
        <Button
          size="sm"
          data-testid={`skill-${side}-add`}
          onClick={() =>
            onChange([
              ...rows,
              { key: "", type: "string", description: "", required: false, extra: {} },
            ])
          }
        >
          Add a field
        </Button>
      </div>
    </div>
  );
}

function SettingsEditor({
  rows,
  errors,
  onChange,
}: {
  rows: SettingRow[];
  errors: SkillFormErrors;
  onChange(rows: SettingRow[]): void;
}) {
  const set = (i: number, patch: Partial<SettingRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-4" data-testid="skill-settings">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No settings. Add one for anything an agent should be able to tune, like a threshold.
        </p>
      ) : null}
      {rows.map((r, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until named.
          key={i}
          className="grid grid-cols-1 items-start gap-2 border-b border-line pb-4 md:grid-cols-4"
        >
          <Field label="Key" error={errors[`settings.${i}.key`]}>
            <TextInput
              data-testid={`skill-setting-${i}-key`}
              value={r.key}
              invalid={Boolean(errors[`settings.${i}.key`])}
              onChange={(e) => set(i, { key: e.target.value })}
            />
          </Field>
          <Field label="Label" error={errors[`settings.${i}.label`]}>
            <TextInput
              data-testid={`skill-setting-${i}-label`}
              value={r.label}
              invalid={Boolean(errors[`settings.${i}.label`])}
              onChange={(e) => set(i, { label: e.target.value })}
            />
          </Field>
          <Field label="Type">
            <Select
              value={r.type}
              onChange={(e) => set(i, { type: e.target.value as SettingType })}
            >
              {SETTING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "enum"
                    ? "Choice"
                    : t === "string"
                      ? "Text"
                      : t === "boolean"
                        ? "Yes or no"
                        : "Number"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default" error={errors[`settings.${i}.default`]}>
            {r.type === "boolean" ? (
              <Select
                value={r.default || "false"}
                onChange={(e) => set(i, { default: e.target.value })}
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : (
              <TextInput
                data-testid={`skill-setting-${i}-default`}
                value={r.default}
                invalid={Boolean(errors[`settings.${i}.default`])}
                onChange={(e) => set(i, { default: e.target.value })}
              />
            )}
          </Field>
          {r.type === "enum" ? (
            <Field
              label="Choices"
              className="md:col-span-2"
              error={errors[`settings.${i}.options`]}
              hint="Separated by commas."
            >
              <TextInput value={r.options} onChange={(e) => set(i, { options: e.target.value })} />
            </Field>
          ) : null}
          <div className="flex items-center gap-4 md:col-span-2 md:pt-6">
            <Check
              checked={r.clientSpecific}
              onChange={(clientSpecific) => set(i, { clientSpecific })}
              testId={`skill-setting-${i}-client-specific`}
            >
              Set per client (never promoted into a template)
            </Check>
            <Button
              variant="ghost"
              size="sm"
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
          data-testid="skill-setting-add"
          onClick={() =>
            onChange([
              ...rows,
              {
                key: "",
                label: "",
                type: "number",
                default: "",
                options: "",
                clientSpecific: false,
              },
            ])
          }
        >
          Add a setting
        </Button>
      </div>
    </div>
  );
}

export function SkillEditor({
  form,
  errors,
  tools,
  connectors,
  slugLocked,
  onChange,
}: {
  form: SkillForm;
  errors: SkillFormErrors;
  tools: readonly ToolSpec[];
  connectors: readonly { id: string; name: string }[];
  /** A saved skill keeps its slug: agents name it by `custom:<slug>`. */
  slugLocked: boolean;
  onChange(next: SkillForm): void;
}) {
  const [slugEdited, setSlugEdited] = useState(slugLocked);
  const set = <K extends keyof SkillForm>(key: K, value: SkillForm[K]) =>
    onChange({ ...form, [key]: value });
  const groups = new Map<string, ToolSpec[]>();
  // Skill model (2026-11-10): an AI skill may only read; writes are steps of their own.
  for (const t of tools.filter((x) => x.sideEffect === "none")) {
    const g = t.connector ?? t.source;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const groupName = (g: string) =>
    g === "platform" ? "Mezonas" : (connectors.find((c) => c.id === g)?.name ?? g);
  const categories = CATEGORIES.some(([id]) => id === form.category)
    ? CATEGORIES
    : [...CATEGORIES, [form.category, categoryLabel(form.category)] as const];

  const ai = form.kind === "ai";
  const problems = useMemo(() => {
    if (!SLUG_OK.test(form.slug) || !form.name.trim()) return [];
    return definitionProblems(definitionFromForm(form, tools), tools);
  }, [form, tools]);
  const scope = {
    inputs: form.input.map((r) => r.key).filter(Boolean),
    parameters: form.parameters.filter((p) => p.name),
  };
  return (
    <div className="flex flex-col gap-5">
      <KindCard form={form} errors={errors} onChange={onChange} />
      <Card className="p-5">
        <SectionLabel>What it does</SectionLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" error={errors.name} testId="skill-name">
            <TextInput
              data-testid="skill-name-input"
              value={form.name}
              invalid={Boolean(errors.name)}
              onChange={(e) =>
                onChange({
                  ...form,
                  name: e.target.value,
                  ...(slugEdited ? {} : { slug: slugify(e.target.value) }),
                })
              }
            />
          </Field>
          <Field
            label="Id"
            error={errors.slug}
            hint={
              slugLocked
                ? "Agents name it by this; it can't change."
                : "Agents name it custom:<id>."
            }
          >
            <TextInput
              data-testid="skill-slug-input"
              value={form.slug}
              disabled={slugLocked}
              invalid={Boolean(errors.slug)}
              onChange={(e) => {
                setSlugEdited(true);
                set("slug", e.target.value);
              }}
            />
          </Field>
          <Field label="Category" error={errors.category}>
            <Select
              data-testid="skill-category-select"
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
            >
              {categories.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="In one sentence" error={errors.description}>
            <TextInput
              data-testid="skill-description-input"
              value={form.description}
              invalid={Boolean(errors.description)}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
          {ai ? (
            <Field
              label="Instructions"
              className="md:col-span-2"
              error={errors.instructions}
              hint="How the model does it, in plain language: firm rules first, then judgment."
            >
              <TextArea
                data-testid="skill-instructions-input"
                rows={6}
                value={form.instructions}
                invalid={Boolean(errors.instructions)}
                onChange={(e) => set("instructions", e.target.value)}
              />
            </Field>
          ) : null}
        </div>
      </Card>

      {ai ? (
        <Card className="p-5">
          <SectionLabel>Tools it may read with</SectionLabel>
          <p className="mb-3 text-sm text-ink-muted">
            An AI skill only reads, through the client's connections. A change is a write step after
            the skill: "Save to records" or "Change in" the client's tool.
          </p>
          <div className="flex flex-col gap-4" data-testid="skill-tools">
            {[...groups.entries()].map(([g, list]) => (
              <div key={g}>
                <p className="mb-1.5 text-sm font-medium text-ink">{groupName(g)}</p>
                <div className="flex flex-col gap-1.5">
                  {list.map((t) => (
                    <Check
                      key={t.id}
                      testId={`skill-tool-${t.id}`}
                      checked={form.tools.includes(t.id)}
                      onChange={(on) =>
                        set(
                          "tools",
                          on ? [...form.tools, t.id] : form.tools.filter((x) => x !== t.id),
                        )
                      }
                    >
                      <span>{toolTitle(t)}</span>
                      <span className="text-ink-muted">{t.description}</span>
                    </Check>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="p-5">
        <SectionLabel>What goes in</SectionLabel>
        <FieldsEditor
          side="input"
          rows={form.input}
          errors={errors}
          onChange={(rows) => set("input", rows)}
        />
      </Card>
      <Card className="p-5">
        <SectionLabel>What comes out</SectionLabel>
        <FieldsEditor
          side="output"
          rows={form.output}
          errors={errors}
          onChange={(rows) => set("output", rows)}
        />
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Client timeline line"
            hint="Optional, e.g. Checked {{vendor}}. Built from the output only."
          >
            <TextInput
              data-testid="skill-summary-input"
              value={form.summary}
              onChange={(e) => set("summary", e.target.value)}
            />
          </Field>
          <div className="md:pt-7">
            <Check
              checked={form.producesAlerts}
              onChange={(v) => set("producesAlerts", v)}
              testId="skill-alerts-toggle"
            >
              Raises alerts (its output must list its sources)
            </Check>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <SectionLabel>Parameters</SectionLabel>
        <ParametersEditor
          rows={form.parameters}
          errors={errors}
          onChange={(rows) => set("parameters", rows)}
        />
      </Card>

      {ai ? null : (
        <Card className="p-5">
          <SectionLabel>Rule rows</SectionLabel>
          <RuleRowsEditor
            rows={form.rules}
            scope={scope}
            outputs={form.output.map((r) => r.key).filter(Boolean)}
            error={errors.rules}
            onChange={(rows) => set("rules", rows)}
          />
        </Card>
      )}

      {problems.length > 0 ? (
        <ul className="ds-banner flex-col gap-1 text-sm" data-testid="skill-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      <Card className="p-5">
        <SectionLabel>Settings</SectionLabel>
        <SettingsEditor
          rows={form.settings}
          errors={errors}
          onChange={(rows) => set("settings", rows)}
        />
      </Card>
    </div>
  );
}
