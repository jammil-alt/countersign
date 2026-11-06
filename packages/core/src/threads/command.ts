// `/commands` in threads (ARCHITECTURE §11.2, §10.8; docs/plan.md §1.38): parsing a message that
// starts with `/<word>`, and an agent's command name. Pure, so the portal, the back office and the
// server read a message the same way.

/** A parsed `/word rest` message. `name` is lower case; `args` is the rest, trimmed. */
export interface ParsedCommand {
  name: string;
  args: string;
}

// DECISION: a command word is letters, digits, dashes, and the dots, colons and underscores of a
// skill id (`docs.extract`, `custom:intake`), ending at whitespace or the end of the message.
// `/path/to`, `/ hello` and `//x` are plain text, so a pasted path never becomes a command.
// Only the word is matched (bounded, anchored); the rest is sliced off and trimmed, so no regex
// runs over the message's length (no backtracking on long text).
const COMMAND = /^\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=\s|$)/;

/** `/remy hello` → `{name: "remy", args: "hello"}`; anything else → null. */
export function parseCommand(text: string): ParsedCommand | null {
  const start = text.trimStart();
  const m = COMMAND.exec(start);
  if (!m) return null;
  return { name: (m[1] as string).toLowerCase(), args: start.slice(m[0].length).trim() };
}

/** Longest name `commandWord` reads: a first name, never a long text. */
const COMMAND_WORD_INPUT_MAX = 256;

/**
 * A name lowered to a command word: accents dropped, anything but letters, digits and dashes
 * removed. "Rémy" → "remy"; "Ana-Lú" → "ana-lu". Empty when nothing is left.
 */
export function commandWord(name: string): string {
  const word = name
    .slice(0, COMMAND_WORD_INPUT_MAX)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  // Leading and trailing dashes trimmed by index: linear, with no `-+$` to backtrack on.
  let from = 0;
  let to = word.length;
  while (from < to && word[from] === "-") from++;
  while (to > from && word[to - 1] === "-") to--;
  return word.slice(from, to).slice(0, 64);
}

/** The first word of a name ("Pia Lopez" → "Pia"); the whole name when it has one word. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name.trim();
}

/** An agent a command name may point at: one of the client's active agents. */
export interface CommandCandidate {
  agentId: string;
  slug: string;
  /** The live version's identity name ("Remy"). */
  identityName: string;
}

/**
 * Each agent's command name (ARCHITECTURE §10.8): the first word of its identity name, lower case
 * (`/remy`), when no other candidate's first word is the same; else its slug (unique per client).
 * Computed on read from the client's active agents, so it needs no column.
 */
export function agentCommandNames(candidates: readonly CommandCandidate[]): Map<string, string> {
  const words = candidates.map((c) => commandWord(firstName(c.identityName)));
  const counts = new Map<string, number>();
  for (const w of words) if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
  const slugs = new Set(candidates.map((c) => c.slug));
  const names = new Map<string, string>();
  candidates.forEach((c, i) => {
    const w = words[i] as string;
    // A first word that is another agent's slug would make `/word` ambiguous too.
    const clash = !w || (counts.get(w) ?? 0) > 1 || (slugs.has(w) && w !== c.slug);
    names.set(c.agentId, clash ? c.slug : w);
  });
  return names;
}

/** The agent `/name` points at among the candidates, or null. */
export function resolveAgentCommand(
  name: string,
  candidates: readonly CommandCandidate[],
): CommandCandidate | null {
  const names = agentCommandNames(candidates);
  const wanted = name.toLowerCase();
  return candidates.find((c) => names.get(c.agentId) === wanted) ?? null;
}

/**
 * The skill `/word` names on an agent (the back office's `/skill args` on an agent thread): a
 * skill id (`materials.match-lines`) or its last part (`match-lines`), when only one matches.
 */
export function resolveSkillCommand(name: string, skillIds: readonly string[]): string | null {
  const wanted = name.toLowerCase();
  const exact = skillIds.find((s) => s.toLowerCase() === wanted);
  if (exact) return exact;
  const byLast = skillIds.filter((s) => s.toLowerCase().split(/[.:]/).pop() === wanted);
  return byLast.length === 1 ? (byLast[0] as string) : null;
}
