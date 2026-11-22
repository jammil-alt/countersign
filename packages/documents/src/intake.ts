// File and email intake (owner, 2026-11-22; docs/plan.md §1.213): reports from systems with no
// open API (CR2, Great Plains) arrive as .csv, .xlsx or .json files at the client's forwarding
// address. Each is matched to one of the client's report profiles (the upload connection's
// `config.reports`), read in code by Read table's own rules with the profile's parameters,
// checked against its control total, and landed as `raw_record` rows, each with its file, sheet
// and row number. The same bytes again are rejected as a duplicate (per client, by sha256); a
// scheduled report that doesn't arrive raises a missing-report alert with its sources
// (invariant 10). Rows are data: they reach agents only through tools (invariant 9).

import {
  type ContentStore,
  readTableFile,
  TableFileError,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  isTableType,
  REPORT_CONTROL_TOTAL_ALERT,
  REPORT_FILE_ENTITY,
  REPORT_MISSING_ALERT,
  type ReportProfile,
  ReportProfiles,
  reportRowEntity,
  tableFiles,
} from "@countersign/core";
import {
  alert,
  connection,
  connectionChange,
  type Db,
  type document,
  rawRecord,
  type Tx,
  withTenant,
} from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

type ConnectionRow = typeof connection.$inferSelect;
type DocumentRow = typeof document.$inferSelect;

export class ReportProfileError extends Error {
  override name = "ReportProfileError";
}

// ── Profiles and counts ─────────────────────────────────────────────────────────────────────

/** A client's report profiles; an unreadable list reads as none (and is refused when saved). */
export function reportProfilesOf(row: Pick<ConnectionRow, "config">): ReportProfile[] {
  const parsed = ReportProfiles.safeParse(row.config?.reports ?? []);
  return parsed.success ? parsed.data : [];
}

export const IntakeStats = z.object({
  /** Files refused because the same bytes had landed before. */
  duplicates: z.number().int().nonnegative().default(0),
  lastDuplicateAt: z.string().nullable().default(null),
  /** Files refused by their control total. */
  rejected: z.number().int().nonnegative().default(0),
  /** Per report: when a file of it last landed and its `report_file` record. */
  reports: z
    .record(z.string(), z.object({ lastLandedAt: z.string(), lastFileId: z.string() }))
    .default({}),
});
export type IntakeStats = z.infer<typeof IntakeStats>;

// DECISION: intake's counts live in the upload connection's `sync_cursor.intake`, beside the
// forwarding counts (connector state the operator never edits), so saving profiles never resets
// them, and the missing-report check reads one row per client.
export function intakeStatsOf(row: Pick<ConnectionRow, "syncCursor">): IntakeStats {
  const parsed = IntakeStats.safeParse(row.syncCursor?.intake ?? {});
  return parsed.success ? parsed.data : IntakeStats.parse({});
}

async function updateStats(
  tx: Tx,
  row: Pick<ConnectionRow, "id" | "tenantId">,
  change: (s: IntakeStats) => IntakeStats,
): Promise<void> {
  const where = and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId));
  const [fresh] = await tx
    .select({ syncCursor: connection.syncCursor })
    .from(connection)
    .where(where)
    .for("update");
  const next = change(intakeStatsOf({ syncCursor: fresh?.syncCursor ?? null }));
  await tx
    .update(connection)
    .set({ syncCursor: { ...(fresh?.syncCursor ?? {}), intake: next } })
    .where(where);
}

/** Why a profile can't be saved, in plain words; null when it can. */
export function reportProfileProblem(profile: ReportProfile): string | null {
  const options = tableFiles.readTableOptions(profile.read);
  if (!options.ok) return `${profile.name}: ${options.error}`;
  const columns = options.options.columns;
  // DECISION: a profile names at least one required column: that is how a file is known to be
  // this report rather than another file from the same sender.
  if (!columns.some((c) => c.required === true)) {
    return `${profile.name}: mark at least one column required, so its files can be told apart`;
  }
  const control = profile.controlTotal?.field;
  if (control) {
    const c = columns.find((x) => x.field === control);
    if (!c || (c.type !== "money" && c.type !== "number")) {
      return `${profile.name}: the control total is a money or number column`;
    }
  }
  if (profile.expected?.every === "week" && profile.expected.weekday === undefined) {
    return `${profile.name}: a weekly report names its weekday`;
  }
  if (profile.expected?.every === "month" && profile.expected.day === undefined) {
    return `${profile.name}: a monthly report names its day`;
  }
  return null;
}

/** Saves the client's report profiles (the whole list), logged as a connection change. */
export async function saveReportProfiles(
  tx: Tx,
  row: ConnectionRow,
  input: unknown,
  actorId: string | null,
  now: Date,
): Promise<ReportProfile[]> {
  const parsed = ReportProfiles.safeParse(input);
  if (!parsed.success) throw new ReportProfileError(z.prettifyError(parsed.error));
  const before = reportProfilesOf(row);
  const next = parsed.data.map((p) => ({
    ...p,
    createdAt: before.find((b) => b.id === p.id)?.createdAt ?? p.createdAt ?? now.toISOString(),
  }));
  for (const p of next) {
    const problem = reportProfileProblem(p);
    if (problem) throw new ReportProfileError(problem);
  }
  await tx
    .update(connection)
    .set({ config: { ...row.config, reports: next } })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change: { reports: { from: before, to: next } },
  });
  return next;
}

