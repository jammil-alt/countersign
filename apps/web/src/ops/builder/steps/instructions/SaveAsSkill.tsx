// Save as skill (docs/step-model-plan.md §5): the rules or the AI written in a Do step become a
// skill in the library, with a name and a description, this client's only or shared with every
// client, and the step then uses it. A person never leaves the step to do this.

import { useId, useState } from "react";
import { Button } from "../../../../ui/primitives";
import { TextArea } from "../../../agents/ui";
import { SmallInput } from "../../fields";
import type { StepFormEnv } from "../form-kit";
import type { DoStep, Step } from "../types";
import { writtenInStep } from "../written";

const SCOPE_WORDS = {
  client: { label: "This client only", hint: "Only this client's agents can use it." },
  shared: {
    label: "Shared with every client",
    hint: "Every client's agents can use it, with their next publish.",
  },
} as const;

export function SaveAsSkill(props: { step: DoStep; env: StepFormEnv; onChange(next: Step): void }) {
  const { step, env } = props;
  const save = env.saveAsSkill;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(step.name);
  const [about, setAbout] = useState(step.purpose ?? "");
  const [scope, setScope] = useState<"client" | "shared">(save?.scopes[0] ?? "shared");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const id = useId();
  // Only what the step writes in itself can be saved: rows for rules, text for AI.
  if (!save || !writtenInStep(step)) return null;

  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpen(true)}>
        Save as skill
      </Button>
    );
  }
  const ready = name.trim() !== "" && about.trim() !== "" && !busy;
  return (
    <form
      className="flex flex-col gap-2 border border-line p-3"
      aria-label="Save as skill"
      data-testid="save-as-skill"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setFailed(null);
        save
          .run({ step, name: name.trim(), description: about.trim(), scope })
          .then((next) => {
            props.onChange(next);
            setOpen(false);
          })
          .catch((error: unknown) =>
            setFailed(error instanceof Error ? error.message : "It wasn't saved. Try again."),
          )
          .finally(() => setBusy(false));
      }}
    >
      <span className="eyebrow text-ink-muted">Save as skill</span>
      <label className="flex flex-col gap-1 text-sm text-ink" htmlFor={`${id}-name`}>
        Name
        <SmallInput
          id={`${id}-name`}
          maxLength={120}
          value={name}
          placeholder="What it is called in the library"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-ink" htmlFor={`${id}-about`}>
        Description
        <TextArea
          id={`${id}-about`}
          rows={2}
          maxLength={500}
          value={about}
          placeholder="What it does, in a sentence"
          onChange={(e) => setAbout(e.target.value)}
        />
      </label>
      {save.scopes.length > 1 ? (
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Who can use it">
          {save.scopes.map((s) => (
            <label key={s} className="flex items-start gap-2 text-sm text-ink">
              <input
                type="radio"
                name={`${id}-scope`}
                checked={scope === s}
                onChange={() => setScope(s)}
              />
              <span className="flex flex-col">
                {SCOPE_WORDS[s].label}
                <span className="text-xs text-ink-muted">{SCOPE_WORDS[s].hint}</span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">
          This agent is a template, so the skill is shared with every client.
        </p>
      )}
      {failed ? (
        <p role="alert" className="text-xs text-risk">
          {failed}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!ready}>
          Save skill
        </Button>
        <Button size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
