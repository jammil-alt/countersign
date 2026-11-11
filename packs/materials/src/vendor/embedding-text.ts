// The text a master item, a vendor item or an open line is embedded as (docs/plan.md §1.88, the
// owner's template of 2026-11-11): name + description + specs, because a detail may appear in any
// of them. One fixed template, the same order and labels for every kind, so comparisons are like
// for like:
//
//   Name: <name>
//   Description: <description as written; for a vendor item, the vendor's own wording>
//   Specs: category <c>; <attribute> <value>; …
//
// Empty fields are left out; prices, quantities, dates and order or shipping terms are stripped
// from the name and the description; the whole is capped at EMBEDDING_TEXT_MAX_WORDS words. Pure:
// no I/O. What changes this text changes the embedding (`embeddingStale`, ./tools.ts).

import { CATEGORY_SPECS } from "../catalog/parsers";
import type { Category } from "../schema";

/**
 * The template's name, stored beside the text an item was embedded from (`ext.embedding.template`),
 * so a later change of template makes every item embedded under the old one due again.
 */
export const EMBEDDING_TEMPLATE = "name-description-specs/1";

// DECISION: "a few hundred words" (the owner's cap) is 300 words. When a text is longer, the
// description is cut first, then the name; the specs (a few words) are kept whole.
export const EMBEDDING_TEXT_MAX_WORDS = 300;

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const UNIT =
  "(?:ea|each|sht|sheet|pc|pcs|piece|bf|lf|ft|box|bx|cs|case|bdl|bundle|gal|gallon|qt|pr|pair|roll|mbf|unit)";
const NUM = "\\d[\\d,]*(?:\\.\\d+)?";
/** After NUM: the whole figure, not the start of a fraction or a longer number (3/4, 5/8). */
const WHOLE = "(?![\\d,]|[./]\\d)";

// DECISION: what is stripped, in this order. Only figures with a money mark, a two-decimal price
// per unit, a date with matching separators, a labelled quantity, and order or shipping words:
// a bare fraction, a size (4X8), a thickness (.75, 18MM) or a thread (1/4-20) is never touched,
// because those are what the item is.
const STRIP: readonly RegExp[] = [
  // Prices: price: 68.50, EXT: $980.00, @ $68.50/SHT, $68.50, USD 68.50, 68.50 USD, 68.50/EA.
  // A labelled price (first, with its label) is a whole figure, never a fraction's numerator
  // ("TOTAL 5/8 EDGE"); the grade EXT ("CDX PLYWOOD EXT 3/4") is a price label only with a colon,
  // an equals sign or a money mark.
  new RegExp(
    `\\bext(?:ended)?\\.?(?:\\s+(?:price|amount|amt))?\\s*(?:[:=]\\s*\\$?|\\$)\\s*${NUM}${WHOLE}`,
    "gi",
  ),
  new RegExp(
    `\\b(?:unit\\s+)?(?:price|cost|amount|total)\\s*[:=]?\\s*\\$?\\s*${NUM}${WHOLE}`,
    "gi",
  ),
  new RegExp(`@\\s*\\$?\\s*${NUM}(?:\\s*\\/\\s*${UNIT}\\b)?`, "gi"),
  new RegExp(`\\$\\s*${NUM}(?:\\s*\\/\\s*${UNIT}\\b)?`, "gi"),
  new RegExp(`\\b(?:usd|cad|eur|gbp)\\s*${NUM}`, "gi"),
  new RegExp(`\\b${NUM}\\s*(?:usd|cad|eur|gbp|dollars?)\\b`, "gi"),
  new RegExp(`\\b\\d[\\d,]*\\.\\d{2}\\s*\\/\\s*${UNIT}\\b`, "gi"),
  // Dates: 11/02/2026, 2026-11-02, 02.11.26, Nov 2, 2026.
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}([/.-])\d{1,2}\1\d{2,4}\b/g,
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4}\\b)?`, "gi"),
  // Quantities, labelled: QTY 40, Qty: 40, ordered 40, shipped 12, B/O 3.
  new RegExp(
    `(?:\\b(?:qty|quantity|ordered|shipped|back\\s*ordered|backordered)|\\bb\\/o)\\.?\\s*[:#]?\\s*${NUM}`,
    "gi",
  ),
  // Pack quantities, the vendor's (vendor_item.pack_size): BOX OF 50, PACK OF 2, 100/BOX, 50 PER CASE.
  /\b(?:box|bx|pack|pk|pkg|case|cs|bag|carton|ctn|bundle|bdl|bucket|pail)\s+of\s+\d+\b/gi,
  /\b\d+\s*(?:\/|per\s+)(?:box|bx|pack|pk|pkg|case|cs|bag|carton|ctn|bundle|bdl)\b/gi,
  // Order and shipping terms: PO# 1234, order no. 55, invoice # A-1, FOB origin, net 30, ship via
  // UPS, freight, delivery charge, prepaid, collect, will call, drop ship, due on receipt.
  /\b(?:p\.?o\.?|order|so|invoice|inv|job)\s*(?:no\.?|number|#)\s*:?\s*[\w-]+/gi,
  /\bpo\s*#?\s*\d[\w-]*/gi,
  /\bf\.?o\.?b\.?\s+(?:origin|destination|shipping point|\w+)/gi,
  /\bnet\s*\d+(?:\s*days)?\b/gi,
  /\bship(?:ped)?\s+via\s+\S+/gi,
  /\bdue\s+(?:on\s+)?(?:receipt|\d+\s+days)\b/gi,
  /\b(?:freight|shipping|delivery|handling|fuel surcharge)(?:\s+(?:charges?|included|incl\.?|extra|prepaid|collect))?\b/gi,
  /\b(?:prepaid|collect|will\s+call|drop\s+ship(?:ped)?|back\s*order(?:ed)?)\b/gi,
  /\bterms?\s*:\s*\S+/gi,
];

