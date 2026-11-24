// Collect reports (owner, 2026-11-24): the builder's sample file for a report, back office only
// (invariant 11). The operator adds a sample of the report; the server reads its format and, for
// a spreadsheet, its headers and what their first rows look like, and answers the expected
// columns. Nothing is stored: the sample never becomes a client's document.

import { z } from "zod";
import { REPORT_FORMATS } from "../process/collect";
import { TableColumn } from "../schemas/table";
import { defineRoute } from "./contract";

const OPS = ["operator"] as const;
const ApiId = z.string().min(1).max(200);

/** 5 MB of bytes, as base64. */
const SAMPLE_BASE64_MAX = Math.ceil((5 * 1024 * 1024) / 3) * 4;

export const CollectSampleView = z.object({
  /** The sample's format; null for a file no report takes. */
  format: z.enum(REPORT_FORMATS).nullable(),
  filename: z.string(),
  /** A spreadsheet's expected columns, one per header, typed from its first rows. */
  columns: z.array(TableColumn),
  /** The worksheet read (an .xlsx file's). */
  sheet: z.string().nullable(),
  rowCount: z.number().int(),
  /** Why it couldn't be read as a spreadsheet; null when it could (or isn't one). */
  failure: z.string().nullable(),
});
export type CollectSampleView = z.infer<typeof CollectSampleView>;

export const collectRoutes = {
  opsCollectSample: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/collect/sample",
    auth: "session",
    roles: OPS,
    summary:
      "Read a sample of a report a collect step waits for: its format and, for a spreadsheet, the expected columns",
    params: z.object({ id: ApiId }),
    body: z.strictObject({
      file: z.strictObject({
        filename: z.string().min(1).max(255),
        mimeType: z.string().max(200).default(""),
        base64: z.string().min(1).max(SAMPLE_BASE64_MAX),
      }),
    }),
    response: CollectSampleView,
  }),
};
