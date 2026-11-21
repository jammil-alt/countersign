// How alike two normalised names are, from 0 to 1 (docs/plan.md §1.164 "The match"). Trigrams as
// pg_trgm counts them, so the scores read like the candidate search's, plus what trigrams miss:
// word order ("doe jane"), a nickname ("Bob" is "Robert"), an initial ("J. Doe"), a middle name.
// Pure: no I/O.

/** pg_trgm's trigrams of a text: each word padded with two spaces before and one after. */
export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm's `similarity`: shared trigrams over all of both. */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** Common English nicknames → the name they are short for (both read as the latter). */
// DECISION: a short list of the usual ones; a nickname not here still reads close by trigrams,
// and the model or a person decides the rest.
const NICKNAMES: Readonly<Record<string, string>> = {
  bob: "robert",
  bobby: "robert",
  rob: "robert",
  robbie: "robert",
  bill: "william",
  billy: "william",
  will: "william",
  liz: "elizabeth",
  beth: "elizabeth",
  betsy: "elizabeth",
  lizzie: "elizabeth",
  jim: "james",
  jimmy: "james",
  jamie: "james",
  mike: "michael",
  mikey: "michael",
  dave: "david",
  tom: "thomas",
  tommy: "thomas",
  dan: "daniel",
  danny: "daniel",
  chris: "christopher",
  kate: "katherine",
  katie: "katherine",
  kathy: "katherine",
  cathy: "catherine",
  jen: "jennifer",
  jenny: "jennifer",
  joe: "joseph",
  joey: "joseph",
  steve: "steven",
  stephen: "steven",
  tony: "anthony",
  rick: "richard",
  rich: "richard",
  dick: "richard",
  matt: "matthew",
  pat: "patricia",
  patty: "patricia",
  sue: "susan",
  suzy: "susan",
  alex: "alexander",
  andy: "andrew",
  drew: "andrew",
  ed: "edward",
  eddie: "edward",
  ted: "edward",
  greg: "gregory",
  jeff: "jeffrey",
  geoff: "jeffrey",
  geoffrey: "jeffrey",
  jon: "jonathan",
  johnny: "john",
  jack: "john",
  ken: "kenneth",
  larry: "lawrence",
  nick: "nicholas",
  pete: "peter",
  sam: "samuel",
  sandy: "sandra",
  ron: "ronald",
  tim: "timothy",
  vicky: "victoria",
  vic: "victor",
  meg: "margaret",
  maggie: "margaret",
  peggy: "margaret",
  abby: "abigail",
  becky: "rebecca",
  ben: "benjamin",
  charlie: "charles",
  chuck: "charles",
  frank: "francis",
  fred: "frederick",
  hank: "henry",
  harry: "henry",
  josh: "joshua",
  nate: "nathan",
  zach: "zachary",
  deb: "deborah",
  debbie: "deborah",
  mandy: "amanda",
  manny: "manuel",
  cindy: "cynthia",
  terry: "terrence",
};

/** A first name as the name it is short for. */
export function canonicalFirst(name: string): string {
  return NICKNAMES[name] ?? name;
}

/**
 * Two people's normalised names: 1 for the same words (in any order, a nickname or an initial for
 * the first name), less for a missing middle name, else their trigram similarity.
 */
export function personSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = a.split(" ").filter(Boolean);
  const y = b.split(" ").filter(Boolean);
  if (x.length === 0 || y.length === 0) return 0;
  const sorted = (t: string[]) => [...t].map(canonicalFirst).sort().join(" ");
  if (sorted(x) === sorted(y)) return 1;
  const trigram = trigramSimilarity(
    x.map(canonicalFirst).join(" "),
    y.map(canonicalFirst).join(" "),
  );
  // First and last names (the first and the last word) decide; a middle name or initial may be
  // missing on one side.
  const [xf, xl] = [canonicalFirst(x[0] ?? ""), x[x.length - 1] ?? ""];
  const [yf, yl] = [canonicalFirst(y[0] ?? ""), y[y.length - 1] ?? ""];
  if (x.length >= 2 && y.length >= 2 && xl === yl) {
    if (xf === yf) return Math.max(trigram, 0.92);
    // "J Doe" and "Jane Doe": an initial for the first name.
    if ((xf.length === 1 || yf.length === 1) && xf[0] === yf[0]) return Math.max(trigram, 0.85);
  }
  return trigram;
}

/**
 * Two companies' normalised names: 1 for the same words in any order; 0.8 when one is the other
 * with more words ("acme" and "acme industries" may be one company or two); else trigrams.
 */
export function companySimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = a.split(" ").filter(Boolean);
  const y = b.split(" ").filter(Boolean);
  if (x.length === 0 || y.length === 0) return 0;
  if ([...x].sort().join(" ") === [...y].sort().join(" ")) return 1;
  // Written with and without spaces ("blue line" and "blueline").
  if (x.join("") === y.join("")) return 0.95;
  const trigram = trigramSimilarity(a, b);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.every((w) => long.includes(w))) return Math.max(trigram, 0.8);
  return trigram;
}

/** Two deals' normalised names: their trigram similarity, 1 when the words are the same. */
export function dealSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = a.split(" ").filter(Boolean).sort().join(" ");
  const y = b.split(" ").filter(Boolean).sort().join(" ");
  if (x && x === y) return 1;
  return trigramSimilarity(a, b);
}
