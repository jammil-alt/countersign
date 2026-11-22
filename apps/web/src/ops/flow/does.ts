// What a step does, in a line, for its details on hover (owner, 2026-11-22: "change the tool tip
// to include what the step does rather than the instructions on click and drag… if all steps say
// that, there is no value in stating it over and over"; docs/plan.md §1.182). A skill, a tool and
// an automation say it in their own words (the host's label carries those); every other kind, and
// any step whose own words are missing, gets its kind's line here.
import type { Step } from "./types";

const KIND_DOES: Record<Step["kind"], string> = {
  read: "Reads records. It changes nothing.",
  write: "Changes or saves a record.",
  skill: "Runs a skill on what the steps before it produced.",
  person: "Asks a person, and waits for their answer.",
  conversation: "Talks with someone back and forth until its goal is met.",
  notify: "Tells someone, and moves on.",
  if: "Sends the run down the first path whose rule holds, else the Otherwise path.",
  for_each: "Does its steps once for each item in a list.",
  repeat: "Repeats its steps until they are done, or it reaches its limit.",
  wait: "Pauses the run for a set time.",
  stop: "Ends the run here.",
  process: "Runs an automation: a saved set of steps.",
  handoff: "Hands the work to another agent, which runs on its own.",
  missing: "Holds the place of a step nobody has built yet.",
};

/** A person's step by what it asks: an approval, or an answer. */
export function kindDoes(step: Step): string {
  if (step.kind === "person") {
    return step.mode === "approve"
      ? "Asks a person to approve, and waits for their answer."
      : "Asks a person a question, and waits for their answer.";
  }
  return KIND_DOES[step.kind];
}
