import type { StepFormEnv } from "../form-kit";
import type { DoStep } from "../types";

/** What each instructions part is given: the step, what it reads, and how to hand the step back. */
export interface InstructionsProps {
  step: DoStep;
  env: StepFormEnv;
  onChange(next: DoStep): void;
}
