// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14) on a skill step's inspector: its kind,
// the model it runs on and where that came from ("Runs on: Sonnet (set for this skill in the
// agent)"), with the step's own override for the rare double use; its parameters as the agent
// sets them, each with the step's own override; and the skill version it pins, with "Move to
// vN" (compatible: one click; breaking: every reference downstream remapped first).
import {
  agentSkillEntry,
  effectiveModel,
  MODEL_SOURCE_WORDS,
  modelTools,
  type ProcessAgentBundle,
  parseSkillRef,
  type SkillDefinition,
  type SkillMoveView,
  skillKind,
  type TypingContext,
  toolLookup,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Badge, Button, cx } from "../../ui/primitives";
import { modelOptionLabel } from "../agents/definition-form";
import { errorText, useAction } from "../agents/ui";
import { ParameterValueInput, parameterText, valueProblem } from "../skills/parameters";
import { type FieldErrors, Row, SmallSelect } from "./fields";
import type { Process, Step } from "./model";
import { outputFields, remappable, type SkillReference } from "./skill-move";

type SkillStep = Extract<Step, { kind: "skill" }>;
type SetStep = (key: string, fn: (s: Step) => Step) => void;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="eyebrow text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

// ── The model ────────────────────────────────────────────────────────────────────────────────

/** A model's name as the pickers show it: its served label, else its provider's name for it. */
function modelName(id: string, served: readonly { id: string; label: string }[]): string {
  return served.find((m) => m.id === id)?.label ?? modelOptionLabel(id);
}

/**
 * "Runs on: <model> (<where it came from>)" and the step's own override. Most specific wins: the
 * step, then the agent's setting for this skill, then the skill's recommended model, then the
 * agent's own (core's `effectiveModel`). A deterministic skill runs no model; a built-in whose
 * tool calls a model picks its own, so neither offers a choice.
 */
export function RunsOnRow({
  step,
  skill,
  bundle,
  ctx,
  fieldErrors,
  set,
}: {
  step: SkillStep;
  skill: SkillDefinition;
  bundle: ProcessAgentBundle;
  ctx: TypingContext;
  fieldErrors: FieldErrors;
  set: SetStep;
}) {
  const id = parseSkillRef(step.skill).id;
  const agentSkill = agentSkillEntry(bundle.definition, id)?.model;
  const own = step.model ?? step.customize?.model;
  const runs = effectiveModel({
    skill,
    agentModel: bundle.definition.model,
    agentSkill,
    step: own,
  });
  const models = useApi(apiRoutes.opsModels, runs ? { life: "catalog" } : null);
  if (!runs) {
    const inside = modelTools(skill, toolLookup(ctx.tools ?? {}));
    return (
      <p className="text-sm text-ink-muted" data-testid="builder-inspector-runs-on">
        {inside.length > 0
          ? "Its built-in code calls a model of its own; the step doesn't choose it."
          : "Runs no model: it works by rules, the same every time."}
      </p>
    );
  }
  const served = models.data?.models ?? [];
  const current = step.model?.id ?? "";
  // What the step falls back to without its own: the agent's setting, else the skill's.
  const below = effectiveModel({ skill, agentModel: bundle.definition.model, agentSkill });
  return (
    <>
      <p className="text-sm text-ink" data-testid="builder-inspector-runs-on">
        Runs on: <span className="font-medium">{modelName(runs.model.id, served)}</span>{" "}
        <span className="text-ink-muted">({MODEL_SOURCE_WORDS[runs.from]})</span>
      </p>
      <Row
        label="Model for this step"
        field="model"
        errors={fieldErrors}
        hint={
          models.error
            ? "Couldn't load the models; the step keeps its own."
            : "Only for a step that uses the skill differently. Price per million tokens, in and out."
        }
      >
        <SmallSelect
          data-field="model"
          data-testid="builder-inspector-model"
          value={current}
          onChange={(e) => {
            const next = e.target.value;
            set("model", (s) => {
              if (s.kind !== "skill") return s;
              const { model: _m, ...rest } = s;
              return next ? { ...rest, model: { id: next } } : rest;
            });
          }}
        >
          <option value="">
            {below ? `As the agent runs it: ${modelName(below.model.id, served)}` : "As the agent"}
          </option>
          {current && !served.some((m) => m.id === current) ? (
            <option value={current}>A model no longer offered</option>
          ) : null}
          {served.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · ${m.inputPerMtok} / ${m.outputPerMtok}
            </option>
          ))}
        </SmallSelect>
      </Row>
    </>
  );
}

// ── Parameters ───────────────────────────────────────────────────────────────────────────────

/**
 * The skill's parameters on this step: what the agent sets (else the skill's default), and the
 * step's own value over it (its customization's `parameters`). Empty keeps the agent's.
 */
