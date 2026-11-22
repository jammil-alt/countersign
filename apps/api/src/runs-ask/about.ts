// R2: a plain-words question's `aboutText` ("Acme") as records (docs/plan.md §1.193). The model
// only says what the runs were about, in the question's words; it is never handed the client's
// vendors, customers or documents. Code looks the words up with ⌘K's own queries
// (../search/queries.ts), in the request's scope (the portal's one client, or the clients asked
// about, invariant 1), and keeps the records some run (that this surface reads) was about. The
// answer shows each as a chip the person can take out.

import {
  aboutWords,
  type RunAbout,
  type RunSubjectKind,
  readSearchText,
  recordHitSubjectKind,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import { runsAboutCounts } from "../runs/about";
import {
  type SearchScope,
  searchDocuments,
  searchOrganizations,
  searchRecords,
} from "../search/queries";

/** The most records a question's words become. */
export const ASK_ABOUT_RECORDS = 5;

export interface ResolvedAbout {
  /** The filter's `about`: the records found, else the words themselves; empty for no words. */
  about: RunAbout[];
  /** Each record's name, for its chip. */
  names: Map<string, string>;
}

const dot = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

/** An organization's kind as runs keep it: a customer, else a vendor, else an organization. */
function organizationKind(kinds: readonly string[]): RunSubjectKind {
  if (kinds.includes("customer")) return "customer";
  if (kinds.includes("vendor")) return "vendor";
  return "organization";
}

/**
 * The records the words name that runs were about: transactions, receivables and vendors,
 * organizations and documents, as ⌘K finds them, kept only when a run this surface reads was
 * about one, the most runs first, at most five.
 */
// DECISION: a record no run was about is left out (it would make a chip that finds nothing), and
// when no record is left the words themselves are the filter, matched against what runs kept
// ("Acme" in a label or number). Either way the person sees the chips and can take one out.
export async function resolveAboutText(
  tx: Tx,
  scope: SearchScope,
  text: string,
): Promise<ResolvedAbout> {
  const words = aboutWords(text);
  if (words.length < 2) return { about: [], names: new Map() };
  const q = readSearchText(words);
  const [records, organizations, documents] = await Promise.all([
    searchRecords(tx, scope, q),
    searchOrganizations(tx, scope, q),
    searchDocuments(tx, scope, q),
  ]);
  const found: { kind: RunSubjectKind; id: string; name: string }[] = [
    ...records.map((r) => ({ kind: recordHitSubjectKind(r.kind), id: r.id, name: r.label })),
    ...organizations.map((o) => ({ kind: organizationKind(o.kinds), id: o.id, name: o.name })),
    ...documents.map((d) => ({
      kind: "document" as const,
      id: d.id,
      name: dot(d.vendor, d.number) || d.filename,
    })),
  ];
  const counts = await runsAboutCounts(
    tx,
    scope.tenantIds,
    found.map((f) => f.id),
    scope.surface,
  );
  const kept = found
    .map((f, i) => ({ ...f, i, runs: counts.get(f.id) ?? 0 }))
    .filter((f) => f.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.i - b.i)
    .filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i)
    .slice(0, ASK_ABOUT_RECORDS);
  if (kept.length === 0) return { about: [{ text: words }], names: new Map() };
  return {
    about: kept.map((f) => ({ kind: f.kind, id: f.id })),
    names: new Map(kept.map((f) => [f.id, f.name])),
  };
}
