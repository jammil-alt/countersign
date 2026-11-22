// Back office: file and email intake's report profiles (owner, 2026-11-22; docs/plan.md §1.213).
// The operator saves how each kind of a client's emailed or exported report reads (Read table's
// own parameters), its control total and when it is expected; files of it sent to the client's
// forwarding address then land by themselves (packages/documents `landReport`). `propose` reads
// one of the client's table files with no columns and suggests them. Operator only, audited by
// `mount`; inside the client's tenant (invariant 1); no model reads the files.

import {
  ContentStore,
  ensureUploadConnection,
  readTableFile,
  TableFileError,
} from "@countersign/connectors";
import {
  type IntakeReportsView,
  isTableType,
  REPORT_FILE_ENTITY,
  routes,
  tableFiles,
} from "@countersign/core";
import { document, rawRecord } from "@countersign/db";
import {
  intakeStatsOf,
  ReportProfileError,
  reportProfilesOf,
  saveReportProfiles,
} from "@countersign/documents";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";

const RECENT = 20;

export function opsIntakeReportRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsIntakeReports, async (ctx): Promise<IntakeReportsView> => {
    ensureClient(ctx, ctx.params.id);
    const { tx, params } = ctx;
    const conn = await ensureUploadConnection(tx, params.id);
    const stats = intakeStatsOf(conn);
    const files = await tx
      .select({ id: rawRecord.id, payload: rawRecord.payload, syncedAt: rawRecord.syncedAt })
      .from(rawRecord)
      .where(
        and(
          eq(rawRecord.tenantId, params.id),
          eq(rawRecord.connectionId, conn.id),
          eq(rawRecord.entityType, REPORT_FILE_ENTITY),
        ),
      )
      .orderBy(desc(rawRecord.syncedAt))
      .limit(RECENT);
    return {
      profiles: reportProfilesOf(conn),
      duplicates: stats.duplicates,
      rejected: stats.rejected,
      lastDuplicateAt: stats.lastDuplicateAt,
      recent: files.map((f) => {
        const p = f.payload as Record<string, unknown>;
        return {
          fileRecordId: f.id,
          report: String(p.report ?? ""),
          documentId: String(p.documentId ?? ""),
          file: String(p.file ?? ""),
          rows: typeof p.rows === "number" ? p.rows : 0,
          receivedAt: typeof p.receivedAt === "string" ? p.receivedAt : f.syncedAt.toISOString(),
        };
      }),
    };
  });

  mount(app, routes.opsSaveIntakeReports, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx, params, body, session } = ctx;
    const conn = await ensureUploadConnection(tx, params.id);
    try {
      const profiles = await saveReportProfiles(
        tx,
        conn,
        body.profiles,
        session.user.id,
        new Date(),
      );
      return { profiles };
    } catch (error) {
      if (error instanceof ReportProfileError) {
        throw new HttpError(422, "invalid_report", error.message);
      }
      throw error;
    }
  });

  mount(app, routes.opsProposeIntakeReport, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx, params, body, services } = ctx;
    const [doc] = await tx
      .select()
      .from(document)
      .where(and(eq(document.id, body.documentId), eq(document.tenantId, params.id)))
      .limit(1);
    if (!doc) throw notFound("document");
    if (!isTableType(doc.mimeType)) {
      throw new HttpError(422, "unreadable_file", "the file isn't a .csv, .xlsx or .json file");
    }
    const stored = await new ContentStore(services.deps.objects(services.env)).get(
      params.id,
      doc.sha256,
    );
    if (!stored) throw notFound("the document's file");
    const file = { bytes: stored.bytes, mimeType: doc.mimeType, filename: doc.filename };
    const options = tableFiles.readTableOptions({
      header_row: body.headerRow,
      ...(body.sheet ? { sheet: body.sheet } : {}),
    });
    if (!options.ok) throw new HttpError(422, "invalid_parameters", options.error);
    try {
      const { read, sheets } = readTableFile(file, options.options);
      if (read.failure) throw new HttpError(422, "unreadable_file", read.failure);
      return {
        columns: tableFiles.proposeColumns(read),
        sheet: read.sheet,
        sheets,
        rowCount: read.rows.length,
        totals: read.totals.length,
      };
    } catch (error) {
      if (error instanceof TableFileError) {
        throw new HttpError(422, "unreadable_file", error.message);
      }
      throw error;
    }
  });
}
