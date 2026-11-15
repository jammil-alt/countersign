// Agent motion (docs/plan.md §1.103): which of the design system's four thinking states a step
// shows while it runs. Weighing and Tracing are processing (Tracing for fetching, connecting,
// matching, reconciling), Drafting is writing, Rechecking is reviewing work before it goes on.
// The state is only a picture: the step's own words carry what it does. It is read from the
// step's kind and, for a skill, the words of its id ("materials.match_lines" traces,
// "account.draft_change" drafts, "docs.bill.check" rechecks); anything else weighs.
// DECISION: words of the skill id, not a field on the skill: no skill version changes for a
// picture, and a skill that reads wrong shows another of four loops, nothing more.

export const THINKING_STATES = ["weighing", "tracing", "drafting", "rechecking"] as const;
export type ThinkingState = (typeof THINKING_STATES)[number];

const RECHECKING =
  /\b(check|checks|checking|recheck|review|reviews|verify|validate|audit|reread|confirm|confer)\b/;
const DRAFTING =
  /\b(draft|drafts|write|compose|reply|replies|summarize|summary|digest|report|explain|note|memo|message|letter|email|converse|translate|document)\b/;
const TRACING =
  /\b(match|matches|matching|reconcile|lookup|search|find|fetch|get|read|import|sync|link|pairs|candidates|query|history|browse|list|extract|locate|map|open)\b/;

/** Words of a skill id after its namespace: "materials.prices.compare_vendors" → "prices compare vendors". */
function skillWords(skill: string): string {
  const id = skill.replace(/@\d+$/, "");
  const parts = id.startsWith("custom:") ? [id.slice("custom:".length)] : id.split(".").slice(1);
  return parts.join(" ").replace(/[_-]/g, " ").toLowerCase();
}

/**
 * A step's thinking state: by its kind (a step run's `nodeType`, a process step's `kind`, or
 * `confer` for a check's row), and for a skill step by its skill id.
 */
export function thinkingOf(step: {
  kind?: string | null | undefined;
  skill?: string | null | undefined;
}): ThinkingState {
  switch (step.kind) {
    case "confer":
      return "rechecking";
    case "read":
    case "write":
    case "action":
      return "tracing";
    case "conversation":
    case "notify":
      return "drafting";
  }
  if (!step.skill) return "weighing";
  const words = skillWords(step.skill);
  if (RECHECKING.test(words)) return "rechecking";
  if (DRAFTING.test(words)) return "drafting";
  if (TRACING.test(words)) return "tracing";
  return "weighing";
}
