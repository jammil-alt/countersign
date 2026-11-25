// One input field's source (§5 "Input", §6): picked as "step name › field" from what the steps
// before hand on, or a fixed value typed by hand. What is stored is the reference with the step's
// id (`{{steps.<id>.output.header.vendorName}}`); the person sees the words.
//
// Stream G (§6): each field also says its source's state. Fits reads a field directly; Translated is
// filled on the incoming side (renamed, converted or worked out), shown as its own choice and
// replaced by picking anything else; Doesn't fit is a field the step needs that nothing gives.

import { steps } from "@countersign/core";
import { useState } from "react";
import { SmallInput, SmallSelect } from "../fields";
import { guessInput, type InputOption, optionFor } from "./options";
import type { Field } from "./types";

const FIXED = "__fixed__";
const TRANSLATED = "__translated__";

export interface InputPickerProps {
  field: Pick<Field, "name" | "type" | "required">;
  options: readonly InputOption[];
  /** What is stored for the field now; undefined: nothing gives it. */
  value: unknown;
  onChange(value: unknown): void;
  /** Where the field comes from, as the incoming side worked it out. */
  source?: steps.FieldSource | undefined;
}

export function InputPicker({ field, options, value, onChange, source }: InputPickerProps) {
  const picked = optionFor(options, value);
  const hasValue = value !== undefined && value !== "";
  const [fixed, setFixed] = useState(hasValue && !picked);
  const guess = !hasValue ? guessInput(field as Field, options) : undefined;
  const translated = !hasValue && source?.state === "translated";
  const selected = translated
    ? TRANSLATED
    : fixed || (hasValue && !picked)
      ? FIXED
      : (picked?.ref ?? "");
  // A field nothing gives, that the step needs, doesn't fit (a word, not only a colour).
  const unfit = field.required && !hasValue && !translated;
  return (
    <div className="flex flex-col gap-1" data-testid={`input-${field.name}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <SmallSelect
          aria-label={`Input ${field.name}`}
          className="min-w-56 flex-1"
          invalid={unfit}
          value={selected}
          onChange={(e) => {
            const v = e.target.value;
            if (v === TRANSLATED) return;
            if (v === FIXED) {
              setFixed(true);
              if (picked) onChange(undefined);
            } else {
              setFixed(false);
              onChange(v === "" ? undefined : v);
            }
          }}
        >
          {translated ? (
            <option value={TRANSLATED}>Translated automatically</option>
          ) : (
            <option value="">Nothing yet</option>
          )}
          {options.map((o) => (
            <option key={o.ref} value={o.ref}>
              {o.label}
            </option>
          ))}
          <option value={FIXED}>A fixed value…</option>
        </SmallSelect>
        {selected === FIXED ? (
          <SmallInput
            aria-label={`Fixed value for ${field.name}`}
            className="w-48"
            value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          />
        ) : null}
      </div>
      {translated && source ? (
        <p className="text-xs text-ink-muted" data-testid={`input-${field.name}-source`}>
          {steps.stateWords(source)}
        </p>
      ) : null}
      {unfit ? (
        <p className="text-xs text-risk">
          Doesn't fit: nothing gives "{field.name}".
          {guess ? (
            <>
              {" "}
              <button
                type="button"
                className="ds-btn ds-btn--link text-xs"
                onClick={() => onChange(guess.ref)}
              >
                Use {guess.label}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
