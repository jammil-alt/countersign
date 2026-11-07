// What each run is about (core RunSubject), for its title in the run lists, search and the run
// pages of both surfaces; and the names of the records a run's steps cite. Derived here when a
// response is built (no column, no migration): the document that started the run, else its first
// change to a client's tool, else what started it. Every query names the clients as well as
// relying on RLS (invariant 1).
import {
  changeSubject,
  isPlainObject,
  isUuid,
  type RunSubject,
  runStartedBy,
} from "@countersign/core";
import {
  docExtraction,
  document,
  externalAction,
  rawRecord,
  type Tx,
  transaction,
  vendor,
} from "@countersign/db";
import { and, desc, inArray, sql } from "drizzle-orm";
import { changeDisplay } from "../change-display";
import type { Platform } from "../platform";

interface RunLike {
  id: string;
  tenantId: string;
  trigger: unknown;
}

type Registries = Pick<Platform, "tools" | "connectors">;

/** The document a run's trigger names (`payload.documentId`, or the trigger's own). */
export function triggerDocumentId(trigger: unknown): string | null {
  if (!isPlainObject(trigger)) return null;
  const payload = isPlainObject(trigger.payload) ? trigger.payload : {};
  const id = payload.documentId ?? trigger.documentId;
  return typeof id === "string" && isUuid(id) ? id : null;
}

/** Each document's latest reading: its vendor and invoice number, and its file name. */
async function documentNames(
  tx: Tx,
  tenantIds: readonly string[],
  ids: readonly string[],
): Promise<Map<string, { vendor: string | null; number: string | null; filename: string }>> {
  const out = new Map<string, { vendor: string | null; number: string | null; filename: string }>();
  if (ids.length === 0 || tenantIds.length === 0) return out;
  const docs = await tx
    .select({ id: document.id, filename: document.filename })
    .from(document)
    .where(and(inArray(document.tenantId, [...tenantIds]), inArray(document.id, [...ids])));
  if (docs.length === 0) return out;
  const readings = await tx
    .selectDistinctOn([docExtraction.documentId], {
      documentId: docExtraction.documentId,
      vendor: sql<string | null>`${docExtraction.header}->>'vendorName'`,
      number: sql<string | null>`${docExtraction.header}->>'invoiceNumber'`,
    })
    .from(docExtraction)
    .where(
      and(
        inArray(docExtraction.tenantId, [...tenantIds]),
        inArray(
          docExtraction.documentId,
          docs.map((d) => d.id),
        ),
      ),
    )
    .orderBy(docExtraction.documentId, desc(docExtraction.createdAt));
  const latest = new Map(readings.map((r) => [r.documentId, r]));
  for (const d of docs) {
    const r = latest.get(d.id);
    out.set(d.id, { vendor: r?.vendor ?? null, number: r?.number ?? null, filename: d.filename });
  }
  return out;
}

/** What each run is about, by run id. Two or three queries for a whole list. */
export async function runSubjects(
  tx: Tx,
  tenantIds: readonly string[],
  runs: readonly RunLike[],
  platform: Registries,
): Promise<Map<string, RunSubject>> {
  const out = new Map<string, RunSubject>();
  if (runs.length === 0) return out;
  const docOf = new Map(runs.map((r) => [r.id, triggerDocumentId(r.trigger)]));
  const docs = await documentNames(tx, tenantIds, [
    ...new Set([...docOf.values()].filter((v): v is string => v !== null)),
  ]);
  const rest: RunLike[] = [];
  for (const r of runs) {
    const docId = docOf.get(r.id);
    const doc = docId ? docs.get(docId) : undefined;
    if (doc) {
      out.set(r.id, {
        kind: "document",
        vendor: doc.vendor,
        number: doc.number,
        filename: doc.filename,
      });
    } else {
      rest.push(r);
    }
  }
  if (rest.length === 0) return out;
  // Each remaining run's first change to a client's tool.
  const firsts = await tx
    .selectDistinctOn([externalAction.runId], {
      runId: externalAction.runId,
      tool: externalAction.tool,
      before: externalAction.before,
      input: externalAction.input,
    })
    .from(externalAction)
    .where(
      and(
        inArray(externalAction.tenantId, [...tenantIds]),
        inArray(
          externalAction.runId,
          rest.map((r) => r.id),
        ),
      ),
    )
    .orderBy(externalAction.runId, externalAction.createdAt, externalAction.id);
  const changes = new Map(firsts.map((a) => [a.runId, a]));
  for (const r of rest) {
    const a = changes.get(r.id);
    const view = a ? changeDisplay(platform, a.tool) : null;
    if (a && view) {
      out.set(r.id, changeSubject(view.tool, view.connectorName, a.before, a.input));
      continue;
    }
    const trigger = isPlainObject(r.trigger) ? r.trigger : {};
    out.set(r.id, {
      kind: "trigger",
      startedBy: runStartedBy(trigger),
      event: typeof trigger.eventType === "string" ? trigger.eventType : null,
    });
  }
  return out;
}

