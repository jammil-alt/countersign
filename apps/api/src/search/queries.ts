// v0.12 W2-F: ⌘K search, one query per kind (ARCHITECTURE §11.6; docs/plan.md §1.49). Each query
// runs in the request's scoped transaction (RLS) and names the clients it covers (invariant 1):
// the portal's one client, or the clients an operator serves. ILIKE on the text (its `%`, `_` and
// `\` taken literally), plus an amount (`$1,234.50`) and a run's short id. No new index: the lists
// are per client. Parameters only; no SQL is built from the text.

import {
  interleave,
  likeContaining,
  rankEntries,
  SEARCH_HITS_PER_KIND,
  type SearchRecordHit,
  type SearchText,
  shortRunId,
} from "@countersign/core";
import {
  agent,
  contact,
  docExtraction,
  document,
  organization,
  receivable,
  run,
  stepRun,
  type Tx,
  transaction,
  vendor,
} from "@countersign/db";
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from "drizzle-orm";

export type SearchSurface = "portal" | "ops";

export interface SearchScope {
  surface: SearchSurface;
  /** One client for the portal; the clients served (or one) for the back office. */
  tenantIds: readonly string[];
}

const N = SEARCH_HITS_PER_KIND;

/** What a portal search reads of the agents: the client's services (active or paused). */
const SERVICE_STATUSES = ["active", "paused"] as const;

// ── Agents and services ─────────────────────────────────────────────────────────────────────────

