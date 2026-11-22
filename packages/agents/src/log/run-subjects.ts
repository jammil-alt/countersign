// What each run was about, kept as it happens (docs/reporting-plan.md §3 R1, docs/plan.md §1.188):
// `run_subject` rows from what started the run and, when a step finishes, from the step's
// output `sources`, its tool calls' `about` and its changes to the client's tools. One writer for
// the live run and the backfill. Every query names the client as well as relying on RLS
// (invariant 1); rows are only inserted (invariant 3). Labels and numbers are data, never
// instructions (invariant 9).

import {
  aboutOf,
  amountOf,
  changeSubject,
  Decimal,
  isPlainObject,
  isUuid,
  type RunSubjectKind,
  type RunSubjectRole,
  type SubjectFacts,
  subjectKindOfEntity,
  subjectText,
  type ToolSpec,
} from "@countersign/core";
import {
  connection,
  contact,
  docExtraction,
  document,
  externalAction,
  message,
  organization,
  rawRecord,
  receivable,
  run,
  runSubject,
  stepRun,
  type Tx,
  toolCall,
  transaction,
  vendor,
} from "@countersign/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

/** A tool's spec by id, as the platform's registry has it (apps/api passes it). */
export type SubjectToolLookup = (toolId: string) => ToolSpec | undefined;

/** The most `sources` of one step kept as subjects. */
const MAX_SOURCES = 100;

type Row = typeof runSubject.$inferInsert;

/**
 * The document or message a run's trigger names (`payload.documentId`, or the trigger's own). A
 * message trigger's message is its thread message (`messageId`), else, for one that came in from
 * outside (email, SMS, WhatsApp), the raw record it arrived as (`rawRecordId`).
 */
