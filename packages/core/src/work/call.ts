// Your call (docs/plan.md §1.124.3; docs/cases-plan.md T1): the one to-do list across the back
// office. Who has a to-do, what it is about, the kind chips over the list, the tag on each card,
// when "Later" brings one back, the client page's activity filters, and the screen's words, from
// the agreed prototype (docs/design/pipelines.html, `yourCall()` and `clientPage()`).

import { z } from "zod";

// DECISION (owner, 2026-11-17): a to-do is the operator's, Reggie's or the client's, with an
// optional named operator (`owner_user_id`).
export const TODO_OWNER_VALUES = ["operator", "reggie", "client"] as const;
export const TodoOwner = z.enum(TODO_OWNER_VALUES);
export type TodoOwner = z.infer<typeof TodoOwner>;

export const TODO_ABOUT_VALUES = [
  "issue",
  "client_ask",
  "enhancement",
  "build",
  "deal",
  "question",
  "run",
  "client",
  // docs/plan.md §1.125: a Dev queue request's notice (accepted, shipped).
  "code_request",
] as const;
export const TodoAboutKind = z.enum(TODO_ABOUT_VALUES);
export type TodoAboutKind = z.infer<typeof TodoAboutKind>;

/**
 * Where a line on Your call comes from: a to-do row, or read from its own table (never copied):
 * an escalation (an open inbox item for us), a run queued for audit, a build item we own, a change
 * Reggie proposed, or an item on a client's Desk.
 */
export const TODO_ITEM_SOURCES = [
  "todo",
  "escalation",
  "run_audit",
  "build_item",
  "reggie_card",
  "desk",
] as const;
export const TodoItemSource = z.enum(TODO_ITEM_SOURCES);
export type TodoItemSource = z.infer<typeof TodoItemSource>;

/** The kind chips over the list (the prototype's CALL_KINDS). */
export const CALL_KINDS = ["all", "issues", "builds", "sales", "enh", "other"] as const;
export const CallKind = z.enum(CALL_KINDS);
export type CallKind = z.infer<typeof CallKind>;

export const CALL_KIND_LABELS: Readonly<Record<CallKind, string>> = {
  all: "All",
  issues: "Issues",
  builds: "Agent builds",
  sales: "Sales",
  enh: "Enhancements",
  other: "Questions and runs",
};

/** The chip a to-do falls under, from what it is about and where it comes from. */
export function callKindOf(
  about: TodoAboutKind | null,
  source: TodoItemSource = "todo",
): Exclude<CallKind, "all"> {
  if (source === "build_item") return "builds";
  switch (about) {
    case "issue":
    case "client_ask":
      return "issues";
    case "build":
    case "code_request":
      return "builds";
    case "deal":
      return "sales";
    case "enhancement":
      return "enh";
    default:
      return "other";
  }
}

/**
 * The tag on a card ("Issue · critical", "Agent build", "New account"). `detail` is what the
 * about-row adds: an issue's urgency, a deal's kind, an enhancement's ask count.
 */
export function todoTag(
  about: TodoAboutKind | null,
  detail: { urgency?: string | null; dealKind?: "new" | "expansion" | null; asks?: number } = {},
): string {
  switch (about) {
    case "issue":
      return detail.urgency ? `Issue · ${detail.urgency}` : "Issue";
    case "client_ask":
      return "Ask";
    case "build":
      return "Agent build";
    case "deal":
      return detail.dealKind === "expansion" ? "Expansion" : "New account";
    case "enhancement":
      return detail.asks
        ? `Enhancement · ${detail.asks} client${detail.asks === 1 ? "" : "s"}`
        : "Enhancement";
    case "question":
      return "Question";
    case "run":
      // S4.7 (QA W8): a finished run picked for a spot check, not a run held back.
      return "Run to check";
    case "client":
      return "Client";
    case "code_request":
      return "Dev queue";
    default:
      return "To-do";
  }
}

