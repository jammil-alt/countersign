// Table files as documents (docs/plan.md §1.164): an .xlsx is stored like a PDF, read whole for
// Read table's code but never for a model, kept per client, and a file Write table made is stored
// quietly (no `document.received`), naming its sources.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CSV_MIME_TYPE, XLSX_MIME_TYPE } from "@countersign/core";
import { document, event } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { readingFile } from "./extract";
import { type Client, createHarness, type Harness } from "./harness.test-helper";
import { DocumentError, storeDocument } from "./store";
import { storeTableFile, tableFile } from "./tables";

const h = await createHarness();
afterAll(() => h?.close());

const XLSX = new Uint8Array(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/tables/vendor-invoices.xlsx"),
  ),
);

describe.skipIf(!h)("table documents", () => {
  const harness = h as Harness;
  const upload = (c: Client, bytes: Uint8Array, filename: string, mimeType: string) =>
    harness.as(c, (tx) =>
      storeDocument(tx, harness.content, {
        tenantId: c.tenantId,
        source: "upload",
        connectionId: c.uploadConnectionId,
        bytes,
        filename,
        mimeType,
      }),
    );

  it("stores an .xlsx upload and reads it whole for code, never for a model", async () => {
    const { document: doc, event: received } = await upload(
      harness.A,
      XLSX,
      "vendor-invoices.xlsx",
      XLSX_MIME_TYPE,
    );
    expect(received?.type).toBe("document.received");
    const file = await tableFile(harness, harness.A.tenantId, doc.id);
    expect(file).toMatchObject({ filename: "vendor-invoices.xlsx", mimeType: XLSX_MIME_TYPE });
    expect(file.bytes).toEqual(XLSX);
    await expect(readingFile(harness, harness.A.tenantId, doc.id)).rejects.toMatchObject({
      code: "not_extractable",
    });
    // Another client's id finds nothing.
    await expect(tableFile(harness, harness.B.tenantId, doc.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a document that isn't a table", async () => {
    const { document: pdf } = await upload(
      harness.A,
      new TextEncoder().encode("%PDF-1.7 table test"),
      "a.pdf",
      "application/pdf",
    );
    await expect(tableFile(harness, harness.A.tenantId, pdf.id)).rejects.toBeInstanceOf(
      DocumentError,
    );
  });

  it("stores a file Write table made quietly, once, naming its sources", async () => {
    const bytes = new TextEncoder().encode("Vendor,Amount\r\nCascade,12.00\r\n");
    const input = {
      tenantId: harness.A.tenantId,
      bytes,
      filename: "import.csv",
      mimeType: CSV_MIME_TYPE,
      sources: ["0190a1b2-0000-7000-8000-0000000000d1"],
      agentVersionId: "0190a1b2-0000-7000-8000-0000000000a1",
      runId: "0190a1b2-0000-7000-8000-0000000000b1",
      testRun: true,
    };
    const first = await storeTableFile(harness, input);
    const again = await storeTableFile(harness, input);
    expect(first.created).toBe(true);
    expect(again).toEqual({ documentId: first.documentId, created: false });
    const [row] = await harness.as(harness.A, (tx) =>
      tx.select().from(document).where(eq(document.id, first.documentId)),
    );
    expect(row).toMatchObject({ source: "generated", mimeType: CSV_MIME_TYPE, connectionId: null });
    expect(row?.meta).toMatchObject({ kind: "table", sources: input.sources, testRun: true });
    const events = await harness.as(harness.A, (tx) =>
      tx
        .select()
        .from(event)
        .where(and(eq(event.type, "document.received"), eq(event.subjectId, first.documentId))),
    );
    expect(events).toEqual([]);
  });
});
