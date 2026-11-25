// What every step form is given and returns (stream B's contract between its parts: the Do form,
// the Checks and Match sections, the End card, the workflow outputs, the Data tab). A form edits one
// step by handing the next one back; it never reaches into the workflow, which the host owns.

import type { People } from "../people";
import type { BuilderIssue } from "./issues";
import type { UsesContext } from "./options";
import type { SuggestFn } from "./suggest";
import type { Field, Step, Workflow } from "./types";

/** What a form reads about the workflow it is in and what the step may use. */
export interface StepFormEnv {
  workflow: Workflow;
  uses: UsesContext;
  /** The fields the workflow's trigger hands on, for the Input picker (`trigger.<field>`). */
  trigger: readonly Field[];
  /** Who a step asks or tells: the client's team, or the roles for a template. */
  people: People;
  /** Asks Suggest; the host owns the agent and the route. */
  suggest: SuggestFn;
  /** The models a step may run on, as `{ id, label }`. */
  models: readonly { id: string; label: string }[];
}

export interface StepFormProps<S extends Step = Step> {
  step: S;
  env: StepFormEnv;
  /** Issues about this step, in plain words, to show beside what they are about. */
  issues: readonly BuilderIssue[];
  /** The step as it should now be. One undo per typing run is the host's. */
  onChange(next: S): void;
}
