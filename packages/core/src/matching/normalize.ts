// Keys as the matching engine compares them (docs/plan.md §1.215): references, counterparties and
// free text, normalised the same way on both sides and in a client's saved rules. Pure.

/** How a configuration reads a reference. */
export const REFERENCE_FORMS = ["alnum", "invoice_number"] as const;
export type ReferenceForm = (typeof REFERENCE_FORMS)[number];

/**
 * A reference on its letters and digits, lower case: "CHK #1042" is "chk1042". Shorter than three
 * characters, none (Bookkeeping's reconciliation, §1.80, compared them so; kept exactly).
 */
export function alnumReference(v: string | null | undefined): string | null {
  const r = (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return r.length >= 3 ? r : null;
}

// DECISION: an invoice number across two systems is the same when what is left after a leading
// "invoice"/"inv"/"no"/"#" word and leading zeros is: "INV-000042", "Invoice #42" and "42" agree.
// Letters elsewhere stay ("ROMCO-42" is "romco42"), so two prefixes that name different series never
// agree by themselves; a client's saved rule says when they do.
const INVOICE_PREFIX = /^(?:invoice|inv|no|nr|number|num)+/;

/** An invoice number as two systems may each write it. */
export function invoiceNumber(v: string | null | undefined): string | null {
  let r = (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  r = r.replace(INVOICE_PREFIX, "");
  r = r.replace(/^0+(?=[0-9a-z])/, "");
  return r.length >= 1 && r !== "0" ? r : null;
}

export function normalizeReference(form: ReferenceForm, v: string | null | undefined) {
  return form === "invoice_number" ? invoiceNumber(v) : alnumReference(v);
}

const LEGAL = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "co",
  "corp",
  "corporation",
  "company",
  "plc",
  "lp",
  "llp",
  "pc",
  "the",
]);

/** A counterparty's name without punctuation, case or legal form: "ROMCO, Inc." is "romco". */
export function normalizeCounterparty(v: string | null | undefined): string | null {
  const words = (v ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0 && !LEGAL.has(w));
  const r = words.join(" ");
  return r.length > 0 ? r : null;
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Trigram similarity (as Postgres' pg_trgm), 0 to 1, on already-normalised text. */
export function textSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}
