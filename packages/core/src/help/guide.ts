// v0.17 (ARCHITECTURE §10.15 "Home", docs/plan.md §1.96, O6): the portal's guide, one entry per
// thing a person does, for Sloan to answer "how do I…" with the steps and a link. Platform words,
// read by Sloan as data through `account.help`; the portal's own paths, never a guess.
//
// English only for now: Sloan answers in the client's language from these steps.

import type { OwnerArea } from "../owners/areas";

export interface GuideEntry {
  id: string;
  title: string;
  /** Where it is done in the portal; a `:param` is filled in from the record. */
  path: string;
  /** Words people use for it, for matching a question. */
  words: readonly string[];
  steps: readonly string[];
}

export const PORTAL_GUIDE: readonly GuideEntry[] = [
  {
    id: "home",
    title: "See how everything is going",
    path: "/",
    words: ["home", "overview", "status", "dashboard", "today"],
    steps: [
      "Home shows what is running, what waits on you, what failed today and the next run.",
      "Your agents are below it, each with how its week went and what it did last.",
    ],
  },
  {
    id: "inbox",
    title: "Sign or answer what waits on you",
    path: "/inbox",
    words: ["approve", "sign", "inbox", "waiting", "approval", "answer"],
    steps: [
      "Open Inbox at the top right.",
      "Open an item to see what it would do, then Approve, Reject or edit it before you sign.",
    ],
  },
  {
    id: "runs",
    title: "See what an agent did",
    path: "/runs",
    words: ["runs", "history", "what happened", "failed", "error", "log"],
    steps: [
      "Open Runs and pick a run, or open one from Home.",
      "Each step says what it did; open a step to see what went in and what came out.",
    ],
  },
  {
    id: "connections",
    title: "Connect or reconnect a tool",
    path: "/accounts",
    words: ["connect", "reconnect", "quickbooks", "gmail", "login", "sign in", "disconnected"],
    steps: [
      "Open Accounts.",
      "Choose the tool and sign in to it yourself. We never see your password.",
    ],
  },
  {
    id: "people",
    title: "Change who an agent contacts",
    path: "/agents/:serviceId/settings",
    words: ["people", "contact", "who", "approver", "send to", "team"],
    steps: [
      "Open the agent, then its Settings, then People.",
      "Pick the role (for example the purchaser) and choose who fills it.",
    ],
  },
  {
    id: "hours",
    title: "Set business hours and away dates",
    path: "/settings/hours",
    words: ["hours", "business hours", "holiday", "away", "quiet hours", "after hours"],
    steps: [
      "Open Settings, then Business hours.",
      "Set the working week, then add away dates for anyone who is out.",
    ],
  },
  {
    id: "directory-import",
    title: "Upload a list of employees, vendors or customers",
    path: "/contacts?import=1",
    words: ["upload", "import", "list", "csv", "spreadsheet", "vendors", "employees", "customers"],
    steps: [
      "Attach the CSV here in the chat, or open Contacts and choose Import.",
      "We show each row and what it would add or change; nothing is saved until you confirm.",
    ],
  },
  {
    id: "switch-account",
    title: "Switch to another account",
    path: "/",
    words: ["switch", "another account", "other company", "change client", "account"],
    steps: ["Open the account name at the top left and choose the other account."],
  },
  {
    id: "agents",
    title: "Open one of your agents",
    path: "/agents/:serviceId",
    words: ["agent", "agents", "pia", "owner", "rename", "processes"],
    steps: [
      "Open an agent from Home or from Agents to see what it does and its runs.",
      "A client admin can rename an agent there.",
    ],
  },
  {
    id: "request",
    title: "Ask us for a change or something new",
    path: "/sloan?mode=change",
    words: ["change", "request", "new", "feature", "feedback", "idea", "build"],
    steps: [
      "Tell Sloan or the agent what you want in the chat.",
      "We show you the words before anything is sent to your Mezonas lead.",
    ],
  },
];

/** Entries for a question or a screen: those whose words or path match, best first. */
export function guideFor(input: { question?: string; path?: string }, limit = 3): GuideEntry[] {
  const q = (input.question ?? "").toLowerCase();
  const scored = PORTAL_GUIDE.map((e) => {
    let score = 0;
    for (const w of e.words) if (q.includes(w)) score += w.length;
    if (input.path && (input.path === e.path || input.path.startsWith(`${e.path}/`))) score += 5;
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

/** What each area could do for a client that doesn't use it yet, in a line (Home's Ideas). */
export const AREA_IDEAS: Readonly<Record<OwnerArea, { title: string; line: string }>> = {
  purchasing: {
    title: "Purchasing",
    line: "Read vendor invoices, match items across vendors, watch prices and chase quotes.",
  },
  sales: {
    title: "Sales",
    line: "Follow up quotes that went quiet and keep your CRM's next steps current.",
  },
  receivables: {
    title: "Receivables",
    line: "Remind customers about overdue invoices and log the dates they promise.",
  },
  bookkeeping: {
    title: "Bookkeeping",
    line: "Book bank and card transactions to your chart of accounts and reconcile each month.",
  },
  marketing: {
    title: "Marketing",
    line: "Measure your website and draft titles, descriptions and articles.",
  },
  general: {
    title: "Operations",
    line: "Reminders, timesheets and the small recurring jobs that fall between areas.",
  },
};
