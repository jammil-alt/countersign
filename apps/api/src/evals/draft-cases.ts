// Draft it now, against the real model (./builder.eval.ts): a description in, a drafted workflow
// out, graded by a judge. The first case is the one the owner tried on 2026-11-24 ("they really
// don't match"): a ten-step monthly process whose draft lost five steps, reworded the rest and put
// Collect reports on the wrong step. Made up: the names are not a client's. Step model (build item
// 9): the Builder drafts v5 workflows, so the cases are graded in its words (Do, done by, uses,
// outputs and End), and the cases after the first are one per thing it must do in that model.

import type { StepAgentBundle } from "@countersign/agents";
import type { steps } from "@countersign/core";

export interface DraftCase {
  id: string;
  title: string;
  /** For the judge: what the operator asked for. */
  situation: string;
  /** The operator's words, as typed on Describe it. */
  description: string;
  points: { id: string; text: string }[];
}

/** One step in a line: its kind, who does it and what it uses, its checks. */
function stepWords(s: steps.Step): string {
  const parts: string[] = [s.kind];
  if (s.kind === "do") {
    if (s.doneBy) parts.push(`done by ${s.doneBy}`);
    const u = s.uses;
    if (u?.type === "action") parts.push(`uses action ${u.action}`);
    else if (u?.type === "skill") parts.push(`uses skill ${u.skill}`);
    else if (u?.type === "match") {
      parts.push(
        `uses match to ${u.match.to}, ${u.match.type}${u.match.keys ? ` on ${u.match.keys.join(", ")}` : ""}`,
      );
    } else if (u?.type === "automation") parts.push(`uses automation ${u.automation}`);
    else if (u?.type === "missing") parts.push(`not built yet: ${u.need}`);
    else if (u?.type) parts.push(`uses ${u.type}`);
    else if (s.rules?.rows?.length)
      parts.push(`rules written in the step (${s.rules.rows.length} rows)`);
    else if (s.ai?.text) parts.push(`AI written in the step: "${s.ai.text.slice(0, 160)}"`);
    if (s.person) parts.push(`person ${s.person.mode} ${s.person.who}`);
  }
  if (s.kind === "loop") {
    parts.push(`goal "${s.goal.slice(0, 120)}", reads ${s.reads.join(", ") || "nothing"}`);
    parts.push(`at most ${s.maxTurns} turns`);
    if (s.skill) parts.push(`saved Loop ${s.skill}`);
  }
  if (s.kind === "end") {
    parts.push(
      s.outputs.length
        ? `delivers ${s.outputs.join(", ")}`
        : `nothing to do: ${s.nothingToDo ?? ""}`,
    );
  }
  if (s.checks?.approval) parts.push(`approval ${s.checks.approval.required}`);
  return parts.join(", ");
}

/** A drafted bundle as the judge reads it: each workflow's ways in, outputs and steps, nested. */
export function renderDraft(bundle: StepAgentBundle): string {
  const lines: string[] = [];
  const walk = (list: readonly steps.Step[], depth: number) => {
    list.forEach((s, i) => {
      lines.push(`${"  ".repeat(depth)}${i + 1}. ${s.name} [${stepWords(s)}]`);
      if (s.kind === "for_each" || s.kind === "repeat") walk(s.steps, depth + 1);
      if (s.kind === "fork") {
        for (const p of s.paths) {
          lines.push(`${"  ".repeat(depth + 1)}path: ${p.name}`);
          walk(p.steps, depth + 2);
        }
        if (s.otherwise.steps.length) {
          lines.push(`${"  ".repeat(depth + 1)}otherwise:`);
          walk(s.otherwise.steps, depth + 2);
        }
      }
      if (s.kind === "do" && s.collect) {
        for (const it of s.collect.items) {
          lines.push(`${"  ".repeat(depth + 1)}report: ${it.name} from ${it.owner}`);
        }
      }
    });
  };
  for (const w of bundle.workflows) {
    lines.push(`Workflow ${w.slug}: ${w.name}`);
    for (const t of w.workflow.triggers) lines.push(`  starts: ${JSON.stringify(t.on)}`);
    for (const o of w.workflow.outputs) {
      const approval = o.checks?.approval ? `, approval ${o.checks.approval.required}` : "";
      lines.push(
        `  output ${o.id}: ${o.name} (${o.kind}${o.action ? ` ${o.action.action}` : ""}${approval})`,
      );
    }
    walk(w.workflow.steps, 1);
  }
  return lines.join("\n");
}

