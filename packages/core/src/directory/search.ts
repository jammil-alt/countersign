// Directory search, scored in code (docs/plan.md §1.27): the same ranking for agents'
// `directory.search` and the screens. Every word of the query must match some field (name, email,
// phone by digits, title, organization, roles, website); names count most. Pure, so it is unit
// tested; packages/db reads the client's rows with the filters and this ranks them.

/** Lower case, accents removed, so "José" finds "jose". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

export interface QueryParts {
  /** Folded words, at most 8. */
  words: string[];
  /** The query's digits when it reads as a phone (4 or more digits and nothing but phone signs). */
  phoneDigits: string | null;
}

export function parseQuery(query: string | undefined): QueryParts {
  const q = (query ?? "").trim();
  const phoneLike = /^[\d\s()+.-]+$/.test(q) && digitsOf(q).length >= 4;
  return {
    words: fold(q)
      .split(/[\s,;]+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}@+]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter((w) => w.length > 0)
      .slice(0, 8),
    phoneDigits: phoneLike ? digitsOf(q) : null,
  };
}

/** What search looks at in an entry. */
export interface SearchableEntry {
  name: string;
  email?: string | null | undefined;
  phones?: readonly (string | null | undefined)[] | undefined;
  title?: string | null | undefined;
  organization?: string | null | undefined;
  roles?: readonly string[] | undefined;
  website?: string | null | undefined;
}

/**
 * How well an entry matches, 0 for no match. An empty query matches everything with score 1, so
 * filters alone list entries by name.
 */
export function scoreEntry(entry: SearchableEntry, query: QueryParts): number {
  if (query.words.length === 0 && query.phoneDigits === null) return 1;
  const phones = (entry.phones ?? []).filter((p): p is string => Boolean(p)).map(digitsOf);
  if (query.phoneDigits !== null) {
    return phones.some((p) => p.includes(query.phoneDigits as string)) ? 10 : 0;
  }
  const name = fold(entry.name);
  const nameWords = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const others = [
    entry.email ? fold(entry.email) : "",
    entry.title ? fold(entry.title) : "",
    entry.organization ? fold(entry.organization) : "",
    entry.website ? fold(entry.website) : "",
    ...(entry.roles ?? []).map(fold),
  ].filter(Boolean);
  let score = 0;
  for (const w of query.words) {
    let best = 0;
    if (nameWords.includes(w)) best = 3;
    else if (nameWords.some((n) => n.startsWith(w))) best = 2;
    else if (name.includes(w)) best = 1.5;
    if (best < 1 && others.some((o) => o.includes(w))) best = 1;
    if (best < 1 && /^\d{4,}$/.test(w) && phones.some((p) => p.includes(w))) best = 1;
    if (best === 0) return 0;
    score += best;
  }
  if (name === query.words.join(" ")) score += 5;
  return score;
}

/** Entries that match, best first, then by name; at most `limit`. */
export function rankEntries<T extends SearchableEntry>(
  entries: readonly T[],
  query: string | undefined,
  limit: number,
): { entry: T; score: number }[] {
  const parts = parseQuery(query);
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, parts) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit);
}
