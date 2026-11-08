/**
 * A client's claims list and the lint that reads it (docs/marketing-plan.md §4.5). The list is the
 * client's (claims_version, newest wins): what its public text may say, may say on a condition,
 * and may never say. For Mezonas it starts from `docs/marketing/claims.md`, loaded by the operator
 * as JSON (`fixtures/marketing/mezonas-claims.json`, the `seed-claims` action).
 *
 * The lint is the part of the list a machine can read:
 *
 * - **refuse**: a "Never" entry's phrases, plus two rules every client keeps (no exclamation
 *   marks, never "AI-powered": the house voice). Publishing is refused until the words change.
 * - **check**: an "Approved with a condition" entry's phrases. Publishing goes ahead, and the editor
 *   shows the condition beside the words, because only a person can tell whether it holds.
 *
 * What it cannot see, a person still reads for: whether a claim is true. It never rewrites
 * anything. Pure: text and the list in, findings out.
 */
// Ported from Plenary Labs' claims lint (apps/api/src/content/claims.ts), whose rules were written
// into the code for one product. Here each client has its own list, so the rules are data.
// DECISION: a list's machine-readable part is plain phrases, matched whole-word and case-blind
// with any run of spaces between words, never regular expressions: a list is entered by people in
// the back office, and a phrase can't be written to match everything or to hang the check.

import { z } from "zod";

export type ClaimSeverity = "refuse" | "check";

export interface ClaimFinding {
  /** The rule: `exclamation`, `ai_powered`, or the list entry's id. */
  readonly rule: string;
  readonly severity: ClaimSeverity;
  /** The words that matched, as written. */
  readonly match: string;
  /** What the list says, in a sentence a person acts on. */
  readonly message: string;
}

const Phrase = z.string().trim().min(2).max(120);
const EntryId = z
  .string()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "lowercase words joined by - or _")
  .max(60);

export const ApprovedClaim = z.strictObject({
  id: EntryId,
  /** The claim, as it may be said. */
  text: z.string().trim().min(1).max(500),
  /** Why it is true: where in the product or the code it comes from. */
  why: z.string().trim().max(500).optional(),
  note: z.string().trim().max(500).optional(),
});

export const ConditionalClaim = z.strictObject({
  id: EntryId,
  text: z.string().trim().min(1).max(500),
  /** What must hold before it is said; shown beside every match. */
  condition: z.string().trim().min(1).max(500),
  /** Words that bring the condition up when they appear. */
  phrases: z.array(Phrase).max(20).default([]),
});

export const NeverClaim = z.strictObject({
  id: EntryId,
  text: z.string().trim().min(1).max(500),
  why: z.string().trim().max(500).optional(),
  /** Words that refuse a publish when they appear. */
  phrases: z.array(Phrase).max(20).default([]),
});

/** A claims list, as `claims_version.body` keeps it. */
export const ClaimsList = z
  .strictObject({
    /** Whose list it is and how it reads, e.g. "What Mezonas may claim in public". */
    title: z.string().trim().min(1).max(200),
    /** "draft" until the client (for Mezonas, the owner) has read it. */
    status: z.enum(["draft", "approved"]).default("draft"),
    approved: z.array(ApprovedClaim).max(200).default([]),
    conditional: z.array(ConditionalClaim).max(200).default([]),
    never: z.array(NeverClaim).max(200).default([]),
  })
  .superRefine((list, ctx) => {
    const ids = [...list.approved, ...list.conditional, ...list.never].map((e) => e.id);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) ctx.addIssue({ code: "custom", message: `the id "${id}" is used twice` });
      seen.add(id);
    }
  });
export type ClaimsList = z.output<typeof ClaimsList>;

/** A client without a list yet: only the rules every client keeps. */
export const EMPTY_CLAIMS: ClaimsList = {
  title: "No claims list yet",
  status: "draft",
  approved: [],
  conditional: [],
  never: [],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A phrase as a whole-word, case-blind pattern, any run of spaces between its words. */
export function phrasePattern(phrase: string): RegExp {
  const words = phrase.trim().split(/\s+/).map(escapeRegExp).join("[\\s-]+");
  // A word boundary only where the phrase starts or ends with a letter or digit.
  const start = /^[\p{L}\p{N}]/u.test(phrase.trim()) ? "(?<![\\p{L}\\p{N}])" : "";
  const end = /[\p{L}\p{N}]$/u.test(phrase.trim()) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${start}${words}${end}`, "giu");
}

/** The rules every client keeps, whatever its list says (CLAUDE.md, "UI and copy"). */
const HOUSE_RULES: readonly {
  rule: string;
  pattern: RegExp;
  message: string;
}[] = [
  {
    rule: "exclamation",
    pattern: /!+/g,
    message: "No exclamation marks: plain words carry it.",
  },
  {
    rule: "ai_powered",
    pattern: /(?<![\p{L}\p{N}])AI[\s-]*(?:powered|driven)(?![\p{L}\p{N}])/giu,
    message: 'Never "AI-powered": say what the work is and who checks it.',
  },
];

/** Every finding in a piece of public text, house rules first, then the list's entries. */
export function lintClaims(text: string, list: ClaimsList = EMPTY_CLAIMS): ClaimFinding[] {
  const findings: ClaimFinding[] = [];
  const seen = new Set<string>();
  const add = (f: ClaimFinding) => {
    const key = `${f.rule}\u0000${f.match.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };
  for (const rule of HOUSE_RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      add({ rule: rule.rule, severity: "refuse", match: m[0], message: rule.message });
    }
  }
  for (const entry of list.never) {
    for (const phrase of entry.phrases) {
      for (const m of text.matchAll(phrasePattern(phrase))) {
        add({
          rule: entry.id,
          severity: "refuse",
          match: m[0],
          message: `Never: ${entry.text}`,
        });
      }
    }
  }
  for (const entry of list.conditional) {
    for (const phrase of entry.phrases) {
      for (const m of text.matchAll(phrasePattern(phrase))) {
        // Words a "Never" entry already refused are not also a condition to check.
        if (findings.some((f) => f.severity === "refuse" && f.match.includes(m[0]))) continue;
        add({
          rule: entry.id,
          severity: "check",
          match: m[0],
          message: `Only if: ${entry.condition}`,
        });
      }
    }
  }
  return findings;
}
