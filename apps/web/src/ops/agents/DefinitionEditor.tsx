// The definition editor (ARCHITECTURE §9.1, §15 "editor"): identity, instructions, skills with
// their settings (forms from each skill's settings schema), permissions and default approver,
// budgets. Saving makes a new draft version from the version it was opened on; the workflows are
// kept as they are (the builder edits them). The same editor serves templates and client agents.
import type { AnyAgentBundle, SkillOption } from "@countersign/core";
import { useMemo, useState } from "react";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionSummary } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Badge, Button, Card, SectionLabel } from "../../ui/primitives";
import {
  APPROVER_ROLES,
  applyForm,
  checkBundle,
  type DefinitionForm,
  formFromBundle,
  MODEL_OPTIONS,
  optionFor,
  type SettingValue,
  validateForm,
} from "./definition-form";
import { Field, isCode, Notice, Select, TextArea, TextInput, useAction } from "./ui";

/** POST /api/ops/agents/:id/versions: the draft, and what would stop it from publishing. */
export type SaveResult = ResponseOf<typeof apiRoutes.opsSaveVersion>;

export function DefinitionEditor({
  agent,
  from,
  bundle,
  skills,
  onSaved,
  onNoChange,
}: {
  agent: AgentSummary;
  /** The version the editor was opened on: the new draft's parent. */
  from: VersionSummary;
  bundle: AnyAgentBundle;
  /** The skills this agent may use (GET /api/ops/agents/:id/skills). */
  skills: readonly SkillOption[];
  onSaved(result: SaveResult): void;
  onNoChange(): void;
}) {
  const [form, setForm] = useState<DefinitionForm>(() => formFromBundle(bundle));
  const [changeNote, setChangeNote] = useState("");
  const [releaseNote, setReleaseNote] = useState("");
  const [touched, setTouched] = useState(false);
  const save = useAction();
  const errors = useMemo(() => validateForm(form, skills), [form, skills]);
  const hasErrors = Object.keys(errors).length > 0;
  const shown = touched ? errors : {};

  const set = <K extends keyof DefinitionForm>(key: K, value: DefinitionForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function onSave() {
    setTouched(true);
    if (hasErrors) return;
    const next = applyForm(bundle, form, skills);
    if (checkBundle(next)) return;
    const res = await save.call(apiRoutes.opsSaveVersion, {
      params: { id: agent.id },
      body: {
        bundle: next,
        parentVersionId: from.id,
        ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
        ...(agent.kind === "template" && releaseNote.trim()
          ? { releaseNote: releaseNote.trim() }
          : {}),
      },
    });
    if (res.ok) onSaved(res.data);
    else if (isCode(res.error, "no_op")) {
      // The API's hash check: nothing changed since `from`, so no version was made.
      save.clear();
      onNoChange();
    }
  }

  const bundleProblem = touched && !hasErrors ? checkBundle(applyForm(bundle, form, skills)) : null;

  return (
    <div className="flex flex-col gap-5" data-testid="agent-editor">
      <Card className="p-5">
        <SectionLabel>Identity</SectionLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name" error={shown.name} testId="agent-editor-name">
            <TextInput
              data-testid="agent-editor-name-input"
              value={form.name}
              invalid={Boolean(shown.name)}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="Area" hint="What part of the business it works in, e.g. Purchasing.">
            <TextInput
              data-testid="agent-editor-role-input"
              value={form.role}
              onChange={(e) => set("role", e.target.value)}
            />
          </Field>
          <Field label="Mission" className="md:col-span-2">
            <TextArea
              data-testid="agent-editor-mission-input"
              rows={2}
              value={form.mission}
              onChange={(e) => set("mission", e.target.value)}
            />
          </Field>
          <Field label="Model" error={shown.modelId} testId="agent-editor-model">
            <Select
              data-testid="agent-editor-model-select"
              value={form.modelId}
              onChange={(e) => set("modelId", e.target.value)}
            >
              {[...new Set([...MODEL_OPTIONS, form.modelId])].filter(Boolean).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Max tokens per answer"
            error={shown.maxTokens}
            testId="agent-editor-max-tokens"
          >
            <TextInput
              data-testid="agent-editor-max-tokens-input"
              inputMode="numeric"
              value={form.maxTokens}
              invalid={Boolean(shown.maxTokens)}
              onChange={(e) => set("maxTokens", e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <SectionLabel>Instructions</SectionLabel>
        <Field label="How this agent works" hint="Plain language. Added to every prompt it runs.">
          <TextArea
            data-testid="agent-editor-instructions-input"
            rows={8}
            value={form.instructions}
            onChange={(e) => set("instructions", e.target.value)}
          />
        </Field>
      </Card>

      <SkillsCard
        form={form}
        skills={skills}
        errors={shown}
        kind={agent.kind}
        onChange={(next) => set("skills", next)}
      />

      <Card className="p-5">
        <SectionLabel>Permissions</SectionLabel>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Mode</legend>
          <ModeOption
            value="suggest_only"
            current={form.mode}
            onSelect={(m) => set("mode", m)}
            title="Suggest only"
            text="Every change to a client's tools waits for a person."
          />
          <ModeOption
            value="act"
            current={form.mode}
            onSelect={(m) => set("mode", m)}
            title="Act"
            text="A step whose approval the operator switched off may change a tool without asking, where the client's connection allows it."
          />
        </fieldset>
        <p className="mt-3 text-sm text-ink-muted" data-testid="agent-editor-approval-rule">
          Approval stays on for every step that changes a client's tool until it is switched off in
          the workflow, and only where the connection allows automatic changes. Delete is never
          automatic.
        </p>
        <ApproverField
          value={form.approver}
          error={shown.approver}
          onChange={(v) => set("approver", v)}
        />
      </Card>

      <Card className="p-5">
        <SectionLabel>Budgets</SectionLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Max steps per run" error={shown.maxSteps} testId="agent-editor-max-steps">
            <TextInput
              data-testid="agent-editor-max-steps-input"
              inputMode="numeric"
              value={form.maxSteps}
              invalid={Boolean(shown.maxSteps)}
              onChange={(e) => set("maxSteps", e.target.value)}
            />
          </Field>
          <Field
            label="Max cost per run (USD)"
            error={shown.maxCostUsd}
            testId="agent-editor-max-cost"
          >
            <TextInput
              data-testid="agent-editor-max-cost-input"
              inputMode="decimal"
              value={form.maxCostUsd}
              invalid={Boolean(shown.maxCostUsd)}
              onChange={(e) => set("maxCostUsd", e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-base text-ink">
            <input
              className="size-4 accent-slate"
              type="checkbox"
              data-testid="agent-editor-memory-toggle"
              checked={form.memory}
              onChange={(e) => set("memory", e.target.checked)}
            />
            Remembers notes between runs
          </label>
        </div>
      </Card>

      <Card className="p-5">
        <SectionLabel>Save as a draft</SectionLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Change note" hint={`What changed since v${from.version}.`}>
            <TextInput
              data-testid="agent-editor-change-note-input"
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
            />
          </Field>
          {agent.kind === "template" ? (
            <Field
              label="Release note"
              hint="What clients' update reviews show when it's published."
            >
              <TextInput
                data-testid="agent-editor-release-note-input"
                value={releaseNote}
                onChange={(e) => setReleaseNote(e.target.value)}
              />
            </Field>
          ) : null}
        </div>
        {touched && hasErrors ? (
          <div className="mt-4">
            <Notice tone="warning" testId="agent-editor-invalid">
              Fix the highlighted fields before saving.
            </Notice>
          </div>
        ) : null}
        {bundleProblem ? (
          <div className="mt-4">
            <Notice tone="warning">
              This definition does not match the schema: {bundleProblem}
            </Notice>
          </div>
        ) : null}
        {save.error ? (
          <div className="mt-4">
            <Notice tone="warning" testId="agent-editor-save-error">
              {(save.error as Error).message}
            </Notice>
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-3">
          <span className="text-sm text-ink-muted">
            A new draft version, edited from v{from.version}. Publish it from Versions.
          </span>
          <Button
            variant="primary"
            data-testid="agent-editor-save"
            disabled={save.busy || (touched && hasErrors)}
            onClick={onSave}
          >
            {save.busy ? "Saving…" : "Save draft"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ModeOption({
  value,
  current,
  onSelect,
  title,
  text,
}: {
  value: DefinitionForm["mode"];
  current: DefinitionForm["mode"];
  onSelect(mode: DefinitionForm["mode"]): void;
  title: string;
  text: string;
}) {
  const selected = value === current;
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 ${
        selected ? "border-slate bg-slate-tint" : "border-line bg-surface hover:bg-surface-subtle"
      }`}
    >
      <input
        type="radio"
        name="agent-mode"
        className="mt-1 size-4 accent-slate"
        data-testid={`agent-editor-mode-${value}`}
        checked={selected}
        onChange={() => onSelect(value)}
      />
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="block text-sm text-ink-muted">{text}</span>
      </span>
    </label>
  );
}

const APPROVER_LABEL: Record<string, string> = {
  client_admin: "The client's admin",
  operator: "Us (the operator)",
};

function ApproverField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | undefined;
  onChange(v: string): void;
}) {
  const isRole = value === "" || (APPROVER_ROLES as readonly string[]).includes(value);
  const [person, setPerson] = useState(!isRole);
  const choice = person ? "person" : value;
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="Default approver" hint="For steps that don't name their own approver.">
        <Select
          data-testid="agent-editor-approver-select"
          value={choice}
          onChange={(e) => {
            const v = e.target.value;
            setPerson(v === "person");
            onChange(v === "person" ? "" : v);
          }}
        >
          <option value="">The client's setting</option>
          {APPROVER_ROLES.map((r) => (
            <option key={r} value={r}>
              {APPROVER_LABEL[r]}
            </option>
          ))}
          <option value="person">A specific person…</option>
        </Select>
      </Field>
      {person ? (
        <Field label="Person (user id)" error={error} testId="agent-editor-approver">
          <TextInput
            data-testid="agent-editor-approver-input"
            value={value}
            invalid={Boolean(error)}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      ) : null}
    </div>
  );
}

function SkillsCard({
  form,
  skills,
  errors,
  kind,
  onChange,
}: {
  form: DefinitionForm;
  skills: readonly SkillOption[];
  errors: Record<string, string>;
  kind: AgentSummary["kind"];
  onChange(next: DefinitionForm["skills"]): void;
}) {
  const [adding, setAdding] = useState("");
  const listed = new Set(form.skills.map((s) => optionFor(s.skill, skills)?.id ?? s.skill));
  const addable = skills.filter((s) => !listed.has(s.id));

  const update = (i: number, key: string, value: SettingValue | undefined) =>
    onChange(
      form.skills.map((s, j) => {
        if (j !== i) return s;
        const settings = { ...s.settings };
        if (value === undefined || value === "") delete settings[key];
        else settings[key] = value;
        return { ...s, settings };
      }),
    );

  return (
    <Card className="p-5">
      <SectionLabel>Skills it uses</SectionLabel>
      {form.skills.length === 0 ? (
        <p className="mb-4 text-sm text-ink-muted">
          No skills yet. Its workflows can still use actions, people and logic steps.
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {form.skills.map((entry, i) => {
          const option = optionFor(entry.skill, skills);
          return (
            <li
              key={entry.skill}
              data-testid={`agent-editor-skill-${entry.skill}`}
              className="rounded-md border border-line p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* By its name; the reference only when there is no skill to name it. */}
                  <p className="font-medium text-ink">{option?.name ?? entry.skill}</p>
                  {option ? (
                    <p className="text-sm text-ink-muted">{option.description}</p>
                  ) : (
                    <p
                      className="text-sm text-risk"
                      data-testid={`agent-editor-skill-${entry.skill}-missing`}
                    >
                      This skill isn't available to this agent; publishing will refuse it.
                    </p>
                  )}
                  {errors[`skills.${i}`] ? (
                    <p className="text-sm text-risk">{errors[`skills.${i}`]}</p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  data-testid={`agent-editor-skill-${entry.skill}-remove`}
                  onClick={() => onChange(form.skills.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
              {option && option.settings.length > 0 ? (
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  {option.settings.map((s) => (
                    <SettingField
                      key={s.key}
                      setting={s}
                      value={entry.settings[s.key]}
                      error={errors[`skills.${i}.${s.key}`]}
                      testId={`agent-editor-setting-${entry.skill}-${s.key}`}
                      template={kind === "template"}
                      onChange={(v) => update(i, s.key, v)}
                    />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex items-end gap-2">
        <Field label="Add a skill" className="flex-1">
          <Select
            data-testid="agent-editor-skill-add-select"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          >
            <option value="">
              {addable.length ? "Choose a skill…" : "No other skills available"}
            </option>
            {addable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.category}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          data-testid="agent-editor-skill-add"
          disabled={!adding}
          onClick={() => {
            onChange([...form.skills, { skill: adding, settings: {} }]);
            setAdding("");
          }}
        >
          Add
        </Button>
      </div>
    </Card>
  );
}

function SettingField({
  setting,
  value,
  error,
  testId,
  template,
  onChange,
}: {
  setting: SkillOption["settings"][number];
  value: SettingValue | undefined;
  error: string | undefined;
  testId: string;
  template: boolean;
  onChange(v: SettingValue | undefined): void;
}) {
  const def = setting.default === undefined ? "none" : String(setting.default);
  const label = (
    <span className="flex items-center gap-2">
      {setting.label}
      {setting.clientSpecific ? (
        <Badge tone="neutral">{template ? "Set per client" : "This client's"}</Badge>
      ) : null}
    </span>
  );
  const hint = `Default: ${def}`;
  if (setting.type === "boolean" || setting.type === "enum") {
    const options = setting.type === "boolean" ? ["true", "false"] : (setting.options ?? []);
    return (
      <Field label={label} hint={hint} error={error} testId={testId}>
        <Select
          data-testid={`${testId}-select`}
          value={value === undefined ? "" : String(value)}
          invalid={Boolean(error)}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === "" ? undefined : setting.type === "boolean" ? v === "true" : v);
          }}
        >
          <option value="">Default ({def})</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {setting.type === "boolean" ? (o === "true" ? "Yes" : "No") : o}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  return (
    <Field label={label} hint={hint} error={error} testId={testId}>
      <TextInput
        data-testid={`${testId}-input`}
        inputMode={setting.type === "number" ? "decimal" : undefined}
        placeholder={def}
        value={value === undefined ? "" : String(value)}
        invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** Loads the agent's skill options for the editor. */
export function useSkillOptions(agentId: string) {
  return useApi(apiRoutes.opsAgentSkills, { params: { id: agentId } });
}
