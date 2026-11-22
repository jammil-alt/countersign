// File and email intake (docs/plan.md §1.213), end to end: a made-up CR2-style report sent to the
// client's forwarding address lands as raw records with their provenance; the same file again is
// refused as a duplicate; a file whose total doesn't agree lands nothing and raises an alert with
// its sources; a scheduled report that doesn't arrive raises a missing-report alert, once.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { forwardingAddress, newForwardingSecret, updateForwarding } from "@countersign/connectors";
import {
  REPORT_CONTROL_TOTAL_ALERT,
  REPORT_FILE_ENTITY,
  REPORT_MISSING_ALERT,
  type ReportProfileInput,
  reportRowEntity,
} from "@countersign/core";
import { alert, connection, rawRecord } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receiveForwardedEmail } from "./forwarding";
import { INVOICE_DIR } from "./golden.test-helper";
import { createHarness, type Harness } from "./harness.test-helper";
import {
  checkMissingReports,
  intakeStatsOf,
  ReportProfileError,
  saveReportProfiles,
} from "./intake";

const h = await createHarness();
afterAll(() => h?.close());

const DOMAIN = "in.mezonas.test";
const SENDER = "reports@pinecrest.example";
const INTAKE_DIR = resolve(INVOICE_DIR, "../intake");
const csv = (name: string) => readFileSync(resolve(INTAKE_DIR, name));

/** A message from the report system with one CSV attached, as Email Routing hands it over. */
function reportEmail(to: string, filename: string, bytes: Buffer): Uint8Array {
  const b64 = bytes.toString("base64").replace(/.{76}/g, "$&\r\n");
  return new TextEncoder().encode(
    [
      `Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=${SENDER}`,
      `From: CR2 Reports <${SENDER}>`,
      `To: ${to}`,
      `Subject: Scheduled report: ${filename}`,
      "Date: Fri, 20 Nov 2026 06:02:00 -0600",
      `Message-ID: <${filename}@pinecrest.example>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="=_b"',
      "",
      "--=_b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your scheduled report is attached.",
      "",
      "--=_b",
      `Content-Type: text/csv; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      b64,
      "--=_b--",
      "",
    ].join("\r\n"),
  );
}

const CR2: ReportProfileInput = {
  id: "cr2-daily-sales",
  name: "CR2 daily sales",
  match: { filename: "cr2-daily-sales-*.csv", senders: ["pinecrest.example"] },
  read: {
    header_row: 4,
    columns: [
      { field: "ticket", headers: ["Ticket"], type: "text", required: true },
      { field: "date", headers: ["Date"], type: "date", dateStyle: "mdy", required: true },
      { field: "customer", headers: ["Customer"], type: "text" },
      { field: "item", headers: ["Item"], type: "text" },
      { field: "qty", headers: ["Qty"], type: "number" },
      { field: "netSales", headers: ["Net Sales"], type: "money", required: true },
    ],
  },
  controlTotal: { field: "netSales" },
  expected: { every: "day", byHour: 8, graceHours: 2 },
};

const GP: ReportProfileInput = {
  id: "gp-open-payables",
  name: "Great Plains open payables",
  read: {
    columns: [
      { field: "vendorId", headers: ["Vendor ID"], type: "text", required: true },
      { field: "documentNumber", headers: ["Document Number"], type: "text", required: true },
      { field: "amount", headers: ["Current Trx Amount"], type: "money", required: true },
    ],
  },
  controlTotal: { field: "amount" },
  expected: { every: "week", weekday: 1, byHour: 9, graceHours: 4 },
};

