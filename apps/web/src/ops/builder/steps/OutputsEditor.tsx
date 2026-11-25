// STUB (filled by the End worker): the workflow's declared outputs, next to the triggers (§9).
import type { StepFormEnv } from "./form-kit";
import type { BuilderIssue } from "./issues";
import type { Workflow } from "./types";

export interface OutputsEditorProps {
  workflow: Workflow;
  env: StepFormEnv;
  /** Issues about outputs (`at` is an output's id), in plain words. */
  issues: readonly BuilderIssue[];
  onChange(next: Workflow): void;
}

export function OutputsEditor(_props: OutputsEditorProps) {
  return null;
}