// DECISION: an inbound message has no `message` row, only its raw record; that record is the
// message that started the run. Only for a `message` trigger: another event's `rawRecordId` (a
// synced bill) is not a message.
export function triggerSubjectIds(trigger: unknown): { documentId?: string; messageId?: string } {
  if (!isPlainObject(trigger)) return {};
  const payload = isPlainObject(trigger.payload) ? trigger.payload : {};
  const pick = (key: string): string | undefined => {
    const v = payload[key] ?? trigger[key];
    return typeof v === "string" && isUuid(v) ? v.toLowerCase() : undefined;
  };
  const documentId = pick("documentId");
  const messageId =
    pick("messageId") ?? (trigger.type === "message" ? pick("rawRecordId") : undefined);
  return {
    ...(documentId ? { documentId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function facts(
  kind: RunSubjectKind,
  role: RunSubjectRole,
  recordId: string | null,
  more: Partial<Omit<SubjectFacts, "kind" | "role" | "recordId">> = {},
): SubjectFacts {
  return {
    kind,
    role,
    recordId,
    connector: more.connector ?? null,
    externalId: more.externalId ?? null,
    label: more.label ?? null,
    number: more.number ?? null,
    amount: more.amount ?? null,
  };
}

function money(value: unknown, currency: unknown): SubjectFacts["amount"] {
  if (typeof currency !== "string" || currency.length !== 3) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const d = new Decimal(value);
    return d.isFinite() ? { value: d.toFixed(), currency } : null;
  } catch {
    return null;
  }
}

/** `jsonb` path to the tool's document number wherever a connector keeps it. */
const txnDocNumber = sql<
  string | null
>`jsonb_path_query_first(${transaction.ext}, '$.*.docNumber') #>> '{}'`;

/**
 * What our records with these ids are, by id: the kind from the record's own table (invariant
 * 10's ids), its name, number and money. Ids no platform table holds are `record`s (a pack's own
 * rows: the platform never special-cases a pack).
 */
export async function recordSubjectsTx(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  role: RunSubjectRole,
): Promise<Map<string, SubjectFacts>> {
  const out = new Map<string, SubjectFacts>();
  const wanted = [...new Set(ids.filter((id) => isUuid(id)).map((id) => id.toLowerCase()))];
  const left = () => wanted.filter((id) => !out.has(id));
  if (wanted.length === 0) return out;

  // Documents, and an extraction as its document: the latest reading's vendor, number and total.
  const extractions = await tx
    .select({ id: docExtraction.id, documentId: docExtraction.documentId })
    .from(docExtraction)
    .where(and(eq(docExtraction.tenantId, tenantId), inArray(docExtraction.id, wanted)));
  const docOf = new Map(extractions.map((x) => [x.id, x.documentId]));
  const docIds = [...new Set([...wanted, ...docOf.values()])];
  const docs = await tx
    .select({ id: document.id, filename: document.filename })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), inArray(document.id, docIds)));
  if (docs.length > 0) {
    const readings = await tx
      .selectDistinctOn([docExtraction.documentId], {
        documentId: docExtraction.documentId,
        vendor: sql<string | null>`${docExtraction.header}->>'vendorName'`,
        number: sql<string | null>`${docExtraction.header}->>'invoiceNumber'`,
        total: docExtraction.total,
        currency: docExtraction.currency,
      })
      .from(docExtraction)
      .where(
        and(
          eq(docExtraction.tenantId, tenantId),
          inArray(
            docExtraction.documentId,
            docs.map((d) => d.id),
          ),
        ),
      )
      .orderBy(docExtraction.documentId, desc(docExtraction.createdAt));
    const reading = new Map(readings.map((r) => [r.documentId, r]));
    const byDoc = new Map<string, SubjectFacts>();
    for (const d of docs) {
      const r = reading.get(d.id);
      // DECISION: a document reads by its vendor when it has been read, else by its file's name;
      // its number is the invoice's own (docs/plan.md §1.188).
      byDoc.set(
        d.id,
        facts("document", role, d.id, {
          label: subjectText(r?.vendor) ?? subjectText(d.filename),
          number: subjectText(r?.number, 64),
          amount: r ? money(r.total, r.currency) : null,
        }),
      );
    }
    for (const id of wanted) {
      const f = byDoc.get(docOf.get(id) ?? id);
      if (f) out.set(id, f);
    }
  }

  if (left().length > 0) {
    const txns = await tx
      .select({
        id: transaction.id,
        connector: transaction.connector,
        externalId: transaction.externalId,
        total: transaction.total,
        currency: transaction.currency,
        vendorName: vendor.name,
        docNumber: txnDocNumber,
      })
      .from(transaction)
      .leftJoin(
        vendor,
        sql`${vendor.id} = ${transaction.vendorId} and ${vendor.tenantId} = ${transaction.tenantId}`,
      )
      .where(and(eq(transaction.tenantId, tenantId), inArray(transaction.id, left())));
    for (const t of txns) {
      out.set(
        t.id,
        facts("transaction", role, t.id, {
          connector: t.connector,
          externalId: t.externalId,
          label: subjectText(t.vendorName),
          number: subjectText(t.docNumber, 64),
          amount: money(t.total, t.currency),
        }),
      );
    }
  }
  if (left().length > 0) {
    const rows = await tx
      .select({
        id: receivable.id,
        connector: receivable.connector,
        externalId: receivable.externalId,
        customerName: receivable.customerName,
        docNumber: receivable.docNumber,
        total: receivable.total,
        currency: receivable.currency,
      })
      .from(receivable)
      .where(and(eq(receivable.tenantId, tenantId), inArray(receivable.id, left())));
    for (const r of rows) {
      out.set(
        r.id,
        facts("transaction", role, r.id, {
          connector: r.connector,
          externalId: r.externalId,
          label: subjectText(r.customerName),
          number: subjectText(r.docNumber, 64),
          amount: money(r.total, r.currency),
        }),
      );
    }
  }
  if (left().length > 0) {
    const rows = await tx
      .select({ id: vendor.id, name: vendor.name })
      .from(vendor)
      .where(and(eq(vendor.tenantId, tenantId), inArray(vendor.id, left())));
    for (const v of rows)
      out.set(v.id, facts("vendor", role, v.id, { label: subjectText(v.name) }));
  }
  if (left().length > 0) {
    const rows = await tx
      .select({ id: organization.id, name: organization.name, kinds: organization.kinds })
      .from(organization)
      .where(and(eq(organization.tenantId, tenantId), inArray(organization.id, left())));
    for (const o of rows) {
      const kind: RunSubjectKind = o.kinds.includes("customer")
        ? "customer"
        : o.kinds.includes("vendor")
          ? "vendor"
          : "organization";
      out.set(o.id, facts(kind, role, o.id, { label: subjectText(o.name) }));
    }
  }
  if (left().length > 0) {
    const rows = await tx
      .select({ id: contact.id, name: contact.name })
      .from(contact)
      .where(and(eq(contact.tenantId, tenantId), inArray(contact.id, left())));
    for (const c of rows)
      out.set(c.id, facts("person", role, c.id, { label: subjectText(c.name) }));
  }
  if (left().length > 0) {
    const rows = await tx
      .select({
        id: rawRecord.id,
        connector: rawRecord.connector,
        entityType: rawRecord.entityType,
        externalId: rawRecord.externalId,
        docNumber: sql<string | null>`${rawRecord.payload}->>'DocNumber'`,
        name: sql<
          string | null
        >`coalesce(${rawRecord.payload}->>'DisplayName', ${rawRecord.payload}->>'Name', ${rawRecord.payload}->'VendorRef'->>'name', ${rawRecord.payload}->'CustomerRef'->>'name')`,
      })
      .from(rawRecord)
      .where(and(eq(rawRecord.tenantId, tenantId), inArray(rawRecord.id, left())));
    for (const r of rows) {
      out.set(
        r.id,
        facts(subjectKindOfEntity(r.entityType), role, r.id, {
          connector: r.connector,
          externalId: r.externalId,
          label: subjectText(r.name),
          number: subjectText(r.docNumber, 64),
        }),
      );
    }
  }
  if (left().length > 0) {
    // A message is named by its id only: its text is the sender's, and stays out (invariant 12).
    const rows = await tx
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.tenantId, tenantId), inArray(message.id, left())));
    for (const m of rows) out.set(m.id, facts("message", role, m.id));
  }
  for (const id of left()) out.set(id, facts("record", role, id));
  return out;
}

