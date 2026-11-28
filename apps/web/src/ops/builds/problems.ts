// A draft's problems in plain words (feedback, 2026-11-16: "these all need to be human readable,
// with a suggested solution to each: what would make it work, and what would we lose, if anything,
// if we go down that route"). The validator's message stays the source of the detail; each code
// adds what it means, the usual fix and its cost. A code not listed here reads as its message,
// with the Builder offered as the way to a fix.
import type { DraftProblem } from "@countersign/core";

export interface ProblemAdvice {
  /** What is wrong, in a sentence. */
  what: string;
  /** What would make it work. */
  fix: string;
  /** What that fix costs or gives up; null when it costs nothing worth saying. */
  cost: string | null;
}

/** `{{trigger.documentId}}` → "the trigger's documentId"; `{{steps.find.output.total}}` → "the find step's total". */
export function plainRefs(text: string): string {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref: string) => {
    const parts = ref.split(".");
    if (parts[0] === "trigger") {
      return parts.length > 1 ? `the trigger's ${parts.slice(1).join(".")}` : "the trigger";
    }
    if (parts[0] === "steps" && parts[1]) {
      const rest = parts.slice(2).filter((p) => p !== "output");
      return rest.length > 0
        ? `the ${parts[1]} step's ${rest.join(".")}`
        : `what the ${parts[1]} step gives`;
    }
    return ref;
  });
}

/** A sentence: capital first letter, a full stop at the end. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?!]$/.test(first) ? first : `${first}.`;
}

/** The quoted field in `no field "documentId"`, or null. */
function missingField(title: string): string | null {
  return /no field "([^"]+)"/.exec(title)?.[1] ?? null;
}

const ASK_BUILDER =
  "Ask the Builder about it in the conversation, or open the step in the workflow.";

export function problemAdvice(p: Pick<DraftProblem, "code" | "title">): ProblemAdvice {
  const detail = sentence(plainRefs(p.title));
  switch (p.code) {
    case "missing_step": {
      // `"Name" is missing: what it needs`
      const need = /is missing:\s*(.+)$/s.exec(p.title)?.[1];
      return {
        what: need ? sentence(need) : detail,
        fix: "Build the piece (a new tool or skill, which engineering builds), or put a person step here so someone on the client's team does it, or drop it from scope.",
        cost: "A person step works today but takes a person's time on every case. Dropping it means these cases aren't handled by the agent. Building it takes engineering time before it can be published.",
      };
    }
    case "template_path": {
      const field = missingField(p.title);
      const ref = /^(\{\{[^}]+\}\})/.exec(p.title)?.[1];
      return {
        what: field
          ? `A step reads ${ref ? plainRefs(ref) : `"${field}"`}, but nothing before it gives a field called "${field}".`
          : detail,
        fix: "Point the step at a field that exists (the field picker lists them), or add a step before it that produces the value, then read that step's output.",
        cost: "Nothing if the value is there under another name. If nothing gives it, the added step is one more to build and test.",
      };
    }
    case "template_scope":
      return {
        what: `A step reads a step that hasn't run yet at that point. ${detail}`,
        fix: "Move the step after the one it reads, or read something that comes earlier.",
        cost: null,
      };
    case "template_syntax":
      return {
        what: `A reference is written wrong. ${detail}`,
        fix: "Rewrite it with the field picker, as one {{…}} reference.",
        cost: null,
      };
    case "rule_invalid":
      return {
        what: "A decision's rule compares something that isn't a single field, so it can't be checked.",
        fix: "Make the rule's field one reference, like the trigger's total. If it needs two values or words around them, add a Reshape data step before the decision to work the value out, and compare that.",
        cost: "One more step before the decision. Nothing is lost.",
      };
    case "rules_empty":
      return {
        what: "A path of a decision has no rule, so it is never taken.",
        fix: "Add the rule that says when to take this path, or remove the path.",
        cost: null,
      };
    case "handoff_unknown_step":
      return {
        what: "A hand-off to another workflow or agent doesn't say which step it starts at.",
        fix: "Open the hand-off step and pick the step it starts at, usually the first step of that flow.",
        cost: null,
      };
    case "handoff_unknown_agent":
      return {
        what: "A hand-off doesn't say which agent it goes to.",
        fix: "Open the hand-off step and pick the agent.",
        cost: null,
      };
    case "handoff_no_live":
      return {
        what: "A hand-off goes to an agent with no live version yet.",
        fix: "Publish that agent first, or hand this work to a person step for now.",
        cost: "Until that agent is live, a person does this part.",
      };
    case "input_missing":
      return {
        what: `A step is missing something it needs. ${detail}`,
        fix: "Fill it from an earlier step's output or with a fixed value.",
        cost: null,
      };
    case "input_type":
    case "input_unknown":
      return {
        what: `A step is given something it can't use. ${detail}`,
        fix: "Give it a value of the kind it takes, or remove the extra field.",
        cost: null,
      };
    case "input_not_fixed":
      return {
        what: "Instructions to a model are built from data that could change them, which we never allow.",
        fix: "Keep the instructions fixed, and pass the data as the step's input instead.",
        cost: null,
      };
    case "unknown_tool":
    case "unknown_skill":
      return {
        what: `A step uses something the catalog doesn't have. ${detail}`,
        fix: "Pick a tool or skill the catalog has, or turn the step into a missing step for engineering to build.",
        cost: "A missing step holds Publish until it is built or replaced.",
      };
    case "connection_missing":
    case "action_no_connection":
      return {
        what: `A step needs a connection the agent isn't given. ${detail}`,
        fix: "Bind the connection on the agent (the client connects it in their portal), or use a step that doesn't need it.",
        cost: "Nothing, once the client connects it. Until then the step can't run.",
      };
    case "verb_off":
    case "approval_required_by_connection":
    case "approval_always":
    case "approval_needs_act":
      return {
        what: `A step's approval doesn't fit what the connection or agent allows. ${detail}`,
        fix: "Turn approval back on for the step. Approval stays on unless the client's settings allow it off.",
        cost: "Each change waits for a person's sign-off, which is the default anyway.",
      };
    case "deadline_missing":
      return {
        what: "A step waits on a person with no limit on how long.",
        fix: "Say how long to wait, and what happens if nobody answers in time.",
        cost: null,
      };
    case "skill_unsaved":
      return {
        what: "The skill isn't saved yet.",
        fix: "Save it in its Builder conversation.",
        cost: null,
      };
    default:
      return { what: detail, fix: ASK_BUILDER, cost: null };
  }
}

/** "In “Read document” · Vendor flow", or null when the problem names no step or flow. */
export function problemWhere(p: Pick<DraftProblem, "stepName" | "workflowName">): string | null {
  const parts = [p.stepName ? `In “${p.stepName}”` : null, p.workflowName ?? null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}