// ── Landing a file ──────────────────────────────────────────────────────────────────────────

export type ReportIntake =
  | {
      status: "landed";
      documentId: string;
      report: string;
      rows: number;
      fileRecordId: string;
      controlTotal: tableFiles.ControlTotalCheck;
    }
  | { status: "duplicate"; documentId: string; fileRecordId: string; report: string | null }
  | {
      status: "rejected";
      documentId: string;
      report: string;
      reason: string;
      alertId: string | null;
    }
  /** A table file no profile reads: kept as a document, for Read table. */
  | { status: "unknown"; documentId: string };

/** Where each landed row came from (invariant 10's sources, kept on the row itself). */
export interface RowProvenance {
  documentId: string;
  file: string;
  sheet: string | null;
  row: number;
}

const INSERT_CHUNK = 500;

/**
 * Lands one table document as a report, in the caller's transaction (inside the client's
 * `withTenant`). Returns null for a document that isn't a table file. Nothing lands for a
 * duplicate, a file no profile reads, or one whose control total doesn't agree.
 */
export async function landReport(
  tx: Tx,
  content: ContentStore,
  input: {
    connection: ConnectionRow;
    document: DocumentRow;
    /** The sender proven for it (forwarding's `authenticatedAs`); null for an upload. */
    from: string | null;
    now: Date;
  },
): Promise<ReportIntake | null> {
  const doc = input.document;
  const conn = input.connection;
  if (!isTableType(doc.mimeType)) return null;
  const tenantId = doc.tenantId;

  // The same bytes landed before (per client, by sha256): refused, nothing lands twice.
  const [seen] = await tx
    .select({ id: rawRecord.id, payload: rawRecord.payload })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, conn.id),
        eq(rawRecord.entityType, REPORT_FILE_ENTITY),
        eq(rawRecord.externalId, doc.sha256),
      ),
    )
    .limit(1);
  if (seen) {
    await updateStats(tx, conn, (s) => ({
      ...s,
      duplicates: s.duplicates + 1,
      lastDuplicateAt: input.now.toISOString(),
    }));
    const report = (seen.payload as { report?: unknown }).report;
    return {
      status: "duplicate",
      documentId: doc.id,
      fileRecordId: seen.id,
      report: typeof report === "string" ? report : null,
    };
  }

  const profiles = reportProfilesOf(conn);
  if (profiles.length === 0) return { status: "unknown", documentId: doc.id };
  const stored = await content.get(tenantId, doc.sha256);
  if (!stored) return { status: "unknown", documentId: doc.id };

  // The first profile whose name and sender rules fit and whose required columns are all there.
  let profile: ReportProfile | null = null;
  let read: tableFiles.TableRead | null = null;
  for (const p of profiles) {
    if (!tableFiles.profileMayMatch(p, { filename: doc.filename, from: input.from })) continue;
    const options = tableFiles.readTableOptions(p.read);
    if (!options.ok) continue;
    try {
      const file = readTableFile(
        { bytes: stored.bytes, mimeType: doc.mimeType, filename: doc.filename },
        options.options,
      );
      if (file.read.failure) continue;
      profile = p;
      read = file.read;
      break;
    } catch (error) {
      if (error instanceof TableFileError) continue;
      throw error;
    }
  }
  if (!profile || !read) return { status: "unknown", documentId: doc.id };

  const control = profile.controlTotal
    ? tableFiles.checkControlTotal(read, profile.controlTotal.field)
    : ({ status: "none" } as const);
  if (control.status === "mismatch") {
    const reason = `the rows' ${control.field} add up to ${control.found}, the file's total (row ${control.totalRow}) says ${control.expected}`;
    const [raised] = await tx
      .insert(alert)
      .values({
        tenantId,
        pack: null,
        kind: REPORT_CONTROL_TOTAL_ALERT,
        subjectType: "document",
        subjectId: doc.id,
        severity: "warning",
        title: `${profile.name}: totals don't agree`.slice(0, 200),
        body: `We didn't take in ${doc.filename}: ${reason}. Send a corrected file, or ask us to check the report's settings.`,
        evidence: [doc.id],
        facts: {
          report: profile.id,
          field: control.field,
          expected: control.expected,
          found: control.found,
          totalRow: control.totalRow,
        },
        dedupeKey: `${REPORT_CONTROL_TOTAL_ALERT}:${doc.sha256}`,
      })
      .onConflictDoNothing()
      .returning({ id: alert.id });
    await updateStats(tx, conn, (s) => ({ ...s, rejected: s.rejected + 1 }));
    return {
      status: "rejected",
      documentId: doc.id,
      report: profile.id,
      reason,
      alertId: raised?.id ?? null,
    };
  }

  // The file's record first: its id is the landed rows' and any later alert's source.
  const [file] = await tx
    .insert(rawRecord)
    .values({
      tenantId,
      connectionId: conn.id,
      connector: UPLOAD_CONNECTOR_ID,
      entityType: REPORT_FILE_ENTITY,
      externalId: doc.sha256,
      externalVersion: null,
      payload: {
        report: profile.id,
        documentId: doc.id,
        file: doc.filename,
        sheet: read.sheet,
        rows: read.rows.length,
        problems: read.problems.length,
        controlTotal: control.status === "none" ? null : control,
        from: input.from,
        receivedAt: input.now.toISOString(),
      },
    })
    .returning({ id: rawRecord.id });
  if (!file) throw new Error("report file insert returned nothing");

  const entityType = reportRowEntity(profile.id);
  const values = read.rows.map((fields, i) => {
    const provenance: RowProvenance = {
      documentId: doc.id,
      file: doc.filename,
      sheet: read.sheet,
      row: read.rowNumbers[i] as number,
    };
    return {
      tenantId,
      connectionId: conn.id,
      connector: UPLOAD_CONNECTOR_ID,
      entityType,
      // DECISION: a row's id is its file's sha256, sheet and row number: unique, and the same
      // row of the same file can never land twice even past the duplicate check.
      externalId: `${doc.sha256}:${read.sheet ?? ""}:${provenance.row}`,
      externalVersion: null,
      payload: { report: profile.id, fileRecordId: file.id, fields, provenance },
    };
  });
  for (let i = 0; i < values.length; i += INSERT_CHUNK) {
    await tx.insert(rawRecord).values(values.slice(i, i + INSERT_CHUNK));
  }

  // A missing-report alert for this report is answered by its arrival.
  await tx
    .update(alert)
    .set({ status: "dismissed", resolvedAt: input.now })
    .where(
      and(
        eq(alert.tenantId, tenantId),
        eq(alert.kind, REPORT_MISSING_ALERT),
        eq(alert.status, "open"),
        sql`${alert.facts}->>'report' = ${profile.id}`,
      ),
    );
  const id = profile.id;
  await updateStats(tx, conn, (s) => ({
    ...s,
    reports: { ...s.reports, [id]: { lastLandedAt: input.now.toISOString(), lastFileId: file.id } },
  }));
  return {
    status: "landed",
    documentId: doc.id,
    report: profile.id,
    rows: read.rows.length,
    fileRecordId: file.id,
    controlTotal: control,
  };
}

