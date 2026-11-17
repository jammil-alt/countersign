// The client file (docs/cases-plan.md §4.1; docs/plan.md §1.149): reading and writing files and
// their facts in an operator's transaction. Both tables are operator-only (migration 0066): row-level
// security keeps a file that names a client to operators serving it, and a fact to its file; every
// query here says the same (invariant 1). Facts are only added: a correction is a new fact naming
// the one it replaces, at most once. Nothing here ever reaches a client's session (invariant 11).

import {
  type ClientFactView,
  type ClientFileDetail,
  type ClientFileSummary,
  currentFacts,
  type NewClientFact,
  theirFacts,
} from "@countersign/core";
import { appUser, clientFact, clientFile, deal, intake, type Tx, tenant } from "@countersign/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { HttpError, iso, notFound } from "../http";
import { inSalesScope } from "../work/deals";

export type FileRow = typeof clientFile.$inferSelect;
export type FactRow = typeof clientFact.$inferSelect;

/** Files about no client (prospects), or about clients this session serves. */
export function filesInScope(tenantIds: readonly string[]) {
  return tenantIds.length > 0
    ? or(isNull(clientFile.clientId), inArray(clientFile.clientId, [...tenantIds]))
    : isNull(clientFile.clientId);
}

export async function readFile(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
  lock = false,
): Promise<FileRow> {
  const q = tx
    .select()
    .from(clientFile)
    .where(and(eq(clientFile.id, id), filesInScope(tenantIds)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("client file");
  return row;
}

/** A client's file, if it has one (one per client). */
export async function fileOfClient(tx: Tx, clientId: string): Promise<FileRow | null> {
  const [row] = await tx.select().from(clientFile).where(eq(clientFile.clientId, clientId));
  return row ?? null;
}

const sameName = (column: typeof clientFile.name | typeof deal.company, name: string) =>
  sql`lower(btrim(${column})) = lower(btrim(${name}))`;

/**
 * A prospect's file with this company name, newest first: what a deal or a new client for the
 * company reuses, so a lost deal's file serves the next one.
 */
// DECISION: a company is matched by its name, case and spaces aside, among files with no client
// yet; the operator can always name the file instead.
export async function prospectFileNamed(tx: Tx, name: string): Promise<FileRow | null> {
  const [row] = await tx
    .select()
    .from(clientFile)
    .where(and(isNull(clientFile.clientId), sameName(clientFile.name, name)))
    .orderBy(desc(clientFile.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * A client this session serves with this name (case and spaces aside), not retired: Invite and
 * Sign up now with a typed company stop there rather than make a second one (a retried sign-up
 * whose account was made but whose invite failed lands here too).
 */
export async function servedClientNamed(
  tx: Tx,
  tenantIds: readonly string[],
  name: string,
): Promise<{ id: string; name: string } | null> {
  if (tenantIds.length === 0) return null;
  const [row] = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(
      and(
        inArray(tenant.id, [...tenantIds]),
        isNull(tenant.retiredAt),
        sql`lower(btrim(${tenant.name})) = lower(btrim(${name}))`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The company's open New account deal with no client yet, by its file or (unless told not) by name. */
export async function openNewDealFor(
  tx: Tx,
  tenantIds: readonly string[],
  company: { name: string; fileId?: string | null },
  matchName = true,
): Promise<typeof deal.$inferSelect | null> {
  if (!matchName && !company.fileId) return null;
  const byName = sameName(deal.company, company.name);
  const [row] = await tx
    .select()
    .from(deal)
    .where(
      and(
        inSalesScope(tenantIds),
        eq(deal.kind, "new"),
        eq(deal.outcome, "open"),
        isNull(deal.clientId),
        company.fileId
          ? matchName
            ? or(eq(deal.clientFileId, company.fileId), byName)
            : eq(deal.clientFileId, company.fileId)
          : byName,
      ),
    )
    .orderBy(desc(deal.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function newFile(
  tx: Tx,
  input: { name: string; website?: string | null; clientId?: string | null; userId: string },
): Promise<FileRow> {
  const [row] = await tx
    .insert(clientFile)
    .values({
      name: input.name.trim().slice(0, 200),
      website: input.website ?? null,
      clientId: input.clientId ?? null,
      status: input.clientId ? "client" : "prospect",
      createdBy: input.userId,
    })
    .returning();
  if (!row) throw new Error("client file insert returned nothing");
  return row;
}

/** Links a file to the client it became: once, and a client has one file. */
export async function linkFileToClient(tx: Tx, file: FileRow, clientId: string): Promise<FileRow> {
  if (file.clientId === clientId) {
    if (file.status === "client") return file;
  } else {
    if (file.clientId) {
      throw new HttpError(409, "file_has_client", "this file is already another client's");
    }
    const other = await fileOfClient(tx, clientId);
    if (other) throw new HttpError(409, "client_has_file", "that client already has a file");
  }
  const [row] = await tx
    .update(clientFile)
    .set({ clientId, status: "client" })
    .where(eq(clientFile.id, file.id))
    .returning();
  if (!row) throw new Error("client file update returned nothing");
  return row;
}

/** The client's file, made from its name when it has none (a client made before files existed). */
export async function ensureClientFile(
  tx: Tx,
  clientId: string,
  name: string,
  userId: string,
): Promise<FileRow> {
  return (await fileOfClient(tx, clientId)) ?? newFile(tx, { name, clientId, userId });
}

/** Points a deal at a file. A deal for a client takes only that client's file. */
export async function pointDealAt(
  tx: Tx,
  row: typeof deal.$inferSelect,
  file: FileRow,
): Promise<void> {
  if (row.clientFileId === file.id) return;
  if (row.clientId && file.clientId && row.clientId !== file.clientId) {
    throw new HttpError(422, "other_client", "that deal is another client's");
  }
  await tx.update(deal).set({ clientFileId: file.id }).where(eq(deal.id, row.id));
}

// ── Facts ───────────────────────────────────────────────────────────────────────────────────────

/** A file's facts, oldest first (the order corrections are read in). */
async function factsOf(tx: Tx, fileId: string): Promise<FactRow[]> {
  return tx
    .select()
    .from(clientFact)
    .where(eq(clientFact.fileId, fileId))
    .orderBy(asc(clientFact.createdAt), asc(clientFact.id));
}

/** The file's current `theirs` facts: all a client may ever be shown, to confirm in the intake. */
export async function theirFactsOf(tx: Tx, fileId: string): Promise<FactRow[]> {
  return theirFacts(await factsOf(tx, fileId));
}

async function userNames(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  for (const u of await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, wanted))) {
    out.set(u.id, u.name ?? u.email);
  }
  return out;
}

function factView(
  f: FactRow,
  replacedBy: Map<string, string>,
  names: Map<string, string>,
): ClientFactView {
  return {
    id: f.id,
    fileId: f.fileId,
    section: f.section,
    text: f.text,
    sourceKind: f.sourceKind,
    sources: f.sources,
    sureness: f.sureness,
    audience: f.audience,
    replacesId: f.replacesId,
    replacedById: replacedBy.get(f.id) ?? null,
    actor: f.actor,
    by: f.createdBy ? { id: f.createdBy, name: names.get(f.createdBy) ?? "Operator" } : null,
    createdAt: iso(f.createdAt) as string,
  };
}

/**
 * Adds facts to a file. A correction names a current fact of the same file; each fact is corrected
 * once (the database's unique index says so too). Who added it is the session's, never the body's.
 */
export async function addFacts(
  tx: Tx,
  file: FileRow,
  facts: readonly NewClientFact[],
  by: { actor: FactRow["actor"]; userId: string | null },
): Promise<FactRow[]> {
  const existing = await factsOf(tx, file.id);
  const current = new Set(currentFacts(existing).map((f) => f.id));
  const ids = new Set(existing.map((f) => f.id));
  const replacing = new Set<string>();
  for (const f of facts) {
    if (!f.replacesId) continue;
    if (!ids.has(f.replacesId)) throw notFound("fact");
    if (!current.has(f.replacesId) || replacing.has(f.replacesId)) {
      throw new HttpError(409, "already_corrected", "that fact has already been corrected");
    }
    replacing.add(f.replacesId);
  }
  const made: FactRow[] = [];
  for (const f of facts) {
    const [row] = await tx
      .insert(clientFact)
      .values({
        fileId: file.id,
        section: f.section,
        text: f.text,
        sourceKind: f.sourceKind,
        sources: f.sources,
        sureness: f.sureness,
        audience: f.audience,
        replacesId: f.replacesId ?? null,
        actor: by.actor,
        createdBy: by.userId,
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    if (!row) throw new Error("fact insert returned nothing");
    made.push(row);
  }
  await tx.update(clientFile).set({ updatedAt: new Date() }).where(eq(clientFile.id, file.id));
  return made;
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────────

export async function fileSummaries(
  tx: Tx,
  tenantIds: readonly string[],
  rows: readonly FileRow[],
): Promise<ClientFileSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [counts, deals, clients] = await Promise.all([
    tx
      .select({
        fileId: clientFact.fileId,
        // Qualified by hand: a one-table select leaves its columns unqualified.
        n: sql<number>`(count(*) filter (where not exists (select 1 from client_fact r where r.replaces_id = "client_fact"."id")))::int`,
        last: sql<Date | null>`max(${clientFact.createdAt})`,
      })
      .from(clientFact)
      .where(inArray(clientFact.fileId, ids))
      .groupBy(clientFact.fileId),
    tx
      .select({ fileId: deal.clientFileId, n: sql<number>`count(*)::int` })
      .from(deal)
      .where(
        and(inArray(deal.clientFileId, ids), eq(deal.outcome, "open"), inSalesScope(tenantIds)),
      )
      .groupBy(deal.clientFileId),
    (async () => {
      const wanted = [...new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x))];
      return wanted.length
        ? tx
            .select({ id: tenant.id, name: tenant.name })
            .from(tenant)
            .where(inArray(tenant.id, wanted))
        : [];
    })(),
  ]);
  const factN = new Map(counts.map((c) => [c.fileId, c]));
  const dealN = new Map(deals.map((d) => [d.fileId, d.n]));
  const names = new Map(clients.map((c) => [c.id, c.name]));
  return rows.map((r) => {
    const last = factN.get(r.id)?.last;
    return {
      id: r.id,
      name: r.name,
      website: r.website,
      status: r.status,
      client: r.clientId ? { id: r.clientId, name: names.get(r.clientId) ?? r.name } : null,
      facts: factN.get(r.id)?.n ?? 0,
      openDeals: dealN.get(r.id) ?? 0,
      lastFactAt: last ? new Date(last).toISOString() : null,
      createdAt: iso(r.createdAt) as string,
      updatedAt: iso(r.updatedAt) as string,
    };
  });
}

/** A file with its facts (current ones, newest first; or all of them), its deals and intakes. */
export async function fileDetail(
  tx: Tx,
  tenantIds: readonly string[],
  row: FileRow,
  history = false,
): Promise<ClientFileDetail> {
  const [[summary], facts, deals, intakes] = await Promise.all([
    fileSummaries(tx, tenantIds, [row]),
    factsOf(tx, row.id),
    tx
      .select({
        id: deal.id,
        kind: deal.kind,
        title: deal.title,
        stage: deal.stage,
        outcome: deal.outcome,
      })
      .from(deal)
      .where(and(eq(deal.clientFileId, row.id), inSalesScope(tenantIds)))
      .orderBy(desc(deal.createdAt)),
    // An intake is the client's own record; only those of clients this session serves.
    tenantIds.length > 0
      ? tx
          .select({
            id: intake.id,
            clientId: intake.tenantId,
            status: intake.status,
            createdAt: intake.createdAt,
          })
          .from(intake)
          .where(and(eq(intake.fileId, row.id), inArray(intake.tenantId, [...tenantIds])))
          .orderBy(desc(intake.createdAt))
      : Promise.resolve([]),
  ]);
  if (!summary) throw new Error("no summary");
  const replacedBy = new Map<string, string>();
  for (const f of facts) if (f.replacesId) replacedBy.set(f.replacesId, f.id);
  const shown = (history ? facts : currentFacts(facts)).slice().reverse();
  const names = await userNames(
    tx,
    shown.map((f) => f.createdBy),
  );
  return {
    file: summary,
    facts: shown.map((f) => factView(f, replacedBy, names)),
    deals: deals.map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      stage: d.stage as ClientFileDetail["deals"][number]["stage"],
      outcome: d.outcome,
    })),
    intakes: intakes.map((i) => ({
      id: i.id,
      clientId: i.clientId,
      status: i.status,
      createdAt: iso(i.createdAt) as string,
    })),
  };
}
