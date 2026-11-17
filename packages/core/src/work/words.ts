// The back office work screens' words (docs/plan.md §1.124), from the agreed prototype
// (docs/design/pipelines.html). Plain, short, sentence case.

export const WORK_WORDS = {
  build: {
    title: "Build",
    lede: "Issues, agent builds and enhancements in one order. Reggie keeps the order; you can move anything.",
    newItem: "New item",
    autopilot: "Autopilot",
    builderBoard: "Drafts in the Agent lab",
  },
  empty: "Nothing matches.",
  clear: "Clear the search and filters",
  noDate: "No date",
  movedByReggie: "Moved by Reggie",
  movedByYou: "Moved by you",
  readNotYet: "Reggie hasn't read this yet",
  hold: {
    on: "Safety hold on",
    detail: "The agent's writes and messages are stopped; its runs go on as drafts.",
    review: "Review held items",
    rollBack: "Roll back",
    release: "Release",
  },
  /** Converting an issue that isn't a fault into an ask: what the client reads. */
  convertedToAsk: "It isn't a fault: it's on our list.",
} as const;

/** The plain hold notice the client reads (a draft for the operator to send). */
export function holdNotice(agentName: string): string {
  return `We paused ${agentName} while we fix a problem we found. Nothing it would have done is lost: it waits for us to review. We'll write again within the hour.`;
}

/** What the portal shows for where a request stands. */
export const PORTAL_REQUEST_STATUS_WORDS = {
  on_it: "We're on it",
  waiting_on_you: "Waiting on you",
  fixed: "Fixed",
  closed: "Closed",
} as const;
