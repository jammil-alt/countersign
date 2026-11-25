// The Input box's body (§5, §6): each field the step's Uses takes, with where it comes from; or,
// for rules and AI written in the step, a list of named inputs the person adds.

import { Button } from "../../../ui/primitives";
import { SmallInput } from "../fields";
import type { StepFormProps } from "./form-kit";
import { InputPicker } from "./InputPicker";
import { inputOptions } from "./options";
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