/** A name or description with prices, quantities, dates and order or shipping terms taken out. */
export function stripTerms(text: string): string {
  let out = text;
  for (const re of STRIP) out = out.replace(re, " ");
  return trimEdges(out.replace(/\(\s*\)|\[\s*\]/g, " ").replace(/\s+/g, " "));
}

const EDGE = new Set([" ", "\t", "\n", "\r", ",", ";", ":", "/", "|", "-"]);

/** Without separators left at either end, by index rather than a pattern (CodeQL: no slow match). */
function trimEdges(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && EDGE.has(text[start] ?? "")) start += 1;
  while (end > start && EDGE.has(text[end - 1] ?? "")) end -= 1;
  return text.slice(start, end).trim();
}

// DECISION: attributes that are packaging, not the thing: a pack size is the vendor's (vendor_item
// .pack_size), and a quantity, so it is never part of the specs. The measured thickness in mm is
// written beside the nominal one ("3/4in (19.1mm)"), as the owner's example reads.
const NOT_SPECS = new Set(["pack_size", "thickness_mm"]);

const words = (s: string) => s.replace(/_/g, " ").trim();

/** `category sheet goods; face baltic birch; material plywood; thickness 3/4in (19.1mm); …`. */
export function specsText(
  category: Category | string | null | undefined,
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): string {
  const parts: string[] = [];
  if (category) parts.push(`category ${words(category)}`);
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(attributes ?? {})) {
    if (typeof v === "string" && v.trim() && v !== "none") a[k] = v.trim();
    else if (typeof v === "number" && Number.isFinite(v)) a[k] = String(v);
  }
  // The category's key attributes in its own order, then the rest by name.
  const keys = (category && CATEGORY_SPECS[category as Category]?.keys) || [];
  const order = [
    ...keys.filter((k) => k in a),
    ...Object.keys(a)
      .filter((k) => !keys.includes(k))
      .sort(),
  ];
  for (const k of order) {
    if (NOT_SPECS.has(k)) continue;
    let value = words(a[k] ?? "").toLowerCase();
    if (k === "thickness" && a.thickness_mm) value += ` (${a.thickness_mm}mm)`;
    parts.push(`${words(k)} ${value}`);
  }
  if (!a.thickness && a.thickness_mm) parts.push(`thickness ${a.thickness_mm}mm`);
  return parts.join("; ");
}

export interface EmbeddingFields {
  name: string | null | undefined;
  description?: string | null | undefined;
  category?: Category | string | null | undefined;
  attributes?: Readonly<Record<string, unknown>> | null | undefined;
}

const countWords = (s: string) => (s ? s.split(" ").length : 0);
const firstWords = (s: string, n: number) => (n <= 0 ? "" : s.split(" ").slice(0, n).join(" "));

/** The one template: `Name:`, `Description:`, `Specs:` lines, empty ones left out, capped. */
export function embeddingText(f: EmbeddingFields): string {
  let name = stripTerms(f.name ?? "");
  let description = stripTerms(f.description ?? "");
  // A description that only repeats the name adds nothing.
  if (description.toLowerCase() === name.toLowerCase()) description = "";
  const specs = specsText(f.category, f.attributes);
  // The labels count as words too: Name's, Description's when there is one, and Specs'.
  const labels = 1 + (description ? 1 : 0) + (specs ? 1 : 0);
  const room = EMBEDDING_TEXT_MAX_WORDS - labels - countWords(specs);
  if (countWords(name) + countWords(description) > room) {
    description = firstWords(description, room - countWords(name));
    if (countWords(name) > room) name = firstWords(name, room);
  }
  return [
    name ? `Name: ${name}` : "",
    description ? `Description: ${description}` : "",
    specs ? `Specs: ${specs}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
