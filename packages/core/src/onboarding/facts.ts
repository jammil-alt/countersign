// The client file (docs/cases-plan.md §4.1; docs/plan.md §1.126): what we know about a prospect or
// a client, from the first conversation on. A file is the company a deal points at before set-up;
// its facts are insert only, and a correction is a new fact that replaces an earlier one. Operator
// only: no portal route returns a file or a fact (invariant 11). Only `theirs` facts are ever
// copied into a client's intake; `ours` never leave the back office.

import { z } from "zod";
import { isUuid } from "../ids";

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const CLIENT_FILE_STATUSES = ["prospect", "client", "lost"] as const;
export const ClientFileStatus = z.enum(CLIENT_FILE_STATUSES);
export type ClientFileStatus = z.infer<typeof ClientFileStatus>;

/** The file's sections, in the order the file tab shows them. */
export const FACT_SECTIONS = [
  "business",
  "people",
  "systems",
  "volumes",
  "processes",
  "pains",
  "limits",
  "notes",
] as const;
export const FactSection = z.enum(FACT_SECTIONS);
export type FactSection = z.infer<typeof FactSection>;

export const FACT_SECTION_WORDS: Record<FactSection, string> = {
  business: "The business",
  people: "People",
  systems: "Systems",
  volumes: "Volumes",
  processes: "Processes",
  pains: "Pains and wants",
  limits: "Limits",
  notes: "Our notes",
};

/** Where a fact came from. Its `sources` name the record ids behind it (invariant 10). */
export const FACT_SOURCE_KINDS = [
  "call",
  "note",
  "email",
  "document",
  "website",
  "intake",
  "tool",
  "run",
  "other",
] as const;
export const FactSourceKind = z.enum(FACT_SOURCE_KINDS);
export type FactSourceKind = z.infer<typeof FactSourceKind>;

/** How sure we are: heard (someone said it), seen (in a document or tool), confirmed by the client. */
export const FACT_SURENESS = ["heard", "seen", "confirmed"] as const;
export const FactSureness = z.enum(FACT_SURENESS);
export type FactSureness = z.infer<typeof FactSureness>;

/**
 * Who may see a fact: `theirs` is about their business (shown to the client to confirm in the
 * intake, then in their knowledge base); `ours` is our notes, operator only, always.
 */
export const FACT_AUDIENCES = ["theirs", "ours"] as const;
export const FactAudience = z.enum(FACT_AUDIENCES);
export type FactAudience = z.infer<typeof FactAudience>;

/** Who wrote it: an operator, Reggie (a card the operator ticked), the client (the intake), the system. */
export const FACT_ACTORS = ["operator", "reggie", "client", "system"] as const;
export const FactActor = z.enum(FACT_ACTORS);
export type FactActor = z.infer<typeof FactActor>;

export const FACT_TEXT_MAX = 2000;
/** At most this many record ids behind one fact. */
export const FACT_SOURCES_MAX = 20;

export const ClientFactView = z.object({
  id: z.string(),
  fileId: z.string(),
  section: FactSection,
  text: z.string(),
  sourceKind: FactSourceKind,
  sources: z.array(z.string()),
  sureness: FactSureness,
  audience: FactAudience,
  /** The fact this one corrects; the earlier one is no longer current. */
  replacesId: z.string().nullable(),
  /** A later fact corrected this one (history only). */
  replacedById: z.string().nullable(),
  actor: FactActor,
  /** Who added it, by name (the operator who typed or ticked it); null for the system. */
  by: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
});
export type ClientFactView = z.infer<typeof ClientFactView>;

/**
 * A new fact as the back office sends it. The actor and who added it are the session's, never the
 * body's. New facts start `ours` unless the operator marks them as plainly about the business.
 */
// DECISION (cases-plan §8 q13, the design): `ours` is the default audience; anything an agent
// should know becomes a `theirs` fact the client confirms, or a rule on the agent.
export const NewClientFact = z.strictObject({
  section: FactSection,
  text: z.string().trim().min(1).max(FACT_TEXT_MAX),
  sourceKind: FactSourceKind,
  sources: z.array(Id).max(FACT_SOURCES_MAX).default([]),
  sureness: FactSureness.default("heard"),
  audience: FactAudience.default("ours"),
  /** A correction: the fact it replaces, in the same file. */
  replacesId: Id.optional(),
});
export type NewClientFact = z.infer<typeof NewClientFact>;
export type NewClientFactInput = z.input<typeof NewClientFact>;

/**
 * The facts still current: those no later fact replaces. Pure; the order kept is the input's.
 * A replacement in another file is ignored (the API refuses one; this only reads).
 */
export function currentFacts<
  T extends { id: string; fileId: string; replacesId: string | null | undefined },
>(facts: readonly T[]): T[] {
  const replaced = new Set<string>();
  const fileOf = new Map(facts.map((f) => [f.id, f.fileId]));
  for (const f of facts) {
    if (f.replacesId && fileOf.get(f.replacesId) === f.fileId) replaced.add(f.replacesId);
  }
  return facts.filter((f) => !replaced.has(f.id));
}

/** The facts a client may see (to confirm in the intake): current and `theirs` only. */
export function theirFacts<
  T extends {
    id: string;
    fileId: string;
    replacesId: string | null | undefined;
    audience: FactAudience;
  },
>(facts: readonly T[]): T[] {
  return currentFacts(facts).filter((f) => f.audience === "theirs");
}