/** The id the client's tool gave the record a change wrote, from what the write returned. */
// DECISION: `id` (every connector's write output names it so), else the record's own `Id` or `id`
// as it was before; nothing else is guessed.
function externalIdOf(result: unknown, before: unknown): string | null {
  for (const v of [
    isPlainObject(result) ? result.id : undefined,
    isPlainObject(result) ? result.Id : undefined,
    isPlainObject(before) ? before.Id : undefined,
    isPlainObject(before) ? before.id : undefined,
  ]) {
    if ((typeof v === "string" && v.trim() !== "") || typeof v === "number") return String(v);
  }
  return null;
}

/** The entity a change's tool writes: its own, or the one its input names (`entityInput`). */
function entityOf(spec: ToolSpec | undefined, input: unknown): string | null {
  if (!spec) return null;
  if (spec.entity) return spec.entity;
  if (spec.entityInput && isPlainObject(input)) {
    const v = input[spec.entityInput.field];
    return typeof v === "string" ? (spec.entityInput.values[v] ?? null) : null;
  }
  return null;
}

/** A change to a client's tool as a subject: its record, number, counterparty and money. */
export function changeSubjectFacts(
  spec: ToolSpec | undefined,
  action: {
    connector: string;
    input: unknown;
    editedInput: unknown;
    before: unknown;
    result: unknown;
  },
): SubjectFacts {
  // What was written: the signer's edit when there was one (ARCHITECTURE §11.1).
  const input = action.editedInput ?? action.input;
  const view = changeSubject(spec?.display, "", action.before, input);
  const declared = spec?.about?.[0]?.kind;
  const result = isPlainObject(action.result) ? action.result : {};
  return facts(declared ?? subjectKindOfEntity(entityOf(spec, input)), "changed", null, {
    connector: action.connector,
    externalId: externalIdOf(action.result, action.before),
    label: subjectText(view.with),
    number: subjectText(view.number ?? result.docNumber, 64),
    amount: spec ? amountOf(spec, input) : null,
  });
}

/** numeric(14,4): an amount it can't hold is left off the row rather than fail the step. */
const MAX_AMOUNT = new Decimal("1e10");

/** A subject as its row keeps it: four places, an amount the column holds, an id with its tool. */
function kept(f: SubjectFacts): SubjectFacts {
  // Rounded to the column's four places first: 9999999999.99995 rounds past what it holds.
  const d = f.amount ? new Decimal(new Decimal(f.amount.value).toFixed(4)) : null;
  const fits = d?.abs().lt(MAX_AMOUNT) === true;
  return {
    ...f,
    externalId: f.connector ? f.externalId : null,
    amount: f.amount && d && fits ? { value: d.toFixed(4), currency: f.amount.currency } : null,
  };
}

