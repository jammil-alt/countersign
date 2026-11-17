// The Builder's test cases (./builder.eval.ts): moments from the QA runs on staging (2026-11-16 and
// 2026-11-17) where the Builder went wrong, with what a good answer does. Made up: no client data.
//
// A point is graded by a judge model, literally. Style problems are checked by rule.

import type { BuildTurnAnswer, BuildTurnInput } from "@countersign/agents";
import type { Brief } from "@countersign/core";

export interface BuilderCase {
  id: string;
  title: string;
  /** For the judge: what the operator is doing and what the build holds. */
  situation: string;
  input: Omit<BuildTurnInput, "ctx">;
  points: { id: string; text: string }[];
  /** The answer as the judge reads it. */
  render(answer: BuildTurnAnswer): string;
}

const confirmed = (text: string) => ({ text, state: "confirmed" as const });

const empty = {
  fitgap: { rows: [], needsTrue: [], setup: [] },
  testPlan: { datasets: [] },
  issues: [],
  focus: null,
  facts: [],
  history: [],
};

function render(a: BuildTurnAnswer): string {
  const lines = [a.text];
  if (a.chips.length) lines.push("", `Chips: ${a.chips.join(" | ")}`);
  if (a.brief) {
    lines.push("", "Brief changes:");
    for (const [k, f] of Object.entries(a.brief))
      if (f) lines.push(`- ${k} [${f.state}]: ${f.text}`);
  }
  if (a.fitgap) {
    lines.push("", "Fit-gap rows:");
    for (const r of a.fitgap.rows) lines.push(`- ${r.need}: ${r.verdict}. How: ${r.how}`);
    if (a.fitgap.needsTrue.length) {
      lines.push("What needs to be true:");
      for (const n of a.fitgap.needsTrue) lines.push(`- ${n.text}`);
    }
    if (a.fitgap.setup.length) {
      lines.push("Client intake form:");
      for (const f of a.fitgap.setup) lines.push(`- ${f.label} (${f.kind}): ${f.hint}`);
    }
  }
  if (a.items.length) {
    lines.push("", "New open items:");
    for (const i of a.items)
      lines.push(`- ${i.title} (${i.kind}, ${i.owner})${i.detail ? `: ${i.detail}` : ""}`);
  }
  if (a.proposal) {
    lines.push(
      "",
      `Proposal: ${a.proposal.summary}`,
      `Action: ${JSON.stringify(a.proposal.action)}`,
    );
  }
  return lines.join("\n");
}

// ── Run 1: vendor onboarding and contract intake (a template) ─────────────────────────────────

const vendorBrief: Brief = {
  goal: confirmed(
    "Set up each new vendor for the client: their record in the accounting system, their tax form on file, their contract and its prices, so invoices can be checked against them later.",
  ),
  trigger: confirmed("A new vendor's onboarding form or contract arrives by email."),
  dataIn: confirmed("The vendor's onboarding form, their W-9 and their contract as PDFs."),
  dataOut: confirmed(
    "The vendor in the accounting system, their contract on file, and their contracted items and prices on the client's item list.",
  ),
  measure: confirmed("Every new vendor set up within two business days, with nothing missing."),
  people: confirmed("The client's AP clerk approves each new vendor."),
  volume: confirmed("About 10 new vendors a month per client."),
};

const vendorIntake: BuilderCase = {
  id: "vendor-intake-gaps",
  title: "Vendor onboarding: what to ask before confirming the brief",
  situation:
    "An operator is building a template agent for vendor onboarding and contract intake. The brief is filled in; the operator asks the assistant what else could go wrong or hasn't been covered before confirming it. A good answer surfaces the predictable ways this work breaks for different clients.",
  input: {
    ...empty,
    phase: "intake",
    kind: "agent",
    title: "Vendor onboarding and contract intake",
    clientName: null,
    brief: vendorBrief,
    words:
      "That's everything I have. Before I confirm the brief: list what could go wrong or what we haven't covered, then ask your most important question.",
  },
  points: [
    {
      id: "no-erp",
      text: "It raises clients that have no ERP or accounting system, and where the vendor record lives then",
    },
    {
      id: "late-contract",
      text: "It raises a contract that arrives later than the onboarding form (weeks after) and how it gets matched to the right vendor",
    },
    {
      id: "scanned",
      text: "It raises what the contracts look like: scanned PDFs, or pricing in exhibits or tables",
    },
    {
      id: "item-list",
      text: "It raises where the item list lives and how it later feeds invoice matching",
    },
    {
      id: "w9",
      text: "It raises checking the W-9 (that the tax ID on it is valid or matches), without asking for the tax ID itself",
    },
    { id: "one-question", text: "It ends with a single question, not several" },
  ],
  render,
};

