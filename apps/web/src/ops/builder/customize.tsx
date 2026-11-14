// A skill step's customization (ARCHITECTURE §10.14 "Skill templates"; core's
// `processes.SkillCustomization`): skills in the Library are templates, and a step may change the
// skill's settings, add instructions (after the skill's own, never replacing them), add or edit
// rule rows and keep only some output fields. It never changes what the skill is: its method, its
// types, its core instructions or its tools. Each part is shown against the skill template's value
// (and, on a client agent, the agent template's), and core's `customizationProblems` says what
// can't apply. The customization is versioned with the agent like everything else in the bundle.
import {
  type AnyAgentBundle,
  lookupSkill,
  type ProcessAgentBundle,
  processes,
  SKILL_KIND_LABEL,
  type SkillDefinition,
  type SkillSetting,
  skillKind,
  skillMethod,
  type TypingContext,
  toolLookup,
  uuidv7,
} from "@countersign/core";
import type { ReactNode } from "react";
import { TextArea } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Badge, Button } from "../../ui/primitives";
import { ruleRowText } from "../skills/rule-rows";
import { rulesText } from "../workflow/describe";
import {
  type FieldErrors,
  JsonInput,
  parseNumberText,
  Row,
  SmallInput,
  SmallSelect,
} from "./fields";
import { findTemplateStep, type Process, type Step } from "./model";
import { RulesEditor } from "./rules";

type SkillStep = Extract<Step, { kind: "skill" }>;
type Customization = processes.SkillCustomization;
type RuleEdit = processes.SkillRuleEdit;
type SetStep = (key: string, fn: (s: Step) => Step) => void;

/**
 * A new rule row's id. Customizations are versioned with the agent and merged three-way by id
 * (invariant 3), so an added row gets a uuidv7 like every other id the builder makes; its `name`
 * is what people read. A rule id starts with a letter, hence the prefix.
 */
// DECISION (web, wave 3b): `rule-<uuidv7>`, not a per-step counter: a template's and a client
// agent's independently added rows can't share an id and be lined up as one in an update merge.
export function newRuleId(newId: () => string = uuidv7): string {
  return `rule-${newId()}`;
}

const METHOD_LABEL: Record<string, string> = {
  rules: "Rules",
  ai: "AI",
  rules_then_ai: "Rules, then AI for what they leave open",
};

function settingText(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** A customization with empty parts dropped; undefined when nothing is left. */
function tidy(c: Customization): Customization | undefined {
  const out: Customization = {};
  if (c.settings && Object.keys(c.settings).length) out.settings = c.settings;
  if (c.addInstructions) out.addInstructions = c.addInstructions;
  const add = c.rules?.add?.length ? c.rules.add : undefined;
  const edit = c.rules?.edit?.length ? c.rules.edit : undefined;
  if (add || edit) out.rules = { ...(add ? { add } : {}), ...(edit ? { edit } : {}) };
  if (c.model) out.model = c.model;
  if (c.keep?.length) out.keep = c.keep;
  // Skill model (2026-11-10): the step's own parameter values (skill-step.tsx edits them).
  if (c.parameters && Object.keys(c.parameters).length) out.parameters = c.parameters;
  return Object.keys(out).length ? out : undefined;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="eyebrow text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

/** A setting's control: a select for yes/no and options, a text box otherwise. */
function SettingControl({
  setting,
  value,
  placeholder,
  onChange,
}: {
  setting: SkillSetting;
  value: unknown;
  placeholder: string;
  onChange(v: unknown): void;
}) {
  const field = `customize.settings.${setting.key}`;
  const testId = `builder-setting-${setting.key}`;
  if (setting.type === "boolean" || setting.type === "enum") {
    const options = setting.type === "boolean" ? ["true", "false"] : (setting.options ?? []);
    return (
      <SmallSelect
        data-field={field}
        data-testid={testId}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : setting.type === "boolean" ? v === "true" : v);
        }}
      >
        <option value="">Default ({placeholder})</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {setting.type === "boolean" ? (o === "true" ? "Yes" : "No") : o}
          </option>
        ))}
      </SmallSelect>
    );
  }
  return (
    <SmallInput
      data-field={field}
      data-testid={testId}
      value={value === undefined ? "" : String(value)}
      placeholder={placeholder}
      onChange={(e) => {
        const text = e.target.value;
        if (text === "") onChange(undefined);
        else onChange(setting.type === "number" ? parseNumberText(text) : text);
      }}
    />
  );
}

