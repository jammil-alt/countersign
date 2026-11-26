// The Do step's form (docs/step-model-plan.md §5): Goal, Done by, Uses, Input, Instructions,
// Output, Checks, and More folded. The main form shows only these boxes. Nothing here loosens an
// approval: a Change starts with its approver on, and switching it off is the Checks section's,
// held to what the client's connection allows (invariant 8).

import { TextInput } from "../../agents/ui";
import { SmallInput } from "../fields";
import { ChecksSection } from "./ChecksSection";
import { FieldsEditor } from "./FieldsEditor";
import type { StepFormProps } from "./form-kit";
import { Input } from "./Input";
import { AiInstructions } from "./instructions/AiInstructions";
import { CollectInstructions } from "./instructions/CollectInstructions";
import { ContactInstructions } from "./instructions/ContactInstructions";
import { PersonInstructions } from "./instructions/PersonInstructions";
import { RulesInstructions } from "./instructions/RulesInstructions";
import { SaveAsSkill } from "./instructions/SaveAsSkill";
import { TellInstructions } from "./instructions/TellInstructions";
import type { BuilderIssue } from "./issues";
import { MatchSection } from "./MatchSection";
import { MoreSection } from "./MoreSection";
import {
  actionKindOf,
  chooseDoneBy,
  chooseUses,
  DONE_BY_CHOICES,
  inputFields,
  ownInstructions,
  USES_FOR,
  usesLabel,
} from "./options";
import { ModelField, picksModel } from "./runsOn";
import { SuggestButton } from "./SuggestButton";
import type { DoStep, Step } from "./types";
import { UsesPicker } from "./UsesPicker";

const KIND_WORDS = {
  get: "Get: it reads and changes nothing.",
  save: "Save: it writes to our records.",
  change: "Change: it acts in the client's tool, so approval is on.",
  send: "Send: it sends a message.",
} as const;

/** Which box an issue is about, by its code; the rest show at the top. */
const BOX: Record<string, "goal" | "doneBy" | "uses" | "input" | "instructions"> = {
  goal_missing: "goal",
  done_by_required: "doneBy",
  done_by_with_automation: "doneBy",
  uses_not_allowed: "uses",
  unknown_profile: "uses",
  match_settings: "uses",
  input_missing: "input",
  instructions_missing: "instructions",
  instructions_not_for_done_by: "instructions",
};

