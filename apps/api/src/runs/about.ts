// R2: runs found by what they were about (docs/reporting-plan.md §3 R2, docs/plan.md §1.193),
// from what each run kept (`run_subject`, §1.188). RunFilter's `about` and `text` as conditions
// on `run`, the names of the records a filter names, and how many runs are about a record. The
// portal reads only the rows its timeline shows (`client_visible`, the owner's answer 1). Every
// query names the run's own client as well as its id, or the clients asked about (invariant 1);
// labels and numbers are data, matched with parameters, never instructions (invariant 9).

import { likeContaining, type RunAbout, type RunAboutName } from "@countersign/core";
import { run, runSubject, type Tx } from "@countersign/db";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";

/** Who reads what runs kept: the back office every row, the portal the rows its timeline shows. */
export type SubjectSurface = "ops" | "portal";

/** A label or number containing the words (`%`, `_` and `\` taken literally). */
function wordsMatch(text: string): SQL {
  const p = likeContaining(text);
  return sql`(${runSubject.label} ilike ${p} or ${runSubject.number} ilike ${p})`;
}

/** The run kept a row matching `match` that this surface reads. */
function keptBy(match: SQL, surface: SubjectSurface): SQL {
  const visible = surface === "portal" ? sql` and ${runSubject.clientVisible}` : sql``;
  return sql`exists (select 1 from ${runSubject}
    where ${runSubject.runId} = ${run.id} and ${runSubject.tenantId} = ${run.tenantId}${visible}
      and ${match})`;
}

/**
 * `about`: runs about any of the entries, a record by its id, words in a label or number.
 */
// DECISION: the entries are any-of, as every other list in RunFilter is ("Acme" found as two
// vendors is runs about either), and a record matches by its id alone: our ids are unique, and a
// tool may keep an organization as the vendor it is, so the kind names it for people only.
export function aboutWhere(about: readonly RunAbout[], surface: SubjectSurface): SQL {
  const ids = about.flatMap((e) => ("kind" in e ? [e.id] : []));
  const words = about.flatMap((e) => ("text" in e ? [e.text] : []));
  const match = or(
    ...(ids.length ? [inArray(runSubject.recordId, ids)] : []),
    ...words.map(wordsMatch),
  );
  return match ? keptBy(sql`(${match})`, surface) : sql`false`;
}

/** `text` over what a run was about: a kept label or number containing it. */
export function subjectTextWhere(text: string, surface: SubjectSurface): SQL {
  return keptBy(wordsMatch(text), surface);
}

/**
 * The records an `about` filter names, by what runs of these clients kept about them: the latest
 * row's label and number (the portal's, from its rows only). A record no run kept a row for is
 * still named, by its kind alone.
 */
export async function aboutNames(
  tx: Tx,
  tenantIds: readonly string[],
  about: readonly RunAbout[] | undefined,
  surface: SubjectSurface,
): Promise<RunAboutName[] | undefined> {
  const records = (about ?? []).flatMap((e) => ("kind" in e ? [e] : []));
  if (records.length === 0 || tenantIds.length === 0) return undefined;
  const rows = await tx
    .selectDistinctOn([runSubject.recordId], {
      recordId: runSubject.recordId,
      label: runSubject.label,
      number: runSubject.number,
    })
    .from(runSubject)
    .where(
      and(
        inArray(runSubject.tenantId, [...tenantIds]),
        inArray(
          runSubject.recordId,
          records.map((r) => r.id),
        ),
        ...(surface === "portal" ? [eq(runSubject.clientVisible, true)] : []),
      ),
    )
    // The latest row that names it, with a label before one without.
    .orderBy(
      runSubject.recordId,
      sql`${runSubject.label} is null`,
      desc(runSubject.createdAt),
      desc(runSubject.id),
    );
  const byId = new Map(rows.map((r) => [r.recordId, r]));
  return records.map((r) => ({
    kind: r.kind,
    id: r.id,
    label: byId.get(r.id)?.label ?? null,
    number: byId.get(r.id)?.number ?? null,
  }));
}

/**
 * How many runs of these clients were about each record (⌘K): the back office every run, the
 * portal its live runs by the rows its timeline shows, and of the agents a limited person sees.
 */
export async function runsAboutCounts(
  tx: Tx,
  tenantIds: readonly string[],
  recordIds: readonly string[],
  surface: SubjectSurface,
  agentScope?: SQL,
): Promise<Map<string, number>> {
  const ids = [...new Set(recordIds)];
  if (ids.length === 0 || tenantIds.length === 0) return new Map();
  const rows = await tx
    .select({
      recordId: runSubject.recordId,
      runs: sql<number>`count(distinct ${runSubject.runId})::int`,
    })
    .from(runSubject)
    .innerJoin(run, and(eq(run.id, runSubject.runId), eq(run.tenantId, runSubject.tenantId)))
    .where(
      and(
        inArray(runSubject.tenantId, [...tenantIds]),
        inArray(runSubject.recordId, ids),
        ...(surface === "portal" ? [eq(runSubject.clientVisible, true), eq(run.mode, "live")] : []),
        ...(agentScope ? [agentScope] : []),
      ),
    )
    .groupBy(runSubject.recordId);
  return new Map(rows.flatMap((r) => (r.recordId ? [[r.recordId, r.runs] as const] : [])));
}
