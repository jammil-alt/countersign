// Splitting text into searchable passages, and the text-search configuration for a client's
// language. Pure functions: no database.

/** About a paragraph or two: long enough to answer a question, short enough to quote. */
export const CHUNK_MAX_CHARS = 1200;

/**
 * Passages of at most `max` characters: paragraphs (blank-line separated) packed together, a long
 * paragraph split at sentence ends, and a long sentence at a word boundary.
 */
export function chunkText(text: string, max = CHUNK_MAX_CHARS): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const pieces = paragraphs.flatMap((p) => splitLong(p, max));
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) current = piece;
    else if (current.length + 2 + piece.length <= max) current = `${current}\n\n${piece}`;
    else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [paragraph];
  const out: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    for (const part of splitWords(sentence, max)) {
      if (!current) current = part;
      else if (current.length + 1 + part.length <= max) current = `${current} ${part}`;
      else {
        out.push(current);
        current = part;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

function splitWords(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const out: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    // A single "word" longer than a passage (a URL, a pasted blob) is cut where it falls.
    for (let i = 0; i < word.length; i += max) {
      const w = word.slice(i, i + max);
      if (!current) current = w;
      else if (current.length + 1 + w.length <= max) current = `${current} ${w}`;
      else {
        out.push(current);
        current = w;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/** Postgres text-search configurations for the portal's languages (docs/plan.md §1.18). */
const SEARCH_CONFIGS: Record<string, string> = {
  en: "english",
  es: "spanish",
  fr: "french",
  pt: "portuguese",
  it: "italian",
  de: "german",
};

/**
 * The text-search configuration for a client's language (`tenant.settings.language`, e.g. `es`
 * or `pt-BR`), so words match their other forms ("invoices" finds "invoice"). Unknown or unset:
 * English.
 */
export function searchConfigFor(language: unknown): string {
  if (typeof language !== "string") return "english";
  const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return SEARCH_CONFIGS[base] ?? "english";
}
