// The rule editors' field picker, from what a step may read (the Input picker's options).
import type { PathOption } from "@countersign/core";
import type { InputOption } from "./options";

const SCHEMA_TYPE: Record<InputOption["type"], string> = {
  text: "string",
  number: "number",
  money: "string",
  date: "string",
  yes_no: "boolean",
  list: "array",
  group: "object",
  record: "string",
};

/** `{{steps.<id>.output.total}}` as a path the rule rows can pick: `steps.<id>.output.total`. */
export function pickPaths(options: readonly InputOption[]): (PathOption & { label?: string })[] {
  return options.map((o) => ({
    path: o.ref.replace(/^\{\{|\}\}$/g, ""),
    schema: { type: SCHEMA_TYPE[o.type] } as PathOption["schema"],
    ...(o.stepId ? { stepId: o.stepId } : {}),
    label: o.label,
  }));
}