const vendorOverlap: BuilderCase = {
  id: "vendor-overlap",
  title: "Vendor onboarding: notices work that already exists",
  situation:
    "Same build. Another agent, AP Invoice Review, already has an open item 'Separate vendor management flow for unmatched or new vendors'. A good answer notices the overlap before a second build starts. (This needs the assistant to be shown other agents and their open items.)",
  input: {
    ...vendorIntake.input,
    words: "Anything we already have that this overlaps with?",
  },
  points: [
    {
      id: "overlap",
      text: "It names AP Invoice Review or its open item about a vendor management flow as overlapping work",
    },
  ],
  render,
};

// ── Run 2: monthly bank reconciliation (a template), the fit-gap ───────────────────────────────

const reconBrief: Brief = {
  goal: confirmed(
    "Reconcile each bank and card account in QuickBooks Online every month against the statement PDF, and get the reconciliation approved.",
  ),
  trigger: confirmed("Every month, 5 business days after month end."),
  dataIn: confirmed(
    "The month's bank and card lines, the QuickBooks register for each account, and the bank statement PDF.",
  ),
  dataOut: confirmed(
    "A reconciliation report per account, each line matched or explained, and the items marked reconciled in QuickBooks once approved.",
  ),
  rules: confirmed(
    "Match a bank line to a QuickBooks entry when amounts match and dates are within 5 days. Differences over $500 go to the controller; under that, the bookkeeper approves.",
  ),
  people: confirmed("The bookkeeper prepares; the controller approves differences over $500."),
};

const reconFitgap: BuilderCase = {
  id: "recon-fitgap",
  title: "Bank reconciliation: an honest fit-gap",
  situation:
    "The brief for a monthly bank reconciliation template is confirmed and the assistant writes the fit-gap: each need, whether the platform's catalog does it as is, needs configuring, can be built from catalog parts, needs something the catalog lacks (figure out), or is against the rules.",
  input: {
    ...empty,
    phase: "fitgap",
    kind: "agent",
    title: "Monthly bank reconciliation",
    clientName: null,
    brief: reconBrief,
    words: null,
  },
  points: [
    {
      id: "business-days",
      text: "Starting 5 business days after month end is not marked as done as is: the catalog's schedules don't count business days",
    },
    {
      id: "bank-feed",
      text: "It says the bank and card lines come from a bank feed connection, not from QuickBooks' own bank feed",
    },
    { id: "date-window", text: "Matching within a 5-day date window is not marked as done as is" },
    {
      id: "approval-routing",
      text: "Sending differences over $500 to the controller and the rest to the bookkeeper is not marked as done as is",
    },
    {
      id: "mark-reconciled",
      text: "Marking items reconciled in QuickBooks is marked as something the catalog lacks (figure out), not as done or configurable",
    },
    {
      id: "next-step",
      text: "The reply ends by saying what to do next: agree the direction when the fit-gap looks right",
    },
    {
      id: "plain-how",
      text: "The rows' 'How' are in plain words, naming tools by their names rather than ids like qbo.account.register",
    },
  ],
  render,
};

// ── Run 3: weekly past-due invoice reminders (a template) ─────────────────────────────────────

const remindersBrief: Brief = {
  goal: confirmed("Remind customers of invoices 15 or more days past due, once a week."),
  trigger: confirmed("Every Monday at 8am in the client's time zone."),
  dataIn: confirmed("Open invoices from QuickBooks Online, with each customer's email."),
  dataOut: confirmed(
    "One reminder email per customer listing their past-due invoices and total, sent from the client's mailbox after the client admin approves the batch.",
  ),
  rules: confirmed("Only customers owing $50 or more. Nothing is written to QuickBooks."),
  people: confirmed("The client admin approves the batch."),
};

const remindersFitgap: BuilderCase = {
  id: "reminders-fitgap",
  title: "Past-due reminders: grouping by customer isn't in the catalog",
  situation:
    "The brief for weekly past-due reminders is confirmed and the assistant writes the fit-gap. The catalog has a skill, 'Filter, group and total a list', that keeps items by rules (such as a date at least N days ago), groups them by a field and totals them in decimals; Reshape data can only pick, pluck or map items. Emails can only be sent to contacts who agreed to email.",
  input: {
    ...empty,
    phase: "fitgap",
    kind: "agent",
    title: "Weekly past-due reminders",
    clientName: null,
    brief: remindersBrief,
    words: null,
  },
  points: [
    {
      id: "grouping",
      text: "Filtering past-due invoices and grouping and totaling them by customer is done with 'Filter, group and total a list', not with Reshape data",
    },
    {
      id: "consent",
      text: "It flags that emailing QuickBooks customers needs them to count as contacts who agreed to email",
    },
    {
      id: "schedule",
      text: "The Monday 8am schedule is treated as something the catalog does (as is or by configuring)",
    },
    {
      id: "next-step",
      text: "The reply ends by saying what to do next: agree the direction when the fit-gap looks right",
    },
  ],
  render,
};