/**
 * When "Later" brings a to-do back: 9:00 on the next weekday.
 * DECISION: in UTC. A to-do spans clients in many zones and an operator has no zone of its own
 * yet; the snooze is a convenience, not a deadline.
 */
export function laterUntil(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9));
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d;
}

/** The client page's activity filters. */
export const ACTIVITY_FILTERS = ["all", "messages", "questions", "runs", "decisions"] as const;
export const ActivityFilter = z.enum(ACTIVITY_FILTERS);
export type ActivityFilter = z.infer<typeof ActivityFilter>;

export const ACTIVITY_FILTER_LABELS: Readonly<Record<ActivityFilter, string>> = {
  all: "All activity",
  messages: "Messages",
  questions: "Questions",
  runs: "Runs",
  decisions: "Decisions and changes",
};

/** A page of the client's activity. */
export const ACTIVITY_PAGE = 50;

/** Your call's words (the prototype's, word for word where it has them). */
export const YOUR_CALL_WORDS = {
  title: "Your call",
  lede: "One list for everything in the back office. Reggie does most of it; these need a person.",
  keys: "J K move · S do it · E edit · O open",
  tabs: { you: "Yours", reggie: "Reggie's", client: "The clients'", done: "Done today" },
  empty: "Nothing needs you right now.",
  emptyNote: (reggie: number) =>
    `Reggie is on ${reggie} thing${reggie === 1 ? "" : "s"}. You'll see one here when it needs a person.`,
  /** Nothing at all waits on you (the done-tone empty state). */
  clear: "You're clear",
  seeReggie: (reggie: number) => `See what Reggie is on (${reggie})`,
  /** A kind chip or a search that leaves Yours empty: what is empty, and where the work is. */
  noneOfKind: {
    all: "Nothing needs you",
    issues: "No issues need you",
    builds: "No agent builds need you",
    sales: "No deals need you",
    enh: "No enhancements need you",
    other: "No questions or runs need you",
  } satisfies Record<CallKind, string>,
  noSearchMatch: (q: string) => `Nothing of yours matches “${q}”`,
  elsewhere: (reggie: number, client: number) =>
    `Reggie is on ${reggie} thing${reggie === 1 ? "" : "s"}, and ${client} ${client === 1 ? "waits" : "wait"} on clients.`,
  showAll: (n: number) => `Show all ${n}`,
  noMatch: "Nothing matches.",
  clearFilters: "Clear the filters",
  draftHead: "The draft",
  optionsHead: "Pick one",
  readHead: "Reggie's read",
  later: "Later",
  edit: "Edit",
  take: "Take it",
  remind: "Remind",
  reggieIntro: "What Reggie is working on now. Take one to do it yourself.",
  clientIntro: "Waiting on clients. Reggie chases these; an overdue one also comes to you.",
  doneIntro:
    "Everything Reggie did on its own today. Spot-check a few; each one you flag goes on its play's record.",
  flag: "Flag",
  flagged: "Flagged",
  sent: "Sent",
  internal: "Internal",
  undo: "Undo",
  sending: "Sending in 5 seconds.",
  snoozed: "Snoozed until the next weekday at 9:00.",
  taken: "It's yours now. Reggie stops and leaves its notes.",
  mine: "Only mine",
  kpi: {
    needYou: "Need you",
    // S4.7 (QA W8): the tile counts agents on a safety hold (`holds`), not critical items.
    critical: "Agents on safety hold",
    reggie: "Reggie is on",
    clients: "Waiting on clients",
    questions: "Questions this week",
  },
} as const;

/** The undo window before an action that sends a draft goes (done in the page, by waiting). */
export const CALL_UNDO_MS = 5_000;

/** The flows of the Done today groups, in the prototype's order, with their names. */
export const DONE_TODAY_FLOWS = [
  ["issues", "Issues"],
  ["questions", "Questions"],
  ["builds", "Agent builds"],
  ["new", "New accounts"],
  ["grow", "Expansion"],
  ["enh", "Enhancements"],
] as const;