export async function searchAgents(tx: Tx, scope: SearchScope, q: SearchText) {
  const p = likeContaining(q.text);
  const named = or(ilike(agent.name, p), ilike(agent.serviceName, p), ilike(agent.slug, p));
  const clientAgents = and(
    inArray(agent.tenantId, [...scope.tenantIds]),
    eq(agent.kind, "client"),
    eq(agent.testCopy, false),
  );
  // DECISION: the portal finds its services (active or paused client agents), by service or agent
  // name; the back office also finds templates, which the portal never sees.
  const where =
    scope.surface === "portal"
      ? and(clientAgents, inArray(agent.runStatus, [...SERVICE_STATUSES]), named)
      : and(or(clientAgents, and(isNull(agent.tenantId), eq(agent.kind, "template"))), named);
  return tx
    .select({
      id: agent.id,
      tenantId: agent.tenantId,
      kind: agent.kind,
      name: agent.name,
      serviceName: agent.serviceName,
      runStatus: agent.runStatus,
    })
    .from(agent)
    .where(where)
    .orderBy(sql`coalesce(${agent.serviceName}, ${agent.name})`, agent.id)
    .limit(N);
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────

/** The latest step summary of a run. */
const latestSummary = sql<string | null>`(select ${stepRun.summary} from ${stepRun}
  where ${stepRun.runId} = ${run.id} and ${stepRun.tenantId} = ${run.tenantId} and ${stepRun.summary} is not null
  order by ${stepRun.finishedAt} desc nulls last limit 1)`;

export async function searchRuns(tx: Tx, scope: SearchScope, q: SearchText) {
  const p = likeContaining(q.text);
  const matches: SQL[] = [ilike(agent.name, p), ilike(agent.serviceName, p)];
  if (q.runTail) matches.push(sql`right(replace(${run.id}::text, '-', ''), 6) = ${q.runTail}`);
  // DECISION: the back office also matches workflows, errors and step summaries; the portal only
  // short ids and service names, since its timeline shows only client-visible steps and an
  // internal step's summary must not make a run turn up.
  if (scope.surface === "ops") {
    matches.push(
      ilike(run.workflowSlug, p),
      sql`${run.error}->>'reason' ilike ${p}`,
      sql`exists (select 1 from ${stepRun} where ${stepRun.runId} = ${run.id} and ${stepRun.tenantId} = ${run.tenantId} and ${stepRun.summary} ilike ${p})`,
    );
  }
  const where = and(
    inArray(run.tenantId, [...scope.tenantIds]),
    ...(scope.surface === "portal" ? [eq(run.mode, "live")] : []),
    or(...matches),
  );
  return tx
    .select({
      id: run.id,
      tenantId: run.tenantId,
      status: run.status,
      mode: run.mode,
      createdAt: run.createdAt,
      // For the run's subject (its title): the document or change it is about.
      trigger: run.trigger,
      agentId: agent.id,
      agentName: agent.name,
      serviceName: agent.serviceName,
      summary: scope.surface === "ops" ? latestSummary : sql<null>`null`,
    })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .where(where)
    .orderBy(desc(run.createdAt), desc(run.id))
    .limit(N)
    .then((rows) => rows.map((r) => ({ ...r, shortId: shortRunId(r.id) })));
}

// ── Records: transactions, receivables, vendors ─────────────────────────────────────────────────

/** The tool's document number, wherever a connector keeps it (`ext.<connector>.docNumber`). */
const txnDocNumber = sql<
  string | null
>`jsonb_path_query_first(${transaction.ext}, '$.*.docNumber') #>> '{}'`;

type RecordRow = SearchRecordHit & { tenantId: string };

/** Transactions, receivables and vendors in turn, at most 5, so one kind doesn't hide the others. */
export async function searchRecords(
  tx: Tx,
  scope: SearchScope,
  q: SearchText,
): Promise<RecordRow[]> {
  const ids = [...scope.tenantIds];
  const p = likeContaining(q.text);
  const amount = q.amount;

  const txns = await tx
    .select({
      id: transaction.id,
      tenantId: transaction.tenantId,
      kind: transaction.kind,
      txnDate: transaction.txnDate,
      total: transaction.total,
      currency: transaction.currency,
      vendorName: vendor.name,
      docNumber: txnDocNumber,
    })
    .from(transaction)
    .leftJoin(
      vendor,
      and(eq(vendor.id, transaction.vendorId), eq(vendor.tenantId, transaction.tenantId)),
    )
    .where(
      and(
        inArray(transaction.tenantId, ids),
        or(
          ilike(transaction.memo, p),
          sql`${txnDocNumber} ilike ${p}`,
          ilike(vendor.name, p),
          ...(amount === null ? [] : [sql`${transaction.total} = ${amount}::numeric`]),
        ),
      ),
    )
    .orderBy(sql`${transaction.txnDate} desc nulls last`, desc(transaction.createdAt))
    .limit(N);

  const recvs = await tx
    .select({
      id: receivable.id,
      tenantId: receivable.tenantId,
      status: receivable.status,
      docNumber: receivable.docNumber,
      customerName: receivable.customerName,
      txnDate: receivable.txnDate,
      total: receivable.total,
      currency: receivable.currency,
    })
    .from(receivable)
    .where(
      and(
        inArray(receivable.tenantId, ids),
        or(
          ilike(receivable.docNumber, p),
          ilike(receivable.customerName, p),
          ilike(receivable.privateNote, p),
          ...(amount === null
            ? []
            : [
                sql`${receivable.total} = ${amount}::numeric`,
                sql`${receivable.balance} = ${amount}::numeric`,
              ]),
        ),
      ),
    )
    .orderBy(desc(receivable.txnDate), desc(receivable.createdAt))
    .limit(N);

  const vendors = await tx
    .select({ id: vendor.id, tenantId: vendor.tenantId, name: vendor.name })
    .from(vendor)
    .where(
      and(
        inArray(vendor.tenantId, ids),
        or(ilike(vendor.name, p), sql`array_to_string(${vendor.aliases}, ' ') ilike ${p}`),
      ),
    )
    .orderBy(asc(vendor.name), asc(vendor.id))
    .limit(N);

  return interleave<RecordRow>(
    [
      txns.map(
        (t): RecordRow => ({
          kind: "transaction",
          id: t.id,
          tenantId: t.tenantId,
          label: [t.vendorName, t.docNumber].filter(Boolean).join(" · ") || t.kind,
          type: t.kind,
          number: t.docNumber,
          date: t.txnDate,
          amount: t.total,
          currency: t.currency,
        }),
      ),
      recvs.map(
        (r): RecordRow => ({
          kind: "receivable",
          id: r.id,
          tenantId: r.tenantId,
          label: [r.customerName, r.docNumber].filter(Boolean).join(" · "),
          type: r.status,
          number: r.docNumber,
          date: r.txnDate,
          amount: r.total,
          currency: r.currency,
        }),
      ),
      vendors.map(
        (v): RecordRow => ({
          kind: "vendor",
          id: v.id,
          tenantId: v.tenantId,
          label: v.name,
          type: null,
          number: null,
          date: null,
          amount: null,
          currency: null,
        }),
      ),
    ],
    N,
  );
}

// ── People and organizations (the directory's ranking) ──────────────────────────────────────────

/** The most directory rows a search reads per kind before ranking them. */
// DECISION: the directory is filtered in SQL by the query's longest word (ILIKE on the fields its
// ranking reads), then ranked with core's `rankEntries`, the same ranking as the directory; a
// directory is hundreds of rows per client, so 500 candidates are plenty.
const DIRECTORY_CANDIDATES = 500;

function longestWord(text: string): string {
  let best = "";
  for (const w of text.split(" ")) if (w.length > best.length) best = w;
  return best;
}

/** The query's digits, when it reads as a phone (4+ digits and only phone signs). */
function phoneDigits(text: string): string | null {
  let digits = "";
  for (const c of text) {
    if (c >= "0" && c <= "9") digits += c;
    else if (!" ()+.-".includes(c)) return null;
  }
  return digits.length >= 4 ? digits : null;
}

export async function searchPeople(tx: Tx, scope: SearchScope, q: SearchText) {
  const ids = [...scope.tenantIds];
  const digits = phoneDigits(q.text);
  const p = likeContaining(longestWord(q.text));
  const where = digits
    ? or(
        sql`regexp_replace(coalesce(${contact.phone}, ''), '[^0-9]', '', 'g') like ${likeContaining(digits)}`,
        sql`regexp_replace(coalesce(${contact.whatsapp}, ''), '[^0-9]', '', 'g') like ${likeContaining(digits)}`,
      )
    : or(
        ilike(contact.name, p),
        ilike(contact.email, p),
        ilike(contact.title, p),
        ilike(organization.name, p),
        sql`${contact.roles}::text ilike ${p}`,
      );
  const rows = await tx
    .select({
      id: contact.id,
      tenantId: contact.tenantId,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      whatsapp: contact.whatsapp,
      title: contact.title,
      roles: contact.roles,
      orgId: organization.id,
      orgName: organization.name,
    })
    .from(contact)
    .leftJoin(
      organization,
      and(eq(organization.id, contact.organizationId), eq(organization.tenantId, contact.tenantId)),
    )
    .where(and(inArray(contact.tenantId, ids), where))
    .orderBy(asc(contact.name), asc(contact.id))
    .limit(DIRECTORY_CANDIDATES);
  return rankEntries(
    rows.map((r) => ({
      row: r,
      name: r.name,
      email: r.email,
      phones: [r.phone, r.whatsapp],
      title: r.title,
      organization: r.orgName,
      roles: r.roles ?? [],
    })),
    q.text,
    N,
  ).map(({ entry: { row: r } }) => ({
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    email: r.email,
    title: r.title,
    organization: r.orgId && r.orgName ? { id: r.orgId, name: r.orgName } : null,
  }));
}

export async function searchOrganizations(tx: Tx, scope: SearchScope, q: SearchText) {
  const ids = [...scope.tenantIds];
  const digits = phoneDigits(q.text);
  const p = likeContaining(longestWord(q.text));
  const where = digits
    ? sql`regexp_replace(coalesce(${organization.phone}, ''), '[^0-9]', '', 'g') like ${likeContaining(digits)}`
    : or(
        ilike(organization.name, p),
        ilike(organization.email, p),
        ilike(organization.website, p),
        sql`array_to_string(${organization.kinds}, ' ') ilike ${p}`,
      );
  const rows = await tx
    .select({
      id: organization.id,
      tenantId: organization.tenantId,
      name: organization.name,
      email: organization.email,
      phone: organization.phone,
      website: organization.website,
      kinds: organization.kinds,
    })
    .from(organization)
    .where(and(inArray(organization.tenantId, ids), where))
    .orderBy(asc(organization.name), asc(organization.id))
    .limit(DIRECTORY_CANDIDATES);
  return rankEntries(
    rows.map((r) => ({
      row: r,
      name: r.name,
      email: r.email,
      phones: [r.phone],
      website: r.website,
      roles: r.kinds,
    })),
    q.text,
    N,
  ).map(({ entry: { row: r } }) => ({
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    kinds: [...r.kinds],
    website: r.website,
  }));
}

// ── Documents ───────────────────────────────────────────────────────────────────────────────────

export async function searchDocuments(tx: Tx, scope: SearchScope, q: SearchText) {
  const p = likeContaining(q.text);
  const docs = await tx
    .select({
      id: document.id,
      tenantId: document.tenantId,
      filename: document.filename,
      status: document.status,
      receivedAt: document.receivedAt,
    })
    .from(document)
    .where(
      and(
        inArray(document.tenantId, [...scope.tenantIds]),
        or(
          ilike(document.filename, p),
          sql`exists (select 1 from ${docExtraction} where ${docExtraction.documentId} = ${document.id} and ${docExtraction.tenantId} = ${document.tenantId}
            and (${docExtraction.header}->>'vendorName' ilike ${p} or ${docExtraction.header}->>'invoiceNumber' ilike ${p}))`,
        ),
      ),
    )
    .orderBy(desc(document.receivedAt), desc(document.id))
    .limit(N);
  if (docs.length === 0) return [];
  // Each document's latest reading: its vendor and number.
  const readings = await tx
    .selectDistinctOn([docExtraction.documentId], {
      documentId: docExtraction.documentId,
      vendor: sql<string | null>`${docExtraction.header}->>'vendorName'`,
      number: sql<string | null>`${docExtraction.header}->>'invoiceNumber'`,
    })
    .from(docExtraction)
    .where(
      and(
        inArray(docExtraction.tenantId, [...scope.tenantIds]),
        inArray(
          docExtraction.documentId,
          docs.map((d) => d.id),
        ),
      ),
    )
    .orderBy(docExtraction.documentId, desc(docExtraction.createdAt));
  const latest = new Map(readings.map((r) => [r.documentId, r]));
  return docs.map((d) => ({
    ...d,
    vendor: latest.get(d.id)?.vendor ?? null,
    number: latest.get(d.id)?.number ?? null,
  }));
}