function Issues({ list }: { list: readonly BuilderIssue[] }) {
  if (list.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5" data-testid="do-issues">
      {list.map((i) => (
        <li key={`${i.code}:${i.message}`} className="text-xs text-risk">
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function Box({
  title,
  suggest,
  issues,
  children,
}: {
  title: string;
  suggest?: React.ReactNode;
  issues?: readonly BuilderIssue[];
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {suggest}
      </div>
      {children}
      {issues ? <Issues list={issues} /> : null}
    </section>
  );
}

export function DoForm(props: StepFormProps<DoStep>) {
  const { step, env, onChange } = props;
  const at = (box: string) => props.issues.filter((i) => BOX[i.code] === box);
  const top = props.issues.filter((i) => BOX[i.code] === undefined);
  const suggestFor = (label: string, field?: string) => (
    <SuggestButton
      step={step}
      field={field}
      label={label}
      suggest={env.suggest}
      onApply={(next: Step) => next.kind === "do" && onChange(next)}
      flagged={field === undefined ? props.issues.length > 0 : undefined}
    />
  );

  const doneBy = step.doneBy;
  const hasUses = doneBy !== undefined && USES_FOR[doneBy].length > 0;
  const uses = step.uses;
  const kind = actionKindOf(step, env.uses);
  const own = ownInstructions(doneBy, uses);
  const takes = inputFields(step, env.uses);
  const hasOwnOutput = uses === undefined && (doneBy === "rules" || doneBy === "ai");
  const hasUsesOutput = uses?.type === "action" || uses?.type === "skill" || uses?.type === "match";
  const written = (own === "rules" || own === "ai") && uses === undefined;

  return (
    <div className="flex flex-col gap-4" data-testid="do-form">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow text-ink-muted">Do</span>
        {suggestFor("this step")}
      </div>
      <Issues list={top} />

      <Box title="Goal" suggest={suggestFor("Goal", "goal")} issues={at("goal")}>
        <SmallInput
          aria-label="Goal"
          placeholder="What this step does, in one sentence"
          maxLength={200}
          value={step.name}
          onChange={(e) => onChange({ ...step, name: e.target.value })}
        />
        <TextInput
          aria-label="Purpose"
          className="h-9 text-sm"
          maxLength={200}
          placeholder="Why it is there (optional)"
          value={step.purpose ?? ""}
          onChange={(e) => {
            const { purpose: _p, ...rest } = step;
            onChange(e.target.value ? { ...rest, purpose: e.target.value } : rest);
          }}
        />
      </Box>

      <Box title="Done by" suggest={suggestFor("Done by", "doneBy")} issues={at("doneBy")}>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Done by">
          {DONE_BY_CHOICES.map((c) => (
            <label
              key={c.value}
              className={`ds-pill cursor-pointer border px-2 py-1 text-sm ${doneBy === c.value ? "border-slate text-slate" : "border-line"}`}
            >
              <input
                type="radio"
                className="sr-only"
                name={`doneby-${step.id}`}
                checked={doneBy === c.value}
                onChange={() => onChange(chooseDoneBy(step, c.value))}
              />
              {c.label}
            </label>
          ))}
        </div>
        {doneBy ? (
          <p className="text-xs text-ink-muted">
            {DONE_BY_CHOICES.find((c) => c.value === doneBy)?.hint}
          </p>
        ) : null}
      </Box>

      {hasUses ? (
        <Box title="Uses" suggest={suggestFor("Uses", "uses")} issues={at("uses")}>
          <UsesPicker
            doneBy={doneBy}
            step={step}
            ctx={env.uses}
            onPick={(next) => onChange(chooseUses(step, next, env.uses))}
          />
          {kind ? <p className="text-xs text-ink-muted">{KIND_WORDS[kind]}</p> : null}
          {uses?.type === "match" ? <MatchSection {...props} /> : null}
        </Box>
      ) : null}

      {takes.length > 0 || written ? (
        <Box title="Input" suggest={suggestFor("Input", "input")} issues={at("input")}>
          <Input {...props} takes={takes} free={written} />
        </Box>
      ) : null}

      {own ? (
        own !== "rules" && own !== "ai" ? (
          <Box
            title="Instructions"
            suggest={suggestFor("Instructions", "instructions")}
            issues={at("instructions")}
          >
            {own === "person" ? <PersonInstructions {...props} /> : null}
            {own === "contact" ? <ContactInstructions {...props} /> : null}
            {own === "collect" ? <CollectInstructions {...props} /> : null}
            {own === "tell" ? <TellInstructions {...props} /> : null}
          </Box>
        ) : uses === undefined ? (
          <Box
            title="Instructions"
            suggest={suggestFor("Instructions", "instructions")}
            issues={at("instructions")}
          >
            {own === "rules" ? <RulesInstructions {...props} /> : <AiInstructions {...props} />}
            <SaveAsSkill
              step={step}
              env={env}
              onChange={(next) => next.kind === "do" && onChange(next)}
            />
          </Box>
        ) : null
      ) : null}

      {hasOwnOutput ? (
        <Box title="Output" suggest={suggestFor("Output", "output")}>
          <FieldsEditor
            label="Output"
            fields={step.output ?? []}
            onChange={(output) => onChange({ ...step, output })}
          />
        </Box>
      ) : null}
      {hasUsesOutput ? (
        <Box title="Output">
          <p className="text-xs text-ink-muted">From {usesLabel(step, env.uses)}</p>
          <ul className="flex flex-wrap gap-1.5">
            {outputNames(props).map((n) => (
              <li key={n} className="ds-pill border border-line px-2 py-0.5 text-xs">
                {n}
              </li>
            ))}
          </ul>
        </Box>
      ) : null}

      {/* Owner, 2026-11-26: a model per step, where everyone sees it, not folded under More. */}
      {picksModel(step) ? (
        <ModelField
          step={step}
          env={env}
          value={step.ai?.model?.id}
          onPick={(id) => {
            const { model: _m, ...rest } = step.ai ?? {};
            onChange({ ...step, ai: id ? { ...rest, model: { id } } : rest });
          }}
        />
      ) : null}
      <ChecksSection {...props} />
      <MoreSection step={step} env={env} onChange={onChange} />
    </div>
  );
}

function outputNames({ step, env }: StepFormProps<DoStep>): string[] {
  const u = step.uses;
  if (u?.type === "action")
    return (env.uses.actions.get(u.action)?.output ?? []).map((f) => f.name);
  if (u?.type === "skill")
    return (env.uses.skills.find((s) => s.ref === u.skill)?.output ?? []).map((f) => f.name);
  if (u?.type === "match") return ["items", "matched", "unsure", "anyUnsure"];
  return [];
}