export function StepParameters({
  step,
  skill,
  bundle,
  set,
}: {
  step: SkillStep;
  skill: SkillDefinition;
  bundle: ProcessAgentBundle;
  set: SetStep;
}) {
  const params = skill.parameters ?? [];
  if (params.length === 0) return null;
  const agent = agentSkillEntry(bundle.definition, parseSkillRef(step.skill).id)?.parameters ?? {};
  const own = step.customize?.parameters ?? {};
  return (
    <Section title="Parameters">
      <p className="text-xs text-ink-muted">
        As the agent sets them in its Settings. Set one here only for a step that differs.
      </p>
      {params.map((p) => {
        const inherited = agent[p.name] ?? p.default;
        const from = agent[p.name] !== undefined ? "The agent's" : "The skill's default";
        const value = own[p.name];
        const problem = valueProblem(p, value);
        return (
          <Row
            key={p.name}
            label={p.label}
            aside={
              value !== undefined ? (
                <Badge tone="accent" testId={`builder-parameter-${p.name}-own`}>
                  This step's
                </Badge>
              ) : null
            }
            hint={
              <span
                data-testid={`builder-parameter-${p.name}-inherited`}
                className={cx(problem && "ds-error")}
              >
                {problem ?? `${from}: ${parameterText(p.type, inherited)}`}
              </span>
            }
          >
            <ParameterValueInput
              param={p}
              value={value}
              testId={`builder-parameter-${p.name}`}
              placeholder={parameterText(p.type, inherited)}
              invalid={Boolean(problem)}
              onChange={(v) =>
                set(`parameter:${p.name}`, (s) => {
                  if (s.kind !== "skill") return s;
                  const parameters = { ...(s.customize?.parameters ?? {}) };
                  if (v === undefined) delete parameters[p.name];
                  else parameters[p.name] = v;
                  const { parameters: _p, ...custom } = s.customize ?? {};
                  const next = Object.keys(parameters).length ? { ...custom, parameters } : custom;
                  const { customize: _c, ...rest } = s;
                  return Object.keys(next).length ? { ...rest, customize: next } : rest;
                })
              }
            />
          </Row>
        );
      })}
    </Section>
  );
}

// ── Versions ─────────────────────────────────────────────────────────────────────────────────

/** What a step's move to another version asks the builder to do. */
export interface SkillMove {
  stepId: string;
  to: string;
  /** The version's definition (instructions left out), so the builder types the step with it. */
  definition: SkillDefinition;
  version: number;
  /** Each reference to remap, and the output field it reads after the move. */
  remaps: Map<SkillReference, string>;
}

/**
 * The version the step pins (or "follows the live version"), and the move to another: the server
 * answers whether it is compatible, what breaks and every reference downstream; a breaking move
 * is saved only once each reference to a removed output field has a field to read instead.
 */
