// v0.17 (ARCHITECTURE §10.15 "Names", docs/plan.md §1.96): owners' names. Short (3 or 4
// letters), from one pool, rotated so each client starts at its own place; a client's owners never
// share a first letter or start with S (Sloan). The client admin may rename an owner.

/**
 * The pool, in rotation order (owner, 2026-11-12). Left out on purpose: names of assistants and AI
 * products (Siri, Alexa, Ava, Aria, Nova, Pi, Echo, HAL), Sloan, and anything starting with S.
 */
export const OWNER_NAME_POOL = [
  "Pia",
  "Teo",
  "Nora",
  "Ivo",
  "Bea",
  "Milo",
  "Zia",
  "Lev",
  "Cleo",
  "Rio",
  "Uma",
  "Hugo",
  "Kit",
  "Faye",
  "Ren",
  "Dara",
  "Jun",
  "Wren",
  "Eli",
  "Tova",
  "Ari",
  "Noor",
  "Gus",
  "Yara",
  "Mae",
  "Arlo",
  "Fen",
  "Ines",
  "Kira",
  "Bram",
  "Ora",
  "Luca",
  "Wyn",
  "Rhea",
  "Enzo",
  "Jude",
  "Gita",
  "Theo",
  "Nia",
  "Vida",
] as const;

/** Sloan is the client's chat; no owner may take the name. */
export const RESERVED_OWNER_NAMES = ["sloan"] as const;
export const OWNER_NAME_MIN = 2;
export const OWNER_NAME_MAX = 12;

/** FNV-1a over the client's id: a stable start in the pool, with no counter to keep. */
function startFor(tenantId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tenantId.length; i++) {
    h ^= tenantId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % OWNER_NAME_POOL.length;
}

const firstLetter = (name: string) => name.trim().charAt(0).toLocaleLowerCase("en");

/**
 * The name a client's next owner gets: from its own place in the pool, the next name whose first
 * letter none of its owners has (and never S). If every letter is taken, the next name not in use;
 * if every name is, the first one again (the operator renames it).
 */
// DECISION (O2): the start is a hash of the client's id, not a counter, so neighbouring clients get
// different names and nothing is stored (docs/plan.md §1.96).
export function nextOwnerName(tenantId: string, taken: readonly string[]): string {
  const start = startFor(tenantId);
  const used = new Set(taken.map((n) => n.trim().toLocaleLowerCase("en")));
  const letters = new Set(taken.map(firstLetter));
  const pool: readonly string[] = OWNER_NAME_POOL;
  const inOrder = pool.map((_, i) => pool[(start + i) % pool.length] ?? "");
  const free = inOrder.filter((n) => n !== "" && !used.has(n.toLocaleLowerCase("en")));
  return (
    free.find((n) => !letters.has(firstLetter(n)) && firstLetter(n) !== "s") ??
    free[0] ??
    OWNER_NAME_POOL[start] ??
    "Pia"
  );
}

export type OwnerNameProblem = "length" | "letters" | "reserved" | "taken";

/**
 * Why a name the client admin typed can't be an owner's, or null: 2 to 12 letters (a hyphen or an
 * apostrophe inside is fine), not Sloan, and not another owner's of the same client.
 */
export function ownerNameProblem(name: string, others: readonly string[]): OwnerNameProblem | null {
  const n = name.trim();
  if (n.length < OWNER_NAME_MIN || n.length > OWNER_NAME_MAX) return "length";
  if (!/^\p{L}(?:[\p{L}'-]*\p{L})?$/u.test(n)) return "letters";
  const lower = n.toLocaleLowerCase("en");
  if ((RESERVED_OWNER_NAMES as readonly string[]).includes(lower)) return "reserved";
  if (others.some((o) => o.trim().toLocaleLowerCase("en") === lower)) return "taken";
  return null;
}
