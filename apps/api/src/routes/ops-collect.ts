// Back office: a collect step's sample report (owner, 2026-11-24). In the builder the operator
// adds a sample of a report the step waits for; it is read here (a spreadsheet as Read table
// reads one, with no expected columns) and the answer is its format and the columns it suggests.
// Nothing is stored or sent to a model; operator only, audited by `mount`.

import { documentMimeType, readTableFile, TableFileError } from "@countersign/connectors";
import { type CollectSampleView, processes, routes, tableFiles } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount } from "../http";
import { agentInScope } from "./ops-lineage";

function bytesOf(base64: string): Uint8Array {
  try {
    return Uint8Array.from(atob(base64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  } catch {
    throw new HttpError(400, "invalid_request", "the file isn't base64");
  }
}

export function opsCollectRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsCollectSample, async (ctx): Promise<CollectSampleView> => {
    const { body } = ctx;
    await agentInScope(ctx, ctx.params.id);
    const { filename } = body.file;
    const mimeType = documentMimeType(body.file.mimeType, filename);
    const format = processes.reportFormatOf(mimeType);
    const none = { format, filename, columns: [], sheet: null, rowCount: 0, failure: null };
    if (format !== "spreadsheet") return none;
    const options = tableFiles.readTableOptions({});
    if (!options.ok) throw new HttpError(500, "internal", options.error);
    try {
      const { read } = readTableFile(
        { bytes: bytesOf(body.file.base64), mimeType, filename },
        options.options,
      );
      return {
        ...none,
        columns: processes.columnsFromSample(read.columns, read.rows),
        sheet: read.sheet,
        rowCount: read.rows.length,
        failure: read.failure,
      };
    } catch (error) {
      if (error instanceof TableFileError) return { ...none, failure: error.message };
      throw error;
    }
  });
}