describe.skipIf(!h)("file and email intake", () => {
  const harness = h as Harness;
  const { A } = harness;
  let address: string;
  const SAVED = new Date("2026-11-16T12:00:00Z");

  const uploadConnection = () =>
    harness.as(A, async (tx) => {
      const [row] = await tx
        .select()
        .from(connection)
        .where(eq(connection.id, A.uploadConnectionId));
      if (!row) throw new Error("no upload connection");
      return row;
    });

  const send = (filename: string, bytes: Buffer, now: Date) =>
    receiveForwardedEmail(
      harness.deps(),
      { from: SENDER, to: address, raw: reportEmail(address, filename, bytes) },
      { domain: DOMAIN, now: () => now },
    );

  const rows = (entityType: string) =>
    harness.as(A, (tx) =>
      tx
        .select()
        .from(rawRecord)
        .where(and(eq(rawRecord.tenantId, A.tenantId), eq(rawRecord.entityType, entityType))),
    );

  const alerts = (kind: string) =>
    harness.as(A, (tx) =>
      tx
        .select()
        .from(alert)
        .where(and(eq(alert.tenantId, A.tenantId), eq(alert.kind, kind))),
    );

  beforeAll(async () => {
    address = forwardingAddress({
      tenantId: A.tenantId,
      clientName: "Pinecrest Supply",
      secret: newForwardingSecret(),
      domain: DOMAIN,
    });
    await harness.as(A, async (tx) => {
      const [row] = await tx
        .select()
        .from(connection)
        .where(eq(connection.id, A.uploadConnectionId));
      if (!row) throw new Error("no upload connection");
      const updated = await updateForwarding(
        tx,
        row,
        { address, allowedSenders: ["pinecrest.example"] },
        null,
      );
      await saveReportProfiles(tx, updated, [CR2, GP], null, SAVED);
    });
  });

  it("refuses a profile that can't tell its files apart or whose total isn't an amount", async () => {
    const row = await uploadConnection();
    const loose = { ...CR2, read: { columns: [{ field: "a", type: "text" }] } };
    await expect(
      harness.as(A, (tx) => saveReportProfiles(tx, row, [loose], null, SAVED)),
    ).rejects.toThrow(ReportProfileError);
    const badTotal = { ...CR2, controlTotal: { field: "ticket" } };
    await expect(
      harness.as(A, (tx) => saveReportProfiles(tx, row, [badTotal], null, SAVED)),
    ).rejects.toThrow(/control total/);
  });

  it("lands a report sent to the intake address as records with file, sheet and row", async () => {
    const r = await send(
      "cr2-daily-sales-2026-11-19.csv",
      csv("cr2-daily-sales-2026-11-19.csv"),
      new Date("2026-11-20T12:05:00Z"),
    );
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    const documentId = r.documents[0]?.id as string;
    expect(r.reports).toEqual([
      {
        status: "landed",
        documentId,
        report: "cr2-daily-sales",
        rows: 5,
        fileRecordId: expect.any(String),
        controlTotal: {
          status: "ok",
          field: "netSales",
          expected: "1346.01",
          found: "1346.01",
          totalRow: 10,
        },
      },
    ]);
    const landed = await rows(reportRowEntity("cr2-daily-sales"));
    expect(landed).toHaveLength(5);
    const first = landed.find((x) => x.externalId.endsWith(":5"));
    expect(first?.connector).toBe("upload");
    expect(first?.payload).toEqual({
      report: "cr2-daily-sales",
      fileRecordId: r.reports?.[0]?.status === "landed" ? r.reports[0].fileRecordId : null,
      fields: {
        ticket: "T-50211",
        date: "2026-11-19",
        customer: "Harbor Decks LLC",
        item: "2x6x12 PT Lumber",
        qty: 24,
        netSales: "214.56",
      },
      provenance: {
        documentId,
        file: "cr2-daily-sales-2026-11-19.csv",
        sheet: null,
        row: 5,
      },
    });
    // Every landed row says where it came from.
    expect(
      landed.map((x) => (x.payload as { provenance: { row: number } }).provenance.row).sort(),
    ).toEqual([5, 6, 7, 8, 9]);
    const [file] = await rows(REPORT_FILE_ENTITY);
    expect(file?.payload).toMatchObject({
      report: "cr2-daily-sales",
      documentId,
      rows: 5,
      from: SENDER,
    });
  });

  it("rejects a second copy of the same file as a duplicate, landing nothing", async () => {
    const r = await send(
      "cr2-daily-sales-2026-11-19.csv",
      csv("cr2-daily-sales-2026-11-19.csv"),
      new Date("2026-11-20T12:30:00Z"),
    );
    expect(r.status === "accepted" && r.reports?.[0]?.status).toBe("duplicate");
    expect(await rows(reportRowEntity("cr2-daily-sales"))).toHaveLength(5);
    expect(await rows(REPORT_FILE_ENTITY)).toHaveLength(1);
    // Renamed, the same bytes are still the same file.
    const renamed = await send(
      "cr2-daily-sales-copy.csv",
      csv("cr2-daily-sales-2026-11-19.csv"),
      new Date("2026-11-20T12:31:00Z"),
    );
    expect(renamed.status === "accepted" && renamed.reports?.[0]?.status).toBe("duplicate");
    const stats = intakeStatsOf(await uploadConnection());
    expect(stats.duplicates).toBe(2);
    expect(stats.reports["cr2-daily-sales"]?.lastLandedAt).toBe("2026-11-20T12:05:00.000Z");
  });

  it("lands nothing when the rows don't add up to the file's total, and says so with its source", async () => {
    const r = await send(
      "cr2-daily-sales-2026-11-20.csv",
      csv("cr2-daily-sales-2026-11-20-bad-total.csv"),
      new Date("2026-11-21T12:05:00Z"),
    );
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    const documentId = r.documents[0]?.id as string;
    expect(r.reports?.[0]).toMatchObject({
      status: "rejected",
      report: "cr2-daily-sales",
      reason: "the rows' netSales add up to 1346.01, the file's total (row 10) says 1446.01",
    });
    expect(await rows(reportRowEntity("cr2-daily-sales"))).toHaveLength(5);
    const [raised] = await alerts(REPORT_CONTROL_TOTAL_ALERT);
    expect(raised).toMatchObject({
      subjectType: "document",
      subjectId: documentId,
      evidence: [documentId],
      status: "open",
    });
  });

  it("leaves a table file no profile reads as a document", async () => {
    const r = await send(
      "notes.csv",
      Buffer.from("Name,Note\nA,b\n"),
      new Date("2026-11-21T12:06:00Z"),
    );
    expect(r.status === "accepted" && r.reports?.[0]?.status).toBe("unknown");
  });

  it("raises a missing-report alert once, with its sources, and clears it when the report lands", async () => {
    // Monday 2026-11-23 14:00 UTC: Great Plains' weekly (Monday 9:00 + 4 h) is past due, never
    // received; CR2's daily (8:00 + 2 h) is past due, its last on the 20th.
    const now = new Date("2026-11-23T14:00:00Z");
    expect(await checkMissingReports(harness.db, A.tenantId, { now, timezone: "UTC" })).toBe(2);
    expect(await checkMissingReports(harness.db, A.tenantId, { now, timezone: "UTC" })).toBe(0);
    const missing = await alerts(REPORT_MISSING_ALERT);
    const gp = missing.find((a) => (a.facts as { report: string }).report === "gp-open-payables");
    const cr2 = missing.find((a) => (a.facts as { report: string }).report === "cr2-daily-sales");
    expect(gp).toMatchObject({
      subjectType: "connection",
      subjectId: A.uploadConnectionId,
      evidence: [A.uploadConnectionId],
      title: "Great Plains open payables didn't arrive",
    });
    const [cr2File] = await rows(REPORT_FILE_ENTITY);
    expect(cr2?.evidence).toEqual([cr2File?.id]);

    // The payables list arrives: it lands (its grand total agrees) and its alert is answered.
    const r = await send("open-payables.csv", csv("gp-open-payables.csv"), now);
    expect(r.status === "accepted" && r.reports?.[0]).toMatchObject({
      status: "landed",
      report: "gp-open-payables",
      rows: 2,
      controlTotal: { status: "ok", expected: "4660.75" },
    });
    const after = await alerts(REPORT_MISSING_ALERT);
    expect(after.find((a) => a.id === gp?.id)?.status).toBe("dismissed");
    expect(after.find((a) => a.id === cr2?.id)?.status).toBe("open");
  });

  it("keeps another client's intake apart", async () => {
    const other = await harness.as(harness.B, (tx) =>
      tx.select().from(rawRecord).where(eq(rawRecord.tenantId, harness.B.tenantId)),
    );
    expect(other).toEqual([]);
  });
});