/** "Northline Panel Supply · 20418": a record's vendor (or customer) and number, or its kind. */
function joined(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** The tool's document number, wherever a connector keeps it (`ext.<connector>.docNumber`). */
const txnDocNumber = sql<
  string | null
>`jsonb_path_query_first(${transaction.ext}, '$.*.docNumber') #>> '{}'`;

/**
 * Names for the records a run's steps cite (`sources`, invariant 10), by id, so a receipt reads
 * "Northline Panel Supply · 20418" rather than "Record ·b538da". Ids that name nothing the
 * platform knows are left out (the receipt keeps its short form).
 */
// DECISION: the same tables the record page reads (transactions, documents and their readings,
// raw records, vendors), one query each for a whole run; a pack's rows are not named here, as the
// platform never special-cases a pack.
export async function sourceNames(
  tx: Tx,
  tenantIds: readonly string[],
  ids: readonly string[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((id) => isUuid(id)))];
  const out: Record<string, string> = {};
  if (wanted.length === 0 || tenantIds.length === 0) return out;
  const tenants = [...tenantIds];

  const txns = await tx
    .select({
      id: transaction.id,
      kind: transaction.kind,
      vendorName: vendor.name,
      docNumber: txnDocNumber,
    })
    .from(transaction)
    .leftJoin(
      vendor,
      sql`${vendor.id} = ${transaction.vendorId} and ${vendor.tenantId} = ${transaction.tenantId}`,
    )
    .where(and(inArray(transaction.tenantId, tenants), inArray(transaction.id, wanted)));
  for (const t of txns) {
    out[t.id] = joined(t.vendorName, t.docNumber) ?? kindWords(t.kind);
  }

  const left = () => wanted.filter((id) => !(id in out));
  if (left().length > 0) {
    const docs = await documentNames(tx, tenants, left());
    for (const [id, d] of docs) out[id] = joined(d.vendor, d.number) ?? d.filename;
  }
  if (left().length > 0) {
    // An extraction id names its document's reading.
    const readings = await tx
      .select({
        id: docExtraction.id,
        vendor: sql<string | null>`${docExtraction.header}->>'vendorName'`,
        number: sql<string | null>`${docExtraction.header}->>'invoiceNumber'`,
      })
      .from(docExtraction)
      .where(and(inArray(docExtraction.tenantId, tenants), inArray(docExtraction.id, left())));
    for (const r of readings) {
      const name = joined(r.vendor, r.number);
      if (name) out[r.id] = name;
    }
  }
  if (left().length > 0) {
    const vendors = await tx
      .select({ id: vendor.id, name: vendor.name })
      .from(vendor)
      .where(and(inArray(vendor.tenantId, tenants), inArray(vendor.id, left())));
    for (const v of vendors) out[v.id] = v.name;
  }
  if (left().length > 0) {
    const raws = await tx
      .select({
        id: rawRecord.id,
        entityType: rawRecord.entityType,
        docNumber: sql<string | null>`${rawRecord.payload}->>'DocNumber'`,
        name: sql<
          string | null
        >`coalesce(${rawRecord.payload}->>'DisplayName', ${rawRecord.payload}->>'Name', ${rawRecord.payload}->'VendorRef'->>'name')`,
      })
      .from(rawRecord)
      .where(and(inArray(rawRecord.tenantId, tenants), inArray(rawRecord.id, left())));
    for (const r of raws) {
      out[r.id] = joined(r.name, r.docNumber) ?? kindWords(r.entityType);
    }
  }
  return out;
}

/** `vendor_credit` → "Vendor credit". */
function kindWords(kind: string): string {
  const words = kind
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
