// Data in and out of files (owner, 2026-11-20; docs/plan.md §1.164): the builder's sample-file
// check for a Read table step, back office only (invariant 11). The operator picks a sample file
// in the step's inspector; the server reads it with the step's effective parameters, exactly as
// the step would, and answers which of the file's headers each expected column took, what is
// missing, and the first rows. Nothing is stored: the sample never becomes a client's document.

import { z } from "zod";
import { TABLE_COLUMN_TYPES } from "../schemas/table";
import { defineRoute } from "./contract";

const OPS = ["operator"] as const;
const ApiId = z.string().min(1).max(200);

/** 5 MB of bytes, as base64. */
const SAMPLE_BASE64_MAX = Math.ceil((5 * 1024 * 1024) / 3) * 4;

export const ReadTableSampleView = z.object({
  /** The file as read: `csv`, `xlsx` or `json`. */
  kind: z.enum(["csv", "xlsx", "json"]),
  /** The worksheet read (an .xlsx file's), and every worksheet it has. */
  sheet: z.string().nullable(),
  sheets: z.array(z.string()),
  /** Each expected column (or, with none, each header) and what the file gave it. */
  columns: z.array(
    z.object({
      field: z.string(),
      header: z.string().nullable(),
      column: z.string().nullable(),
      type: z.enum(TABLE_COLUMN_TYPES).nullable(),
      required: z.boolean(),
    }),
  ),
  /** The file's headers no expected column took. */
  unmatched: z.array(z.object({ header: z.string(), column: z.string() })),
  /** The first rows as the step would give them (at most 5). */
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  /** Rows left out and cells that couldn't be read (at most 20 shown), and how many in all. */
  problems: z.array(
    z.object({
      row: z.number().int().nullable(),
      field: z.string().nullable(),
      message: z.string(),
    }),
  ),
  problemCount: z.number().int(),
  /** Why the step would fail on this file (a required column missing, too many rows). */
  failure: z.string().nullable(),
});
export type ReadTableSampleView = z.infer<typeof ReadTableSampleView>;

export const readTableRoutes = {
  opsReadTableSample: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/read-table/sample",
    auth: "session",
    roles: OPS,
    summary:
      "Read a sample file as a Read table step would: the headers each expected column took, what is missing, the first rows",
    params: z.object({ id: ApiId }),
    body: z.strictObject({
      /** The process being edited (the builder's draft, unsaved). */
      process: z.unknown(),
      /** The Read table step. */
      stepId: z.string().min(1).max(64),
      /** The agent's skills with their parameters (the builder's draft), under the step's own. */
      agentSkills: z
        .array(
          z.object({
            skill: z.string().min(1).max(200),
            parameters: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .max(200)
        .optional(),
      file: z.strictObject({
        filename: z.string().min(1).max(255),
        /** As the browser declared it; the extension decides when it is generic. */
        mimeType: z.string().max(200).default(""),
        base64: z.string().min(1).max(SAMPLE_BASE64_MAX),
      }),
    }),
    response: ReadTableSampleView,
  }),
};