export const DRAFT_CASES: DraftCase[] = [
  {
    id: "ucc-monthly-cycle",
    title: "A numbered ten-step process keeps its ten steps",
    situation:
      "The operator described a monthly UCC filings process as ten numbered steps with sub-points and asked for a draft that runs. The client uses Zoho CRM. The draft should follow the numbered steps one for one, in the operator's words.",
    description: `Steps

1. Receive. When the UCC file arrives by email, start a new monthly cycle. Acknowledge receipt to Dana.
2. Parse and clean:
   * Standardize names, manufacturers and the Acme Equipment seller spellings.
   * Remove duplicates, amendments, refinances and filings outside Acme's area.
   * Fill in missing counties from the city or ZIP.
   * Mark equipment Acme doesn't sell as not applicable.
3. Assign. Give each filing a region, division, rep and sales manager based on county and equipment type. Filings with no territory rule go to an admin queue for manual assignment.
4. Match to Zoho:
   * Find the Account by name (allowing for spelling differences) and address (street, city, ZIP).
   * On that Account, look for a Deal with the same equipment type or make that closed 1-3 months before the filing date.
   * Won: Acme is the seller, or there's a Closed Won Deal.
   * Lost: there's a Closed Lost Deal, but the filing shows another brand.
   * Existing client, no Deal: the Account matches but no related Deal exists.
   * Lead only: the buyer matches an open Lead.
   * Unmatched: no Zoho record, or a similar name in a different city.
   * Save the match type and the reason for every filing.
5. Build manager forms. One form per sales manager listing all filings in their territory. Every filing: pick an outcome (won, lost, not involved) and a reason, with a short explanation.
6. Send. Email each manager a link to their form, with a due date of 2 business days.
7. Follow up. Send a reminder on the due date, and another every 2 business days after that until the form is complete. After the second reminder, copy the regional manager.
8. Write back to Zoho. As responses come in, record the outcome, reason, explanation and any linked Deal in Zoho.
9. Report. When every form is complete, build an Excel report: participation rate and close rate by region, manager and rep; top loss reasons; a detail tab with every filing.
10. Distribute. Email the report to the distribution list, then close the cycle.`,
    points: [
      {
        id: "starts-on-email",
        text: "It starts when the file arrives by email: a message trigger on email or a document.received event, not a manual or scheduled start",
      },
      {
        id: "ten-steps",
        text: "Each of the ten numbered steps is a step of its own at the top level (or a for_each holding that step's per-item work), in the operator's order, with none left out and none merged",
      },
      {
        id: "operator-words",
        text: "The steps are named in the operator's words (Receive, Parse and clean, Assign, Match to Zoho, Build manager forms, Send, Follow up, Write back to Zoho, Report, Distribute, or close to them), not reworded into other wording",
      },
      {
        id: "spreadsheet-in-code",
        text: "The UCC file is read into rows by Read table (the data.read-table skill or the data.table.read action, done by rules), not handed to a model as a file",
      },
      {
        id: "forms-per-manager",
        text: "Steps 5 to 7 go to each sales manager in turn (a for_each over the managers) with a way to ask and wait for their answers (a Do done by a person with a deadline and reminders), not Collect reports and not a single step for everyone",
      },
      {
        id: "decisions-laid-out",
        text: "The decisions the description names are in the draft: filings with no territory rule go to a person (a Fork path or a Do done by a person for manual assignment), and each filing gets one of the named match types (won, lost, existing client with no deal, lead only, unmatched)",
      },
      {
        id: "zoho-write-approved",
        text: "Writing back to Zoho is a Do done by rules using a Zoho action, with its approval on",
      },
      {
        id: "no-collect-misuse",
        text: "Collect reports (a Do using collect) is not used to set match types or for anything other than files people send",
      },
      {
        id: "ends-delivered",
        text: "The workflow declares its outputs (the report emailed to the list at least), and every path ends on an End that delivers one of them",
      },
    ],
  },
  {
    id: "reuse-library-first",
    title: "Reuses the catalog before writing in the step",
    situation:
      "The operator asked for an agent that reads vendor invoices that arrive by email and creates the bill. The catalog has a skill that reads a document and an Accounting action that creates a bill.",
    description:
      "When a vendor invoice arrives by email, read it, match the vendor, and create the bill in the accounting system for a person to approve. Tell AP when it's done.",
    points: [
      {
        id: "reads-with-skill",
        text: "The invoice is read by a library skill or action from the catalog (a Do that uses a skill or an action), not by AI instructions written in the step",
      },
      {
        id: "matches-vendor",
        text: "The vendor is matched by a Match step on the Vendors profile, not by AI written in the step",
      },
      {
        id: "accounting-action",
        text: "The bill is created by a Do done by rules using the Accounting action accounting.bill.create (not one accounting tool's own), with its approval on",
      },
      {
        id: "tells-ap",
        text: "AP is told through a report output delivered by the End, or a Do using tell",
      },
    ],
  },
  {
    id: "written-in-step",
    title: "Writes rules in the step when nothing fits",
    situation:
      "The operator asked for routing rules the catalog has no skill for: which approver gets a purchase request by its amount.",
    description:
      "When a purchase request comes in, route it: under $1,000 to the office manager, $1,000 to $10,000 to the controller, over $10,000 to the owner. Then ask that person to approve it.",
    points: [
      {
        id: "rules-in-step",
        text: "The routing is a Do done by rules with rule rows written in the step (three rows by amount), with its output named, not AI and not a missing step",
      },
      {
        id: "person-approves",
        text: "A Do done by a person approves the request, asking the approver the rules chose",
      },
      {
        id: "ends",
        text: "Every path ends on an End that delivers a declared output",
      },
    ],
  },
  {
    id: "not-built-yet",
    title: "Puts Not built yet where code is missing",
    situation:
      "The operator asked for a step that needs a payroll connector, which the catalog doesn't have.",
    description:
      "Every two weeks, read the pay run from our payroll system and post the journal entry to the accounting system for approval.",
    points: [
      {
        id: "missing-step",
        text: "Reading the pay run is a Do whose uses is missing (not built yet), saying what is missing, in the place where it belongs; it isn't left out or done by AI",
      },
      {
        id: "gap-named",
        text: "The draft's gaps name the missing payroll connector",
      },
    ],
  },
  {
    id: "loop-for-investigation",
    title: "Drafts a Loop for work whose path can't be known ahead",
    situation:
      "The operator asked for an agent that looks into why a bank reconciliation doesn't balance.",
    description:
      "When a reconciliation is left with unmatched items, look into them: read what you need from the bank feed and the books until each is explained or you've tried ten times, then save what you found for a person to review.",
    points: [
      {
        id: "loop",
        text: "The investigation is a Loop step (or the saved Loop bookkeeping.investigate-leftovers) with a goal, read actions only (no change or save), and a limit of about ten turns",
      },
      {
        id: "save-after",
        text: "What the Loop finds is saved by a Do after it (done by rules, using a save action), not by the Loop",
      },
    ],
  },
  {
    id: "vendor-items-by-sku",
    title: "Matches vendor items by SKU only",
    situation:
      "The operator asked for each invoice line to be matched to the vendor's catalog items. The owner's rule: a vendor item is a SKU match or nothing, never a near match.",
    description:
      "For each line of a vendor invoice, find the vendor's catalog item. Lines with no match go to a person.",
    points: [
      {
        id: "match-exact-sku",
        text: "Each line is matched by a Match step to vendor-items with match type exact on the SKU key only (never semantic or hybrid)",
      },
      {
        id: "per-line",
        text: "The lines are matched as a list (the Match's items) or inside a for_each over the lines",
      },
      {
        id: "no-match-person",
        text: "A line with no match goes to a person (the Match's no match setting, or a Do done by a person)",
      },
    ],
  },
  {
    id: "template-no-client-data",
    title: "A template holds nothing of one client",
    situation:
      "The operator described a template using one client's people by email address. A template is forked into many clients.",
    description:
      "When a bill over $5,000 comes in, ask jane@acme-example.com to approve it, then tell ap@acme-example.com.",
    points: [
      {
        id: "no-literals",
        text: "No email address, phone number or record id appears in the draft: people are named by seat (seat:<role>) or client_admin",
      },
      {
        id: "approval",
        text: "A Do done by a person approves the bill",
      },
    ],
  },
];
