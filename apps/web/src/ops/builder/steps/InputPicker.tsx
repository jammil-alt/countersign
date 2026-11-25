// One input field's source (§5 "Input", §6): picked as "step name › field" from what the steps
// before hand on, or a fixed value typed by hand. What is stored is the reference with the step's
// id (`{{steps.<id>.output.header.vendorName}}`); the person sees the words.

import { useState } from "react";
import { SmallInput, SmallSelect } from "../fields";
import { guessInput, type InputOption, optionFor } from "./options";
import type { Field } from "./types";

const FIXED = "__fixed__";

export interface InputPickerProps {
  field: Pick<Field, "name" | "type" | "required">;
  options: readonly InputOption[];
  /** What is stored for the field now; undefined: nothing gives it. */
  value: unknown;
  onChange(value: unknown): void;
}

export function InputPicker({ field, options, value, onChange }: InputPickerProps) {
  const picked = optionFor(options, value);
  const hasValue = value !== undefined && value !== "";
  const [fixed, setFixed] = useState(hasValue && !picked);
  const guess = !hasValue ? guessInput(field as Field, options) : undefined;
  const selected = fixed || (hasValue && !picked) ? FIXED : (picked?.ref ?? "");
  // A field nothing gives, that the step needs, doesn't fit (a word, not only a colour).
  const unfit = field.required && !hasValue;
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
            if (v === FIXED) {
              setFixed(true);
              if (picked) onChange(undefined);
            } else {
              setFixed(false);
              onChange(v === "" ? undefined : v);
            }
          }}
        >
          <option value="">Nothing yet</option>
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
