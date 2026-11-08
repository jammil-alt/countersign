// P-9: a request for a quote as words (docs/plan.md §1.71): the email a vendor gets, built in code
// from the RFQ's lines (the vendor's own words for an item where we have them) and the request's
// needed-by, delivery or pickup. Reach out sends it as a fixed message (`message.template`), so no
// model writes to a vendor and the words are the same on a retried step.

import { dec } from "@countersign/core";

/** Reach out's fixed messages hold at most 1600 characters; we stay under it. */
export const RFQ_TEXT_MAX = 1500;

export interface RfqTextLine {
  lineNo: number;
  description: string;
  qty: string;
  unit: string | null;
  vendorDescription: string | null;
  vendorSku: string | null;
}

export interface RfqTextInput {
  clientName: string;
  vendorName: string;
  contactName: string | null;
  neededBy: string | null;
  fulfillment: "delivery" | "pickup" | null;
  deliverTo: string | null;
  /** yyyy-mm-dd: when we would like the answer. */
  replyBy: string | null;
  lines: readonly RfqTextLine[];
  /** A PDF with the same lines goes with the email. */
  withDocument: boolean;
}

const qtyText = (qty: string) => dec(qty).toString();

/** One line: the vendor's words when we have them, else the client's; quantity, unit and SKU. */
export function rfqLineText(l: RfqTextLine): string {
  const what = l.vendorDescription ?? l.description;
  const sku = l.vendorSku ? ` (your item ${l.vendorSku})` : "";
  return `${l.lineNo}. ${what}${sku}: ${qtyText(l.qty)}${l.unit ? ` ${l.unit}` : ""}`;
}

/** The subject line of the RFQ email. */
export function rfqSubject(clientName: string, lines: number): string {
  return `Request for quote from ${clientName}: ${lines} ${lines === 1 ? "item" : "items"}`.slice(
    0,
    200,
  );
}

// DECISION: the RFQ email is plain English built in code (the vendor's language is open for the
// owner); lines that don't fit under reach out's 1600 characters are left to the attached PDF,
// with a line saying how many.
export function rfqText(input: RfqTextInput): string {
  const head = [
    `Hello ${input.contactName ?? input.vendorName},`,
    "",
    `${input.clientName} would like a quote for:`,
  ];
  const tail: string[] = [""];
  if (input.neededBy) tail.push(`Needed by ${input.neededBy}.`);
  if (input.fulfillment === "pickup") {
    tail.push(input.deliverTo ? `We pick up: ${input.deliverTo}.` : "We pick up.");
  } else if (input.fulfillment === "delivery") {
    tail.push(
      input.deliverTo ? `Deliver to ${input.deliverTo}.` : "Delivered, address to confirm.",
    );
  }
  tail.push(
    "Please reply to this email with your price per unit, the unit, the lead time and whether you have each item.",
  );
  if (input.replyBy) tail.push(`We'd like your answer by ${input.replyBy}.`);
  tail.push("", "Thank you,", input.clientName);
  const fixed = [...head, ...tail].join("\n").length;
  const lines: string[] = [];
  let used = fixed;
  for (const [i, l] of input.lines.entries()) {
    const text = rfqLineText(l);
    const left = input.lines.length - i;
    const note = `(${left} more ${left === 1 ? "line" : "lines"} in the attached request)`;
    if (used + text.length + 1 + note.length + 1 > RFQ_TEXT_MAX && input.withDocument) {
      lines.push(note);
      break;
    }
    if (used + text.length + 1 > RFQ_TEXT_MAX) break;
    lines.push(text);
    used += text.length + 1;
  }
  return [...head, ...lines, ...tail].join("\n").slice(0, RFQ_TEXT_MAX);
}
