// STUB (filled by the End worker): the Data tab (§5): Coming in, Changed, Going out, as JSON.
import type { StepFormEnv } from "./form-kit";
import type { Step } from "./types";

/** What a step's last test run saw, by step id, when there is one. */
export interface LastRun {
  input?: unknown;
  output?: unknown;
}

export interface DataTabProps {
  step: Step;
  env: StepFormEnv;
  /** The step's last test run, if any; otherwise sample data made from the fields' types. */
  lastRun?: LastRun | undefined;
  /** The earlier steps' last runs, by step id, so Coming in is what the step before handed over. */
  runs?: Readonly<Record<string, LastRun>> | undefined;
}

export function DataTab(_props: DataTabProps) {
  return null;
}
