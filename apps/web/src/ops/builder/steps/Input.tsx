// The Input box's body (§5, §6): each field the step's Uses takes, with where it comes from; or,
// for rules and AI written in the step, a list of named inputs the person adds.
//
// Stream G (§6): for the fields a Uses takes, the incoming side is worked out (core
// `steps.translateStep`: Fits, Translated, Doesn't fit) and saved with the step without confirming
// (owner, 2026-11-25), once the person has changed the step. If a needed field still has no source,
// Suggest's Resolve is asked once (the Builder AI's Reshape suggestion) and its answer applied as it
// comes back.
// One checker (staging, 2026-11-28: opening the page dropped a stored step's input, and a Save
// stored it): a step the person hasn't changed on this page is never rewritten by opening it. What
// would change is offered, and applied only when they say so.

import { steps } from "@countersign/core";
import { useEffect, useMemo, useRef } from "react";
import { Button } from "../../../ui/primitives";
import { SmallInput } from "../fields";
import { incomingSources } from "./data";
import type { StepFormProps } from "./form-kit";
import { InputPicker } from "./InputPicker";
import { inputOptions, usesKey } from "./options";
import { SuggestButton } from "./SuggestButton";
import type { DoStep, Field, Step } from "./types";

export function Input({
  step,
  env,
  onChange,
  takes,
  free,
}: StepFormProps<DoStep> & { takes: readonly Field[]; free: boolean }) {
  const options = inputOptions(env.workflow, step.id, env.uses, env.trigger);
  const { worked, offer } = useTranslation({ step, env, onChange, takes, free });
  const setValue = (name: string, value: unknown) => {
    const { [name]: _gone, ...rest } = step.input;
    onChange({ ...step, input: value === undefined ? rest : { ...rest, [name]: value } });
  };
  const suggest = (name: string) => (
    <SuggestButton
      step={step}
      field={`input.${name}`}
      label={`Input ${name}`}
      suggest={env.suggest}
      onApply={(next: Step) => next.kind === "do" && onChange(next)}
    />
  );
  const names = free ? Object.keys(step.input) : takes.map((f) => f.name);
  return (
    <div className="flex flex-col gap-2" data-testid="do-input">
      {offer ? (
        <div
          className="flex flex-wrap items-center gap-2 text-sm text-ink-muted"
          data-testid="do-input-offer"
        >
          <span>
            We can fill this input in from the steps before it. Nothing changes until you say so.
          </span>
          <Button size="sm" data-testid="do-input-offer-apply" onClick={() => onChange(offer)}>
            Fill it in
          </Button>
        </div>
      ) : null}
      {names.map((name) => {
        const field = takes.find((f) => f.name === name) ?? {
          name,
          type: "text" as const,
          required: false,
        };
        return (
          <div key={name} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-ink">
                {name}
                {field.required ? <span className="text-ink-muted"> (needed)</span> : null}
              </span>
              <span className="flex items-center gap-1">
                {suggest(name)}
                {free ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    onClick={() => setValue(name, undefined)}
                  >
                    Remove
                  </Button>
                ) : null}
              </span>
            </div>
            <InputPicker
              field={field}
              options={options}
              value={step.input[name]}
              onChange={(v) => setValue(name, v)}
              source={worked?.fields.find((f) => f.name === name)}
            />
          </div>
        );
      })}
      {free ? <AddInput taken={names} onAdd={(n) => setValue(n, "")} /> : null}
    </div>
  );
}

function AddInput({ taken, onAdd }: { taken: readonly string[]; onAdd(name: string): void }) {
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const el = e.currentTarget.elements.namedItem("name") as HTMLInputElement;
        const n = el.value.trim();
        if (n && !taken.includes(n)) onAdd(n);
        el.value = "";
      }}
    >
      <SmallInput
        name="name"
        aria-label="Name of an input"
        placeholder="Name of an input"
        className="w-48"
      />
      <Button type="submit" size="sm">
        Add an input
      </Button>
    </form>
  );
}

/**
 * The step's incoming side worked out and kept saved with the step (stream G), once the person has
 * changed the step (`env.edited`). Returns each field's source (null for a step that writes its own
 * inputs, or while what was worked out is only offered), and the step as the work-out would leave
 * it while it is offered.
 */
function useTranslation({
  step,
  env,
  onChange,
  takes,
  free,
}: Pick<StepFormProps<DoStep>, "step" | "env" | "onChange"> & {
  takes: readonly Field[];
  free: boolean;
}): { worked: steps.WorkedOut | null; offer: DoStep | null } {
  const sources = useMemo(
    () => incomingSources(env.workflow, step.id, env.uses, env.trigger),
    [env.workflow, step.id, env.uses, env.trigger],
  );
  const result = free || takes.length === 0 ? null : steps.translateStep(step, takes, sources);
  const next = result?.step;
  const auto = env.edited?.(step.id) ?? true;
  useEffect(() => {
    if (auto && next && next !== step) onChange(next);
  }, [auto, next, step, onChange]);

  // Once per step, Uses and set of fields left: the AI's suggestion, applied unless the step was
  // changed meanwhile.
  const latest = useRef(step);
  latest.current = next ?? step;
  const asked = useRef(new Set<string>());
  const left = result?.worked.state === "doesnt_fit" ? steps.unfilled(result.worked).join(",") : "";
  const suggest = env.suggest;
  const key = auto && left ? `${step.id}|${usesKey(step.uses)}|${left}` : "";
  useEffect(() => {
    if (!key || asked.current.has(key)) return;
    asked.current.add(key);
    const sent = latest.current;
    suggest({ step: sent, field: "input", how: "resolve" })
      .then((s) => {
        if (s.applied && s.step.kind === "do" && latest.current === sent) onChange(s.step);
      })
      .catch(() => {
        // Nothing to do: the field stays Doesn't fit and says so.
      });
  }, [key, suggest, onChange]);
  const offer = !auto && next && next !== step ? next : null;
  return { worked: offer ? null : (result?.worked ?? null), offer };
}