function keyOf(f: SubjectFacts): string {
  return JSON.stringify([
    f.kind,
    f.role,
    f.recordId,
    f.connector,
    f.externalId,
    f.label,
    f.number,
    f.amount?.value ?? null,
    f.amount?.currency ?? null,
  ]);
}

/**
 * Inserts the subjects not already kept for this run's step (or, with `stepRunId` null, for what
 * started it). Steps finish more than once (a retry, a step that waited), so the same subject is
 * kept once.
 */
async function insertNew(
  tx: Tx,
  where: { tenantId: string; runId: string; stepRunId: string | null; clientVisible: boolean },
  subjects: readonly SubjectFacts[],
): Promise<number> {
  if (subjects.length === 0) return 0;
  const existing = await tx
    .select({
      kind: runSubject.kind,
      role: runSubject.role,
      recordId: runSubject.recordId,
      connector: runSubject.connector,
      externalId: runSubject.externalId,
      label: runSubject.label,
      number: runSubject.number,
      amount: runSubject.amount,
      currency: runSubject.currency,
    })
    .from(runSubject)
    .where(
      and(
        eq(runSubject.tenantId, where.tenantId),
        eq(runSubject.runId, where.runId),
        where.stepRunId === null
          ? isNull(runSubject.stepRunId)
          : eq(runSubject.stepRunId, where.stepRunId),
      ),
    );
  const seen = new Set(
    existing.map((e) =>
      keyOf(
        kept({
          ...e,
          amount:
            e.amount !== null && e.currency !== null
              ? { value: e.amount, currency: e.currency }
              : null,
        }),
      ),
    ),
  );
  const rows: Row[] = [];
  for (const s of subjects.map(kept)) {
    const key = keyOf(s);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      tenantId: where.tenantId,
      runId: where.runId,
      stepRunId: where.stepRunId,
      kind: s.kind,
      role: s.role,
      recordId: s.recordId,
      connector: s.connector,
      // A tool's id means nothing without the tool (the row's check, 0077): `kept` drops it.
      externalId: s.externalId,
      label: s.label,
      number: s.number,
      amount: s.amount?.value ?? null,
      currency: s.amount?.currency ?? null,
      clientVisible: where.clientVisible,
    });
  }
  if (rows.length > 0) await tx.insert(runSubject).values(rows);
  return rows.length;
}

/**
 * Runs a subjects write in its own savepoint, so a failure undoes only it, never the step or run
 * it is about; `onError` hears of it.
 */
// DECISION: what a run was about is an index over its history, not the history itself: a write
// that fails leaves the step's own row as it is (docs/plan.md §1.188).
export async function keepSubjects(
  tx: Tx,
  write: (sp: Tx) => Promise<number>,
  onError?: (error: unknown) => void,
): Promise<number> {
  try {
    return await tx.transaction(write);
  } catch (error) {
    onError?.(error);
    return 0;
  }
}

/**
 * Keeps what started a run: the document or message its trigger names. Its row has no step
 * (docs/plan.md §1.188). Shown to the client only for a live run (test runs are hidden from the
 * portal, ARCHITECTURE §10.4). Returns the rows added.
 */
export async function writeTriggerSubjectsTx(
  tx: Tx,
  input: { tenantId: string; runId: string; trigger: unknown; mode: string },
): Promise<number> {
  const { documentId, messageId } = triggerSubjectIds(input.trigger);
  const ids = [documentId, messageId].filter((v): v is string => v !== undefined);
  if (ids.length === 0) return 0;
  const named = await recordSubjectsTx(tx, input.tenantId, ids, "read");
  const subjects: SubjectFacts[] = [];
  // DECISION: the trigger says what its ids are: one no table of that kind holds (a document since
  // removed) is still kept, by its id alone, as that kind.
  for (const [id, kind] of [
    [documentId, "document"],
    [messageId, "message"],
  ] as const) {
    if (!id) continue;
    const found = named.get(id);
    if (kind === "message") {
      // A message, or an inbound one's raw record, keeps its tool and id, never its words
      // (invariant 12).
      subjects.push(
        facts("message", "read", id, {
          connector: found?.connector ?? null,
          externalId: found?.externalId ?? null,
        }),
      );
    } else {
      subjects.push(found?.kind === kind ? found : facts(kind, "read", id));
    }
  }
  return insertNew(
    tx,
    {
      tenantId: input.tenantId,
      runId: input.runId,
      stepRunId: null,
      clientVisible: input.mode === "live",
    },
    subjects,
  );
}