export interface CustomizeProps {
  step: SkillStep;
  ctx: TypingContext;
  bundle: ProcessAgentBundle;
  /** A client agent's base template version, for "the template's value". */
  template: { bundle: AnyAgentBundle | ProcessAgentBundle; workflow: Process | undefined } | null;
  errors: FieldErrors;
  set: SetStep;
}

/** Settings, added instructions, rule rows and the output fields kept, against the skill's own. */
export function CustomizeSection(props: CustomizeProps) {
  const { step, ctx, set } = props;
  const skill = lookupSkill(step.skill, ctx);
  if (!skill) return null;
  const custom = step.customize ?? {};
  const setCustom = (key: string, fn: (c: Customization) => Customization) =>
    set(`customize:${key}`, (s) => {
      if (s.kind !== "skill") return s;
      const next = tidy(fn(s.customize ?? {}));
      const { customize: _c, ...rest } = s;
      return next ? { ...rest, customize: next } : rest;
    });
  const method = skillMethod(skill);
  // Core names a rule by its id; an added row reads by its name (its id is a uuid).
  const addedNames = new Map(
    (step.customize?.rules?.add ?? []).flatMap((r) => (r.name ? [[r.id, r.name] as const] : [])),
  );
  const problems = (
    step.customize ? processes.customizationProblems(skill, step.customize) : []
  ).map((p) =>
    p.replace(/\brule ([a-z][a-z0-9_-]*)/g, (whole, id: string) => {
      const name = addedNames.get(id);
      return name ? `rule “${name}”` : whole;
    }),
  );
  const fields = Object.keys(
    (skill.output.properties as Record<string, unknown> | undefined) ?? {},
  );
  return (
    <div className="flex flex-col gap-4" data-testid="builder-customize">
      <p className="text-xs text-ink-muted" data-testid="builder-customize-method">
        {/* Skill model (2026-11-10): the kind first; a stored retiring method says itself. */}
        {SKILL_KIND_LABEL[skillKind(skill, toolLookup(ctx.tools ?? {}))]}
        {method === "rules_then_ai" ? ` · ${METHOD_LABEL[method]}` : ""}. This step customizes the
        skill for this workflow; the skill itself stays as it is in the Library.
      </p>
      {problems.length ? (
        <ul className="ds-banner flex-col gap-1 text-sm" data-testid="builder-customize-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <SettingsPart {...props} skill={skill} setCustom={setCustom} />
      {method !== "rules" ? (
        <Section title="Instructions">
          {skill.instructions ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-ink-muted">
                The skill's own instructions
              </summary>
              <p
                className="mt-2 whitespace-pre-wrap text-ink"
                data-testid="builder-customize-own-instructions"
              >
                {skill.instructions}
              </p>
            </details>
          ) : null}
          <Row
            label="Add to them"
            field="customize.addInstructions"
            errors={props.errors}
            hint="Added after the skill's own, never replacing them."
          >
            <TextArea
              rows={3}
              data-field="customize.addInstructions"
              data-testid="builder-customize-instructions"
              value={custom.addInstructions ?? ""}
              onChange={(e) => {
                const text = e.target.value;
                setCustom("instructions", (c) => {
                  const { addInstructions: _a, ...rest } = c;
                  return text ? { ...rest, addInstructions: text } : rest;
                });
              }}
            />
          </Row>
        </Section>
      ) : null}
      {method !== "ai" ? <RulesPart {...props} skill={skill} setCustom={setCustom} /> : null}
      {fields.length > 1 ? (
        <Section title="What it passes on">
          <p className="text-xs text-ink-muted">Untick what later steps don't need.</p>
          <div className="flex flex-col gap-1" data-field="customize.keep" tabIndex={-1}>
            {fields.map((f) => {
              const kept = custom.keep ? custom.keep.includes(f) : true;
              return (
                <label key={f} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-slate"
                    data-testid={`builder-customize-keep-${f}`}
                    checked={kept}
                    onChange={(e) =>
                      setCustom("keep", (c) => {
                        const now = c.keep ?? fields;
                        const next = e.target.checked ? [...now, f] : now.filter((x) => x !== f);
                        const { keep: _k, ...rest } = c;
                        // Every field kept is the same as no `keep`.
                        return next.length === fields.length || next.length === 0
                          ? rest
                          : { ...rest, keep: fields.filter((x) => next.includes(x)) };
                      })
                    }
                  />
                  <span className="reference">{f}</span>
                </label>
              );
            })}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function SettingsPart(
  props: CustomizeProps & {
    skill: SkillDefinition;
    setCustom(key: string, fn: (c: Customization) => Customization): void;
  },
) {
  const { step, skill, bundle, template, errors } = props;
  if (skill.settings.length === 0) return null;
  const agentOverrides =
    bundle.definition.skills.find((s) => s.skill === step.skill)?.settings ?? {};
  const templateStep = template ? findTemplateStep(template.workflow, step.id) : undefined;
  const templateAgent =
    template?.bundle.definition.skills.find((s) => s.skill === step.skill)?.settings ?? {};
  return (
    <Section title="Settings">
      <p className="text-xs text-ink-muted">
        Empty means the agent's setting, else the skill's default.
      </p>
      {skill.settings.map((setting) => {
        const own = step.customize?.settings?.[setting.key] ?? step.settings?.[setting.key];
        const fallback = agentOverrides[setting.key] ?? setting.default;
        const templateValue = template
          ? ((templateStep?.kind === "skill"
              ? (templateStep.customize?.settings?.[setting.key] ??
                templateStep.settings?.[setting.key])
              : undefined) ??
            templateAgent[setting.key] ??
            setting.default)
          : undefined;
        const effective = own ?? fallback;
        const customized =
          template !== null && JSON.stringify(effective) !== JSON.stringify(templateValue);
        return (
          <Row
            key={setting.key}
            label={setting.label}
            field={`customize.settings.${setting.key}`}
            errors={errors}
            aside={
              customized ? (
                <Badge tone="accent" testId={`builder-setting-${setting.key}-customized`}>
                  Customized
                </Badge>
              ) : null
            }
            hint={
              <span data-testid={`builder-setting-${setting.key}-template`}>
                {template
                  ? `Template: ${settingText(templateValue)}`
                  : `The skill's default: ${settingText(setting.default)}`}
              </span>
            }
          >
            <SettingControl
              setting={setting}
              value={own}
              placeholder={settingText(fallback)}
              onChange={(v) => {
                // A step's own setting moves into its customization (the step's most specific
                // layer, core's `stepSkillSettings`), so it is one place, not two.
                set(`setting:${setting.key}`, step, setting.key, v);
              }}
            />
          </Row>
        );
      })}
    </Section>
  );

  function set(key: string, _s: SkillStep, k: string, v: unknown) {
    props.set(`customize:${key}`, (x) => {
      if (x.kind !== "skill") return x;
      const { settings: legacy, customize, ...rest } = x;
      const left = { ...(legacy ?? {}) };
      delete left[k];
      const next = { ...(customize?.settings ?? {}) };
      if (v === undefined) delete next[k];
      else next[k] = v;
      const c = tidy({ ...(customize ?? {}), settings: next });
      return {
        ...rest,
        ...(Object.keys(left).length ? { settings: left } : {}),
        ...(c ? { customize: c } : {}),
      };
    });
  }
}

function RulesPart(
  props: CustomizeProps & {
    skill: SkillDefinition;
    setCustom(key: string, fn: (c: Customization) => Customization): void;
  },
) {
  const { step, skill, setCustom, errors } = props;
  const own = skill.rules ?? [];
  const edits = step.customize?.rules?.edit ?? [];
  const added = step.customize?.rules?.add ?? [];
  const setEdits = (key: string, fn: (e: RuleEdit[]) => RuleEdit[]) =>
    setCustom(`rules.edit:${key}`, (c) => ({
      ...c,
      rules: { ...c.rules, edit: fn(c.rules?.edit ?? []) },
    }));
  const setAdded = (key: string, fn: (a: typeof added) => typeof added) =>
    setCustom(`rules.add:${key}`, (c) => ({
      ...c,
      rules: { ...c.rules, add: fn(c.rules?.add ?? []) },
    }));
  return (
    <Section title="Rules">
      <p className="text-xs text-ink-muted">
        Tried top to bottom; the first that matches sets the result. Rows you add go after the
        skill's.
      </p>
      {own.length === 0 && added.length === 0 ? (
        <p className="text-sm text-ink-muted">The skill has no rules of its own.</p>
      ) : null}
      <ol className="flex flex-col gap-2" data-testid="builder-customize-rules">
        {own.map((row) => {
          const edit = edits.find((e) => e.id === row.id);
          const i = edits.findIndex((e) => e.id === row.id);
          const when = edit?.when ?? row.when;
          const set = edit?.set ?? row.set;
          return (
            <li
              key={row.id}
              className="flex flex-col gap-2 rounded-sm border border-line p-2"
              data-testid={`builder-rule-${row.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{row.name ?? row.id}</span>
                {edit ? (
                  <span className="flex items-center gap-2">
                    <Badge tone="accent">Customized</Badge>
                    <button
                      type="button"
                      data-testid={`builder-rule-${row.id}-revert`}
                      className="ds-btn ds-btn--link text-xs"
                      onClick={() =>
                        setEdits(`${row.id}:revert`, (e) => e.filter((x) => x.id !== row.id))
                      }
                    >
                      Use the skill's
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid={`builder-rule-${row.id}-edit`}
                    className="ds-btn ds-btn--link text-xs"
                    onClick={() =>
                      setEdits(`${row.id}:edit`, (e) => [
                        ...e,
                        { id: row.id, when: row.when, set: row.set },
                      ])
                    }
                  >
                    Change for this step
                  </button>
                )}
              </div>
              {edit ? (
                <>
                  <RulesEditor
                    rules={when}
                    paths={[]}
                    errors={errors}
                    prefix={`customize.rules.edit.${i}.when`}
                    testPrefix={`builder-rule-${row.id}-when`}
                    onChange={(next, key) =>
                      setEdits(`${row.id}:${key}`, (e) =>
                        e.map((x) => (x.id === row.id ? { ...x, when: next } : x)),
                      )
                    }
                  />
                  <Row
                    label="Then the result has"
                    field={`customize.rules.edit.${i}.set`}
                    errors={errors}
                  >
                    <JsonInput
                      field={`customize.rules.edit.${i}.set`}
                      testId={`builder-rule-${row.id}-set`}
                      value={set}
                      rows={2}
                      onChange={(v) =>
                        setEdits(`${row.id}:set`, (e) =>
                          e.map((x) =>
                            x.id === row.id
                              ? { ...x, set: (v ?? {}) as Record<string, unknown> }
                              : x,
                          ),
                        )
                      }
                    />
                  </Row>
                </>
              ) : (
                <p className="reference text-ink-muted" data-testid={`builder-rule-${row.id}-text`}>
                  {/* Skill model (2026-11-10): a row with typed conditions or outputs in words. */}
                  {row.conditions?.length || row.compute
                    ? ruleRowText(row, {
                        inputs: [],
                        parameters: (skill.parameters ?? []).map((p) => ({
                          name: p.name,
                          label: p.label,
                          type: p.type,
                        })),
                      })
                    : `if ${rulesText(when)} then ${JSON.stringify(set)}`}
                </p>
              )}
            </li>
          );
        })}
        {added.map((row, i) => (
          <li
            key={row.id}
            className="flex flex-col gap-2 rounded-sm border border-line p-2"
            data-testid={`builder-rule-added-${i}`}
          >
            <div className="flex items-center justify-between gap-2">
              <SmallInput
                aria-label="Rule name"
                data-testid={`builder-rule-added-${i}-name`}
                value={row.name ?? ""}
                placeholder={row.id}
                onChange={(e) =>
                  setAdded(`${i}:name`, (a) =>
                    a.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  )
                }
              />
              <button
                type="button"
                data-testid={`builder-rule-added-${i}-remove`}
                className="ds-btn ds-btn--link shrink-0 text-xs"
                onClick={() => setAdded(`${i}:remove`, (a) => a.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
            <RulesEditor
              rules={row.when}
              paths={[]}
              errors={errors}
              prefix={`customize.rules.add.${i}.when`}
              testPrefix={`builder-rule-added-${i}-when`}
              onChange={(when, key) =>
                setAdded(`${i}:${key}`, (a) => a.map((x, j) => (j === i ? { ...x, when } : x)))
              }
            />
            <Row label="Then the result has" field={`customize.rules.add.${i}.set`} errors={errors}>
              <JsonInput
                field={`customize.rules.add.${i}.set`}
                testId={`builder-rule-added-${i}-set`}
                value={row.set}
                rows={2}
                onChange={(v) =>
                  setAdded(`${i}:set`, (a) =>
                    a.map((x, j) =>
                      j === i ? { ...x, set: (v ?? {}) as Record<string, unknown> } : x,
                    ),
                  )
                }
              />
            </Row>
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        className="self-start"
        data-testid="builder-rule-add"
        onClick={() =>
          setAdded("add", (a) => [
            ...a,
            {
              id: newRuleId(),
              name: `Rule ${own.length + a.length + 1}`,
              when: { match: "all", rules: [] },
              set: {},
            },
          ])
        }
      >
        <Icon name="add" />
        Add a rule
      </Button>
    </Section>
  );
}
