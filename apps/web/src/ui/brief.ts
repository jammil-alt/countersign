// A long description as one plain line for a card or a row, with the full text a click away (a side
// sheet). Many descriptions are written for the model (field names in backticks, asides in
// brackets, rules after a colon); a person scanning a list needs only the headline. Pure.

/** Abbreviations whose full stop doesn't end a sentence. */
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs)\.(?=\s)/g;
const HOLD = "\u0000";

/**
 * The description's headline: its first sentence without asides in brackets, cut at a colon,
 * semicolon or dash when a headline comes before it, and at most `max` characters (cut at a word,
 * with "…"). Ends with a full stop, or "…" when cut. An empty description is "".
 */
export function brief(text: string | null | undefined, max = 120): string {
  let s = (text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  // Asides in brackets, inner ones first.
  let before: string;
  do {
    before = s;
    s = s.replace(/\s*\([^()]*\)/g, "");
  } while (s !== before);
  // The first sentence: a stop before a capital, a backtick or the end.
  s = s.replace(ABBREVIATIONS, (m) => m.replaceAll(".", HOLD));
  const first = s.match(/^.+?[.!?](?=\s+[A-Z`]|$)/);
  if (first) s = first[0];
  s = s
    .replace(/[.!?]$/, "")
    .replaceAll(HOLD, ".")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
  // The headline before a list or a rule, when there is a headline.
  for (const sep of [": ", "; ", " — ", " – "]) {
    const at = s.indexOf(sep);
    if (at >= 24) s = s.slice(0, at);
  }
  if (s.length <= max) return `${s}.`;
  const cut = s.slice(0, max);
  const clause = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf(" and "), cut.lastIndexOf(" or "));
  const word = cut.lastIndexOf(" ");
  const end = clause >= max / 3 ? clause : word > 0 ? word : max;
  return `${cut.slice(0, end).replace(/[\s,;:]+$/, "")}…`;
}

/**
 * Whether the full text says more than its short line (`brief`'s, or one written by hand): a
 * sheet then shows it "In full". A full stop either way doesn't count.
 */
export function saysMore(full: string | null | undefined, short?: string): boolean {
  const whole = (full ?? "").replace(/\s+/g, " ").trim();
  const line = short ?? brief(whole);
  return line.replace(/[.…]$/, "") !== whole.replace(/\.$/, "");
}