// The third run's false "Done": asked to build what the catalog lacks. (Its own missing step, the
// grouping, has a skill now, so the case is the reconciliation's: no tool marks items reconciled.)
const honestEdit: BuilderCase = {
  id: "honest-edit",
  title: "Never promise a tool it can't build",
  situation:
    "The draft of a bank reconciliation exists. Its step 'Mark the items reconciled in QuickBooks' is a missing step: no catalog tool marks QuickBooks items reconciled. The operator asks the assistant to build it. The assistant can only change the draft with what the catalog has; it can't create a skill or a tool. A good answer says so, says what the missing tool must do, and hands it to engineering, without proposing an edit that pretends to build it.",
  input: {
    ...empty,
    phase: "draft",
    kind: "agent",
    title: "Monthly bank reconciliation",
    clientName: null,
    brief: reconBrief,
    issues: [
      "[problem:main|mark||missing_step] Draft problem (Open, holds the next move): Missing step: Mark the items reconciled in QuickBooks. In “Mark the items reconciled in QuickBooks”",
    ],
    facts: [
      "Draft problem: Missing step: Mark the items reconciled in QuickBooks",
      'Draft v1 step [lines] Read the bank lines (read), in "Monthly reconciliation"',
      'Draft v1 step [register] Read the QuickBooks register (read), in "Monthly reconciliation"',
      'Draft v1 step [match] Match lines to entries (skill), in "Monthly reconciliation"',
      'Draft v1 step [approve] Approve the reconciliation (person), in "Monthly reconciliation"',
      'Draft v1 step [mark] Mark the items reconciled in QuickBooks (missing), in "Monthly reconciliation"',
    ],
    focus: {
      line: "[problem:main|mark||missing_step] Draft problem (Open, holds the next move): Missing step: Mark the items reconciled in QuickBooks",
      thread: [],
    },
    words: "Build the step that marks them reconciled.",
  },
  points: [
    { id: "cant-build", text: "It says plainly that it can't create the tool or skill itself" },
    {
      id: "spec",
      text: "It says what the missing tool must do (which items, in which account, after approval)",
    },
    {
      id: "engineering",
      text: "It adds an open item for engineering, or proposes handing it to engineering",
    },
    {
      id: "no-false-edit",
      text: "It does not propose a draft edit that claims to build or add the skill",
    },
    { id: "not-done", text: "It never says the skill is built or the step is done" },
  ],
  render,
};

export const BUILDER_CASES: BuilderCase[] = [
  vendorIntake,
  vendorOverlap,
  reconFitgap,
  remindersFitgap,
  honestEdit,
];

/** Problems any answer can be checked for by rule (QA, 2026-11-17). */
export function styleProblems(c: BuilderCase, a: BuildTurnAnswer): string[] {
  const out: string[] = [];
  const text = a.text;
  const toolId = /\b[a-z]+(?:\.[a-z_]+){1,3}\b/g;
  const ids = (text.match(toolId) ?? []).filter((m) => !/^(e\.g|i\.e)$/.test(m));
  if (ids.length) out.push(`internal ids in the reply: ${[...new Set(ids)].join(", ")}`);
  const codes = text.match(/\b(not_possible|figure_out|needsTrue|dataIn|dataOut|outOfScope)\b/g);
  if (codes) out.push(`codes in the reply: ${[...new Set(codes)].join(", ")}`);
  if (/\(row [\w-]+\)|\brow [a-z]+-[a-z-]+/.test(text)) out.push("a row id in the reply");
  const questions = (text.match(/\?/g) ?? []).length;
  if (c.input.phase === "intake" && questions > 2) out.push(`${questions} questions in one turn`);
  for (const r of a.fitgap?.rows ?? []) {
    const inHow = r.how.match(toolId);
    if (inHow) out.push(`ids in "how" of "${r.need}": ${[...new Set(inHow)].join(", ")}`);
  }
  if (/^done\b/i.test(text.trim())) out.push('starts with "Done"');
  return out;
}
