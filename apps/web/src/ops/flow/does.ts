// What a step does, in a line, for its details on hover (owner, 2026-11-22: "change the tool tip
// to include what the step does rather than the instructions on click and drag… if all steps say
// that, there is no value in stating it over and over"; docs/plan.md §1.182). A skill, a tool and
// an automation say it in their own words (the host's label carries those); every other kind, and
// any step whose own words are missing, gets its kind's line here, in the reader's language (the
// client's chart, docs/sop-plan.md §6a; English in the back office).
import type { PlainKey, Translate } from "../../i18n/catalog";
import { EN } from "../../i18n/i18n";
import type { Step } from "./types";

const KIND_DOES: Record<Step["kind"], PlainKey> = {
  read: "flow.does.read",
  write: "flow.does.write",
  skill: "flow.does.skill",
  person: "flow.does.person",
  conversation: "flow.does.conversation",
  notify: "flow.does.notify",
  if: "flow.does.if",
  for_each: "flow.does.forEach",
  repeat: "flow.does.repeat",
  wait: "flow.does.wait",
  stop: "flow.does.stop",
  process: "flow.does.process",
  handoff: "flow.does.handoff",
  missing: "flow.does.missing",
};

/** A person's step by what it asks: an approval, or an answer. */
export function kindDoes(step: Step, t: Translate = EN.t): string {
  if (step.kind === "person") {
    return t(step.mode === "approve" ? "flow.does.approve" : "flow.does.ask");
  }
  return t(KIND_DOES[step.kind]);
}