export function VersionSection({
  step,
  skill,
  agentId,
  tenantId,
  workflow,
  onMove,
}: {
  step: SkillStep;
  skill: SkillDefinition;
  agentId: string;
  tenantId: string | null;
  workflow: Process;
  onMove(move: SkillMove): void;
}) {
  const { id, version: pinned } = parseSkillRef(step.skill);
  const custom = id.startsWith("custom:");
  const library = useApi(apiRoutes.opsSkills, custom ? {} : null);
  const item = (library.data?.skills ?? [])
    .filter((s) => s.ref === id)
    .sort((a, b) => Number(b.clientId === tenantId) - Number(a.clientId === tenantId))[0];
  const detail = useApi(apiRoutes.opsSkill, item ? { params: { id: item.id } } : null);
  const move = useAction();
  const [to, setTo] = useState<number | null>(null);
  const [view, setView] = useState<SkillMoveView | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({});
  if (!custom) {
    return (
      <Section title="Version">
        <p className="text-sm text-ink-muted" data-testid="builder-skill-version">
          Built in: it moves with the platform.
        </p>
      </Section>
    );
  }
  const live = item?.liveVersion ?? null;
  const current = pinned ?? live;
  const versions = (detail.data?.versions ?? [])
    .filter((v) => v.version !== current)
    .sort((a, b) => b.version - a.version);

  async function ask(n: number) {
    setTo(n);
    setView(null);
    const res = await move.call(apiRoutes.opsSkillStepMove, {
      params: { id: agentId },
      body: { process: workflow, stepId: step.id, to: `${id}@${n}` },
    });
    if (!res.ok) return;
    setView(res.data);
    // A renamed field is picked for the operator; they can change it.
    const pre: Record<number, string> = {};
    res.data.references.forEach((r, i) => {
      const renamed = res.data.breaks.find((b) => b.side === "output" && b.field === r.field);
      if (renamed?.renamedTo) pre[i] = renamed.renamedTo;
    });
    setPicks(pre);
  }

  const fields = view ? outputFields(view.definition) : [];
  const toRemap = view ? view.references.filter((r) => remappable(r, step.id)) : [];
  const ready = view
    ? view.compatible || view.references.every((r, i) => !remappable(r, step.id) || picks[i])
    : false;

  return (
    <Section title="Version">
      <p className="text-sm text-ink" data-testid="builder-skill-version">
        {pinned !== null
          ? `Pinned to v${pinned}${live !== null && live !== pinned ? `; v${live} is live` : ""}.`
          : `Follows the live version${live !== null ? `, v${live}` : ""}.`}{" "}
        <span className="text-ink-muted">
          ({skillKind(skill) === "ai" ? "AI" : "Deterministic"})
        </span>
      </p>
      {versions.length > 0 ? (
        <div className="flex flex-wrap gap-2" data-testid="builder-skill-versions">
          {versions.map((v) => (
            <Button
              key={v.id}
              size="sm"
              data-testid={`builder-skill-move-${v.version}`}
              disabled={move.busy}
              onClick={() => ask(v.version)}
            >
              Move to v{v.version}
              {v.status === "draft" ? " (draft)" : ""}
            </Button>
          ))}
        </div>
      ) : detail.data ? (
        <p className="text-xs text-ink-muted">No other version to move to.</p>
      ) : null}
      {move.busy ? <p className="text-sm text-ink-muted">Checking what moves…</p> : null}
      {move.error ? <p className="ds-error text-sm">{errorText(move.error)}</p> : null}
      {view && to !== null ? (
        <div className="flex flex-col gap-2" data-testid="builder-skill-move">
          {view.compatible ? (
            <p className="text-sm text-ink" data-testid="builder-skill-move-compatible">
              v{to} only adds what is optional: nothing downstream changes.
            </p>
          ) : (
            <>
              <p className="text-sm text-ink" data-testid="builder-skill-move-breaking">
                v{to} changes what this step takes or gives back. Remap each place below first.
              </p>
              <ul className="flex flex-col gap-1 text-sm text-ink-muted">
                {view.breaks.map((b) => (
                  <li key={`${b.side}:${b.kind}:${b.field}`}>{b.message}</li>
                ))}
              </ul>
              {view.references.length > 0 ? (
                <ul className="flex flex-col gap-2" data-testid="builder-skill-move-references">
                  {view.references.map((r, i) => (
                    <li
                      key={`${r.stepId}:${r.at}:${r.expr}`}
                      className="flex flex-col gap-1 rounded-sm border border-line p-2"
                      data-testid={`builder-skill-move-ref-${i}`}
                    >
                      <span className="text-sm text-ink">
                        {stepName(workflow, r.stepId)} · <span className="reference">{r.at}</span>
                      </span>
                      <span className="reference text-xs text-ink-muted">{r.expr}</span>
                      {remappable(r, step.id) ? (
                        <SmallSelect
                          aria-label="Reads instead"
                          data-testid={`builder-skill-move-ref-${i}-to`}
                          value={picks[i] ?? ""}
                          onChange={(e) => setPicks({ ...picks, [i]: e.target.value })}
                        >
                          <option value="">Reads instead…</option>
                          {fields.map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </SmallSelect>
                      ) : (
                        <span className="text-xs text-ink-muted">
                          {r.stepId === step.id
                            ? "Fill this input on the step after the move."
                            : "Reads the whole output: change it by hand after the move."}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              {view.errors.length > 0 ? (
                <ul className="ds-banner flex-col gap-1 text-sm">
                  {view.errors.map((e) => (
                    <li key={`${e.stepId}:${e.field}:${e.code}`}>
                      {e.stepId ? `${stepName(workflow, e.stepId)}: ` : ""}
                      {e.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              data-testid="builder-skill-move-apply"
              disabled={!ready}
              onClick={() => {
                const remaps = new Map<SkillReference, string>();
                view.references.forEach((r, i) => {
                  const pick = picks[i];
                  if (pick && remappable(r, step.id)) remaps.set(r, pick);
                });
                onMove({
                  stepId: step.id,
                  to: `${id}@${to}`,
                  definition: view.definition as SkillDefinition,
                  version: to,
                  remaps,
                });
                setView(null);
                setTo(null);
              }}
            >
              {view.compatible
                ? `Move to v${to}`
                : `Move to v${to} and remap ${toRemap.length === 1 ? "1 place" : `${toRemap.length} places`}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setView(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function stepName(process: Process, id: string): string {
  let name = id;
  const visit = (steps: readonly Step[]) => {
    for (const s of steps) {
      if (s.id === id) name = s.name || id;
      if (s.kind === "if") {
        for (const p of s.paths) {
          if (p.id === id) name = p.name;
          visit(p.steps);
        }
        visit(s.otherwise.steps);
      }
      if (s.kind === "for_each") visit(s.steps);
    }
  };
  visit(process.steps);
  return name;
}
