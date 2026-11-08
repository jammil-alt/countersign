// §1.77: the weekly report may not invent a number (docs/marketing-plan.md §4.6, "Guardrails in
// code"). Ported from Plenary Labs (apps/api/src/marketing/figures-check.ts), copied, not shared.
//
// The report agent reads its figures already written out (`written`, ./figures.ts: "412",
// "3.1%", "+30.6%") and is told to copy any it uses. This check holds it to that: every number in
// the report must appear, as written, somewhere in the figures `marketing.report.record` reads
// again for the same site and days. A report that fails is not recorded; the tool says which
// numbers had no source, and the agent may correct the report and try again.
//
// Dates are not figures: "21 Oct", "2026-10-21" and "October 21" are taken out before numbers are
// read, so a date written in the agent's own words is never a false alarm. So are ordinals used as
// words ("1st") and the digits in a page address ("/guides/2026-plan") or a link. Pure.

const MONTHS =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

const DATES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b\\d{1,2}(?:\\s*[–-]\\s*\\d{1,2})?\\s+(?:${MONTHS})\\b(?:\\s+\\d{4})?`, "gi"),
  new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:\\s*[–-]\\s*\\d{1,2})?(?:,?\\s+\\d{4})?\\b`, "gi"),
  /\b\d{1,2}(?:st|nd|rd|th)\b/gi,
];

/** Addresses and links: their digits are part of a name, not a figure. */
const PATHS = /(?:https?:\/\/\S+|(?<![\w.])\/[\w\-./?=&%]*)/g;

/** A number as written: a sign, digits with thousands commas, a decimal part, a unit. */
const NUMBER = /[+−-]?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|pts|k\b|m\b|s\b))?/g;

/** One number in a canonical spelling: no thousands commas, a plain minus, no space before a unit. */
const canonical = (token: string) => token.replace(/,/g, "").replace("−", "-").replace(/\s+/g, "");

/** The numbers in a text, dates, ordinals and addresses left out. */
export function numbersIn(text: string): string[] {
  let stripped = text.replace(PATHS, " ");
  for (const date of DATES) stripped = stripped.replace(date, " ");
  return (stripped.match(NUMBER) ?? []).map((token) => canonical(token.trim()));
}

/**
 * The numbers in `report` that appear nowhere in `given`. A number matches with or without its
 * sign, so "fell by 12.0%" can quote a given "−12.0%".
 */
export function inventedFigures(report: string, given: string): string[] {
  const known = new Set<string>();
  for (const token of numbersIn(given)) {
    known.add(token);
    known.add(token.replace(/^[+-]/, ""));
  }
  const invented: string[] = [];
  for (const token of numbersIn(report)) {
    const bare = token.replace(/^[+-]/, "");
    if (!known.has(token) && !known.has(bare) && !invented.includes(token)) invented.push(token);
  }
  return invented;
}

// ── How figures are written ─────────────────────────────────────────────────────────────────────

/** A count as the report writes it: "1,204". */
export const countText = (n: number) => Math.round(n).toLocaleString("en-US");

/** A rate (a string to 4 places, or null) as a percentage to one place: "3.1%". */
export function rateText(rate: string | number | null | undefined): string {
  if (rate === null || rate === undefined) return "none";
  const n = typeof rate === "number" ? rate : Number(rate);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "none";
}

/** A change from `before` to `now` as a percentage to one place: "+30.6%", "−12.0%", or "new". */
export function changeText(now: number, before: number): string {
  if (before === 0) return now === 0 ? "no change" : "new";
  const pct = (now / before - 1) * 100;
  const fixed = Math.abs(pct).toFixed(1);
  if (fixed === "0.0") return "no change";
  return `${pct >= 0 ? "+" : "−"}${fixed}%`;
}

/** An average position to one place: "12.3"; "none" without one. */
export const positionText = (p: number | null | undefined) =>
  p === null || p === undefined ? "none" : p.toFixed(1);

/** An engaged-time band in words: "30s to 60s", "over 240s". */
export function bandText(
  band: { fromSeconds: number; toSeconds: number | null } | null | undefined,
): string {
  if (!band) return "none";
  return band.toSeconds === null
    ? `over ${band.fromSeconds}s`
    : `${band.fromSeconds}s to ${band.toSeconds}s`;
}
