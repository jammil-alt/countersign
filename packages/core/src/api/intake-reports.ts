// File and email intake (owner, 2026-11-22; docs/plan.md §1.213): the back office's report
// profiles for a client, operator only (invariant 11). A profile says how one kind of emailed or
// exported report reads (Read table's own parameters), so the second file of a kind needs no
// setup; `propose` reads a file the client sent with no columns and suggests them from its
// headers, for the operator to check and save. Nothing here sends a file to a model.

import { z } from "zod";
import { ReportProfile } from "../schemas/report-profile";
import { TableColumn } from "../schemas/table";
import { defineRoute } from "./contract";

const OPS = ["operator"] as const;
const IdParams = z.object({ id: z.string().min(1).max(200) });

export const IntakeReportsView = z.object({
  profiles: z.array(ReportProfile),
  /** Files refused as duplicates and by their control totals, and each report's last file. */
  duplicates: z.number().int(),
  rejected: z.number().int(),
  lastDuplicateAt: z.string().nullable(),
  /** The last files landed (at most 20, newest first). */
  recent: z.array(
    z.object({
      fileRecordId: z.string(),
      report: z.string(),
      documentId: z.string(),
      file: z.string(),
      rows: z.number().int(),
      receivedAt: z.string(),
    }),
  ),
});
export type IntakeReportsView = z.infer<typeof IntakeReportsView>;

export const intakeReportRoutes = {
  opsIntakeReports: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/intake/reports",
    auth: "session",
    roles: OPS,
    summary: "A client's report profiles for file and email intake, and the files they landed",
    params: IdParams,
    response: IntakeReportsView,
  }),
  opsSaveIntakeReports: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/intake/reports",
    auth: "session",
    roles: OPS,
    summary: "Save a client's report profiles (the whole list)",
    params: IdParams,
    body: z.strictObject({ profiles: z.array(z.unknown()).max(50) }),
    response: z.object({ profiles: z.array(ReportProfile) }),
  }),
  opsProposeIntakeReport: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/intake/reports/propose",
    auth: "session",
    roles: OPS,
    summary: "Suggest a report profile's columns from one of the client's table files",
    params: IdParams,
    body: z.strictObject({
      documentId: z.uuid(),
      /** The row the file's headers are on (a report's title block sits above them). */
      headerRow: z.number().int().min(1).max(100).default(1),
      sheet: z.string().max(200).nullable().default(null),
    }),
    response: z.object({
      columns: z.array(TableColumn),
      sheet: z.string().nullable(),
      sheets: z.array(z.string()),
      rowCount: z.number().int(),
      /** The file's total rows, so the operator can pick a control total. */
      totals: z.number().int(),
    }),
  }),
};
