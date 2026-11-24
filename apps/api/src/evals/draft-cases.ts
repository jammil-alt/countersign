// Draft it now, against the real model (./builder.eval.ts): a description in, a drafted workflow
// out, graded by a judge. The first case is the one the owner tried on 2026-11-24 ("they really
// don't match"): a ten-step monthly process whose draft lost five steps, reworded the rest and put
// Collect reports on the wrong step. Made up: the names are not a client's.

import type { ProcessAgentBundle } from "@countersign/core";

export interface DraftCase {
  id: string;
  title: string;
  /** For the judge: what the operator asked for. */
  situation: string;
  /** The operator's words, as typed on Describe it. */
  description: string;
  points: { id: string; text: string }[];
}

type Step = { id: string; kind: string; name: string } & Record<string, unknown>;

/** A drafted bundle as the judge reads it: each workflow's ways in and steps, nested. */
export function renderDraft(bundle: ProcessAgentBundle): string {
  const lines: string[] = [];
  const walk = (steps: readonly Step[], depth: number) => {
    steps.forEach((s, i) => {
      const what = [
        s.kind,
        typeof s.skill === "string" ? `skill ${s.skill}` : null,
        typeof s.tool === "string" ? `tool ${s.tool}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`${"  ".repeat(depth)}${i + 1}. ${s.name} [${what}]`);
      if (Array.isArray(s.steps)) walk(s.steps as Step[], depth + 1);
      if (Array.isArray(s.paths)) {
        for (const p of s.paths as { name: string; steps: Step[] }[]) {
          lines.push(`${"  ".repeat(depth + 1)}path: ${p.name}`);
          walk(p.steps, depth + 2);
        }
        const o = s.otherwise as { steps: Step[] } | undefined;
        if (o?.steps.length) {
          lines.push(`${"  ".repeat(depth + 1)}otherwise:`);
          walk(o.steps, depth + 2);
        }
      }
      if (Array.isArray(s.items)) {
        for (const it of s.items as { name: string; owner: string }[]) {
          lines.push(`${"  ".repeat(depth + 1)}report: ${it.name} from ${it.owner}`);
        }
      }
    });
  };
  for (const w of bundle.workflows) {
    const process = w.workflow as unknown as { triggers: { on: unknown }[]; steps: Step[] };
    lines.push(`Workflow ${w.slug}: ${w.name}`);
    for (const t of process.triggers) lines.push(`  starts: ${JSON.stringify(t.on)}`);
    walk(process.steps, 1);
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
        text: "The UCC file is read into rows by Read table (data.read-table) or a read step, not handed to a model as a file",
      },
      {
        id: "forms-per-manager",
        text: "Steps 5 to 7 go to each sales manager in turn (a for_each over the managers) with a way to ask and wait for their answers (Request info, forms.request, or a person step with a deadline and reminders), not Collect reports and not a single step for everyone",
      },
      {
        id: "zoho-write-approved",
        text: "Writing back to Zoho is a write step on a Zoho tool with its approval check on",
      },
      {
        id: "no-collect-misuse",
        text: "Collect reports (a collect step) is not used to set match types or for anything other than files people send",
      },
    ],
  },
];
