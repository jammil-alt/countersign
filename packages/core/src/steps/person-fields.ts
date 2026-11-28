// What a person step asks the person for (owner, 2026-11-28): the output fields it lists, each
// handed on by its name. The run's loader gives them to the person step, the inbox card shows a box
// for each, and the publish checks read a person step's output as them (`wiring.ts`). Pure.

import type { PersonField } from "../schemas/workflow";
import type { Field } from "./schema";

/** A step's listed output fields as a person is asked them: a list, group or record as text. */
export function personFields(output: readonly Field[] | undefined): PersonField[] {
  return (output ?? []).slice(0, 10).map((f) => ({
    name: f.name,
    type:
      f.type === "number" || f.type === "money" || f.type === "date" || f.type === "yes_no"
        ? f.type
        : "text",
    ...(f.about ? { about: f.about } : {}),
    required: f.required,
  }));
}