// ── Reports that didn't arrive ──────────────────────────────────────────────────────────────

/** A moment in the client's time zone, as people read it: "Nov 21, 2026, 9:00 AM". */
function localTime(at: Date, timezone: string): string {
  const format = (timeZone: string) =>
    at.toLocaleString("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" });
  try {
    return format(timezone);
  } catch {
    return `${format("UTC")} UTC`;
  }
}

/**
 * Raises a missing-report alert for each scheduled report of the client's that is past due with
 * no file landed for its period, once per report and due time. Its sources are the report's last
 * landed file (or, before any, the upload connection it should come through). Returns how many
 * were raised.
 */
export async function checkMissingReports(
  db: Db,
  tenantId: string,
  input: { now: Date; timezone: string },
): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, UPLOAD_CONNECTOR_ID)))
      .orderBy(connection.createdAt)
      .limit(1);
    if (!conn) return 0;
    const profiles = reportProfilesOf(conn).filter((p) => p.expected);
    if (profiles.length === 0) return 0;
    const stats = intakeStatsOf(conn);
    let raised = 0;
    for (const p of profiles) {
      const expected = p.expected;
      if (!expected) continue;
      const last = stats.reports[p.id];
      const check = tableFiles.reportMissing(expected, {
        now: input.now,
        timezone: input.timezone,
        since: p.createdAt ? new Date(p.createdAt) : null,
        lastLandedAt: last ? new Date(last.lastLandedAt) : null,
      });
      if (!check.missing) continue;
      const due = check.due.toISOString();
      const dedupeKey = `${REPORT_MISSING_ALERT}:${p.id}:${due}`;
      // Raised once per due time: one a person dismissed stays dismissed.
      const [before] = await tx
        .select({ id: alert.id })
        .from(alert)
        .where(and(eq(alert.tenantId, tenantId), eq(alert.dedupeKey, dedupeKey)))
        .limit(1);
      if (before) continue;
      const [row] = await tx
        .insert(alert)
        .values({
          tenantId,
          pack: null,
          kind: REPORT_MISSING_ALERT,
          subjectType: "connection",
          subjectId: conn.id,
          severity: "warning",
          title: `${p.name} didn't arrive`.slice(0, 200),
          body: last
            ? `It was due by ${localTime(check.due, input.timezone)}. The last one came in ${localTime(new Date(last.lastLandedAt), input.timezone)}.`
            : `It was due by ${localTime(check.due, input.timezone)}. None has come in yet.`,
          evidence: [last?.lastFileId ?? conn.id],
          facts: { report: p.id, due, lastLandedAt: last?.lastLandedAt ?? null },
          dedupeKey,
        })
        .onConflictDoNothing()
        .returning({ id: alert.id });
      if (row) raised++;
    }
    return raised;
  });
}