/**
 * Keeps what a finished step was about (docs/reporting-plan.md §3 R1): the records its output's
 * `sources` cite (`decided`), what its tool calls' outputs name by each tool's `about`, and each
 * change it made to a client's tool (`changed`). `visible` says whether the client's timeline
 * shows the step (by its node id); only a live run's visible steps are the client's. Returns the
 * rows added.
 */
export async function writeStepSubjectsTx(
  tx: Tx,
  input: {
    tenantId: string;
    stepRunId: string;
    tools: SubjectToolLookup;
    visible: (nodeId: string) => boolean;
  },
): Promise<number> {
  const { tenantId, stepRunId } = input;
  const [step] = await tx
    .select({
      runId: stepRun.runId,
      nodeId: stepRun.nodeId,
      output: stepRun.output,
      mode: run.mode,
    })
    .from(stepRun)
    .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
    .where(and(eq(stepRun.id, stepRunId), eq(stepRun.tenantId, tenantId)));
  if (!step) return 0;

  const subjects: SubjectFacts[] = [];
  // 1. The records the step's output cites (invariant 10).
  const output = isPlainObject(step.output) ? step.output : {};
  const sources = Array.isArray(output.sources)
    ? output.sources.filter((v): v is string => typeof v === "string").slice(0, MAX_SOURCES)
    : [];
  if (sources.length > 0) {
    const named = await recordSubjectsTx(tx, tenantId, sources, "decided");
    subjects.push(...named.values());
  }

  // 2. What its tools' outputs name, by their `about`. A write's own call is its change (3).
  const calls = await tx
    .select({ tool: toolCall.tool, output: toolCall.output })
    .from(toolCall)
    .where(
      and(
        eq(toolCall.tenantId, tenantId),
        eq(toolCall.stepRunId, stepRunId),
        eq(toolCall.status, "succeeded"),
        isNull(toolCall.externalActionId),
      ),
    )
    .orderBy(toolCall.createdAt, toolCall.id);
  const declared: SubjectFacts[] = [];
  for (const c of calls) {
    const spec = input.tools(c.tool);
    if (spec?.about && spec.sideEffect !== "external") declared.push(...aboutOf(spec, c.output));
  }
  // An entry that names its record by id alone reads its name and number from our record, when
  // it is one of the platform's (the kind stays the tool's).
  const bare = declared.filter((d) => d.recordId && d.label === null && d.number === null);
  const found =
    bare.length > 0
      ? await recordSubjectsTx(
          tx,
          tenantId,
          bare.map((d) => d.recordId as string),
          "read",
        )
      : new Map<string, SubjectFacts>();
  for (const d of declared) {
    const f = d.recordId && d.label === null && d.number === null ? found.get(d.recordId) : null;
    subjects.push(
      f && f.kind !== "record"
        ? {
            ...d,
            connector: f.connector,
            externalId: f.externalId,
            label: f.label,
            number: f.number,
            amount: d.amount ?? f.amount,
          }
        : d,
    );
  }

  // 3. Each change it made to a client's tool.
  // DECISION: only a change that is done; one waiting, refused or failed changed nothing yet.
  const actions = await tx
    .select({
      tool: externalAction.tool,
      input: externalAction.input,
      editedInput: externalAction.editedInput,
      before: externalAction.before,
      result: externalAction.result,
      connector: connection.connector,
    })
    .from(externalAction)
    .innerJoin(
      connection,
      and(
        eq(connection.id, externalAction.connectionId),
        eq(connection.tenantId, externalAction.tenantId),
      ),
    )
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        eq(externalAction.stepRunId, stepRunId),
        eq(externalAction.status, "done"),
      ),
    )
    .orderBy(externalAction.createdAt, externalAction.id);
  for (const a of actions) subjects.push(changeSubjectFacts(input.tools(a.tool), a));

  return insertNew(
    tx,
    {
      tenantId,
      runId: step.runId,
      stepRunId,
      clientVisible: step.mode === "live" && input.visible(step.nodeId),
    },
    subjects,
  );
}
