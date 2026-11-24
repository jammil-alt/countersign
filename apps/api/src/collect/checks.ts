// Collect reports (owner, 2026-11-24): the checks on what a report's owner sent. The documents
// are the client's own (uploaded through the report's link); each spreadsheet is read by the
// report's columns exactly as Read table reads one (connectors' `readTableFile`), and core's
// `checkReport` decides. Code only: no model reads the files (invariant 7), and nothing is
// written here.

import { type ContentStore, readTableFile, TableFileError } from "@countersign/connectors";
import { agentStepAddress, processes, tableFiles } from "@countersign/core";
import { type Db, document, withTenant } from "@countersign/db";
import type { CollectPort } from "@countersign/workflows";
import { and, eq, inArray } from "drizzle-orm";
import { agentAddresses } from "../triggers/list";

export function collectChecks(deps: {
  db: Db;
  content?: ContentStore | undefined;
  /** EMAIL_FORWARDING_DOMAIN: agents' addresses; absent: owners only upload through the link. */
  domain?: string | null | undefined;
}): CollectPort {
  return {
    // The step's address: the agent's own with `+<step id>` (core `agentStepAddress`).
    async address(req) {
      if (!deps.domain) return null;
      const addresses = await withTenant(deps.db, req.tenantId, (tx) =>
        agentAddresses(tx, req.tenantId, deps.domain),
      );
      const own = addresses.get(req.agentId);
      return own ? agentStepAddress(own, req.stepId) : null;
    },
    async check(req) {
      const ids = [...new Set(req.documentIds)].slice(0, 20);
      const rows =
        ids.length === 0
          ? []
          : await withTenant(deps.db, req.tenantId, (tx) =>
              tx
                .select({
                  id: document.id,
                  filename: document.filename,
                  mimeType: document.mimeType,
                  sizeBytes: document.sizeBytes,
                  sha256: document.sha256,
                })
                .from(document)
                .where(and(eq(document.tenantId, req.tenantId), inArray(document.id, ids))),
            );
      const options = tableFiles.readTableOptions(processes.readParameters(req.item));
      const files: processes.ReportFile[] = [];
      // In the order the owner sent them; a document that isn't the client's is never read.
      for (const id of ids) {
        const row = rows.find((r) => r.id === id);
        if (!row) continue;
        const file: processes.ReportFile = {
          documentId: row.id,
          filename: row.filename,
          mimeType: row.mimeType,
        };
        if (processes.reportFormatOf(row.mimeType) === "spreadsheet") {
          file.table = await readSheet(deps.content, req.tenantId, row, options);
        }
        files.push(file);
      }
      return processes.checkReport(req.item, req.period, files);
    },
  };
}

async function readSheet(
  content: ContentStore | undefined,
  tenantId: string,
  row: { filename: string; mimeType: string; sizeBytes: number; sha256: string },
  options: ReturnType<typeof tableFiles.readTableOptions>,
): Promise<NonNullable<processes.ReportFile["table"]>> {
  if (!options.ok) return { error: options.error };
  if (row.sizeBytes > processes.TABLE_MAX_BYTES) {
    return { error: `it is over ${processes.TABLE_MAX_BYTES / (1024 * 1024)} MB` };
  }
  const stored = content ? await content.get(tenantId, row.sha256) : null;
  if (!stored) return { error: "the file is missing" };
  try {
    const { read } = readTableFile(
      { bytes: stored.bytes, mimeType: row.mimeType, filename: row.filename },
      options.options,
    );
    return { failure: read.failure, rows: read.rows };
  } catch (error) {
    if (error instanceof TableFileError) return { error: error.message };
    throw error;
  }
}
